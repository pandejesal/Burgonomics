import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * P1-K — a KOT POST whose outcome is UNKNOWN is parked for reconciliation, not
 * blindly retried.
 *
 * The POS accepts a ticket, then the connection resets or the JSON body is
 * truncated. The old classifier parked only TimeoutError/AbortError as
 * ambiguous, so a TypeError (`fetch failed` / ECONNRESET / truncated stream) or
 * a SyntaxError from `response.json()` became `pending_retry` — and the 5-minute
 * worker re-POSTed a paid order the kitchen had already received.
 *
 * The contract pinned here:
 *   - a reset / truncated body / unparseable 200 → `reconciliation_required`,
 *     `petpoojaAmbiguousProcessing`, NO retry-count burn, worker never re-POSTs;
 *   - only a PROVEN rejection (an HTTP failure the origin answered with) or
 *     PROOF the request never left (connection refused / DNS) is retryable;
 *   - staff see the parked order (alert worker) and have a resolve path:
 *     confirm the print (mark done) or retry deliberately.
 *
 * Real document shapes only: branches/{id}, products/{id}, orders/{id}.
 */
const { mockDb, savedDocs, messagingSendSpy } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const messagingSendSpy = vi.fn(async () => "mock_msg_id");

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
      update: vi.fn(async (data: any) => {
        if (!savedDocs[path]) throw new Error(`Document ${path} does not exist`);
        savedDocs[path] = { ...savedDocs[path], ...data };
      }),
    };
  };

  const mockDb: any = {
    collection: (col: string) => ({
      doc: (id: string) => docRef(col, id),
      where: (field: string, _op: string, val: any) => {
        const queryBuilder = (
          filters: Array<{ field: string; val: any }>,
          sortField?: string,
          sortDir: string = "asc",
          limitCount?: number
        ): any => ({
          where: (f: string, _o: string, v: any) =>
            queryBuilder([...filters, { field: f, val: v }], sortField, sortDir, limitCount),
          orderBy: (sf: string, dir: string = "asc") =>
            queryBuilder(filters, sf, dir, limitCount),
          limit: (n: number) => queryBuilder(filters, sortField, sortDir, n),
          startAfter: () => queryBuilder(filters, sortField, sortDir, limitCount),
          get: async () => {
            let matched = Object.entries(savedDocs)
              .filter(([p]) => p.startsWith(`${col}/`))
              .map(([p, data]) => ({
                id: p.slice(col.length + 1),
                ref: docRef(col, p.slice(col.length + 1)),
                data: () => data,
              }))
              .filter((d) => filters.every((f) => d.data()[f.field] === f.val));
            if (sortField) {
              matched = matched.sort((a, b) => {
                const va = a.data()[sortField] || 0;
                const vb = b.data()[sortField] || 0;
                return sortDir === "desc" ? (vb > va ? 1 : -1) : (va > vb ? 1 : -1);
              });
            }
            if (typeof limitCount === "number") matched = matched.slice(0, limitCount);
            return { docs: matched, empty: matched.length === 0 };
          },
        });
        return queryBuilder([{ field, val }]);
      },
    }),
    getAll: async (...refs: any[]) => Promise.all(refs.map((r: any) => r.get())),
    runTransaction: async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
      }),
  };

  return { mockDb, savedDocs, messagingSendSpy };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TIMESTAMP",
    increment: (n: number) => n,
    delete: () => "MOCK_DELETE",
  };
  const firestoreFn: any = vi.fn(() => mockDb);
  firestoreFn.FieldValue = FieldValue;
  const messagingStub = { send: messagingSendSpy };
  return {
    default: {
      firestore: firestoreFn,
      auth: vi.fn(() => ({})),
      messaging: vi.fn(() => messagingStub),
      initializeApp: vi.fn(),
      apps: [{ name: "mock" }],
    },
    firestore: firestoreFn,
    auth: vi.fn(() => ({})),
    messaging: vi.fn(() => messagingStub),
    initializeApp: vi.fn(),
    apps: [{ name: "mock" }],
  };
});

vi.mock("../src/modules/notifications/fcm.service", () => ({
  dispatchFCM: vi.fn(async () => true),
}));

import {
  pushOrderToPetpooja,
  resolvePetpoojaKotAmbiguity,
} from "../src/modules/petpooja/orderPush";
import { retryPendingPetpoojaOrdersWorker } from "../src/modules/petpooja/petpooja.scheduler";
import { posPendingAlertsWorker } from "../src/modules/petpooja/posPendingAlerts";
import { dispatchFCM } from "../src/modules/notifications/fcm.service";
import { config } from "../src/config/env";

const BRANCH = "branch_k1x";
const MINUTE = 60_000;

let prevMock: boolean;
const fetchMock = vi.fn();

function seed() {
  savedDocs[`branches/${BRANCH}`] = {
    name: "K1 Outlet",
    petpoojaStoreId: "res_k1x",
    petpoojaTaxes: [
      { id: "3928", name: "CGST", rate: 2.5 },
      { id: "3929", name: "SGST", rate: 2.5 },
    ],
  };
  savedDocs["products/prod_k1x"] = {
    id: "prod_k1x",
    branchId: BRANCH,
    name: "Smash Burger",
    price: 250,
    inStock: true,
    petpoojaItemId: "7765862",
  };
}

function seedOrder(id: string, extra: Record<string, any> = {}) {
  savedDocs[`orders/${id}`] = {
    id,
    branchId: BRANCH,
    customerId: "cust_k1x",
    userId: "cust_k1x",
    fulfillment: "takeaway",
    paymentMethod: "cod",
    customerName: "K1 Customer",
    customerPhone: "+919825000222",
    items: [
      {
        id: "l1",
        productId: "prod_k1x",
        name: "Smash Burger",
        price: 250,
        quantity: 1,
      },
    ],
    pricing: { grandTotal: 250, gst: 11.9 },
    status: "pending",
    ...extra,
  };
}

/** A node-style transport failure: fetch() rejects with TypeError + cause. */
function transportError(code: string, message = "fetch failed"): Error {
  const err = new TypeError(message);
  (err as any).cause = Object.assign(new Error(`connect ${code}`), { code });
  return err;
}

beforeEach(() => {
  for (const key of Object.keys(savedDocs)) delete savedDocs[key];
  prevMock = config.mock.petpoojaPos;
  config.mock.petpoojaPos = false; // live path; the POST is stubbed
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(dispatchFCM).mockClear();
  vi.mocked(dispatchFCM).mockResolvedValue(true);
  seed();
});

afterEach(() => {
  config.mock.petpoojaPos = prevMock;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("P1-K uncertain KOT outcomes park for reconciliation", () => {
  it("a connection reset after the POST is ambiguous — never re-POSTed", async () => {
    seedOrder("ord_reset");
    fetchMock.mockRejectedValueOnce(transportError("ECONNRESET"));

    const pushed = await pushOrderToPetpooja("ord_reset");
    expect(pushed).toBe(false);

    const doc = savedDocs["orders/ord_reset"];
    expect(doc.petpoojaStatus).toBe("reconciliation_required");
    expect(doc.petpoojaSyncStatus).toBe("reconciliation_required");
    expect(doc.petpoojaAmbiguousProcessing).toBe(true);
    expect(doc.kotSyncFailed).toBe(true);
    expect(doc.petpoojaRetryCount).toBeUndefined();
    expect(doc.petpoojaOrderId).toBeUndefined();

    // The retry worker must not send a second KOT.
    const tick = await retryPendingPetpoojaOrdersWorker();
    expect(tick.retriedCount).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a truncated 200 body (SyntaxError from json()) is ambiguous", async () => {
    seedOrder("ord_truncated");
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected end of JSON input");
      },
    });

    expect(await pushOrderToPetpooja("ord_truncated")).toBe(false);
    const doc = savedDocs["orders/ord_truncated"];
    expect(doc.petpoojaStatus).toBe("reconciliation_required");
    expect(doc.petpoojaAmbiguousProcessing).toBe(true);
    expect(doc.petpoojaRetryCount).toBeUndefined();
    expect(String(doc.lastPetpoojaError)).toMatch(/Unexpected end of JSON input/);

    const tick = await retryPendingPetpoojaOrdersWorker();
    expect(tick.retriedCount).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("an unparseable 200 (JSON that is not an ack object) is ambiguous", async () => {
    seedOrder("ord_weird_ack");
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => "OK",
    });

    expect(await pushOrderToPetpooja("ord_weird_ack")).toBe(false);
    const doc = savedDocs["orders/ord_weird_ack"];
    expect(doc.petpoojaStatus).toBe("reconciliation_required");
    expect(doc.petpoojaAmbiguousProcessing).toBe(true);
  });

  it("a connection REFUSED is proof the request never left — still retryable", async () => {
    seedOrder("ord_refused");
    fetchMock.mockRejectedValueOnce(transportError("ECONNREFUSED", "fetch failed"));

    expect(await pushOrderToPetpooja("ord_refused")).toBe(false);
    const doc = savedDocs["orders/ord_refused"];
    expect(doc.petpoojaStatus).toBe("pending_retry");
    expect(doc.petpoojaRetryCount).toBe(1);
  });

  it("a DNS failure is proof the request never left — still retryable", async () => {
    seedOrder("ord_dns");
    fetchMock.mockRejectedValueOnce(transportError("ENOTFOUND"));

    expect(await pushOrderToPetpooja("ord_dns")).toBe(false);
    expect(savedDocs["orders/ord_dns"].petpoojaStatus).toBe("pending_retry");
  });

  it("an HTTP failure the origin answered with stays retryable (proven rejection)", async () => {
    seedOrder("ord_502");
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      json: async () => ({ success: "1" }),
    });

    expect(await pushOrderToPetpooja("ord_502")).toBe(false);
    const doc = savedDocs["orders/ord_502"];
    expect(doc.petpoojaStatus).toBe("pending_retry");
    expect(doc.petpoojaRetryCount).toBe(1);
  });
});

describe("P1-K a parked paid order is visible to staff", () => {
  it("alerts and escalates a reconciliation_required paid order", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);
    seedOrder("ord_parked_paid", {
      paymentStatus: "completed",
      petpoojaStatus: "reconciliation_required",
      petpoojaSyncStatus: "reconciliation_required",
      petpoojaAmbiguousProcessing: true,
      kotSyncFailed: true,
      shortCode: "BUR-K1",
      payment: { status: "completed", verifiedAt: now - 3 * MINUTE },
    });

    const first = await posPendingAlertsWorker();
    expect(first.alerts2m).toBe(1);
    expect(dispatchFCM).toHaveBeenCalledTimes(1);
    const call = vi.mocked(dispatchFCM).mock.calls[0][0];
    expect(call.topic).toBe(`branch_${BRANCH}_orders`);
    expect(call.title).toMatch(/Petpooja/i);
    // The copy must say the KOT state is UNKNOWN and needs a human check.
    expect(String(call.body)).toMatch(/check the POS|verify/i);
    expect(call.data).toMatchObject({
      type: "pos_pending_alert",
      orderId: "ord_parked_paid",
      branchId: BRANCH,
    });

    // Never re-alerts.
    const second = await posPendingAlertsWorker();
    expect(second.alerts2m).toBe(0);
    expect(dispatchFCM).toHaveBeenCalledTimes(1);
  });

  it("escalates a long-parked order to the staff topic at 5 minutes", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);
    seedOrder("ord_parked_5m", {
      paymentStatus: "completed",
      petpoojaStatus: "reconciliation_required",
      petpoojaAmbiguousProcessing: true,
      kotSyncFailed: true,
      shortCode: "BUR-5M",
      payment: { status: "completed", verifiedAt: now - 6 * MINUTE },
    });

    const result = await posPendingAlertsWorker();
    expect(result.escalations5m).toBe(1);
    expect(vi.mocked(dispatchFCM).mock.calls.map((c) => c[0].topic)).toEqual([
      `branch_${BRANCH}_orders`,
      "tickets_escalated",
    ]);
    expect(savedDocs["orders/ord_parked_5m"].posPendingEscalated5mAt).toBeTypeOf("number");
  });
});

describe("P1-K staff resolve path for an ambiguous KOT", () => {
  const staff = { uid: "staff_k1", role: "branch_staff", branchIds: [BRANCH] };

  it("confirming the print marks the order done with staff evidence", async () => {
    seedOrder("ord_resolve_printed", {
      paymentStatus: "completed",
      petpoojaStatus: "reconciliation_required",
      petpoojaSyncStatus: "reconciliation_required",
      petpoojaAmbiguousProcessing: true,
      kotSyncFailed: true,
      lastPetpoojaError: "fetch failed",
    });

    const result = await resolvePetpoojaKotAmbiguity("ord_resolve_printed", "printed", staff);
    expect(result).toMatchObject({ resolved: "printed" });

    const doc = savedDocs["orders/ord_resolve_printed"];
    expect(doc.petpoojaStatus).toBe("synced");
    expect(doc.petpoojaSyncStatus).toBe("synced");
    expect(doc.petpoojaAmbiguousProcessing).toBe(false);
    expect(doc.kotSyncFailed).toBe(false);
    // Human-confirmed print, never an invented printer acknowledgement.
    expect(doc.kotPrinted).toBe(true);
    expect(doc.kotPrintedSource).toBe("staff_confirmed");
    expect(doc.petpoojaResolvedBy).toBe("staff_k1");
    expect(doc.petpoojaResolvedAt).toBe("MOCK_TIMESTAMP");

    // A replayed webhook must NOT POST a second ticket.
    const replay = await pushOrderToPetpooja("ord_resolve_printed");
    expect(replay).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("choosing retry clears the park so the worker pushes exactly once", async () => {
    seedOrder("ord_resolve_retry", {
      paymentStatus: "completed",
      petpoojaStatus: "reconciliation_required",
      petpoojaSyncStatus: "reconciliation_required",
      petpoojaAmbiguousProcessing: true,
      kotSyncFailed: true,
      petpoojaRetryCount: 1,
      lastPetpoojaError: "fetch failed",
    });

    const result = await resolvePetpoojaKotAmbiguity("ord_resolve_retry", "retry", staff);
    expect(result).toMatchObject({ resolved: "retry" });

    const doc = savedDocs["orders/ord_resolve_retry"];
    expect(doc.petpoojaStatus).toBe("pending_retry");
    expect(doc.petpoojaAmbiguousProcessing).toBe(false);
    expect(doc.petpoojaResolvedBy).toBe("staff_k1");

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: "1", orderID: "pp_k1x_resolved" }),
    });
    const tick = await retryPendingPetpoojaOrdersWorker();
    expect(tick.retriedCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(savedDocs["orders/ord_resolve_retry"].petpoojaOrderId).toBe("pp_k1x_resolved");

    // Idempotent: the same paid order never posts twice.
    expect(await pushOrderToPetpooja("ord_resolve_retry")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a caller from another branch", async () => {
    seedOrder("ord_resolve_forbidden", {
      petpoojaStatus: "reconciliation_required",
      petpoojaAmbiguousProcessing: true,
    });
    await expect(
      resolvePetpoojaKotAmbiguity("ord_resolve_forbidden", "printed", {
        uid: "staff_other",
        role: "branch_staff",
        branchIds: ["branch_somewhere_else"],
      })
    ).rejects.toThrow(/Forbidden/);
    expect(savedDocs["orders/ord_resolve_forbidden"].petpoojaStatus).toBe(
      "reconciliation_required"
    );
  });

  it("refuses to resolve an order that is not parked", async () => {
    seedOrder("ord_not_parked", { petpoojaStatus: "synced", petpoojaOrderId: "pp_done" });
    await expect(
      resolvePetpoojaKotAmbiguity("ord_not_parked", "printed", staff)
    ).rejects.toThrow(/not parked/i);
  });
});
