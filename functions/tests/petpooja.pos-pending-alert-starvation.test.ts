import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * P2-L — the pending-alert scan must not be starved by persistent orders, and
 * must not alert an old order forever.
 *
 * `accepted_unconfirmed` is the sandbox's NORMAL shape (Petpooja never returns
 * an orderID there), so an outlet accumulates hundreds of paid, id-less orders
 * that can never be resolved automatically. The old scan read
 * `where(petpoojaStatus == X).limit(100)` per status with no ordering, so those
 * 100 docs filled every tick and a LATER paid order that had no POS id at all —
 * a real, cookable order — never alerted anyone.
 *
 * The worker now reads each status newest-first and pages (bounded) until it
 * has visited the live window, so the newest paid orders are always seen. It
 * also stops at the age horizon: an order older than 24h must not alert forever.
 *
 * Real document shapes only.
 */
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
        const q = (
          filters: Array<{ field: string; value: any }>,
          order?: { field: string; dir: "asc" | "desc" },
          cursorId?: string,
          limitCount?: number
        ): any => ({
          where: (f: string, _o: string, v: any) => q([...filters, { field: f, value: v }], order, cursorId, limitCount),
          orderBy: (f: string, dir: "asc" | "desc" = "asc") => q(filters, { field: f, dir }, cursorId, limitCount),
          limit: (n: number) => q(filters, order, cursorId, n),
          startAfter: (doc: any) => q(filters, order, typeof doc === "string" ? doc : doc?.id, limitCount),
          get: async () => {
            let rows = Object.entries(savedDocs)
              .filter(([p]) => p.startsWith(`${col}/`))
              .map(([p, data]) => ({ id: p.slice(col.length + 1), data, ref: docRef(col, p.slice(col.length + 1)) }))
              .filter((d) => filters.every((f) => d.data[f.field] === f.value));
            if (order) {
              rows = rows.sort((a, b) => {
                const va = a.data[order.field]?.toMillis?.() ?? a.data[order.field] ?? 0;
                const vb = b.data[order.field]?.toMillis?.() ?? b.data[order.field] ?? 0;
                return order.dir === "desc" ? vb - va : va - vb;
              });
            }
            if (cursorId) {
              const at = rows.findIndex((r) => r.id === cursorId);
              if (at >= 0) rows = rows.slice(at + 1);
            }
            if (typeof limitCount === "number") rows = rows.slice(0, limitCount);
            return {
              docs: rows.map((r) => ({ ...r, data: () => r.data })),
              empty: rows.length === 0,
            };
          },
        });
        return q([{ field, value }]);
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
  POS_PENDING_ALERT_MAX_AGE_MS,
  POS_PENDING_ALERT_MS,
  posPendingAlertsWorker,
} from "../src/modules/petpooja/posPendingAlerts";

const MINUTE = 60_000;

function paidOrder(id: string, verifiedAtMs: number, overrides: Record<string, any> = {}) {
  savedDocs[`orders/${id}`] = {
    id,
    branchId: "branch_b1",
    shortCode: `BUR-${id.slice(-4).toUpperCase()}`,
    paymentStatus: "completed",
    payment: { status: "completed", verifiedAt: verifiedAtMs },
    createdAt: new Date(verifiedAtMs),
    petpoojaStatus: "accepted_unconfirmed",
    petpoojaAcceptedNoId: true,
    ...overrides,
  };
}

beforeEach(() => {
  for (const key of Object.keys(savedDocs)) delete savedDocs[key];
  vi.mocked(dispatchFCM).mockClear();
  vi.mocked(dispatchFCM).mockResolvedValue(true);
});

describe("P2-L scan starvation", () => {
  it("still alerts a new paid order behind 120 persistent id-less accepted orders", async () => {
    const now = Date.now();
    // The sandbox backlog: paid, accepted, no POS id, no resolution path. They
    // are OLDER than the new order and would fill any unordered 100-row window.
    for (let i = 0; i < 120; i++) {
      paidOrder(`ord_backlog_${i}`, now - (10 * MINUTE + i * 1000));
    }
    // The order that matters: paid 2.5 minutes ago and never pushed at all.
    paidOrder(
      "ord_new_paid",
      now - 2.5 * MINUTE,
      { petpoojaStatus: "pending_retry", petpoojaAcceptedNoId: undefined }
    );

    const result = await posPendingAlertsWorker();
    expect(result.alerts2m).toBe(1);

    const alerted = vi.mocked(dispatchFCM).mock.calls.map((c) => c[0].data?.orderId);
    expect(alerted).toContain("ord_new_paid");
    expect(savedDocs["orders/ord_new_paid"].posPendingAlert2mAt).toBeTypeOf("number");
  });

  it("does not alert an order older than the horizon, even if it never alerted", async () => {
    const now = Date.now();
    paidOrder("ord_ancient", now - (POS_PENDING_ALERT_MAX_AGE_MS + 60 * MINUTE), {
      petpoojaStatus: "blocked_configuration",
    });

    const result = await posPendingAlertsWorker();
    expect(result).toEqual({ alerts2m: 0, escalations5m: 0 });
    expect(dispatchFCM).not.toHaveBeenCalled();
    expect(savedDocs["orders/ord_ancient"].posPendingAlert2mAt).toBeUndefined();
  });

  it("still alerts inside the horizon (just under 24h)", async () => {
    const now = Date.now();
    paidOrder("ord_just_inside", now - (POS_PENDING_ALERT_MAX_AGE_MS - MINUTE), {
      petpoojaStatus: "pending_retry",
    });

    const result = await posPendingAlertsWorker();
    // It is past 5 minutes, so it escalates rather than alerting at 2m.
    expect(result.escalations5m).toBe(1);
    expect(savedDocs["orders/ord_just_inside"].posPendingEscalated5mAt).toBeTypeOf("number");
  });

  it("alerts within the 2-minute window once, then never again", async () => {
    const now = Date.now();
    paidOrder("ord_once", now - (POS_PENDING_ALERT_MS + 15_000), {
      petpoojaStatus: "pending_retry",
    });

    expect((await posPendingAlertsWorker()).alerts2m).toBe(1);
    expect(dispatchFCM).toHaveBeenCalledTimes(1);
    expect((await posPendingAlertsWorker()).alerts2m).toBe(0);
    expect(dispatchFCM).toHaveBeenCalledTimes(1);
  });
});
