import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as crypto from "crypto";

/**
 * R21 — payment confirmation concurrency evidence (authoritative
 * `payment.captured` webhook path).
 *
 * Same repair as the sibling verify suite: the previous revision installed a
 * *passthrough* `runTransaction` (callback run once with `get`/`set` delegates).
 * It tested single-threaded branch selection, not the atomic confirmation guard.
 *
 * This revision uses a self-contained in-memory document store with:
 *   1. a COMMIT QUEUE that applies commits strictly one at a time, and
 *   2. OPTIMISTIC CONCURRENCY: a transaction that read a document which a
 *      competing writer advanced before its commit is ABORTED and its callback
 *      RE-INVOKED against the CHANGED snapshot (the retry the guard must survive).
 *
 * `control.injectCompetingCommit(fn)` forces that conflict deterministically.
 *
 * HONESTY LIMIT: in-process model only. It proves retry-safety against an
 * in-memory conflict, not real Firebase cross-process transaction semantics.
 */
const { mockDb, docs, writeLog, commitStats, control } = vi.hoisted(() => {
  process.env.OTP_HMAC_SECRET = "test_otp_r21_webhook";

  type Rec = { data: any; version: number };
  const docs = new Map<string, Rec>();
  /** R29: EVERY store write in arrival order (path + merged payload). Doc
   *  keys alone cannot count two writes that collide on one id — the audit id
   *  is `aud_${Date.now()}_${paymentId}`, so two confirmations inside one
   *  millisecond overwrite the same key. Counting write events closes that
   *  window independently of the id scheme. */
  const writeLog: Array<{ path: string; data: any; merge?: boolean }> = [];
  const commitStats = { commits: 0, retries: 0, contentions: 0 };
  const MAX_RETRIES = 8;
  let pendingCompetingWrite: (() => void) | null = null;

  const versionOf = (path: string): number => {
    const rec = docs.get(path);
    return rec ? rec.version : -1;
  };
  const dataOf = (path: string): any => {
    const rec = docs.get(path);
    return rec ? rec.data : undefined;
  };
  const applyWrite = (path: string, data: any, merge?: boolean) => {
    const existing = docs.get(path);
    const next = merge && existing ? { ...existing.data, ...data } : { ...data };
    docs.set(path, { data: next, version: (existing?.version ?? 0) + 1 });
    writeLog.push({ path, data: next, merge: !!merge });
  };

  let commitTail: Promise<unknown> = Promise.resolve();
  const enqueueCommit = <T>(task: () => T): Promise<T> => {
    const run = commitTail.then(task, task);
    commitTail = run.then(() => undefined, () => undefined);
    return run;
  };

  const runTransaction = (fn: (tx: any) => any): Promise<any> => {
    const attempt = async (): Promise<any> => {
      for (let tries = 0; tries <= MAX_RETRIES; tries++) {
        const readVersions = new Map<string, number>();
        const writes: Array<{ path: string; data: any; merge?: boolean }> = [];
        const tx = {
          get: async (ref: any) => {
            readVersions.set(ref.path, versionOf(ref.path));
            const data = dataOf(ref.path);
            return { exists: data !== undefined, data: () => data, ref };
          },
          set: (ref: any, data: any, opts?: any) =>
            void writes.push({ path: ref.path, data, merge: !!opts?.merge }),
          update: (ref: any, data: any) => void writes.push({ path: ref.path, data, merge: true }),
        };

        const result = await fn(tx);
        const conflicted = (): boolean =>
          [...readVersions.entries()].some(([path, v]) => versionOf(path) !== v);

        if (writes.length === 0) {
          if (conflicted()) {
            commitStats.retries += 1;
            continue;
          }
          return result;
        }

        const outcome = await enqueueCommit(() => {
          if (pendingCompetingWrite) {
            const hook = pendingCompetingWrite;
            pendingCompetingWrite = null;
            hook();
          }
          if (conflicted()) {
            commitStats.contentions += 1;
            return { conflicted: true as const };
          }
          for (const w of writes) applyWrite(w.path, w.data, w.merge);
          commitStats.commits += 1;
          return { conflicted: false as const, result };
        });
        if (!outcome.conflicted) return outcome.result;
        commitStats.retries += 1;
      }
      const err: any = new Error("SIMULATED_TRANSACTION_CONTENTION: retries exhausted");
      err.code = "ABORTED";
      throw err;
    };
    return attempt();
  };

  const docRef = (colName: string, docId: string) => {
    const path = `${colName}/${docId}`;
    return {
      id: docId,
      path,
      get: async () => {
        const data = dataOf(path);
        return { exists: data !== undefined, data: () => data, ref: docRef(colName, docId) };
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
  };

  const getByPath = (obj: any, path: string) =>
    path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

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
      doc: (docId?: string) =>
        docRef(colName, docId || `auto_${Math.random().toString(36).slice(2, 8)}`),
    };
    return q;
  };

  const mockDb: any = { collection: collectionMock, runTransaction };

  return {
    mockDb,
    docs,
    writeLog,
    commitStats,
    control: {
      seed: (path: string, data: any, merge = false) => applyWrite(path, data, merge),
      injectCompetingCommit: (fn: () => void) => {
        pendingCompetingWrite = fn;
      },
      reset: () => {
        docs.clear();
        writeLog.length = 0;
        commitStats.commits = 0;
        commitStats.retries = 0;
        commitStats.contentions = 0;
        pendingCompetingWrite = null;
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
import { verifyPayment } from "../src/modules/payments/razorpay.service";
import { config } from "../src/config/env";

const confirmAudits = () =>
  [...docs.keys()].filter(
    (k) => k.startsWith("payment_audits/aud_") && !k.startsWith("payment_audits/aud_evt_")
  );
/**
 * R29 — count of confirmation-audit WRITES (events), not distinct doc ids.
 * `finishVerifiedPayment` keys its audit `aud_${Date.now()}_${paymentId…}`
 * (razorpay.service.ts:1406), so two confirmations of one payment inside the
 * same millisecond share ONE document id and a key-based count reports 1 even
 * when 2 confirmations ran. This count is immune to that collision; the
 * webhook's own `aud_evt_*` docs are delivery claims, not confirmations, and
 * stay excluded.
 */
const confirmAuditWrites = () =>
  writeLog.filter(
    (e) => e.path.startsWith("payment_audits/aud_") && !e.path.startsWith("payment_audits/aud_evt_")
  );
const keysWithPrefix = (prefix: string) => [...docs.keys()].filter((k) => k.startsWith(prefix));

/**
 * R29 — deterministic audit-id clock (see the sibling verify suite).
 * Monotonic and seeded from the REAL wall clock before the spy is installed,
 * so production time windows (webhook freshness, 10-min idempotency claim
 * TTL, 10-min transfer claim lease) keep reading realistic deltas while every
 * confirmation audit id stays unique. `freezeClock(ms)` pins later `Date.now()`
 * calls when a test wants a fully predictable id.
 */
let nowSpy: { mockRestore: () => void } | null = null;
let nowNext = 0;
let nowFrozen: number | null = null;
const nowIssued = new Set<number>();
const installClock = () => {
  nowSpy?.mockRestore();
  nowNext = Date.now(); // real time, read BEFORE the spy is in place
  nowFrozen = null;
  nowIssued.clear();
  nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
    const value = nowFrozen === null ? (nowNext += 1) : nowFrozen;
    nowIssued.add(value);
    return value;
  });
};
const uninstallClock = () => {
  nowSpy?.mockRestore();
  nowSpy = null;
};

function mockReqRes(payload: any, signature?: string) {
  const req: any = { headers: signature ? { "x-razorpay-signature": signature } : {}, body: payload };
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

const capturedPayload = (
  eventId: string,
  orderId = "order_race_1",
  paymentId = "pay_race_123",
  amount = 25000
) => ({
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

describe("payment confirmation concurrency (webhook path)", () => {
  let prevPg: boolean;
  let prevPp: boolean;
  beforeEach(() => {
    installClock();
    control.reset();
    prevPg = config.mock.paymentGateway;
    prevPp = config.mock.petpoojaPos;
    config.mock.paymentGateway = true;
    config.mock.petpoojaPos = true;
  });
  afterEach(() => {
    uninstallClock();
    config.mock.paymentGateway = prevPg;
    config.mock.petpoojaPos = prevPp;
  });

  it("isolated later-state guard: pending + PREPARING is not regressed and runs no downstream work", async () => {
    control.seed("orders/order_race_1", {
      id: "order_race_1",
      branchId: "branch_surat_01",
      pricing: { grandTotal: 250, split: { branchTransferPaise: 9000 } },
      // paymentStatus NOT completed → the later-state branch is the deciding factor.
      paymentStatus: "pending",
      status: { code: "PREPARING", label: "Preparing", kind: "in_progress", terminal: false },
    });

    const call = mockReqRes(capturedPayload("evt_race_prep_1"));
    await handleRazorpayWebhook(call.req, call.res);

    expect(call.out().statusCode).toBe(200);
    const order = docs.get("orders/order_race_1")!.data;
    expect(order.status).toMatchObject({ code: "PREPARING" });
    expect(order.paymentStatus).toBe("pending");
    // No split, no coin debit, no KOT for a suppressed late capture.
    expect(order.routeTransferStatus).toBeUndefined();
    expect(order.petpoojaOrderId).toBeUndefined();
    expect(keysWithPrefix("coin_transactions/")).toHaveLength(0);
    expect(docs.get("unmatched_payments/ump_evt_race_prep_1")!.data).toMatchObject({
      reason: "suppressed_later_state",
      status: "needs_review",
    });
  });

  it("isolated terminal guard: pending + DELIVERED (terminal) is not regressed by a late capture", async () => {
    control.seed("orders/order_race_1", {
      id: "order_race_1",
      branchId: "branch_surat_01",
      pricing: { grandTotal: 250, split: { branchTransferPaise: 9000 } },
      paymentStatus: "pending",
      status: { code: "DELIVERED", label: "Delivered", kind: "completed", terminal: true },
    });

    const call = mockReqRes(capturedPayload("evt_race_del_1"));
    await handleRazorpayWebhook(call.req, call.res);

    expect(call.out().statusCode).toBe(200);
    const order = docs.get("orders/order_race_1")!.data;
    expect(order.status).toMatchObject({ code: "DELIVERED", terminal: true });
    expect(order.paymentStatus).toBe("pending");
    expect(order.routeTransferStatus).toBeUndefined();
    expect(order.petpoojaOrderId).toBeUndefined();
    expect(docs.get("unmatched_payments/ump_evt_race_del_1")!.data).toMatchObject({
      reason: "suppressed_later_state",
    });
  });

  /**
   * R29 — ORDERING regression (R27 third pass, blocker #2), webhook side.
   *
   * The webhook's split is nested under `if (confirmWritten)`
   * (webhookHandler.ts:412-420) and suppression returns `written:false`
   * (:387-390), so a terminal capture must never reach `executeRouteSplit`.
   * The existing terminal test (W2 above) seeds no split state at all; this
   * one keeps the split UNRESOLVED (`pending_retry`, the retry worker's lane)
   * and links the branch to a Razorpay account, so any reordering that runs
   * the split first really claims + POSTs the payout for a CANCELLED/REFUNDED
   * order — and the assertions below fail with an explicit ordering message
   * when it does. Capture is literal here: the event IS `payment.captured`
   * for the full server-priced total.
   */
  it.each([
    ["CANCELLED", "Cancelled"],
    ["REFUNDED", "Refunded"],
  ] as const)(
    "R29 ordering: %s + payment.captured + UNRESOLVED split is parked with NO split execution",
    async (code, label) => {
      const orderId = `order_r29_wh_${code.toLowerCase()}`;
      control.seed(`orders/${orderId}`, {
        id: orderId,
        branchId: "branch_surat_01",
        pricing: {
          grandTotal: 250,
          split: { branchTransferPaise: 9000, brandRoyaltyPaise: 1600, totalAmountPaise: 25000 },
        },
        paymentStatus: "pending",
        // UNRESOLVED split: executeRouteSplit has no `transferred` shortcut
        // here and would really claim + POST if it were reached first.
        routeTransferStatus: "pending_retry",
        routeTransferError: "Route transfer failed",
        routeTransferRetryCount: 0,
        status: { code, label, kind: code === "CANCELLED" ? "cancelled" : "completed", terminal: true },
      });
      // Linked payout account → a split-first ordering transfers for real
      // (`transferred` + `trf_mock_*`) instead of merely flagging the order.
      control.seed("branches/branch_surat_01", { razorpayAccountId: "acc_surat_1" });

      const eventId = `evt_r29_${code.toLowerCase()}`;
      // Amount matches the priced total on purpose: an amount mismatch would
      // park earlier (confirm_amount_mismatch) and never exercise the
      // terminal/suppression ordering this test exists to pin.
      const call = mockReqRes(capturedPayload(eventId, orderId, "pay_r29_wh", 25000));
      await handleRazorpayWebhook(call.req, call.res);

      expect(call.out().statusCode).toBe(200);

      const ORDERING_DEFECT =
        `R29 ORDERING DEFECT: executeRouteSplit ran (or was reached) for a ${code} order whose ` +
        `split is unresolved — the terminal/later-state suppression must return written:false ` +
        `BEFORE any split work (webhookHandler.ts:387-390 precedes the confirmWritten-gated ` +
        `split at :412-420). No split execution is acceptable on this path.`;

      const order = docs.get(`orders/${orderId}`)!.data;
      expect(order.routeTransferStatus, ORDERING_DEFECT).toBe("pending_retry");
      expect(order.routeTransferClaimedAt, ORDERING_DEFECT).toBeUndefined();
      expect(order["payment.routeTransfer"], ORDERING_DEFECT).toBeUndefined();
      expect(order.routeTransferError, ORDERING_DEFECT).toBe("Route transfer failed");

      // Terminal state preserved, nothing confirmed, nothing pushed to the POS.
      expect(order.status, ORDERING_DEFECT).toMatchObject({ code, terminal: true });
      expect(order.paymentStatus, ORDERING_DEFECT).toBe("pending");
      expect(order.petpoojaOrderId, ORDERING_DEFECT).toBeUndefined();

      // The capture is parked for ops (this is the "suppressed captures are
      // parked" half of R27 4c) — with the event, payment and order bound.
      const park = docs.get(`unmatched_payments/ump_${eventId}`);
      expect(
        park,
        `R29: the ${code} capture must be parked in unmatched_payments by the suppression branch`
      ).toBeDefined();
      expect(park!.data).toMatchObject({
        reason: "suppressed_later_state",
        status: "needs_review",
        razorpayPaymentId: "pay_r29_wh",
        claimedOrderId: orderId,
      });

      expect(confirmAuditWrites(), ORDERING_DEFECT).toHaveLength(0);
      expect(confirmAudits(), ORDERING_DEFECT).toHaveLength(0);
      expect(keysWithPrefix("coin_transactions/"), ORDERING_DEFECT).toHaveLength(0);
    }
  );

  it("foreign capture preserves recorded payment truth and runs no downstream work", async () => {
    control.seed("orders/order_race_1", {
      id: "order_race_1",
      branchId: "branch_surat_01",
      pricing: { grandTotal: 250, split: { branchTransferPaise: 9000 } },
      paymentStatus: "completed",
      status: { code: "CONFIRMED", label: "Order confirmed", kind: "upcoming", terminal: false },
      payment: { status: "completed", razorpayPaymentId: "pay_other_original" },
    });

    const call = mockReqRes(capturedPayload("evt_race_foreign_1"));
    await handleRazorpayWebhook(call.req, call.res);

    expect(call.out().statusCode).toBe(200);
    const order = docs.get("orders/order_race_1")!.data;
    expect(order.payment.razorpayPaymentId).toBe("pay_other_original");
    expect(order["payment.razorpayPaymentId"] ?? order.payment.razorpayPaymentId).not.toBe(
      "pay_race_123"
    );
    expect(order.routeTransferStatus).toBeUndefined();
    expect(order.petpoojaOrderId).toBeUndefined();
    expect(keysWithPrefix("coin_transactions/")).toHaveLength(0);
    expect(docs.get("unmatched_payments/ump_evt_race_foreign_1")!.data).toMatchObject({
      reason: "suppressed_foreign_capture",
      recordedPaymentId: "pay_other_original",
    });
  });

  it("parks a captured amount that does not match the priced total (amount binding, no downstream)", async () => {
    control.seed("orders/order_race_1", {
      id: "order_race_1",
      branchId: "branch_surat_01",
      pricing: { grandTotal: 100, split: { branchTransferPaise: 9000 } },
      paymentStatus: "pending",
    });

    const call = mockReqRes(capturedPayload("evt_race_amt_1", "order_race_1", "pay_race_123", 25000));
    await handleRazorpayWebhook(call.req, call.res);

    expect(call.out().statusCode).toBe(200);
    const order = docs.get("orders/order_race_1")!.data;
    expect(order.paymentStatus).toBe("pending");
    expect(order.status).toBeUndefined();
    expect(order.routeTransferStatus).toBeUndefined();
    expect(order.petpoojaOrderId).toBeUndefined();
    expect(docs.get("unmatched_payments/ump_evt_race_amt_1")!.data).toMatchObject({
      reason: "confirm_amount_mismatch",
      expectedAmount: 100,
    });
  });

  it("normal captured delivery still confirms and runs the downstream split + KOT", async () => {
    control.seed("orders/order_race_1", {
      id: "order_race_1",
      branchId: "branch_surat_01",
      pricing: { grandTotal: 250, split: { branchTransferPaise: 9000, brandRoyaltyPaise: 1600, totalAmountPaise: 25000 } },
      paymentStatus: "pending",
    });
    control.seed("branches/branch_surat_01", { razorpayAccountId: "acc_surat_1" });

    const call = mockReqRes(capturedPayload("evt_race_ok_1"));
    await handleRazorpayWebhook(call.req, call.res);

    expect(call.out().statusCode).toBe(200);
    const order = docs.get("orders/order_race_1")!.data;
    expect(order.paymentStatus).toBe("completed");
    expect(order.status).toMatchObject({ code: "CONFIRMED" });
    expect(order.routeTransferStatus).toBe("transferred");
    expect(order["payment.routeTransfer"].id).toMatch(/^trf_mock_/);
    expect(order.petpoojaOrderId).toMatch(/^pp_kot_/);
  });

  it("serializes concurrent captured deliveries: one transfer, one KOT, no re-POST on repeat", async () => {
    control.seed("orders/order_race_1", {
      id: "order_race_1",
      branchId: "branch_surat_01",
      pricing: { grandTotal: 250, split: { branchTransferPaise: 9000, brandRoyaltyPaise: 1600, totalAmountPaise: 25000 } },
      paymentStatus: "pending",
    });
    control.seed("branches/branch_surat_01", { razorpayAccountId: "acc_surat_1" });

    const first = mockReqRes(capturedPayload("evt_race_cc_1"));
    const second = mockReqRes(capturedPayload("evt_race_cc_2"));
    const [a, b] = await Promise.all([
      handleRazorpayWebhook(first.req, first.res),
      handleRazorpayWebhook(second.req, second.res),
    ]);
    void a;
    void b;

    expect(first.out().statusCode).toBe(200);
    expect(second.out().statusCode).toBe(200);
    const order = docs.get("orders/order_race_1")!.data;
    expect(order.paymentStatus).toBe("completed");
    expect(order.status).toMatchObject({ code: "CONFIRMED" });
    expect(order.routeTransferStatus).toBe("transferred");
    const kotId = order.petpoojaOrderId;
    expect(kotId).toMatch(/^pp_kot_/);

    // Swap the stored receipt for a sentinel: a further delivery that re-POSTed
    // the non-idempotent transfer would overwrite it.
    control.seed("orders/order_race_1", { "payment.routeTransfer": { id: "trf_sentinel_no_repost" } }, true);
    const third = mockReqRes(capturedPayload("evt_race_cc_3"));
    await handleRazorpayWebhook(third.req, third.res);
    expect(third.out().statusCode).toBe(200);
    const after = docs.get("orders/order_race_1")!.data;
    expect(after["payment.routeTransfer"].id).toBe("trf_sentinel_no_repost");
    expect(after.petpoojaOrderId).toBe(kotId);
  });

  it("serializes concurrent webhook + verify on one order: one confirm audit, stable healed hash", async () => {
    control.seed("orders/order_race_1", {
      id: "order_race_1",
      branchId: "branch_surat_01",
      pricing: { grandTotal: 250, split: { branchTransferPaise: 9000 } },
      paymentStatus: "pending",
      // Isolate the confirmation guard: skip the split claim and the KOT push.
      routeTransferStatus: "transferred",
      petpoojaOrderId: "pp_existing_kot",
    });

    const call = mockReqRes(capturedPayload("evt_race_x_1"));
    const [, verified]: any[] = await Promise.all([
      handleRazorpayWebhook(call.req, call.res),
      verifyPayment({
        orderId: "order_race_1",
        razorpayOrderId: "order_rzp_1",
        razorpayPaymentId: "pay_race_123",
        razorpaySignature: "mock_signature_valid",
      }),
    ]);

    expect(call.out().statusCode).toBe(200);
    expect(verified.success).toBe(true);
    const order = docs.get("orders/order_race_1")!.data;
    expect(order.paymentStatus).toBe("completed");
    expect(order.status).toMatchObject({ code: "CONFIRMED" });
    // The browser channel's OTP hash is present (verify generated or healed it).
    const hash = order.deliveryOtpHash;
    expect(hash).toBeDefined();

    // R29 — EXACT audit accounting (replaces the loose `<= 1`, which also
    // accepted 0 and could be masked by a same-millisecond id collision):
    //  * `payment.verifiedAt` is written ONLY by finishVerifiedPayment's
    //    confirm branch; the webhook writes no such field (its own audit
    //    family is `aud_evt_*`, a delivery claim rather than a confirmation
    //    record). So the count is pinned in BOTH directions — exactly 1 iff
    //    verify itself confirmed this order, exactly 0 iff the webhook won
    //    the race — and 2 is unreachable on the collision-free clock.
    const verifyConfirmed = order["payment.verifiedAt"] !== undefined;
    const expectedAudits = verifyConfirmed ? 1 : 0;
    expect(
      confirmAuditWrites(),
      verifyConfirmed
        ? "R29: verify confirmed this order, so exactly ONE confirmation audit write must exist — a second would mean both channels ran the confirm"
        : "R29: the webhook won the race, so verify must have written NO confirmation audit — one would mean the idempotent guard let a second confirmation through"
    ).toHaveLength(expectedAudits);
    expect(
      confirmAudits(),
      "R29: audit document count must equal the audit write count (no same-millisecond id-collision window)"
    ).toHaveLength(expectedAudits);
    if (verifyConfirmed) {
      // Exact expected id: `aud_<deterministic clock value>_<paymentId…>`
      // (`pay_race_123` -> `pay_race_1`), stamped by this test's clock.
      const auditKey = confirmAudits()[0];
      const auditParts = /^payment_audits\/aud_(\d+)_pay_race_1$/.exec(auditKey);
      expect(auditParts, `unexpected confirmation audit id: ${auditKey}`).not.toBeNull();
      expect(
        nowIssued.has(Number(auditParts![1])),
        "audit id must be stamped by the deterministic clock — a wall-clock id reopens the same-millisecond collision window"
      ).toBe(true);
    }
    const auditsAfterRace = confirmAudits().length;
    const auditWritesAfterRace = confirmAuditWrites().length;
    expect(keysWithPrefix("coin_transactions/")).toHaveLength(0);

    // A follow-up verify neither regenerates the hash nor adds a confirm audit.
    const again: any = await verifyPayment({
      orderId: "order_race_1",
      razorpayOrderId: "order_rzp_1",
      razorpayPaymentId: "pay_race_123",
      razorpaySignature: "mock_signature_valid",
    });
    expect(again.deliveryOtp).toBeUndefined();
    expect(docs.get("orders/order_race_1")!.data.deliveryOtpHash).toBe(hash);
    expect(confirmAudits()).toHaveLength(auditsAfterRace);
    expect(confirmAuditWrites()).toHaveLength(auditWritesAfterRace);
  });

  // ── B6 / C12: the delivery-OTP invariant on the AUTHORITATIVE webhook path ──
  // Before the fix, the webhook wrote CONFIRMED with no `deliveryOtpHash` at
  // all, so an app-closed payer's delivery order could never be handed over —
  // verifyDeliveryOtp throws "No delivery OTP found" — for exactly the payers
  // this channel exists to serve. These pin the shared invariant:
  // eligible + absent => mint inside the confirm transaction; an existing hash
  // is never overwritten (idempotent replays); non-delivery orders get none;
  // and this channel never persists the plaintext, which it cannot deliver.

  const seedDeliveryOrder = (orderId: string, extra: Record<string, any> = {}) =>
    control.seed(`orders/${orderId}`, {
      id: orderId,
      branchId: "branch_surat_01",
      orderType: "delivery",
      pricing: { grandTotal: 250, split: { branchTransferPaise: 9000 } },
      paymentStatus: "pending",
      // Isolate the confirmation guard: skip the split claim and the KOT push.
      routeTransferStatus: "transferred",
      petpoojaOrderId: "pp_existing_kot",
      ...extra,
    });

  it("B6: a webhook-only confirm mints the delivery OTP hash in the same confirm, never the plaintext", async () => {
    seedDeliveryOrder("order_otp_1");
    const call = mockReqRes(capturedPayload("evt_otp_1", "order_otp_1", "pay_otp_1"));
    await handleRazorpayWebhook(call.req, call.res);

    expect(call.out().statusCode).toBe(200);
    const order = docs.get("orders/order_otp_1")!.data;
    expect(order.paymentStatus).toBe("completed");
    expect(order.status).toMatchObject({ code: "CONFIRMED" });
    expect(typeof order.deliveryOtpHash).toBe("string");
    expect(order.deliveryOtpHash.length).toBeGreaterThan(0);
    // The plaintext must never be persisted: only the client-verify channel is
    // a defined delivery of the code, and this channel cannot show it.
    expect(order.deliveryOtp).toBeUndefined();
  });

  it("B6: a redelivery of the same capture never overwrites the minted hash", async () => {
    seedDeliveryOrder("order_otp_2");
    const first = mockReqRes(capturedPayload("evt_otp_2a", "order_otp_2", "pay_otp_2"));
    await handleRazorpayWebhook(first.req, first.res);
    const minted = docs.get("orders/order_otp_2")!.data.deliveryOtpHash;
    expect(typeof minted).toBe("string");

    // Same logical capture under a DIFFERENT transport event id
    // (payment.captured and order.paid are distinct ids for one payment):
    // the hash must be identical afterwards — no re-mint, no rotation.
    const second = mockReqRes(capturedPayload("evt_otp_2b", "order_otp_2", "pay_otp_2"));
    await handleRazorpayWebhook(second.req, second.res);
    expect(docs.get("orders/order_otp_2")!.data.deliveryOtpHash).toBe(minted);
  });

  it("B6: non-delivery order types receive no OTP hash", async () => {
    seedDeliveryOrder("order_otp_3", { orderType: "takeaway" });
    const call = mockReqRes(capturedPayload("evt_otp_3", "order_otp_3", "pay_otp_3"));
    await handleRazorpayWebhook(call.req, call.res);

    const order = docs.get("orders/order_otp_3")!.data;
    expect(order.paymentStatus).toBe("completed");
    expect(order.deliveryOtpHash).toBeUndefined();
  });

  it("B6: a pre-existing hash (client-verify confirmed first) is preserved byte-identical", async () => {
    seedDeliveryOrder("order_otp_4", { deliveryOtpHash: "pre_existing_hash_value" });
    const call = mockReqRes(capturedPayload("evt_otp_4", "order_otp_4", "pay_otp_4"));
    await handleRazorpayWebhook(call.req, call.res);

    expect(docs.get("orders/order_otp_4")!.data.deliveryOtpHash).toBe("pre_existing_hash_value");
  });

  it("deterministic contention: a competing confirm between read and commit forces a retry against the changed snapshot", async () => {
    control.seed("orders/order_race_1", {
      id: "order_race_1",
      branchId: "branch_surat_01",
      pricing: { grandTotal: 250, split: { branchTransferPaise: 9000 } },
      paymentStatus: "pending",
      routeTransferStatus: "transferred",
      petpoojaOrderId: "pp_existing_kot",
    });

    // Competing writer confirms + advances the order between our read and commit.
    control.injectCompetingCommit(() =>
      control.seed(
        "orders/order_race_1",
        {
          paymentStatus: "completed",
          "payment.status": "completed",
          "payment.razorpayPaymentId": "pay_race_123",
          status: { code: "CONFIRMED", label: "Order confirmed", kind: "upcoming", terminal: false },
        },
        true
      )
    );

    const call = mockReqRes(capturedPayload("evt_race_det_1"));
    await handleRazorpayWebhook(call.req, call.res);

    // The injection fired: exactly one contention and one retry (abort → re-read).
    expect(commitStats.contentions).toBe(1);
    expect(commitStats.retries).toBe(1);
    expect(call.out().statusCode).toBe(200);
    // The retry observed a later/competing CONFIRMED and did not re-run the
    // suppressed downstream split / KOT work.
    const order = docs.get("orders/order_race_1")!.data;
    expect(order.petpoojaOrderId).toBe("pp_existing_kot");
    expect(order.routeTransferStatus).toBe("transferred");
  });

  it("fails closed on a forged signature with no order write (local HMAC, no provider call)", async () => {
    const prevSecret = config.razorpay.webhookSecret;
    const prevGate = config.mock.paymentGateway;
    try {
      config.mock.paymentGateway = false;
      (config.razorpay as any).webhookSecret = "whsec_r21_local_secret";
      control.seed("orders/order_race_1", {
        id: "order_race_1",
        branchId: "branch_surat_01",
        pricing: { grandTotal: 250, split: { branchTransferPaise: 9000 } },
        paymentStatus: "pending",
      });

      const payload = capturedPayload("evt_race_sig_1");
      const goodSig = crypto
        .createHmac("sha256", "whsec_r21_local_secret")
        .update(JSON.stringify(payload))
        .digest("hex");
      const forged = mockReqRes(payload, goodSig.split("").reverse().join(""));
      await handleRazorpayWebhook(forged.req, forged.res);

      expect(forged.out().statusCode).toBe(401);
      const order = docs.get("orders/order_race_1")!.data;
      expect(order.paymentStatus).toBe("pending");
      expect(order.status).toBeUndefined();
    } finally {
      config.mock.paymentGateway = prevGate;
      (config.razorpay as any).webhookSecret = prevSecret;
    }
  });
});
