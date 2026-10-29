import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Razorpay webhook idempotency-claim regression (granted by the payments owner
 * ses_eb65a55d8ffem6HSQtGO4RMN2B on integration-expanded-team-20261020-ownership,
 * 2026-10-20T00:19:42Z, paths 1 of 2 only).
 *
 * Pins the MONEY-SAFETY properties of `acquireClaim` (webhookHandler.ts:93-133):
 *  - a completed claim replays as a no-op;
 *  - a fresh claim applies exactly once (positive control);
 *  - a STALE claim is taken over for crash recovery but can never resurrect a
 *    terminal order or double-settle it;
 *  - two concurrent takeovers of the SAME stale claim cannot double-settle
 *    (the D1 TOCTOU window: stale takeover is read-then-set, not CAS; damage
 *    must be contained by the downstream split/KOT/coin claims).
 *
 * Reading note (documented, not a silent reinterpretation): the owner asked
 * that a stale claim be "rejected or ignored". The production code deliberately
 * TAKES OVER stale claims (>10 min) so a crashed delivery can still confirm a
 * payer's money, and the safe property is therefore "takeover must not
 * duplicate or resurrect", which is what these assertions pin.
 *
 * HONESTY LIMIT: in-process document store with optimistic-concurrency
 * transactions. It models transaction retry, not Firebase cross-process
 * semantics. Offline only: no network, no provider SDK call, no secret.
 */
const { mockDb, docs, writeLog, control } = vi.hoisted(() => {
  process.env.OTP_HMAC_SECRET = "test_otp_razorpay_stale_claim";

  type Rec = { data: any; version: number };
  const docs = new Map<string, Rec>();
  /** DELTA writes in arrival order (not merged snapshots) so a later merge
   *  can never re-count an earlier field it merely preserved. */
  const writeLog: Array<{ path: string; data: any; merge?: boolean }> = [];

  const versionOf = (path: string): number => docs.get(path)?.version ?? -1;
  const dataOf = (path: string): any => docs.get(path)?.data;

  const applyWrite = (path: string, data: any, merge?: boolean, log = true) => {
    const existing = docs.get(path);
    const next = merge && existing ? { ...existing.data, ...data } : { ...data };
    docs.set(path, { data: next, version: (existing?.version ?? 0) + 1 });
    if (log) writeLog.push({ path, data, merge: !!merge });
  };

  let commitTail: Promise<unknown> = Promise.resolve();
  const enqueueCommit = <T,>(task: () => T): Promise<T> => {
    const run = commitTail.then(task, task);
    commitTail = run.then(() => undefined, () => undefined);
    return run;
  };

  // Deterministic double-read barrier for the D1 test: the first `expected`
  // audit-claim reads all observe the SAME stale snapshot before either caller
  // re-stamps the lease, which is the real TOCTOU interleaving.
  const barrier: { armed: boolean; expected: number; arrivals: number; release: null | (() => void) } = {
    armed: false,
    expected: 2,
    arrivals: 0,
    release: null,
  };
  const passBarrier = async (path: string) => {
    if (!barrier.armed || !path.startsWith("payment_audits/aud_evt_")) return;
    barrier.arrivals += 1;
    if (barrier.arrivals >= barrier.expected) {
      barrier.release?.();
      return;
    }
    await new Promise<void>((resolve) => {
      barrier.release = resolve;
    });
  };

  const runTransaction = (fn: (tx: any) => any): Promise<any> => {
    const attempt = async (): Promise<any> => {
      for (let tries = 0; tries <= 8; tries++) {
        const readVersions = new Map<string, number>();
        const writes: Array<{ path: string; data: any; merge?: boolean }> = [];
        const tx = {
          get: async (ref: any) => {
            readVersions.set(ref.path, versionOf(ref.path));
            const data = dataOf(ref.path);
            return { exists: data !== undefined, data: () => data, ref };
          },
          set: (ref: any, data: any, opts?: any) => void writes.push({ path: ref.path, data, merge: !!opts?.merge }),
          update: (ref: any, data: any) => void writes.push({ path: ref.path, data, merge: true }),
        };
        const result = await fn(tx);
        const conflicted = () => [...readVersions.entries()].some(([path, v]) => versionOf(path) !== v);
        if (writes.length === 0) {
          if (conflicted()) continue;
          return result;
        }
        const outcome = await enqueueCommit(() => {
          if (conflicted()) return { conflicted: true as const };
          for (const w of writes) applyWrite(w.path, w.data, w.merge);
          return { conflicted: false as const, result };
        });
        if (!outcome.conflicted) return outcome.result;
      }
      const err: any = new Error("SIMULATED_TRANSACTION_CONTENTION: retries exhausted");
      err.code = "ABORTED";
      throw err;
    };
    return attempt();
  };

  const docRef = (colName: string, docId: string) => {
    const path = `${colName}/${docId}`;
    const ref: any = {
      id: docId,
      path,
      get: async () => {
        await passBarrier(path);
        const data = dataOf(path);
        return { exists: data !== undefined, data: () => data, ref };
      },
      set: async (data: any, opts?: any) => applyWrite(path, data, !!opts?.merge),
      create: async (data: any) => {
        if (docs.has(path)) {
          const err: any = new Error("ALREADY_EXISTS: Document already exists");
          err.code = 6;
          throw err;
        }
        applyWrite(path, data, false);
      },
      update: async (data: any) => applyWrite(path, data, true),
    };
    return ref;
  };

  const getByPath = (obj: any, path: string) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

  const collectionMock = (colName: string) => {
    const filters: Array<{ field: string; value: any }> = [];
    const q: any = {
      where: (field: string, _op: string, value: any) => {
        filters.push({ field, value });
        return q;
      },
      limit: () => q,
      get: async () => {
        const found = [...docs.entries()]
          .filter(([path]) => path.startsWith(`${colName}/`))
          .filter(([, rec]) => filters.every((f) => getByPath(rec.data, f.field) === f.value))
          .map(([path, rec]) => {
            const [col, id] = path.split("/");
            return { id, ref: docRef(col, id), data: () => rec.data };
          });
        return { empty: found.length === 0, size: found.length, docs: found };
      },
      doc: (docId?: string) => docRef(colName, docId || `auto_${Math.random().toString(36).slice(2, 8)}`),
    };
    return q;
  };

  const mockDb: any = { collection: collectionMock, runTransaction };

  return {
    mockDb,
    docs,
    writeLog,
    control: {
      seed: (path: string, data: any, merge = false) => applyWrite(path, data, merge, false),
      armBarrier: (expected = 2) => {
        barrier.armed = true;
        barrier.expected = expected;
        barrier.arrivals = 0;
        barrier.release = null;
      },
      disarmBarrier: () => {
        barrier.armed = false;
        barrier.release = null;
      },
      reset: () => {
        docs.clear();
        writeLog.length = 0;
        barrier.armed = false;
        barrier.release = null;
      },
    },
  };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_SERVER_TIMESTAMP",
    increment: (n: number) => n,
    arrayUnion: (item: any) => [item],
    delete: () => "MOCK_DELETE",
  };
  const firestoreFn: any = vi.fn(() => mockDb);
  firestoreFn.FieldValue = FieldValue;
  return {
    default: {
      firestore: firestoreFn,
      auth: vi.fn(() => ({})),
      messaging: vi.fn(() => ({})),
      initializeApp: vi.fn(),
      apps: [{ name: "mock" }],
    },
    firestore: firestoreFn,
    auth: vi.fn(() => ({})),
    messaging: vi.fn(() => ({})),
    initializeApp: vi.fn(),
    apps: [{ name: "mock" }],
  };
});

import { handleRazorpayWebhook } from "../src/modules/payments/webhookHandler";
import { config } from "../src/config/env";

const transferWrites = () =>
  writeLog.filter((e) => e.path.startsWith("orders/") && e.data?.routeTransferStatus === "transferred");
const kotWrites = () =>
  writeLog.filter(
    (e) =>
      e.path.startsWith("orders/") &&
      typeof e.data?.petpoojaOrderId === "string" &&
      e.data.petpoojaOrderId.startsWith("pp_kot_")
  );
const orderWrites = () => writeLog.filter((e) => e.path.startsWith("orders/"));
const claimDocKeys = () => [...docs.keys()].filter((k) => k.startsWith("payment_audits/aud_evt_"));

function mockReqRes(payload: any) {
  const req: any = { headers: {}, body: payload };
  let statusCode = 0;
  let body: any = null;
  const res: any = {
    status: (code: number) => {
      statusCode = code;
      return { json: (obj: any) => void (body = obj) };
    },
  };
  return { req, res, out: () => ({ statusCode, body }) };
}

const capturedPayload = (eventId: string, orderId: string, paymentId: string, amount = 25000) => ({
  id: eventId,
  event: "payment.captured",
  payload: {
    payment: {
      entity: {
        id: paymentId,
        amount,
        currency: "INR",
        notes: { orderId, branchId: "branch_surat_01" },
      },
    },
  },
});

const pendingOrder = (id: string, paymentId: string) => ({
  id,
  branchId: "branch_surat_01",
  pricing: { grandTotal: 250, split: { branchTransferPaise: 9000, brandRoyaltyPaise: 1600 } },
  paymentStatus: "pending",
  payment: { razorpayPaymentId: paymentId },
});

const staleClaim = (eventId: string, event = "payment.captured") => ({
  eventId,
  event,
  claimedAt: Date.now() - 11 * 60 * 1000,
  completedAt: null,
});

describe("Razorpay webhook idempotency claim (granted regression)", () => {
  let prevPg: boolean;
  let prevPp: boolean;
  beforeEach(() => {
    control.reset();
    prevPg = config.mock.paymentGateway;
    prevPp = config.mock.petpoojaPos;
    config.mock.paymentGateway = true;
    config.mock.petpoojaPos = true;
  });
  afterEach(() => {
    control.disarmBarrier();
    config.mock.paymentGateway = prevPg;
    config.mock.petpoojaPos = prevPp;
  });

  it("positive control: a FRESH claim applies exactly once (one settlement, one KOT)", async () => {
    control.seed("orders/order_fresh_1", pendingOrder("order_fresh_1", "pay_fresh_1"));
    control.seed("branches/branch_surat_01", { razorpayAccountId: "acc_surat_1" });

    const call = mockReqRes(capturedPayload("evt_fresh_1", "order_fresh_1", "pay_fresh_1"));
    await handleRazorpayWebhook(call.req, call.res);

    expect(call.out().statusCode).toBe(200);
    const order = docs.get("orders/order_fresh_1")!.data;
    expect(order.status).toMatchObject({ code: "CONFIRMED" });
    expect(order.paymentStatus).toBe("completed");
    expect(order["payment.status"]).toBe("completed");
    expect(order.routeTransferStatus).toBe("transferred");
    expect(order["payment.routeTransfer"].id).toMatch(/^trf_mock_/);
    expect(order.petpoojaOrderId).toMatch(/^pp_kot_/);
    // Exactly one settlement write and one KOT marker write.
    expect(transferWrites()).toHaveLength(1);
    expect(kotWrites()).toHaveLength(1);
    expect(claimDocKeys()).toHaveLength(1);
  });

  it("replayed delivery for a COMPLETED claim is a no-op (idempotent, 200 already_processed)", async () => {
    control.seed("orders/order_replay_1", pendingOrder("order_replay_1", "pay_replay_1"));
    control.seed(
      "payment_audits/aud_evt_evt_replay_1",
      { eventId: "evt_replay_1", event: "payment.captured", claimedAt: Date.now() - 5000, completedAt: Date.now() - 4000 },
      false
    );

    const call = mockReqRes(capturedPayload("evt_replay_1", "order_replay_1", "pay_replay_1"));
    await handleRazorpayWebhook(call.req, call.res);

    expect(call.out().statusCode).toBe(200);
    expect(call.out().body).toMatchObject({ status: "already_processed" });
    // Nothing downstream may run for a completed claim.
    expect(orderWrites()).toHaveLength(0);
    expect(transferWrites()).toHaveLength(0);
    expect(kotWrites()).toHaveLength(0);
    expect(docs.get("orders/order_replay_1")!.data.paymentStatus).toBe("pending");
  });

  it("STALE claim takeover never resurrects or double-settles a TERMINAL order", async () => {
    control.seed("orders/order_term_1", {
      id: "order_term_1",
      branchId: "branch_surat_01",
      pricing: { grandTotal: 250, split: { branchTransferPaise: 9000 } },
      paymentStatus: "completed",
      payment: { razorpayPaymentId: "pay_term_1" },
      routeTransferStatus: "transferred",
      "payment.routeTransfer": { id: "trf_sentinel_terminal", status: "processed" },
      petpoojaOrderId: "pp_existing_kot_term",
      status: { code: "DELIVERED", label: "Delivered", kind: "completed", terminal: true },
    });
    control.seed("payment_audits/aud_evt_evt_term_1", staleClaim("evt_term_1"), false);

    const call = mockReqRes(capturedPayload("evt_term_1", "order_term_1", "pay_term_1"));
    await handleRazorpayWebhook(call.req, call.res);

    expect(call.out().statusCode).toBe(200);
    const order = docs.get("orders/order_term_1")!.data;
    // Terminal state and money truth preserved.
    expect(order.status).toMatchObject({ code: "DELIVERED", terminal: true });
    expect(order.paymentStatus).toBe("completed");
    expect(order.routeTransferStatus).toBe("transferred");
    expect(order["payment.routeTransfer"].id).toBe("trf_sentinel_terminal");
    expect(order.petpoojaOrderId).toBe("pp_existing_kot_term");
    // No second settlement, no second KOT.
    expect(transferWrites()).toHaveLength(0);
    expect(kotWrites()).toHaveLength(0);
    // The suppressed capture is parked for ops, not silently dropped.
    const park = docs.get("unmatched_payments/ump_evt_term_1")!.data;
    expect(park).toMatchObject({ reason: "suppressed_later_state", status: "needs_review" });
  });

  it("D1: two CONCURRENT takeovers of the SAME stale claim cannot double-settle", async () => {
    control.seed("orders/order_race_stale_1", pendingOrder("order_race_stale_1", "pay_race_stale_1"));
    control.seed("branches/branch_surat_01", { razorpayAccountId: "acc_surat_1" });
    control.seed("payment_audits/aud_evt_evt_race_stale_1", staleClaim("evt_race_stale_1"), false);

    // Both claim reads observe the stale lease before either re-stamps it.
    control.armBarrier(2);

    const first = mockReqRes(capturedPayload("evt_race_stale_1", "order_race_stale_1", "pay_race_stale_1"));
    const second = mockReqRes(capturedPayload("evt_race_stale_1", "order_race_stale_1", "pay_race_stale_1"));
    await Promise.all([
      handleRazorpayWebhook(first.req, first.res),
      handleRazorpayWebhook(second.req, second.res),
    ]);
    control.disarmBarrier();

    const order = docs.get("orders/order_race_stale_1")!.data;
    expect(order.status).toMatchObject({ code: "CONFIRMED" });
    expect(order.paymentStatus).toBe("completed");
    // MONEY-SAFETY: exactly one settlement and one KOT for one captured payment.
    expect(transferWrites()).toHaveLength(1);
    expect(kotWrites()).toHaveLength(1);
    expect(order.routeTransferStatus).toBe("transferred");
    expect(order["payment.routeTransfer"].id).toMatch(/^trf_mock_/);
    // Still exactly ONE claim document for the event id.
    expect(claimDocKeys()).toHaveLength(1);
    // PROOF the D1 window really opened: both concurrent callers observed the
    // stale lease and re-stamped it (read-then-set, no CAS), i.e. both took
    // over — and the money-safety assertions above still hold.
    const takeovers = writeLog.filter(
      (e) =>
        e.path === "payment_audits/aud_evt_evt_race_stale_1" &&
        e.merge === true &&
        typeof e.data?.claimedAt === "number"
    );
    expect(takeovers.length).toBeGreaterThanOrEqual(2);
    // Each delivery must end in a determinate acknowledgement, never a silent drop.
    expect([first.out().statusCode, second.out().statusCode].every((c) => c === 200 || c === 500)).toBe(true);
  });

  it("stale claim on an already-CONFIRMED order: re-entry keeps the single settlement receipt", async () => {
    control.seed("orders/order_conf_1", {
      id: "order_conf_1",
      branchId: "branch_surat_01",
      pricing: { grandTotal: 250, split: { branchTransferPaise: 9000 } },
      paymentStatus: "completed",
      payment: { razorpayPaymentId: "pay_conf_1" },
      routeTransferStatus: "transferred",
      "payment.routeTransfer": { id: "trf_sentinel_confirmed", status: "processed" },
      petpoojaOrderId: "pp_existing_kot_conf",
      status: { code: "CONFIRMED", label: "Order confirmed", kind: "upcoming", terminal: false },
    });
    control.seed("payment_audits/aud_evt_evt_conf_1", staleClaim("evt_conf_1"), false);

    const call = mockReqRes(capturedPayload("evt_conf_1", "order_conf_1", "pay_conf_1"));
    await handleRazorpayWebhook(call.req, call.res);

    expect(call.out().statusCode).toBe(200);
    const order = docs.get("orders/order_conf_1")!.data;
    // D2 containment: CONFIRMED is not in WH_CONFIRMED_LATER, so the confirm
    // re-write may run — but the settlement receipt and KOT marker must not.
    expect(order.status).toMatchObject({ code: "CONFIRMED" });
    expect(order.paymentStatus).toBe("completed");
    expect(order["payment.routeTransfer"].id).toBe("trf_sentinel_confirmed");
    expect(order.petpoojaOrderId).toBe("pp_existing_kot_conf");
    expect(transferWrites()).toHaveLength(0);
    expect(kotWrites()).toHaveLength(0);
  });
});
