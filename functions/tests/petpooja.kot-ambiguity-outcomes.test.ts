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
 *   - a reset / truncated body / unparseable 200 / 5xx / unrecognised object →
 *     `reconciliation_required`, `petpoojaAmbiguousProcessing`, NO retry-count
 *     burn, worker never re-POSTs;
 *   - only the vendor's documented IN-BAND refusal (`success` "0"/0/false on an
 *     HTTP status below 500 — references/petpooja_save_order_api.md §12, §16.1)
 *     or PROOF the request never left (connection refused / DNS) is retryable.
 *     Astra Finding 1: a gateway 5xx or an unknown acknowledgement does not
 *     prove the POS performed no side effect, and a stable client reference is
 *     not documented vendor duplicate suppression;
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

  it("an HTTP 502 is AMBIGUOUS — a gateway does not prove the POS refused (Astra F1)", async () => {
    // CLASS A — the old oracle of the unsafe contract. This case used to assert
    // `pending_retry` + count 1 for a 502 whose body even said success:"1".
    // Astra Finding 1: a gateway/proxy 5xx does not prove the POS did not save
    // the order, and the retry worker would then POST it a second time. The
    // expectation now follows the safe contract; the case itself is kept.
    seedOrder("ord_502");
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      json: async () => ({ success: "1" }),
    });

    expect(await pushOrderToPetpooja("ord_502")).toBe(false);
    const doc = savedDocs["orders/ord_502"];
    expect(doc.petpoojaStatus).toBe("reconciliation_required");
    expect(doc.petpoojaSyncStatus).toBe("reconciliation_required");
    expect(doc.petpoojaAmbiguousProcessing).toBe(true);
    expect(doc.kotSyncFailed).toBe(true);
    expect(doc.petpoojaRetryCount).toBeUndefined();
    // Only the status and the vendor message survive — never the raw body.
    expect(String(doc.lastPetpoojaError)).toContain("502");

    const tick = await retryPendingPetpoojaOrdersWorker();
    expect(tick.retriedCount).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

/**
 * Astra Finding 1 (High) — only the vendor's documented IN-BAND refusal may be
 * retried automatically.
 *
 * Evidence: references/petpooja_save_order_api.md §12 (lines 192–203), §16.1
 * (lines 550–575) and §16.10 (lines 870–890) — Petpooja reports its own refusal
 * as HTTP 200 with `{"success":"0","message":…}`. Nothing in the vendor contract
 * says a gateway 5xx, a 408/429, or an unrecognised acknowledgement means the
 * order was NOT saved, and a stable client reference is not documented
 * provider-side duplicate suppression.
 *
 * Each case below makes the synthetic POS "save" the order and then answer with
 * an outcome that proves nothing. The contract: park for reconciliation, burn no
 * retry budget, and never POST the same order twice even two hours later.
 */
describe("Astra F1 — only an in-band vendor refusal is auto-retryable", () => {
  /** The exact vendor refusal shape from the reference probes. */
  const vendorRefusal = (message = "Invalid order relay payload") => ({
    ok: true,
    status: 200,
    json: async () => ({ success: "0", message }),
  });

  /** An HTTP failure whose body claims success — a gateway/WAF artefact. */
  const httpFailureWithSuccessBody = (status: number, statusText: string) => ({
    ok: false,
    status,
    statusText,
    json: async () => ({
      success: "1",
      message: "Your order is saved.",
      restID: "res_k1x",
      clientOrderID: "whatever",
      orderID: "",
      code: 200,
    }),
  });

  /**
   * Asserts the ambiguous park: reconciliation_required, flagged ambiguous, no
   * retry budget burned, and exactly ONE POST across a two-hour window of
   * worker ticks (the 5-min scheduler must never re-send).
   */
  async function expectAmbiguousParkAndSinglePost(orderId: string) {
    expect(await pushOrderToPetpooja(orderId)).toBe(false);

    const doc = savedDocs[`orders/${orderId}`];
    expect(doc.petpoojaStatus).toBe("reconciliation_required");
    expect(doc.petpoojaSyncStatus).toBe("reconciliation_required");
    expect(doc.petpoojaAmbiguousProcessing).toBe(true);
    expect(doc.kotSyncFailed).toBe(true);
    expect(doc.petpoojaRetryCount).toBeUndefined();
    expect(doc.petpoojaOrderId).toBeUndefined();
    expect(doc.petpoojaAcceptedNoId).toBeUndefined();
    // The claim is released so an operator (not the worker) owns the next move.
    expect(doc.petpoojaPushClaimedAt).toBeNull();
    expect(doc.petpoojaClaimedAt).toBeNull();

    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Two hours of scheduler ticks (24 ticks) must produce ZERO further POSTs.
    const start = Date.now();
    for (let minute = 5; minute <= 120; minute += 5) {
      vi.setSystemTime(start + minute * MINUTE);
      const tick = await retryPendingPetpoojaOrdersWorker();
      expect(tick.retriedCount, `t+${minute}m`).toBe(0);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  }

  it("a 502 that saved the order is ambiguous — no retry, ONE POST total", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_amb_502");
    fetchMock.mockResolvedValueOnce(httpFailureWithSuccessBody(502, "Bad Gateway"));

    await expectAmbiguousParkAndSinglePost("ord_amb_502");
  });

  it("a 504 gateway timeout is ambiguous — no retry, ONE POST total", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_amb_504");
    fetchMock.mockResolvedValueOnce(httpFailureWithSuccessBody(504, "Gateway Timeout"));

    await expectAmbiguousParkAndSinglePost("ord_amb_504");
  });

  it("a 500 with a success-shaped body is ambiguous — no retry, ONE POST total", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_amb_500");
    fetchMock.mockResolvedValueOnce(httpFailureWithSuccessBody(500, "Internal Server Error"));

    await expectAmbiguousParkAndSinglePost("ord_amb_500");
  });

  it("a 429 rate limit is ambiguous — the POS may still have saved the order", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_amb_429");
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      json: async () => ({ status: "error", message: "rate limited" }),
    });

    await expectAmbiguousParkAndSinglePost("ord_amb_429");
  });

  it("a 403 with a bare gateway message is ambiguous — not a vendor refusal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_amb_403");
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      json: async () => ({ message: "Missing Authentication Token" }),
    });

    await expectAmbiguousParkAndSinglePost("ord_amb_403");
  });

  it("a 2xx object with no recognised success is ambiguous, not a rejection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_amb_empty_obj");
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({}),
    });

    await expectAmbiguousParkAndSinglePost("ord_amb_empty_obj");
  });

  it("a 2xx {status:'error'} with no explicit negative success is ambiguous", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_amb_status_error");
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: "error" }),
    });

    await expectAmbiguousParkAndSinglePost("ord_amb_status_error");
  });

  it("CONTROL: the documented HTTP 200 {success:'0'} refusal IS retryable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_ctrl_200_refusal");
    fetchMock.mockResolvedValueOnce(vendorRefusal());

    expect(await pushOrderToPetpooja("ord_ctrl_200_refusal")).toBe(false);
    const doc = savedDocs["orders/ord_ctrl_200_refusal"];
    expect(doc.petpoojaStatus).toBe("pending_retry");
    expect(doc.petpoojaRetryCount).toBe(1);
    expect(doc.petpoojaNextRetryAtMs).toBe(Date.now() + 5 * MINUTE);
    expect(doc.petpoojaAmbiguousProcessing).toBeUndefined();
    expect(String(doc.lastPetpoojaError)).toContain("Invalid order relay payload");

    // Exactly one deliberate retry, once it is due.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: "1", orderID: "pp_ctrl_retry" }),
    });
    vi.setSystemTime(doc.petpoojaNextRetryAtMs);
    const tick = await retryPendingPetpoojaOrdersWorker();
    expect(tick.retriedCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(savedDocs["orders/ord_ctrl_200_refusal"].petpoojaStatus).toBe("synced");
  });

  it("CONTROL: a 400 carrying an in-band {success:'0'} is still a retryable refusal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_ctrl_400_refusal");
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: async () => ({ success: "0", message: "Invalid order relay payload" }),
    });

    expect(await pushOrderToPetpooja("ord_ctrl_400_refusal")).toBe(false);
    const doc = savedDocs["orders/ord_ctrl_400_refusal"];
    expect(doc.petpoojaStatus).toBe("pending_retry");
    expect(doc.petpoojaRetryCount).toBe(1);
    expect(doc.petpoojaNextRetryAtMs).toBe(Date.now() + 5 * MINUTE);
  });
});

/**
 * Astra small audit (follow-up to F1) — a CONTRADICTORY acknowledgement is not
 * proof of non-acceptance.
 *
 * `classifyKotFailure` accepts `status:"success"` as a recognised ACK on the 2xx
 * path (`orderPush.ts`, `ok` in pushOrderToPetpooja). A 4xx body that says BOTH
 * `status:"success"` and `success:"0"` therefore contradicts itself: one field
 * claims the POS registered the order, the other says it refused. Picking the
 * refusal and re-POSTing would duplicate a ticket the POS may already hold, so a
 * recognised positive status must make the body prove nothing.
 *
 * These cases are pinned as AMBIGUOUS: reconciliation park, no retry-budget
 * burn, and exactly ONE POST across every future worker tick. The response is
 * never recorded as synced, registered, or accepted-no-id.
 */
describe("Astra F1 follow-up — a contradictory ack is ambiguous, never a refusal", () => {
  /** A 4xx whose body carries BOTH a negative success and a positive status. */
  const contradictoryFailure = (success: any, message = "Invalid order relay payload") => ({
    ok: false,
    status: 400,
    statusText: "Bad Request",
    json: async () => ({ success, status: "success", message }),
  });

  /** A plain in-band refusal with no contradictory positive status. */
  const ordinaryRefusal = (success: any, message = "Invalid order relay payload") => ({
    ok: false,
    status: 400,
    statusText: "Bad Request",
    json: async () => ({ success, message }),
  });

  /**
   * Ambiguity contract: park, burn no budget, and never re-POST — checked over a
   * two-hour window so a late retry cannot slip through.
   */
  async function expectAmbiguousAndNeverResent(orderId: string) {
    expect(await pushOrderToPetpooja(orderId)).toBe(false);

    const doc = savedDocs[`orders/${orderId}`];
    expect(doc.petpoojaStatus).toBe("reconciliation_required");
    expect(doc.petpoojaSyncStatus).toBe("reconciliation_required");
    expect(doc.petpoojaAmbiguousProcessing).toBe(true);
    expect(doc.kotSyncFailed).toBe(true);
    // No retry-budget burn: an ambiguous outcome is not an attempt.
    expect(doc.petpoojaRetryCount).toBeUndefined();
    // The contradictory body must never be read as an acceptance.
    expect(doc.petpoojaOrderId).toBeUndefined();
    expect(doc.petpoojaAcceptedNoId).toBeUndefined();
    expect(doc.petpoojaPushClaimedAt).toBeNull();
    expect(doc.petpoojaClaimedAt).toBeNull();

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const start = Date.now();
    for (let minute = 5; minute <= 120; minute += 5) {
      vi.setSystemTime(start + minute * MINUTE);
      const tick = await retryPendingPetpoojaOrdersWorker();
      expect(tick.retriedCount, `t+${minute}m`).toBe(0);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  }

  /** A retryable refusal: retry lane, one attempt burned, a real schedule. */
  function expectRetryableRefusal(orderId: string) {
    const doc = savedDocs[`orders/${orderId}`];
    expect(doc.petpoojaStatus).toBe("pending_retry");
    expect(doc.petpoojaRetryCount).toBe(1);
    expect(doc.petpoojaNextRetryAtMs).toBe(Date.now() + 5 * MINUTE);
    expect(doc.petpoojaAmbiguousProcessing).toBeUndefined();
    expect(doc.petpoojaOrderId).toBeUndefined();
    expect(doc.petpoojaAcceptedNoId).toBeUndefined();
  }

  it("a 400 with success:'0' AND status:'success' is ambiguous — contradictory ack", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_contra_str");
    fetchMock.mockResolvedValueOnce(contradictoryFailure("0"));

    await expectAmbiguousAndNeverResent("ord_contra_str");
  });

  it("a 400 with success:0 AND status:'success' is ambiguous — contradictory ack", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_contra_num");
    fetchMock.mockResolvedValueOnce(contradictoryFailure(0));

    await expectAmbiguousAndNeverResent("ord_contra_num");
  });

  it("a 400 with success:false AND status:'success' is ambiguous — contradictory ack", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_contra_bool");
    fetchMock.mockResolvedValueOnce(contradictoryFailure(false));

    await expectAmbiguousAndNeverResent("ord_contra_bool");
  });

  it("CONTROL: a 400 with numeric success:0 and no positive status stays retryable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_refusal_numeric_zero");
    fetchMock.mockResolvedValueOnce(ordinaryRefusal(0));

    expect(await pushOrderToPetpooja("ord_refusal_numeric_zero")).toBe(false);
    expectRetryableRefusal("ord_refusal_numeric_zero");
  });

  it("CONTROL: a 400 with boolean success:false and no positive status stays retryable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_refusal_boolean_false");
    fetchMock.mockResolvedValueOnce(ordinaryRefusal(false));

    expect(await pushOrderToPetpooja("ord_refusal_boolean_false")).toBe(false);
    expectRetryableRefusal("ord_refusal_boolean_false");
  });

  it("BOUNDARY: a 3xx with an explicit negative success stays a retryable refusal", async () => {
    // Status policy, pinned explicitly: below 500 the body decides, and a 3xx
    // carrying a clean in-band refusal is a refusal (synthetic — no redirect).
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_3xx_refusal");
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 302,
      statusText: "Found",
      json: async () => ({ success: "0", message: "Invalid order relay payload" }),
    });

    expect(await pushOrderToPetpooja("ord_3xx_refusal")).toBe(false);
    expectRetryableRefusal("ord_3xx_refusal");
  });

  it("BOUNDARY: a 3xx with an unrecognised body is ambiguous, not a refusal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_3xx_unknown");
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 302,
      statusText: "Found",
      json: async () => ({ message: "Found" }),
    });

    await expectAmbiguousAndNeverResent("ord_3xx_unknown");
  });
});

/**
 * Astra F1 (round 7) — an HTTP 200 body that BOTH refuses and acknowledges is a
 * CONTRADICTION, and it must be reconciled BEFORE the acceptance fence.
 *
 * `ok` in `pushOrderToPetpooja` is `success === "1" || 1 || true || status ===
 * "success"`. The last disjunct alone makes `{success:false, status:"success"}`
 * an acceptance, so today:
 *   - with an `orderID` the order is written `synced` + `petpoojaOrderId`
 *     (a fabricated acceptance and a claimed POS identity), and
 *   - without one it is written `accepted_unconfirmed` + `petpoojaAcceptedNoId`.
 * Neither field proves the POS registered the ticket: the same body says it was
 * refused. A real acceptance is never accompanied by an explicit negative
 * `success`, so the contradiction must win and the row must be parked.
 *
 * The existing 400 cases above cover the non-2xx shape; these cover HTTP 200,
 * which is the shape the vendor uses for BOTH outcomes and therefore the one
 * where the disjunction is dangerous.
 */
describe("Astra F1 — a contradictory HTTP 200 ack is never an acceptance", () => {
  /** HTTP 200 carrying an explicit negative success plus a positive status. */
  const contradictoryAck = (success: any, extra: Record<string, any> = {}) => ({
    ok: true,
    status: 200,
    json: async () => ({
      success,
      status: "success",
      message: "Your order is saved.",
      ...extra,
    }),
  });

  /**
   * Ambiguity contract for a contradictory 200: parked for reconciliation, NO
   * acceptance of either shape, no budget burn, no manual-entry page, and
   * exactly ONE POST across every future worker tick.
   */
  async function expectContradictionParked(orderId: string) {
    expect(await pushOrderToPetpooja(orderId)).toBe(false);

    const doc = savedDocs[`orders/${orderId}`];
    expect(doc.petpoojaStatus).toBe("reconciliation_required");
    expect(doc.petpoojaSyncStatus).toBe("reconciliation_required");
    expect(doc.petpoojaAmbiguousProcessing).toBe(true);
    expect(doc.kotSyncFailed).toBe(true);

    // NOTHING may be recorded as accepted, in either shape.
    expect(doc.petpoojaOrderId).toBeUndefined();
    expect(doc.petpoojaAcceptedNoId).toBeUndefined();
    expect(doc.petpoojaAcceptedNoIdAt).toBeUndefined();
    expect(doc.petpoojaAcceptedNoIdAck).toBeUndefined();
    expect(doc.petpoojaAcceptanceGeneration).toBeUndefined();
    expect(doc.petpoojaAcceptedAck).toBeUndefined();
    // And no printing claim may be manufactured.
    expect(doc.kotPrinted).toBeUndefined();
    expect(doc.kotPrintedAt).toBeUndefined();

    // No retry-budget burn: a contradiction is not a refused attempt.
    expect(doc.petpoojaRetryCount).toBeUndefined();
    // Claims released so an operator owns the next move.
    expect(doc.petpoojaPushClaimedAt).toBeNull();
    expect(doc.petpoojaClaimedAt).toBeNull();
    // No manual-entry page for an ambiguous (possibly accepted) KOT.
    expect(vi.mocked(dispatchFCM)).not.toHaveBeenCalled();

    // Exactly one deliberate POST, and the worker never sends again.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const start = Date.now();
    for (let minute = 5; minute <= 120; minute += 5) {
      vi.setSystemTime(start + minute * MINUTE);
      const tick = await retryPendingPetpoojaOrdersWorker();
      expect(tick.retriedCount, `t+${minute}m`).toBe(0);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  }

  it("HTTP 200 with success:'0', status:'success' and an orderID is ambiguous, not synced", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_200_contra_str_id");
    fetchMock.mockResolvedValueOnce(
      contradictoryAck("0", { orderID: "pp_example_str", restID: "res_k1x" })
    );

    await expectContradictionParked("ord_200_contra_str_id");
  });

  it("HTTP 200 with success:'0' and status:'success' but NO orderID is ambiguous, not accepted-no-id", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_200_contra_str_noid");
    fetchMock.mockResolvedValueOnce(
      contradictoryAck("0", { orderID: "", restID: "res_k1x", code: 200 })
    );

    await expectContradictionParked("ord_200_contra_str_noid");
  });

  it("HTTP 200 with success:0, status:'success' and an orderID is ambiguous, not synced", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_200_contra_num_id");
    fetchMock.mockResolvedValueOnce(
      contradictoryAck(0, { orderID: "pp_example_num", restID: "res_k1x" })
    );

    await expectContradictionParked("ord_200_contra_num_id");
  });

  it("HTTP 200 with success:0 and status:'success' but NO orderID is ambiguous, not accepted-no-id", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_200_contra_num_noid");
    fetchMock.mockResolvedValueOnce(
      contradictoryAck(0, { orderID: "", restID: "res_k1x", code: 200 })
    );

    await expectContradictionParked("ord_200_contra_num_noid");
  });

  it("HTTP 200 with success:false, status:'success' and an orderID is ambiguous, not synced", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_200_contra_bool_id");
    fetchMock.mockResolvedValueOnce(
      contradictoryAck(false, { orderID: "pp_example_bool", restID: "res_k1x" })
    );

    await expectContradictionParked("ord_200_contra_bool_id");
  });

  it("HTTP 200 with success:false and status:'success' but NO orderID is ambiguous, not accepted-no-id", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_200_contra_bool_noid");
    fetchMock.mockResolvedValueOnce(
      contradictoryAck(false, { orderID: "", restID: "res_k1x", code: 200 })
    );

    await expectContradictionParked("ord_200_contra_bool_noid");
  });

  it("CONTROL: a clean HTTP 200 positive ack still syncs with its order id", async () => {
    // The contradiction rule must not weaken a genuine acceptance.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_200_clean_ack");
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: "1", message: "Your order is saved.", orderID: "pp_clean_1" }),
    });

    expect(await pushOrderToPetpooja("ord_200_clean_ack")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const doc = savedDocs["orders/ord_200_clean_ack"];
    expect(doc.petpoojaStatus).toBe("synced");
    expect(doc.petpoojaOrderId).toBe("pp_clean_1");
    expect(doc.petpoojaAmbiguousProcessing).toBeUndefined();
    expect(doc.kotPrinted).toBeUndefined();
  });

  it("CONTROL: a clean HTTP 200 refusal under 500 still enters the retry lane", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_200_clean_refusal");
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: "0", message: "Invalid order relay payload" }),
    });

    expect(await pushOrderToPetpooja("ord_200_clean_refusal")).toBe(false);
    const doc = savedDocs["orders/ord_200_clean_refusal"];
    expect(doc.petpoojaStatus).toBe("pending_retry");
    expect(doc.petpoojaRetryCount).toBe(1);
    expect(doc.petpoojaAmbiguousProcessing).toBeUndefined();
    expect(doc.petpoojaOrderId).toBeUndefined();
    expect(doc.petpoojaAcceptedNoId).toBeUndefined();
  });
});

/**
 * Astra Finding 2 (High) — an EXPIRED push claim is not proof that nothing was
 * sent.
 *
 * `pushOrderToPetpooja` takes a transactional `petpoojaPushClaimedAt` lease. The
 * current claim only refuses an ACTIVE lease; once the 10-minute TTL lapses it
 * silently renews it and POSTs. The scheduler already quarantines the same state
 * (`petpooja.scheduler.ts`, stale-`processing` crash lane) — the direct path does
 * not, so a caller that wins the race duplicates the KOT. An expired, unreleased
 * claim means the previous sender stopped WRITING; the POS may still hold the
 * ticket (accepted, process died before recording it).
 *
 * The fence must therefore apply to EVERY entry path, including the
 * no-`runTransaction` fallback, and must fail closed on a lease it cannot
 * interpret (NaN, a non-numeric `toMillis`, an unrepresentable sentinel).
 */
describe("Astra F2 — an expired unresolved push claim parks instead of re-POSTing", () => {
  const MINUTE_MS = 60_000;
  const EXPIRED_AT = () => Date.now() - 11 * MINUTE_MS;

  /**
   * The quarantine contract: park for reconciliation, release every claim, keep
   * the retry budget untouched, invent no acceptance — and send NOTHING, now or
   * on any of the next 24 worker ticks.
   */
  async function expectParkedWithoutAnyPost(orderId: string, expectedRetryCount?: number) {
    expect(await pushOrderToPetpooja(orderId)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();

    const doc = savedDocs[`orders/${orderId}`];
    expect(doc.petpoojaStatus).toBe("reconciliation_required");
    expect(doc.petpoojaSyncStatus).toBe("reconciliation_required");
    expect(doc.petpoojaAmbiguousProcessing).toBe(true);
    expect(doc.kotSyncFailed).toBe(true);
    // Claims released: an operator owns the next move, not the worker.
    expect(doc.petpoojaPushClaimedAt).toBeNull();
    expect(doc.petpoojaClaimedAt).toBeNull();
    // Budget unchanged — an unknown outcome is not a spent attempt.
    if (expectedRetryCount === undefined) {
      expect(doc.petpoojaRetryCount).toBeUndefined();
    } else {
      expect(doc.petpoojaRetryCount).toBe(expectedRetryCount);
    }
    // Nothing was accepted, so no id and no printer claim may be manufactured.
    expect(doc.petpoojaOrderId).toBeUndefined();
    expect(doc.petpoojaAcceptedNoId).toBeUndefined();
    expect(doc.kotPrinted).toBeUndefined();
    expect(doc.kotPrintedAt).toBeUndefined();

    // No further POST across two hours of scheduler ticks.
    const start = Date.now();
    for (let minute = 5; minute <= 120; minute += 5) {
      vi.setSystemTime(start + minute * MINUTE_MS);
      const tick = await retryPendingPetpoojaOrdersWorker();
      expect(tick.retriedCount, `t+${minute}m`).toBe(0);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  }

  it("an expired claim on a 'processing' order parks before any POST", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_f2_processing", {
      petpoojaStatus: "processing",
      petpoojaSyncStatus: "processing",
      petpoojaPushClaimedAt: EXPIRED_AT(),
    });
    // A success-shaped answer must never be consulted: the POST must not happen.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: "1", orderID: "pp_f2_should_not_exist" }),
    });

    await expectParkedWithoutAnyPost("ord_f2_processing");
  });

  it("an expired claim on a 'pending_retry' order parks before any POST", async () => {
    // Status-independence: the fence must not depend on the row still saying
    // `processing` — a retry-lane row can carry a dead send lease too.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_f2_pending", {
      petpoojaStatus: "pending_retry",
      petpoojaSyncStatus: "pending_retry",
      petpoojaRetryCount: 2,
      petpoojaNextRetryAtMs: Date.now() - 1,
      petpoojaPushClaimedAt: EXPIRED_AT(),
    });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: "1", orderID: "pp_f2_should_not_exist" }),
    });

    // The existing budget is preserved, not decremented and not incremented.
    await expectParkedWithoutAnyPost("ord_f2_pending", 2);
  });

  it("a NaN claim fails closed — an uninterpretable lease is never a takeover", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_f2_nan", {
      petpoojaStatus: "processing",
      petpoojaPushClaimedAt: Number.NaN,
    });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: "1", orderID: "pp_f2_nan" }),
    });

    await expectParkedWithoutAnyPost("ord_f2_nan");
  });

  it("a toMillis() returning NaN fails closed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_f2_bad_tomillis", {
      petpoojaStatus: "processing",
      petpoojaPushClaimedAt: { toMillis: () => Number.NaN },
    });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: "1", orderID: "pp_f2_bad_tomillis" }),
    });

    await expectParkedWithoutAnyPost("ord_f2_bad_tomillis");
  });

  it("an unrepresentable string lease fails closed", async () => {
    // A hand-edited/imported doc, not a Firestore Timestamp: `Date.now() - NaN`
    // compares false, so the current code reads it as "not active" and POSTs.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_f2_bad_string", {
      petpoojaStatus: "processing",
      petpoojaPushClaimedAt: "not-a-timestamp",
    });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: "1", orderID: "pp_f2_bad_string" }),
    });

    await expectParkedWithoutAnyPost("ord_f2_bad_string");
  });

  it("a numeric-zero claim marker counts as an unresolved old claim", async () => {
    // `petpoojaPushClaimedAt: 0` is falsy-but-present: it names a previous send
    // attempt with no recorded outcome, not "never claimed". Fail closed.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_f2_zero_marker", {
      petpoojaStatus: "processing",
      petpoojaPushClaimedAt: 0,
    });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: "1", orderID: "pp_f2_zero_marker" }),
    });

    await expectParkedWithoutAnyPost("ord_f2_zero_marker");
  });

  it("an acceptance with a POS id wins over a stale claim — deduped, no POST", async () => {
    // Acceptance is PROVEN, so it outranks the expired-lease fence.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_f2_accepted_id", {
      petpoojaStatus: "processing",
      petpoojaPushClaimedAt: EXPIRED_AT(),
      petpoojaOrderId: "pp_f2_already_at_pos",
    });

    expect(await pushOrderToPetpooja("ord_f2_accepted_id")).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    const doc = savedDocs["orders/ord_f2_accepted_id"];
    expect(doc.petpoojaOrderId).toBe("pp_f2_already_at_pos");
    // The winner's synced evidence is not rewritten into a park.
    expect(doc.petpoojaStatus).toBe("processing");
  });

  it("an accepted-no-id order wins over a stale claim — deduped, no POST", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_f2_accepted_no_id", {
      petpoojaStatus: "processing",
      petpoojaPushClaimedAt: EXPIRED_AT(),
      petpoojaAcceptedNoId: true,
    });

    expect(await pushOrderToPetpooja("ord_f2_accepted_no_id")).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    const doc = savedDocs["orders/ord_f2_accepted_no_id"];
    expect(doc.petpoojaAcceptedNoId).toBe(true);
    expect(doc.petpoojaOrderId).toBeUndefined();
    expect(doc.kotPrinted).toBeUndefined();
  });

  it("a FRESH active claim is still busy — yielding, not a park", async () => {
    // Unchanged behaviour guard: a live lease must stay `busy` (deferred, honest
    // false), never a reconciliation park and never a POST.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_f2_active", {
      petpoojaStatus: "processing",
      petpoojaPushClaimedAt: Date.now() - 1 * MINUTE_MS,
    });

    expect(await pushOrderToPetpooja("ord_f2_active")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    const doc = savedDocs["orders/ord_f2_active"];
    expect(doc.petpoojaStatus).toBe("processing");
    expect(doc.petpoojaAmbiguousProcessing).toBeUndefined();
    expect(doc.kotSyncFailed).toBeUndefined();
    expect(doc.petpoojaRetryCount).toBeUndefined();
    expect(doc.petpoojaPushClaimedAt).toBe(Date.now() - 1 * MINUTE_MS);
  });

  it("the scheduler's fresh petpoojaClaimedAt alone does not fence a legitimate push", async () => {
    // The scheduler takes `petpoojaClaimedAt` BEFORE calling this function, so
    // treating it as a provider-send fence would deadlock every retry. Only the
    // dedicated push claim fences a send.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_f2_scheduler_lease", {
      petpoojaStatus: "processing",
      petpoojaClaimedAt: Date.now(), // live scheduler lease, no push claim
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: "1", orderID: "pp_f2_scheduler_ok" }),
    });

    expect(await pushOrderToPetpooja("ord_f2_scheduler_lease")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const doc = savedDocs["orders/ord_f2_scheduler_lease"];
    expect(doc.petpoojaOrderId).toBe("pp_f2_scheduler_ok");
    expect(doc.petpoojaStatus).toBe("synced");
    expect(doc.petpoojaPushClaimedAt).toBeNull();
  });

  it("a datastore without runTransaction refuses the prior-push fence without mutating", async () => {
    // CONTRACT CORRECTION (approved): the capability gap still cannot become a
    // duplicate-KOT bypass — zero POST, returns false — but it also cannot
    // justify a plain read-then-write quarantine. Without an atomic recheck that
    // write could clobber a concurrent acceptance, so this path now REFUSES
    // without any mutation and leaves the row for the scheduler's transactional
    // crash lane or an operator. The prior state is therefore fully preserved.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    const priorClaim = EXPIRED_AT();
    seedOrder("ord_f2_no_tx", {
      petpoojaStatus: "processing",
      petpoojaSyncStatus: "processing",
      petpoojaRetryCount: 1,
      petpoojaPushClaimedAt: priorClaim,
    });
    const before = { ...savedDocs["orders/ord_f2_no_tx"] };
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: "1", orderID: "pp_f2_no_tx" }),
    });

    const origRunTransaction = (mockDb as any).runTransaction;
    delete (mockDb as any).runTransaction;
    try {
      expect(await pushOrderToPetpooja("ord_f2_no_tx")).toBe(false);
    } finally {
      (mockDb as any).runTransaction = origRunTransaction;
    }

    // Nothing was sent, and the row is byte-identical: no park, no claim
    // renewal, no budget burn, no invented acceptance.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(savedDocs["orders/ord_f2_no_tx"]).toEqual(before);
    const doc = savedDocs["orders/ord_f2_no_tx"];
    expect(doc.petpoojaStatus).toBe("processing");
    expect(doc.petpoojaPushClaimedAt).toBe(priorClaim);
    expect(doc.petpoojaRetryCount).toBe(1);
    expect(doc.petpoojaAmbiguousProcessing).toBeUndefined();
    expect(doc.kotSyncFailed).toBeUndefined();
    expect(doc.petpoojaOrderId).toBeUndefined();
    expect(doc.petpoojaAcceptedNoId).toBeUndefined();
    expect(doc.kotPrinted).toBeUndefined();
  });
});

/**
 * Race safety of the F2 quarantine itself.
 *
 * Classification happens INSIDE the claim transaction from a fresh read, but the
 * park is currently written by a plain `orderDoc.ref.set` AFTER that transaction
 * returns. Between the two moments a concurrent commit can land: a sender's late
 * ACK (with a POS id, or id-less) records acceptance, or an operator's
 * reconciliation resolves the row. A plain follow-up write then relabels that
 * accepted state `reconciliation_required` and clears the newer claims — losing
 * a recorded acceptance and re-opening a ticket the kitchen already has.
 *
 * These cases inject that exact commit deterministically: the transaction's own
 * callback is awaited to completion (so the "unresolved" decision is already
 * made), the ACK is written, and only then is the result returned to the caller.
 * The caller must send nothing AND leave every field of the newer acceptance in
 * place.
 */
describe("Astra F2 race — a late acceptance survives the unresolved quarantine", () => {
  const MINUTE_MS = 60_000;

  /** Writes a settled POS acceptance over the seeded row, as a racer would. */
  const recordLateAcceptance = (orderId: string, extra: Record<string, any>) => {
    const doc = savedDocs[`orders/${orderId}`];
    Object.assign(doc, {
      petpoojaStatus: "synced",
      petpoojaSyncStatus: "synced",
      petpoojaAmbiguousProcessing: false,
      kotSyncFailed: false,
      petpoojaPushClaimedAt: null,
      petpoojaClaimedAt: null,
      lastPetpoojaError: null,
      ...extra,
    });
  };

  /**
   * Runs `pushOrderToPetpooja` with a transaction wrapper that lets the claim
   * callback finish, then commits `ack` before the caller resumes.
   */
  async function pushWithLateAcceptance(
    orderId: string,
    ack: () => void
  ): Promise<boolean> {
    const originalRunTransaction = (mockDb as any).runTransaction;
    (mockDb as any).runTransaction = async (fn: any) => {
      const result = await originalRunTransaction(fn);
      // The unresolved decision is final at this point; the racer commits now.
      ack();
      return result;
    };
    try {
      return await pushOrderToPetpooja(orderId);
    } finally {
      (mockDb as any).runTransaction = originalRunTransaction;
    }
  }

  /** The newer acceptance must be byte-for-byte intact after the caller returns. */
  function expectAcceptanceSurvives(orderId: string, extra: Record<string, any>) {
    const doc = savedDocs[`orders/${orderId}`];
    expect(doc.petpoojaStatus).toBe("synced");
    expect(doc.petpoojaSyncStatus).toBe("synced");
    expect(doc.petpoojaAmbiguousProcessing).toBe(false);
    expect(doc.kotSyncFailed).toBe(false);
    expect(doc.lastPetpoojaError).toBeNull();
    expect(doc.petpoojaPushClaimedAt).toBeNull();
    expect(doc.petpoojaClaimedAt).toBeNull();
    for (const [key, value] of Object.entries(extra)) {
      expect(doc[key], key).toBe(value);
    }
    // No quarantine may have been added on top of the acceptance.
    expect(doc.petpoojaRetryCount).toBeUndefined();
  }

  it("a late acceptance WITH a POS id survives the unresolved quarantine — no POST, no overwrite", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_f2_race_id", {
      petpoojaStatus: "processing",
      petpoojaPushClaimedAt: Date.now() - 11 * MINUTE_MS,
    });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: "1", orderID: "pp_f2_race_should_not_exist" }),
    });

    const acceptance = {
      petpoojaOrderId: "pp_race_late_id",
      petpoojaAcceptanceGeneration: 7,
    };
    const pushed = await pushWithLateAcceptance("ord_f2_race_id", () =>
      recordLateAcceptance("ord_f2_race_id", acceptance)
    );

    // Nothing was sent: the expired claim still fences the POST.
    expect(pushed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();

    // The winner's recorded acceptance wins; the quarantine must not land.
    expectAcceptanceSurvives("ord_f2_race_id", acceptance);
    expect(savedDocs["orders/ord_f2_race_id"].petpoojaOrderId).toBe("pp_race_late_id");
    expect(savedDocs["orders/ord_f2_race_id"].petpoojaAcceptedNoId).toBeUndefined();
  });

  it("a late ACCEPTED-NO-ID acknowledgement survives the unresolved quarantine — no POST, no overwrite", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_f2_race_no_id", {
      petpoojaStatus: "pending_retry",
      petpoojaSyncStatus: "pending_retry",
      petpoojaPushClaimedAt: Date.now() - 11 * MINUTE_MS,
    });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: "1", orderID: "" }),
    });

    const acceptance = {
      petpoojaAcceptedNoId: true,
      petpoojaAcceptanceGeneration: 3,
    };
    const pushed = await pushWithLateAcceptance("ord_f2_race_no_id", () =>
      recordLateAcceptance("ord_f2_race_no_id", acceptance)
    );

    expect(pushed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();

    // An id-less acceptance is still PROVEN acceptance: never relabelled, and
    // never given a fabricated id or a printed claim.
    expectAcceptanceSurvives("ord_f2_race_no_id", acceptance);
    expect(savedDocs["orders/ord_f2_race_no_id"].petpoojaAcceptedNoId).toBe(true);
    expect(savedDocs["orders/ord_f2_race_no_id"].petpoojaOrderId).toBeUndefined();
    expect(savedDocs["orders/ord_f2_race_no_id"].kotPrinted).toBeUndefined();
  });

  it("CONTROL: an ACTIVE send claim still yields without writing over a late acceptance", async () => {
    // Same race, but the claim the transaction saw is live, so the caller takes
    // the `busy` path. That path already writes nothing — this pins the
    // behaviour the unresolved path must match.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    const activeClaim = Date.now() - 1 * MINUTE_MS;
    seedOrder("ord_f2_race_busy", {
      petpoojaStatus: "processing",
      petpoojaPushClaimedAt: activeClaim,
    });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: "1", orderID: "pp_f2_race_busy" }),
    });

    const acceptance = { petpoojaOrderId: "pp_race_late_busy" };
    const pushed = await pushWithLateAcceptance("ord_f2_race_busy", () =>
      recordLateAcceptance("ord_f2_race_busy", acceptance)
    );

    expect(pushed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expectAcceptanceSurvives("ord_f2_race_busy", acceptance);
    expect(savedDocs["orders/ord_f2_race_busy"].petpoojaOrderId).toBe("pp_race_late_busy");
  });
});

/**
 * Astra Finding 3 (High) — a CANCELLED order must never send a KOT.
 *
 * The retry lane selects `petpoojaStatus == "pending_retry"` and the shared push
 * claim never checks canonical terminal state, so an order that failed BEFORE the
 * request left (an honest pre-send refusal) and is then cancelled by staff is
 * still POSTed at its due tick — the kitchen receives work for a closed order.
 *
 * The distinction the contract must keep:
 *   - HONEST UNSENT terminal rows retire to `not_applicable` (nothing was ever
 *     sent, so nothing needs reconciling) — never `synced` (a false claim) and
 *     never a dead-letter alert (no operator action is owed);
 *   - ACCEPTED / SYNCED / AMBIGUOUS history is never downgraded or declared
 *     never-sent: an unknown prior send claim keeps the F2 quarantine, which
 *     outranks `not_applicable`.
 *
 * Cancellation AFTER the request was written cannot be undone — that is a real
 * provider-side race and out of scope here.
 */
describe("Astra F3 — a terminal order is never sent a KOT", () => {
  const MINUTE_MS = 60_000;

  /** Canonical statuses the order flow actually writes (orderStatus.ts:54–60). */
  const CANCELLED = {
    code: "CANCELLED",
    label: "Cancelled",
    kind: "cancelled",
    terminal: true,
  } as const;
  const DELIVERED = {
    code: "DELIVERED",
    label: "Delivered",
    kind: "completed",
    terminal: true,
  } as const;

  /** Already at `not_applicable`: retired terminal rows stay retired. */
  const RETIRED = {
    petpoojaStatus: "not_applicable",
    petpoojaSyncStatus: "not_applicable",
  } as const;

  it("a direct push of a CANCELLED order refuses without a POST", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_f3_cancelled_string", { status: "cancelled" });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: "1", orderID: "pp_f3_should_not_exist" }),
    });

    expect(await pushOrderToPetpooja("ord_f3_cancelled_string")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    const doc = savedDocs["orders/ord_f3_cancelled_string"];
    expect(doc.petpoojaOrderId).toBeUndefined();
    expect(doc.petpoojaAcceptedNoId).toBeUndefined();
    expect(doc.petpoojaPushClaimedAt).toBeUndefined(); // no claim taken
    expect(doc.kotPrinted).toBeUndefined();
  });

  it("a direct push of a structured CANCELLED order refuses without a POST", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_f3_cancelled_object", { status: CANCELLED });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: "1", orderID: "pp_f3_should_not_exist" }),
    });

    expect(await pushOrderToPetpooja("ord_f3_cancelled_object")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    const doc = savedDocs["orders/ord_f3_cancelled_object"];
    expect(doc.status).toBe(CANCELLED);
    expect(doc.petpoojaPushClaimedAt).toBeUndefined();
    expect(doc.petpoojaOrderId).toBeUndefined();
  });

  it("a direct push of a legacy 'completed' structured status refuses without a POST", async () => {
    // Existing vocabulary: `kind: "completed"` with `terminal: true` is how the
    // delivered/picked-up family is written (orderStatus.ts:59,199–205).
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_f3_delivered_object", { status: DELIVERED });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: "1", orderID: "pp_f3_should_not_exist" }),
    });

    expect(await pushOrderToPetpooja("ord_f3_delivered_object")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    const doc = savedDocs["orders/ord_f3_delivered_object"];
    expect(doc.petpoojaStatus).toBeUndefined();
    expect(doc.petpoojaOrderId).toBeUndefined();
  });

  it("a LIVE non-terminal order still pushes (control)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_f3_live_control", {
      status: { code: "PREPARING", label: "Preparing", kind: "in_progress", terminal: false },
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: "1", orderID: "pp_f3_live" }),
    });

    expect(await pushOrderToPetpooja("ord_f3_live_control")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(savedDocs["orders/ord_f3_live_control"].petpoojaStatus).toBe("synced");
  });

  it("a direct push of a legacy 'completed' status with NO code and NO terminal flag refuses", async () => {
    // Vocabulary guard: `kind: "completed"` alone already means terminal in the
    // dispatch/terminal-kind checks, so a guard that only reads `terminal: true`
    // would miss this row.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_f3_legacy_completed_kind", { status: { kind: "completed" } });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: "1", orderID: "pp_f3_should_not_exist" }),
    });

    expect(await pushOrderToPetpooja("ord_f3_legacy_completed_kind")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    const doc = savedDocs["orders/ord_f3_legacy_completed_kind"];
    expect(doc.petpoojaOrderId).toBeUndefined();
    expect(doc.petpoojaPushClaimedAt).toBeUndefined();
  });

  it("a direct push of a structured DELIVERED status without the terminal flag refuses", async () => {
    // The flag must not be the only signal: this object carries the delivered
    // code and completed kind but omits `terminal`.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_f3_delivered_no_flag", {
      status: { code: "DELIVERED", kind: "completed" },
    });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: "1", orderID: "pp_f3_should_not_exist" }),
    });

    expect(await pushOrderToPetpooja("ord_f3_delivered_no_flag")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    const doc = savedDocs["orders/ord_f3_delivered_no_flag"];
    expect(doc.petpoojaOrderId).toBeUndefined();
    expect(doc.petpoojaPushClaimedAt).toBeUndefined();
  });

  it("a direct push of a canonical 'delivered' STRING status refuses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_f3_delivered_string", { status: "delivered" });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: "1", orderID: "pp_f3_should_not_exist" }),
    });

    expect(await pushOrderToPetpooja("ord_f3_delivered_string")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    const doc = savedDocs["orders/ord_f3_delivered_string"];
    expect(doc.petpoojaStatus).toBeUndefined();
    expect(doc.petpoojaOrderId).toBeUndefined();
  });

  it.each([
    ["READY_TO_SERVE", { code: "READY_TO_SERVE", label: "Ready to serve", kind: "in_progress", terminal: false }],
    ["OUT_FOR_DELIVERY", { code: "OUT_FOR_DELIVERY", label: "Out for delivery", kind: "in_progress", terminal: false }],
    ["READY_FOR_PICKUP", { code: "READY_FOR_PICKUP", label: "Ready for pickup", kind: "in_progress", terminal: false }],
  ])("a direct push of a live %s order still pushes (control)", async (label, status) => {
    // Non-terminal vocabulary must not be swept up by the terminal guard.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    const orderId = `ord_f3_live_${String(label).toLowerCase()}`;
    seedOrder(orderId, { status });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: "1", orderID: `pp_${orderId}` }),
    });

    expect(await pushOrderToPetpooja(orderId)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(savedDocs[`orders/${orderId}`].petpoojaStatus).toBe("synced");
  });

  it("cancellation committed between the pre-read and the claim transaction stops the POST", async () => {
    // The cheap pre-read sees a live order; the cancellation lands before the
    // shared claim reads its fresh snapshot. The FRESH state must decide.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_f3_cancel_race");

    const originalRunTransaction = (mockDb as any).runTransaction;
    (mockDb as any).runTransaction = async (fn: any) => {
      savedDocs["orders/ord_f3_cancel_race"].status = CANCELLED;
      return originalRunTransaction(fn);
    };
    try {
      expect(await pushOrderToPetpooja("ord_f3_cancel_race")).toBe(false);
    } finally {
      (mockDb as any).runTransaction = originalRunTransaction;
    }

    expect(fetchMock).not.toHaveBeenCalled();
    const doc = savedDocs["orders/ord_f3_cancel_race"];
    expect(doc.status).toBe(CANCELLED);
    expect(doc.petpoojaOrderId).toBeUndefined();
    expect(doc.petpoojaPushClaimedAt).toBeUndefined();
  });

  it("an order cancelled after an honest pre-send refusal is retired, never POSTed at its due tick", async () => {
    // The exact Astra §3 schedule: genuine pre-send failure → pending_retry →
    // staff cancel → the due worker would POST the cancelled order.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_f3_cancel_after_refusal");

    const refused = new TypeError("fetch failed");
    (refused as any).cause = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    fetchMock.mockRejectedValueOnce(refused);

    expect(await pushOrderToPetpooja("ord_f3_cancel_after_refusal")).toBe(false);
    const queued = savedDocs["orders/ord_f3_cancel_after_refusal"];
    // Honest pre-send failure: nothing left the process, so this IS retryable.
    expect(queued.petpoojaStatus).toBe("pending_retry");
    expect(queued.petpoojaRetryCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Staff cancel the order before the due tick.
    queued.status = CANCELLED;
    vi.setSystemTime(queued.petpoojaNextRetryAtMs);

    const tick = await retryPendingPetpoojaOrdersWorker();

    // No second POST, and the row leaves the retry lane.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tick.retriedCount).toBe(0);
    const retired = savedDocs["orders/ord_f3_cancel_after_refusal"];
    expect(retired.petpoojaStatus).toBe("not_applicable");
    expect(retired.petpoojaSyncStatus).toBe("not_applicable");
    // Retirement is not a failure: no false 'synced', no new kotSyncFailed,
    // no budget burn, no leftover lease or schedule.
    expect(retired.petpoojaStatus).not.toBe("synced");
    expect(retired.kotSyncFailed).not.toBe(true);
    expect(retired.petpoojaRetryCount).toBe(1);
    expect(retired.petpoojaNextRetryAtMs ?? null).toBeNull();
    expect(retired.petpoojaPushClaimedAt ?? null).toBeNull();
    expect(retired.petpoojaClaimedAt ?? null).toBeNull();
    expect(retired.petpoojaOrderId).toBeUndefined();
    expect(retired.petpoojaAcceptedNoId).toBeUndefined();
    expect(retired.kotPrinted).toBeUndefined();
    // No operator action is owed for an unsent KOT.
    expect(vi.mocked(dispatchFCM)).not.toHaveBeenCalled();

    // Still retired on later ticks: nothing to reclaim.
    vi.setSystemTime(Date.now() + 60 * MINUTE_MS);
    await retryPendingPetpoojaOrdersWorker();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(savedDocs["orders/ord_f3_cancel_after_refusal"].petpoojaStatus).toBe(
      "not_applicable"
    );
  });

  it("an exhausted-budget terminal row is retired without POST, alert, or dead-letter", async () => {
    // A due row whose retries are spent would normally dead-letter and page the
    // branch. A closed order owes no manual KOT entry, so it must retire quietly.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_f3_exhausted_cancelled", {
      status: CANCELLED,
      petpoojaStatus: "pending_retry",
      petpoojaSyncStatus: "pending_retry",
      petpoojaRetryCount: 99,
      petpoojaNextRetryAtMs: Date.now() - 1,
    });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: "1", orderID: "pp_f3_exhausted" }),
    });

    const tick = await retryPendingPetpoojaOrdersWorker();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(tick.retriedCount).toBe(0);
    const doc = savedDocs["orders/ord_f3_exhausted_cancelled"];
    expect(doc.petpoojaStatus).toBe("not_applicable");
    expect(doc.petpoojaStatus).not.toBe("failed");
    expect(doc.kotSyncFailed).not.toBe(true);
    expect(doc.petpoojaRetryCount).toBe(99);
    // No dead-letter alert and no error snapshot for a closed order.
    expect(vi.mocked(dispatchFCM)).not.toHaveBeenCalled();
    const snapshots = Object.keys(savedDocs).filter((p) =>
      p.startsWith("dev_error_snapshots/")
    );
    expect(snapshots).toHaveLength(0);
  });

  it("a terminal row that is NOT due yet is retired without a POST", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_f3_future_cancelled", {
      status: CANCELLED,
      petpoojaStatus: "pending_retry",
      petpoojaRetryCount: 1,
      petpoojaNextRetryAtMs: Date.now() + 30 * MINUTE_MS,
    });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: "1", orderID: "pp_f3_future" }),
    });

    await retryPendingPetpoojaOrdersWorker();

    expect(fetchMock).not.toHaveBeenCalled();
    const doc = savedDocs["orders/ord_f3_future_cancelled"];
    expect(doc.petpoojaStatus).toBe("not_applicable");
    expect(doc.kotSyncFailed).not.toBe(true);
  });

  it("an accepted order with a POS id keeps its acceptance (never retired as unsent)", async () => {
    // Accepted history outranks the terminal guard: the KOT IS at the kitchen,
    // so the row must not be relabelled `not_applicable`.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_f3_accepted_cancelled", {
      status: CANCELLED,
      petpoojaStatus: "synced",
      petpoojaSyncStatus: "synced",
      petpoojaOrderId: "pp_f3_already_at_pos",
    });

    expect(await pushOrderToPetpooja("ord_f3_accepted_cancelled")).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    const doc = savedDocs["orders/ord_f3_accepted_cancelled"];
    expect(doc.petpoojaStatus).toBe("synced");
    expect(doc.petpoojaOrderId).toBe("pp_f3_already_at_pos");
    expect(doc.kotPrinted).toBeUndefined(); // no invented printing
  });

  it("an accepted-no-id order keeps its acceptance (never retired as unsent)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_f3_no_id_cancelled", {
      status: CANCELLED,
      petpoojaStatus: "accepted_unconfirmed",
      petpoojaSyncStatus: "accepted_unconfirmed",
      petpoojaAcceptedNoId: true,
    });

    expect(await pushOrderToPetpooja("ord_f3_no_id_cancelled")).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    const doc = savedDocs["orders/ord_f3_no_id_cancelled"];
    expect(doc.petpoojaStatus).toBe("accepted_unconfirmed");
    expect(doc.petpoojaAcceptedNoId).toBe(true);
    expect(doc.petpoojaStatus).not.toBe("not_applicable");
  });

  it("an unknown prior send claim on a terminal row keeps the F2 quarantine, not 'not_applicable'", async () => {
    // A dead send lease means the POS MAY hold this KOT. Declaring it
    // `not_applicable` would assert nothing was ever sent — an unsupported claim.
    // F2 quarantine outranks retirement.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_f3_ambiguous_cancelled", {
      status: CANCELLED,
      petpoojaStatus: "pending_retry",
      petpoojaSyncStatus: "pending_retry",
      petpoojaRetryCount: 1,
      petpoojaNextRetryAtMs: Date.now() - 1,
      petpoojaPushClaimedAt: Date.now() - 11 * MINUTE_MS,
    });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: "1", orderID: "pp_f3_ambiguous" }),
    });

    await retryPendingPetpoojaOrdersWorker();

    expect(fetchMock).not.toHaveBeenCalled();
    const doc = savedDocs["orders/ord_f3_ambiguous_cancelled"];
    expect(doc.petpoojaStatus).toBe("reconciliation_required");
    expect(doc.petpoojaAmbiguousProcessing).toBe(true);
    expect(doc.petpoojaStatus).not.toBe("not_applicable");
  });

  it("scheduler retires an honest unsent terminal row with no prior send claim", async () => {
    // Control for the two cases below: no send claim means nothing may exist at
    // the POS, so `not_applicable` retirement is truthful.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_f3_retire_clean", {
      status: CANCELLED,
      petpoojaStatus: "pending_retry",
      petpoojaSyncStatus: "pending_retry",
      petpoojaRetryCount: 1,
      petpoojaNextRetryAtMs: Date.now() + 30 * MINUTE_MS,
    });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: "1", orderID: "pp_f3_retire_clean" }),
    });

    await retryPendingPetpoojaOrdersWorker();

    expect(fetchMock).not.toHaveBeenCalled();
    const doc = savedDocs["orders/ord_f3_retire_clean"];
    expect(doc.petpoojaStatus).toBe("not_applicable");
    expect(doc.petpoojaSyncStatus).toBe("not_applicable");
    expect(doc.kotSyncFailed).not.toBe(true);
    expect(doc.petpoojaRetryCount).toBe(1);
    expect(doc.petpoojaNextRetryAtMs ?? null).toBeNull();
    expect(vi.mocked(dispatchFCM)).not.toHaveBeenCalled();
  });

  it("a terminal EXHAUSTED row with an expired send claim is quarantined, never retired or dead-lettered", async () => {
    // The scan's dead-letter guard checks acceptance history but not the send
    // claim, so it retires `not_applicable` and clears the F2 evidence — while
    // the POS may already hold the KOT. The F2 quarantine must win, and no
    // "enter manually" alert may be sent.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_f3_exhausted_dead_send", {
      status: CANCELLED,
      petpoojaStatus: "pending_retry",
      petpoojaSyncStatus: "pending_retry",
      petpoojaRetryCount: 99,
      petpoojaNextRetryAtMs: Date.now() - 1,
      petpoojaPushClaimedAt: Date.now() - 11 * MINUTE_MS,
    });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: "1", orderID: "pp_f3_exhausted_dead_send" }),
    });

    const tick = await retryPendingPetpoojaOrdersWorker();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(tick.failedCount).toBe(0);
    const doc = savedDocs["orders/ord_f3_exhausted_dead_send"];
    // Quarantine, not retirement and not a dead-letter failure.
    expect(doc.petpoojaStatus).toBe("reconciliation_required");
    expect(doc.petpoojaAmbiguousProcessing).toBe(true);
    expect(doc.petpoojaStatus).not.toBe("not_applicable");
    expect(doc.petpoojaStatus).not.toBe("failed");
    // F2 evidence preserved, budget untouched.
    expect(doc.petpoojaRetryCount).toBe(99);
    // No manual-entry alert and no error snapshot.
    expect(vi.mocked(dispatchFCM)).not.toHaveBeenCalled();
    const snapshots = Object.keys(savedDocs).filter((p) =>
      p.startsWith("dev_error_snapshots/")
    );
    expect(snapshots).toHaveLength(0);
  });

  it("an EXHAUSTED non-terminal row with a stale send claim never becomes a manual-entry failure", async () => {
    // Same defect without the terminal status: a possibly-accepted order is
    // flipped `failed` and the branch is told to type the KOT in by hand.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_f3_exhausted_live_send", {
      petpoojaStatus: "pending_retry",
      petpoojaSyncStatus: "pending_retry",
      petpoojaRetryCount: 99,
      petpoojaNextRetryAtMs: Date.now() - 1,
      petpoojaPushClaimedAt: Date.now() - 11 * MINUTE_MS,
    });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: "1", orderID: "pp_f3_exhausted_live_send" }),
    });

    const tick = await retryPendingPetpoojaOrdersWorker();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(tick.failedCount).toBe(0);
    const doc = savedDocs["orders/ord_f3_exhausted_live_send"];
    expect(doc.petpoojaStatus).not.toBe("failed");
    expect(doc.petpoojaStatus).toBe("reconciliation_required");
    expect(doc.petpoojaAmbiguousProcessing).toBe(true);
    // The F2 QUARANTINE carries kotSyncFailed:true — that is its existing
    // contract and it is how an operator sees the row. It is NOT the
    // dead-letter flag: this is a park for human verification, never the
    // "dead-lettered / enter the KOT by hand" state asserted above by
    // `petpoojaStatus: "failed"` + zero failedCount + zero manual alerts.
    expect(doc.kotSyncFailed).toBe(true);
    expect(doc.petpoojaRetryCount).toBe(99);
    // Claims released so an operator (not a worker) owns the next move.
    expect(doc.petpoojaPushClaimedAt ?? null).toBeNull();
    expect(doc.petpoojaClaimedAt ?? null).toBeNull();
    expect(vi.mocked(dispatchFCM)).not.toHaveBeenCalled();
    const snapshots = Object.keys(savedDocs).filter((p) =>
      p.startsWith("dev_error_snapshots/")
    );
    expect(snapshots).toHaveLength(0);
  });

  it("a non-terminal EXHAUSTED row with a live send claim is left alone — no mutation, no alert", async () => {
    // A live lease means a sender may be in flight right now. Flipping the row
    // `failed` (and paging the branch) would contradict an acceptance that can
    // still land.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_f3_exhausted_active_send", {
      petpoojaStatus: "pending_retry",
      petpoojaSyncStatus: "pending_retry",
      petpoojaRetryCount: 99,
      petpoojaNextRetryAtMs: Date.now() - 1,
      petpoojaPushClaimedAt: Date.now() - 2 * MINUTE_MS,
    });
    const before = { ...savedDocs["orders/ord_f3_exhausted_active_send"] };
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: "1", orderID: "pp_f3_exhausted_active_send" }),
    });

    const tick = await retryPendingPetpoojaOrdersWorker();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(tick.failedCount).toBe(0);
    expect(savedDocs["orders/ord_f3_exhausted_active_send"]).toEqual(before);
    expect(vi.mocked(dispatchFCM)).not.toHaveBeenCalled();
    const snapshots = Object.keys(savedDocs).filter((p) =>
      p.startsWith("dev_error_snapshots/")
    );
    expect(snapshots).toHaveLength(0);
  });

  it("a no-transaction datastore never writes a plain 'failed' over an exhausted terminal row with a prior send claim", async () => {
    // Without an atomic recheck the fallback path must not mutate at all: a
    // plain write could overwrite a concurrent acceptance and its F2 evidence.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    seedOrder("ord_f3_notx_exhausted", {
      status: CANCELLED,
      petpoojaStatus: "pending_retry",
      petpoojaSyncStatus: "pending_retry",
      petpoojaRetryCount: 99,
      petpoojaNextRetryAtMs: Date.now() - 1,
      petpoojaPushClaimedAt: Date.now() - 11 * MINUTE_MS,
    });
    const before = { ...savedDocs["orders/ord_f3_notx_exhausted"] };
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: "1", orderID: "pp_f3_notx_exhausted" }),
    });

    const originalRunTransaction = (mockDb as any).runTransaction;
    delete (mockDb as any).runTransaction;
    try {
      await retryPendingPetpoojaOrdersWorker();
    } finally {
      (mockDb as any).runTransaction = originalRunTransaction;
    }

    expect(fetchMock).not.toHaveBeenCalled();
    expect(savedDocs["orders/ord_f3_notx_exhausted"]).toEqual(before);
    const doc = savedDocs["orders/ord_f3_notx_exhausted"];
    expect(doc.petpoojaStatus).toBe("pending_retry");
    expect(doc.petpoojaStatus).not.toBe("failed");
    expect(doc.petpoojaStatus).not.toBe("not_applicable");
    expect(vi.mocked(dispatchFCM)).not.toHaveBeenCalled();
    const snapshots = Object.keys(savedDocs).filter((p) =>
      p.startsWith("dev_error_snapshots/")
    );
    expect(snapshots).toHaveLength(0);
  });
});
