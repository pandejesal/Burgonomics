import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, savedDocs } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const docRef = (col: string, id: string) => {
    const path = `${col}/${id}`;
    return {
      id,
      path,
      get: vi.fn(async () => ({
        exists: Object.prototype.hasOwnProperty.call(savedDocs, path),
        data: () => savedDocs[path],
        ref: docRef(col, id),
      })),
      set: vi.fn(async (data: any, opts?: any) => {
        savedDocs[path] =
          opts?.merge && savedDocs[path] ? { ...savedDocs[path], ...data } : { ...data };
      }),
    };
  };

  const mockDb: any = {
    collection: (col: string) => ({
      doc: (id: string) => docRef(col, id),
      where: (field: string, _op: string, value: any) => {
        const queryBuilder = (filters: Array<{ field: string; value: any }>, limitCount?: number): any => ({
          where: (f: string, _o: string, v: any) =>
            queryBuilder([...filters, { field: f, value: v }], limitCount),
          limit: (n: number) => queryBuilder(filters, n),
          get: async () => {
            let matched = Object.entries(savedDocs)
              .filter(([path]) => path.startsWith(`${col}/`))
              .map(([path, data]) => {
                const id = path.slice(col.length + 1);
                return { id, ref: docRef(col, id), data: () => data };
              })
              .filter((doc) =>
                filters.every((filter) => doc.data()[filter.field] === filter.value)
              );
            if (typeof limitCount === "number") matched = matched.slice(0, limitCount);
            return { docs: matched, empty: matched.length === 0 };
          },
        });
        return queryBuilder([{ field, value }]);
      },
    }),
  };

  return { mockDb, savedDocs };
});

vi.mock("../src/core/firebase", () => ({ db: mockDb }));
vi.mock("../src/modules/notifications/fcm.service", () => ({
  dispatchFCM: vi.fn(async () => true),
}));

import { dispatchFCM } from "../src/modules/notifications/fcm.service";
import {
  POS_PENDING_ALERT_MS,
  POS_PENDING_ESCALATION_MS,
  posPendingAlertsWorker,
} from "../src/modules/petpooja/posPendingAlerts";

const MINUTE = 60_000;

function addOrder(id: string, overrides: Record<string, any> = {}) {
  savedDocs[`orders/${id}`] = {
    branchId: "b1",
    shortCode: "BUR-123",
    paymentStatus: "completed",
    petpoojaStatus: "pending_retry",
    payment: { status: "completed", verifiedAt: Date.now() - 2.5 * MINUTE },
    ...overrides,
  };
}

describe("paid-but-POS-pending alerts", () => {
  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    vi.mocked(dispatchFCM).mockClear();
    vi.mocked(dispatchFCM).mockResolvedValue(true);
  });

  it("stays silent before the 2-minute threshold", async () => {
    addOrder("young", { payment: { status: "completed", verifiedAt: Date.now() - 1 * MINUTE } });
    await expect(posPendingAlertsWorker()).resolves.toEqual({ alerts2m: 0, escalations5m: 0 });
    expect(dispatchFCM).not.toHaveBeenCalled();
    expect(savedDocs["orders/young"].posPendingAlert2mAt).toBeUndefined();
  });

  it("alerts the branch once at 2 minutes and never repeats", async () => {
    addOrder("two_min", {
      payment: { status: "completed", verifiedAt: Date.now() - (POS_PENDING_ALERT_MS + 10_000) },
    });
    await expect(posPendingAlertsWorker()).resolves.toEqual({ alerts2m: 1, escalations5m: 0 });
    expect(dispatchFCM).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dispatchFCM).mock.calls[0][0]).toMatchObject({
      topic: "branch_b1_orders",
      data: { type: "pos_pending_alert", stage: "2m", orderId: "two_min", branchId: "b1" },
    });
    expect(savedDocs["orders/two_min"].posPendingAlert2mAt).toBeTypeOf("number");

    await expect(posPendingAlertsWorker()).resolves.toEqual({ alerts2m: 0, escalations5m: 0 });
    expect(dispatchFCM).toHaveBeenCalledTimes(1);
  });

  it("escalates to the staff topic at 5 minutes and sets both markers", async () => {
    addOrder("five_min", {
      payment: { status: "completed", verifiedAt: Date.now() - (POS_PENDING_ESCALATION_MS + 30_000) },
    });
    await expect(posPendingAlertsWorker()).resolves.toEqual({ alerts2m: 0, escalations5m: 1 });
    expect(dispatchFCM).toHaveBeenCalledTimes(2);
    expect(vi.mocked(dispatchFCM).mock.calls.map((c) => c[0].topic)).toEqual([
      "branch_b1_orders",
      "tickets_escalated",
    ]);
    expect(vi.mocked(dispatchFCM).mock.calls[0][0].data).toMatchObject({
      type: "pos_pending_escalation",
      stage: "5m",
    });
    expect(savedDocs["orders/five_min"].posPendingAlert2mAt).toBeTypeOf("number");
    expect(savedDocs["orders/five_min"].posPendingEscalated5mAt).toBeTypeOf("number");
  });

  it("ignores unpaid orders, already-pushed orders, and orders with no paid timestamp", async () => {
    addOrder("unpaid", { paymentStatus: "pending", payment: { status: "pending" } });
    addOrder("pushed", { petpoojaOrderId: "pp_1" });
    addOrder("accepted_no_id", { petpoojaAcceptedNoId: true });
    addOrder("no_paid_time", { payment: { status: "completed" } });

    await expect(posPendingAlertsWorker()).resolves.toEqual({ alerts2m: 0, escalations5m: 0 });
    expect(dispatchFCM).not.toHaveBeenCalled();
  });

  it("covers a processing order that has been paid and stalled", async () => {
    addOrder("processing", {
      petpoojaStatus: "processing",
      payment: { status: "completed", verifiedAt: Date.now() - 3 * MINUTE },
    });
    await expect(posPendingAlertsWorker()).resolves.toEqual({ alerts2m: 1, escalations5m: 0 });
    expect(dispatchFCM).toHaveBeenCalledTimes(1);
  });

  it("does not write the marker when the alert transport fails, so the next tick retries", async () => {
    addOrder("retry_alert", {
      payment: { status: "completed", verifiedAt: Date.now() - 3 * MINUTE },
    });
    vi.mocked(dispatchFCM).mockResolvedValueOnce(false);
    await expect(posPendingAlertsWorker()).resolves.toEqual({ alerts2m: 0, escalations5m: 0 });
    expect(savedDocs["orders/retry_alert"].posPendingAlert2mAt).toBeUndefined();

    await expect(posPendingAlertsWorker()).resolves.toEqual({ alerts2m: 1, escalations5m: 0 });
    expect(dispatchFCM).toHaveBeenCalledTimes(2);
    expect(savedDocs["orders/retry_alert"].posPendingAlert2mAt).toBeTypeOf("number");
  });
});
