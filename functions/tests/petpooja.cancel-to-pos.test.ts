import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";

/**
 * POS CANCELLATION â€” Petpooja "Update Order Status" (status "-1").
 *
 * The defect (audit 2026-11-20, pos-crm.md "Update Order Status (cancel only)"):
 * the vendor API was sandbox-proven but NOTHING in the app called it, so a
 * cancelled order stayed live in the kitchen queue and the kitchen cooked food
 * nobody would collect.
 *
 * Pinned here, against the REAL module (only Firestore, the network and the
 * branch alert are faked):
 *   - an order that was never pushed is NEVER cancelled at the POS, and the
 *     refusal is recorded (`not_pushed`) rather than left ambiguous;
 *   - a pushed order is cancelled exactly once, with the request body proven in
 *     the sandbox on 2026-11-20 (restID / orderID / clientorderID /
 *     cancelReason / status "-1");
 *   - a replay of the same cancellation sends nothing (terminal outcome);
 *   - a cancel that arrives while a KOT push owns the lease is DEFERRED, not
 *     raced â€” the worker sends it once the push has settled;
 *   - a vendor failure retries on the shared 5/10/20/40-minute curve, and a
 *     not-yet-due row is not re-sent;
 *   - the retry budget is the KOT budget: exhaustion dead-letters with
 *     `kotCancelFailed` and a branch alert (never a silent drop);
 *   - an unlinked outlet blocks configuration, alerts, and does not retry;
 *   - `PETPOOJA_ENABLED=false` sends nothing and keeps the intent queued.
 */

const h = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const state = { enabled: true };
  const fcm: Array<Record<string, any>> = [];
  const snapshots: Array<Record<string, any>> = [];

  // Built INSIDE vi.hoisted: the firebase-admin factory below is hoisted to the
  // top of the file, so it cannot close over a later top-level const.
  const makeRef = (path: string, id: string): any => ({
    id,
    __path: path,
    get: vi.fn(async () => ({
      id,
      exists: savedDocs[path] !== undefined,
      data: () => savedDocs[path],
      ref: makeRef(path, id),
    })),
    set: vi.fn(async (data: any, opts?: any) => {
      savedDocs[path] = opts?.merge ? { ...(savedDocs[path] || {}), ...data } : { ...data };
    }),
    update: vi.fn(async (data: any) => {
      if (savedDocs[path] === undefined) throw new Error(`No document to update: ${path}`);
      savedDocs[path] = { ...savedDocs[path], ...data };
    }),
  });

  const mockDb: any = {
    collection: (col: string) => ({
      doc: (id: string) => makeRef(`${col}/${id}`, id),
      where: (field: string, op: string, value: any) => ({
        limit: (n: number) => ({
          get: async () => {
            const docs = Object.keys(savedDocs)
              .filter((k) => k.startsWith(`${col}/`))
              .filter((k) => {
                const actual = savedDocs[k]?.[field];
                if (op === "==") return actual === value;
                if (op === "<=") return Number(actual) <= Number(value);
                return false;
              })
              .slice(0, n)
              .map((k) => {
                const id = k.slice(col.length + 1);
                return { id, exists: true, data: () => savedDocs[k], ref: makeRef(k, id) };
              });
            return { empty: docs.length === 0, docs };
          },
        }),
      }),
    }),
    runTransaction: async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
        update: (ref: any, data: any) => ref.update(data),
      }),
  };

  return { savedDocs, state, fcm, snapshots, mockDb };
});

const { savedDocs, state, fcm, snapshots, mockDb } = h;

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TIMESTAMP",
    increment: (n: number) => n,
    arrayUnion: (i: any) => [i],
    delete: () => "MOCK_DELETE",
  };
  const firestoreFn: any = vi.fn(() => h.mockDb);
  firestoreFn.FieldValue = FieldValue;
  firestoreFn.Timestamp = { fromMillis: (ms: number) => ms };
  return {
    default: { firestore: firestoreFn, auth: vi.fn(() => ({})), messaging: vi.fn(() => ({})), initializeApp: vi.fn(), apps: [{ name: "mock" }] },
    firestore: firestoreFn,
    auth: vi.fn(() => ({})),
    messaging: vi.fn(() => ({})),
    initializeApp: vi.fn(),
    apps: [{ name: "mock" }],
  };
});

vi.mock("../src/modules/petpooja/client", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    isPetpoojaEnabled: () => state.enabled,
  };
});

vi.mock("../src/modules/notifications/fcm.service", () => ({
  dispatchFCM: vi.fn(async (p: any) => {
    fcm.push(p);
    return true;
  }),
}));

vi.mock("../src/core/errors", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    captureErrorSnapshot: vi.fn(async (s: any) => {
      snapshots.push(s);
      return "err_test";
    }),
  };
});

import {
  requestPetpoojaOrderCancel,
  retryPendingPetpoojaOrderCancelsWorker,
  isPosCancelEligible,
  planPetpoojaOrderCancel,
  readPosCancelAck,
  buildPosCancelRequestBody,
  PETPOOJA_CANCEL_CLAIM_TTL_MS,
} from "../src/modules/petpooja/orderCancel";
import { PETPOOJA_MAX_RETRY_ATTEMPTS } from "../src/modules/petpooja/retryBackoff";

const originalFetch = globalThis.fetch;
let fetchCalls: Array<{ url: string; init: any; body: any }> = [];
let fetchHandler: ((url: string, init: any) => Response) | null = null;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const SANDBOX_ACK = {
  success: "1",
  message: "Order status updated successfully.",
  restID: "31z58ciw0h",
  clientOrderID: "ord_pushed",
  orderID: "",
  status: "-1",
};

beforeAll(() => {
  globalThis.fetch = vi.fn(async (url: any, init: any) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    fetchCalls.push({ url: String(url), init, body });
    if (fetchHandler) return fetchHandler(String(url), init);
    return json(SANDBOX_ACK);
  }) as any;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  for (const k of Object.keys(savedDocs)) delete savedDocs[k];
  fetchCalls = [];
  fetchHandler = null;
  fcm.length = 0;
  snapshots.length = 0;
  state.enabled = true;
  savedDocs["branches/b1"] = { id: "b1", petpoojaStoreId: "31z58ciw0h" };
});

function seedOrder(id: string, extra: Record<string, any> = {}) {
  savedDocs[`orders/${id}`] = {
    id,
    branchId: "b1",
    customerId: "cust_1",
    status: { code: "CANCELLED", label: "Cancelled", kind: "cancelled", terminal: true },
    ...extra,
  };
}

const orderOf = (id: string) => savedDocs[`orders/${id}`];

describe("POS cancel â€” eligibility comes from POS facts only", () => {
  it("refuses an order that was never pushed and records not_pushed", async () => {
    seedOrder("ord_never", { petpoojaStatus: "not_applicable" });

    const outcome = await requestPetpoojaOrderCancel({
      orderId: "ord_never",
      requestedBy: "customer:cust_1",
    });

    expect(outcome).toBe("not_pushed");
    expect(fetchCalls).toHaveLength(0);
    expect(orderOf("ord_never").petpoojaCancelStatus).toBe("not_pushed");
    expect(String(orderOf("ord_never").petpoojaCancelSkippedReason)).toMatch(/no recorded POS acceptance/);
  });

  it("refuses a dead-lettered KOT (the POS provably never got the order)", async () => {
    seedOrder("ord_dead", { petpoojaStatus: "failed", kotSyncFailed: true });

    expect(isPosCancelEligible(orderOf("ord_dead"))).toBe(false);
    expect(await requestPetpoojaOrderCancel({ orderId: "ord_dead" })).toBe("not_pushed");
    expect(fetchCalls).toHaveLength(0);
  });

  it("treats an id-less acceptance and a parked ambiguity as POS-eligible", () => {
    expect(isPosCancelEligible({ petpoojaAcceptedNoId: true })).toBe(true);
    expect(isPosCancelEligible({ petpoojaStatus: "accepted_unconfirmed" })).toBe(true);
    expect(isPosCancelEligible({ petpoojaStatus: "reconciliation_required" })).toBe(true);
    expect(isPosCancelEligible({ petpoojaStatus: "pending_retry" })).toBe(false);
  });
});

describe("POS cancel â€” exactly one vendor call, in the proven shape", () => {
  it("cancels a pushed order with the sandbox-proven body", async () => {
    seedOrder("ord_pushed", {
      petpoojaStatus: "accepted_unconfirmed",
      petpoojaAcceptedNoId: true,
    });

    const outcome = await requestPetpoojaOrderCancel({
      orderId: "ord_pushed",
      requestedBy: "customer:cust_1",
      reason: "order_cancelled",
    });

    expect(outcome).toBe("cancelled");
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toMatch(/\/V1\/update_order_status$/);
    expect(fetchCalls[0].init.method).toBe("POST");
    expect(fetchCalls[0].body).toMatchObject({
      restID: "31z58ciw0h",
      orderID: "",
      clientorderID: "ord_pushed",
      status: "-1",
    });
    expect(fetchCalls[0].body.cancelReason).toMatch(/customer cancellation/);
    // The uid never leaves the building.
    expect(JSON.stringify(fetchCalls[0].body)).not.toContain("cust_1");

    expect(orderOf("ord_pushed").petpoojaCancelStatus).toBe("cancelled");
    expect(orderOf("ord_pushed").kotCancelFailed).toBeUndefined();
  });

  it("sends the POS order id when the vendor issued one", async () => {
    seedOrder("ord_with_id", { petpoojaOrderId: "POS-9911" });

    expect(await requestPetpoojaOrderCancel({ orderId: "ord_with_id" })).toBe("cancelled");
    expect(fetchCalls[0].body.orderID).toBe("POS-9911");
    expect(fetchCalls[0].body.clientorderID).toBe("ord_with_id");
  });

  it("is idempotent: a replay of the same cancellation sends nothing", async () => {
    seedOrder("ord_replay", { petpoojaAcceptedNoId: true });

    expect(await requestPetpoojaOrderCancel({ orderId: "ord_replay" })).toBe("cancelled");
    expect(await requestPetpoojaOrderCancel({ orderId: "ord_replay" })).toBe("already_cancelled");

    expect(fetchCalls).toHaveLength(1);
    expect(orderOf("ord_replay").petpoojaCancelStatus).toBe("cancelled");
  });

  it("records a contradictory acknowledgement as a failure, never as success", () => {
    expect(readPosCancelAck({ success: "0", status: "success" }).ok).toBe(false);
    expect(readPosCancelAck({ success: "1", status: "-1" }).ok).toBe(true);
    expect(readPosCancelAck({})).toMatchObject({ ok: false });
    expect(readPosCancelAck("nope")).toMatchObject({ ok: false });
  });

  it("builds exactly the body the sandbox accepted (no extra keys, no PII)", () => {
    const body = buildPosCancelRequestBody({
      orderId: "ord_1",
      posOrderId: "",
      restId: "31z58ciw0h",
      reason: "order_cancelled",
      credentials: { appKey: "k", appSecret: "s", accessToken: "t" },
    });
    expect(body).toEqual({
      app_key: "k",
      app_secret: "s",
      access_token: "t",
      restID: "31z58ciw0h",
      orderID: "",
      clientorderID: "ord_1",
      cancelReason: "Order cancelled — customer cancellation (Burgonomics)",
      status: "-1",
    });
  });
});

describe("POS cancel â€” races and retries", () => {
  it("defers while a KOT push owns the lease, then the worker sends exactly one cancel", async () => {
    seedOrder("ord_inflight", {
      petpoojaStatus: "processing",
      petpoojaPushClaimedAt: Date.now(),
    });

    expect(planPetpoojaOrderCancel(orderOf("ord_inflight")).kind).toBe("defer");
    const outcome = await requestPetpoojaOrderCancel({ orderId: "ord_inflight" });
    expect(outcome).toBe("deferred");
    expect(fetchCalls).toHaveLength(0);
    expect(orderOf("ord_inflight").petpoojaCancelStatus).toBe("pending");

    // The push settles: the POS accepted the ticket.
    orderOf("ord_inflight").petpoojaStatus = "accepted_unconfirmed";
    orderOf("ord_inflight").petpoojaAcceptedNoId = true;
    orderOf("ord_inflight").petpoojaPushClaimedAt = null;

    const tick = await retryPendingPetpoojaOrderCancelsWorker();
    expect(tick.cancelledCount).toBe(1);
    expect(fetchCalls).toHaveLength(1);
    expect(orderOf("ord_inflight").petpoojaCancelStatus).toBe("cancelled");
  });

  it("keeps deferring while the lease is younger than the claim TTL", async () => {
    seedOrder("ord_lease", {
      petpoojaAcceptedNoId: true,
      petpoojaStatus: "processing",
      petpoojaPushClaimedAt: Date.now() - (PETPOOJA_CANCEL_CLAIM_TTL_MS - 5_000),
    });

    expect(await requestPetpoojaOrderCancel({ orderId: "ord_lease" })).toBe("deferred");
    expect(fetchCalls).toHaveLength(0);
  });

  it("schedules a vendor failure on the shared backoff and does not re-send before it is due", async () => {
    seedOrder("ord_fail", { petpoojaAcceptedNoId: true });
    fetchHandler = () => json({ message: "upstream exploded" }, 500);

    expect(await requestPetpoojaOrderCancel({ orderId: "ord_fail" })).toBe("pending_retry");
    expect(fetchCalls).toHaveLength(1);
    expect(orderOf("ord_fail").petpoojaCancelStatus).toBe("pending_retry");
    expect(orderOf("ord_fail").petpoojaCancelAttemptCount).toBe(1);
    const dueIn = Number(orderOf("ord_fail").petpoojaCancelNextRetryAtMs) - Date.now();
    expect(dueIn).toBeGreaterThan(4 * 60 * 1000);
    expect(dueIn).toBeLessThanOrEqual(5 * 60 * 1000);

    // Not due yet: the worker must not burn another attempt.
    const tick = await retryPendingPetpoojaOrderCancelsWorker();
    expect(fetchCalls).toHaveLength(1);
    expect(tick.cancelledCount).toBe(0);
  });

  it("retries a due row once the backoff has elapsed", async () => {
    seedOrder("ord_due", {
      petpoojaAcceptedNoId: true,
      petpoojaCancelStatus: "pending_retry",
      petpoojaCancelAttemptCount: 1,
      petpoojaCancelNextRetryAtMs: Date.now() - 1_000,
    });

    const tick = await retryPendingPetpoojaOrderCancelsWorker();
    expect(tick.cancelledCount).toBe(1);
    expect(fetchCalls).toHaveLength(1);
    expect(orderOf("ord_due").petpoojaCancelStatus).toBe("cancelled");
  });

  it("dead-letters on the KOT retry budget with kotCancelFailed and a branch alert", async () => {
    seedOrder("ord_exhausted", {
      petpoojaAcceptedNoId: true,
      petpoojaCancelStatus: "pending_retry",
      petpoojaCancelAttemptCount: PETPOOJA_MAX_RETRY_ATTEMPTS,
      petpoojaCancelNextRetryAtMs: Date.now() - 1_000,
    });
    fetchHandler = () => json({ message: "still down" }, 503);

    await retryPendingPetpoojaOrderCancelsWorker();

    expect(orderOf("ord_exhausted").petpoojaCancelStatus).toBe("failed");
    expect(orderOf("ord_exhausted").kotCancelFailed).toBe(true);
    expect(orderOf("ord_exhausted").petpoojaCancelAttemptCount).toBe(
      PETPOOJA_MAX_RETRY_ATTEMPTS + 1
    );
    expect(fcm).toHaveLength(1);
    expect(fcm[0].topic).toBe("branch_b1_orders");
    expect(fcm[0].data.type).toBe("kot_cancel_failed");
    expect(snapshots.some((s) => /cancel it at the till/i.test(String(s.message)))).toBe(true);
  });

  it("blocks configuration on an unlinked outlet: no call, no retry, one alert", async () => {
    delete savedDocs["branches/b1"];
    savedDocs["branches/b1"] = { id: "b1" };
    seedOrder("ord_unlinked", { petpoojaAcceptedNoId: true });

    expect(await requestPetpoojaOrderCancel({ orderId: "ord_unlinked" })).toBe(
      "blocked_configuration"
    );
    expect(fetchCalls).toHaveLength(0);
    expect(orderOf("ord_unlinked").petpoojaCancelStatus).toBe("blocked_configuration");
    expect(orderOf("ord_unlinked").petpoojaCancelNextRetryAtMs).toBeNull();
    expect(fcm).toHaveLength(1);
  });
});

describe("POS cancel â€” disabled bridge", () => {
  it("records the intent and sends nothing while PETPOOJA_ENABLED=false, then resumes", async () => {
    seedOrder("ord_disabled", { petpoojaAcceptedNoId: true });
    state.enabled = false;

    expect(await requestPetpoojaOrderCancel({ orderId: "ord_disabled" })).toBe("disabled");
    expect(fetchCalls).toHaveLength(0);
    expect(orderOf("ord_disabled").petpoojaCancelStatus).toBe("pending");

    // The worker is a no-op while disabled: no scan, no claim, no POST.
    const idle = await retryPendingPetpoojaOrderCancelsWorker();
    expect(idle.cancelledCount).toBe(0);
    expect(fetchCalls).toHaveLength(0);

    state.enabled = true;
    const tick = await retryPendingPetpoojaOrderCancelsWorker();
    expect(tick.cancelledCount).toBe(1);
    expect(fetchCalls).toHaveLength(1);
    expect(orderOf("ord_disabled").petpoojaCancelStatus).toBe("cancelled");
  });
});
