import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as crypto from "crypto";

/**
 * C03 — captured-payment binding repair (A08 blockers B7 + B8).
 *
 * B7 (verify path): an order already confirmed by captured payment A must
 * refuse a SECOND, DIFFERENT captured payment B — the old path fell through
 * to `finishVerifiedPayment`, which only checked `alreadyCompleted` and
 * answered `{success:true}` with no discrepancy park, silently absorbing
 * payer B's money into payer A's order. The binding is read FRESH inside the
 * pre-split transaction (never from the earlier order snapshot) and checked
 * BEFORE `executeRouteSplit`, so a refusal can never move money, mint an OTP,
 * write a confirmation audit, debit coins, or push a KOT.
 *
 * B8 (webhook): a legacy order doc with no stored `pricing`/`totals` amount
 * must not be confirmed blind. A sound SERVER intent amount (order binding +
 * ownership binding) may supply the expected total; anything else parks
 * `confirm_amount_unknown` — fail closed, never a guess, never a client
 * amount.
 *
 * Rig: in-memory versioned store with a commit queue + optimistic
 * concurrency (a competing writer aborts and re-runs the callback against
 * the CHANGED snapshot), plus `control.injectAfterOrderRead` — a one-shot
 * hook that fires AFTER verify's source read has snapshotted, which is how
 * the "competing transaction changed the snapshot" test pins the FRESH
 * pre-split read.
 *
 * NO PROVIDER CALLS: the live gateway payment fetch is stubbed through
 * `__setPaymentsFetchForTests`, the SDK client through
 * `__setRazorpayClientForTests`, and the webhook runs on the mock gateway
 * (mock Petpooja too). Every assertion below is exercised against stubs only.
 *
 * HONESTY LIMIT: in-process model — it proves the guards against a simulated
 * competing writer, not real Firebase cross-process transaction semantics.
 */
const { mockDb, docs, writeLog, commitStats, control } = vi.hoisted(() => {
  process.env.OTP_HMAC_SECRET = "test_otp_c03_binding";

  type Rec = { data: any; version: number };
  const docs = new Map<string, Rec>();
  /** Every store write in arrival order (path + merged payload): counting
   *  write EVENTS, not doc ids, cannot be masked by an id collision. */
  const writeLog: Array<{ path: string; data: any; merge?: boolean }> = [];
  const commitStats = { commits: 0, retries: 0, contentions: 0 };
  const MAX_RETRIES = 8;

  let pendingCompetingWrite: (() => void) | null = null;
  /** One-shot: fires AFTER the next `orders/*` read snapshots its data, so
   *  the reader gets the CLEAN doc while every later read sees the
   *  competing confirm — the stale-vs-fresh seam B7 depends on. */
  let pendingAfterOrderRead: (() => void) | null = null;

  const versionOf = (path: string): number => docs.get(path)?.version ?? -1;
  const dataOf = (path: string): any => docs.get(path)?.data;
  const applyWrite = (path: string, data: any, merge?: boolean) => {
    const existing = docs.get(path);
    const next = merge && existing ? { ...existing.data, ...data } : { ...data };
    docs.set(path, { data: next, version: (existing?.version ?? 0) + 1 });
    writeLog.push({ path, data: next, merge: !!merge });
  };

  // Commits run strictly one at a time, in arrival order (commit semantics).
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
        if (colName === "orders" && pendingAfterOrderRead) {
          const hook = pendingAfterOrderRead;
          pendingAfterOrderRead = null;
          hook(); // AFTER the snapshot above: this read stays clean
        }
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

  // Dotted top-level keys ("payment.razorpayPaymentId") win over a nested
  // walk so BOTH canonical shapes of the payment binding resolve.
  const getByPath = (obj: any, path: string) =>
    obj != null && Object.prototype.hasOwnProperty.call(obj, path)
      ? obj[path]
      : path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

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
      injectAfterOrderRead: (fn: () => void) => {
        pendingAfterOrderRead = fn;
      },
      reset: () => {
        docs.clear();
        writeLog.length = 0;
        commitStats.commits = 0;
        commitStats.retries = 0;
        commitStats.contentions = 0;
        pendingCompetingWrite = null;
        pendingAfterOrderRead = null;
      },
    },
  };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TIMESTAMP",
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

import {
  verifyPayment,
  __setPaymentsFetchForTests,
} from "../src/modules/payments/razorpay.service";
import { __setRazorpayClientForTests } from "../src/modules/payments/razorpayClient";
import { handleRazorpayWebhook } from "../src/modules/payments/webhookHandler";
import { config } from "../src/config/env";

/** Confirmation audits are `aud_<ts>_<payid>`; webhook claims are `aud_evt_*`. */
const keysWithPrefix = (prefix: string) => [...docs.keys()].filter((k) => k.startsWith(prefix));
const confirmAudits = () =>
  keysWithPrefix("payment_audits/aud_").filter((k) => !k.startsWith("payment_audits/aud_evt_"));
const discrepancyParks = () => keysWithPrefix("payment_discrepancies/");

const GATEWAY_ORDER = "rzp_c03_order_1";

/** Test-only literal keys (never real credentials): the live HMAC path needs
 *  a non-empty secret that does not read as a mock value. */
const LIVE_KEY_ID = "test_key_id_c03";
const LIVE_SECRET = "test_secret_c03_binding_only";
const liveSig = (gatewayOrderId: string, paymentId: string) =>
  crypto.createHmac("sha256", LIVE_SECRET).update(`${gatewayOrderId}|${paymentId}`).digest("hex");

const verifyParams = (orderId: string, paymentId: string) => ({
  orderId,
  razorpayOrderId: GATEWAY_ORDER,
  razorpayPaymentId: paymentId,
  razorpaySignature: liveSig(GATEWAY_ORDER, paymentId),
});

/** Server-priced, CONFIRMED order carrying the FIRST captured payment. */
const confirmedBy = (paymentId: string, extra: Record<string, any> = {}) => ({
  id: extra.id,
  branchId: "branch_c03",
  orderType: "delivery",
  customerId: "cust_c03",
  pricing: { grandTotal: 100, split: { branchTransferPaise: 9500, brandRoyaltyPaise: 500 } },
  paymentStatus: "completed",
  "payment.status": "completed",
  status: { code: "CONFIRMED", label: "Order confirmed", kind: "upcoming", terminal: false },
  payment: { status: "completed", razorpayPaymentId: paymentId, razorpayOrderId: GATEWAY_ORDER },
  // UNRESOLVED split on purpose: if the binding guard were skipped,
  // executeRouteSplit would really claim + POST the payout for pay_B.
  routeTransferStatus: "pending_retry",
  routeTransferError: "Route transfer failed",
  routeTransferRetryCount: 0,
  ...extra,
  ...(extra.id ? {} : {}),
});

/** Live-fetch stub: a CAPTURED payment bound to the gateway order (no network). */
const capturedFetch = (paymentId: string, amountPaise = 10000) =>
  vi.fn(async (requestedId: string) => ({
    id: paymentId,
    order_id: GATEWAY_ORDER,
    amount: amountPaise,
    currency: "INR",
    status: "captured",
    requestedId,
  }));

describe("C03 B7 — verify refuses a second distinct captured payment", () => {
  let prevMock: boolean;
  let prevKeyId: string;
  let prevKeySecret: string;
  let transferSpy: any;
  let reconcileSpy: any;

  beforeEach(() => {
    control.reset();
    prevMock = config.mock.paymentGateway;
    prevKeyId = config.razorpay.keyId;
    prevKeySecret = config.razorpay.keySecret;
    // LIVE path (not the mock short-circuit): capture proof comes from the
    // stubbed gateway fetch, so the guard is exercised on its production
    // condition — `capturedAmountPaise` actually bound.
    config.mock.paymentGateway = false;
    config.razorpay.keyId = LIVE_KEY_ID;
    config.razorpay.keySecret = LIVE_SECRET;
    __setPaymentsFetchForTests(capturedFetch("pay_unstubbed"));
    // Any split that (wrongly) reached the network would hit THIS stub —
    // asserted below as "no provider call, no new money".
    transferSpy = vi.fn(async () => ({ id: "trf_never_expected", status: "processed" }));
    reconcileSpy = vi.fn(async () => ({ items: [] }));
    __setRazorpayClientForTests({
      payments: { fetchTransfer: reconcileSpy, transfer: transferSpy },
    });
  });

  afterEach(() => {
    __setPaymentsFetchForTests(null);
    __setRazorpayClientForTests(null);
    config.mock.paymentGateway = prevMock;
    config.razorpay.keyId = prevKeyId;
    config.razorpay.keySecret = prevKeySecret;
  });

  it("captured pay_A recorded, captured pay_B verified → 409 + one deterministic park, zero side effects", async () => {
    control.seed("orders/order_c03_a", confirmedBy("pay_A", { id: "order_c03_a" }));
    control.seed("branches/branch_c03", { razorpayAccountId: "acc_c03abc1" });
    __setPaymentsFetchForTests(capturedFetch("pay_B"));

    const err: any = await verifyPayment(verifyParams("order_c03_a", "pay_B")).then(
      () => null,
      (e) => e
    );

    expect(err?.statusCode, "second distinct capture must be a structured 409").toBe(409);
    expect(err?.code).toBe("SECOND_CAPTURE_MISMATCH");

    // Deterministic park: one doc id for (order, incoming payment) — a retry
    // converges on the SAME doc instead of forking duplicates for ops.
    expect(discrepancyParks()).toEqual(["payment_discrepancies/dis_order_c03_a_pay_B"]);
    expect(docs.get(discrepancyParks()[0])!.data).toMatchObject({
      orderId: "order_c03_a",
      razorpayPaymentId: "pay_B",
      reason: "SECOND_CAPTURE_MISMATCH",
      status: "needs_review",
      recordedPaymentId: "pay_A",
      recordedRazorpayOrderId: GATEWAY_ORDER,
      actualPaise: 10000,
    });

    // FIRST captured truth preserved — nothing rebinds the order to pay_B.
    const order = docs.get("orders/order_c03_a")!.data;
    expect(order.payment.razorpayPaymentId).toBe("pay_A");
    expect(order.paymentStatus).toBe("completed");
    expect(order.status).toMatchObject({ code: "CONFIRMED" });

    // NO new money: the UNRESOLVED split was never claimed or POSTed.
    expect(order.routeTransferStatus).toBe("pending_retry");
    expect(order.routeTransferClaimedAt).toBeUndefined();
    expect(order["payment.routeTransfer"]).toBeUndefined();
    expect(transferSpy, "no Route transfer POST for a mismatched capture").not.toHaveBeenCalled();
    expect(reconcileSpy).not.toHaveBeenCalled();

    // NO confirm-side effects: no OTP/hash heal, no audit, no coins, no KOT.
    expect(order.deliveryOtpHash).toBeUndefined();
    expect(confirmAudits()).toHaveLength(0);
    expect(keysWithPrefix("coin_transactions/")).toHaveLength(0);
    expect(order.petpoojaOrderId).toBeUndefined();

    // Retry converges on the identical park (still 409, still ONE doc).
    const retry: any = await verifyPayment(verifyParams("order_c03_a", "pay_B")).then(
      () => null,
      (e) => e
    );
    expect(retry?.code).toBe("SECOND_CAPTURE_MISMATCH");
    expect(discrepancyParks()).toHaveLength(1);
  });

  it("legacy DOTTED payment binding is honoured exactly like the nested object shape", async () => {
    control.seed("orders/order_c03_dotted", {
      id: "order_c03_dotted",
      branchId: "branch_c03",
      orderType: "delivery",
      customerId: "cust_c03",
      pricing: { grandTotal: 100, split: { branchTransferPaise: 9500 } },
      paymentStatus: "completed",
      status: { code: "CONFIRMED", label: "Order confirmed", kind: "upcoming", terminal: false },
      // Legacy shape: NO nested `payment` object — dotted top-level keys only.
      "payment.status": "completed",
      "payment.razorpayPaymentId": "pay_A",
      "payment.razorpayOrderId": GATEWAY_ORDER,
      routeTransferStatus: "pending_retry",
      routeTransferError: "Route transfer failed",
      routeTransferRetryCount: 0,
    });
    __setPaymentsFetchForTests(capturedFetch("pay_B"));

    const err: any = await verifyPayment(verifyParams("order_c03_dotted", "pay_B")).then(
      () => null,
      (e) => e
    );

    expect(err?.statusCode).toBe(409);
    expect(err?.code).toBe("SECOND_CAPTURE_MISMATCH");
    expect(discrepancyParks()).toEqual(["payment_discrepancies/dis_order_c03_dotted_pay_B"]);
    expect(docs.get(discrepancyParks()[0])!.data).toMatchObject({
      recordedPaymentId: "pay_A",
      recordedRazorpayOrderId: GATEWAY_ORDER,
    });
    const order = docs.get("orders/order_c03_dotted")!.data;
    expect(order["payment.razorpayPaymentId"]).toBe("pay_A");
    expect(order.routeTransferStatus).toBe("pending_retry");
    expect(transferSpy).not.toHaveBeenCalled();
    expect(confirmAudits()).toHaveLength(0);
  });

  it("competing transaction changed the snapshot: the FRESH pre-split read catches pay_A, the stale read does not", async () => {
    // Source read will see this CLEAN (pending, no recorded payment)…
    control.seed("orders/order_c03_race", {
      id: "order_c03_race",
      branchId: "branch_c03",
      orderType: "delivery",
      customerId: "cust_c03",
      pricing: { grandTotal: 100, split: { branchTransferPaise: 9500 } },
      paymentStatus: "pending",
      routeTransferStatus: "pending_retry",
      routeTransferError: "Route transfer failed",
      routeTransferRetryCount: 0,
    });
    control.seed("branches/branch_c03", { razorpayAccountId: "acc_c03abc1" });
    // …then a competing confirm (pay_A) commits BEFORE the pre-split
    // transaction reads: only the FRESH read can see it.
    control.injectAfterOrderRead(() =>
      control.seed(
        "orders/order_c03_race",
        {
          paymentStatus: "completed",
          "payment.status": "completed",
          payment: {
            status: "completed",
            razorpayPaymentId: "pay_A",
            razorpayOrderId: GATEWAY_ORDER,
          },
          status: { code: "CONFIRMED", label: "Order confirmed", kind: "upcoming", terminal: false },
        },
        true
      )
    );
    __setPaymentsFetchForTests(capturedFetch("pay_B"));

    const err: any = await verifyPayment(verifyParams("order_c03_race", "pay_B")).then(
      () => null,
      (e) => e
    );

    expect(err?.statusCode, "binding must run on the fresh transaction read").toBe(409);
    expect(err?.code).toBe("SECOND_CAPTURE_MISMATCH");
    expect(discrepancyParks()).toEqual(["payment_discrepancies/dis_order_c03_race_pay_B"]);
    expect(docs.get(discrepancyParks()[0])!.data).toMatchObject({ recordedPaymentId: "pay_A" });

    const order = docs.get("orders/order_c03_race")!.data;
    expect(order.payment.razorpayPaymentId).toBe("pay_A");
    expect(order.routeTransferStatus, "pre-split refusal must precede any split claim").toBe(
      "pending_retry"
    );
    expect(order.routeTransferClaimedAt).toBeUndefined();
    expect(transferSpy).not.toHaveBeenCalled();
    expect(order.deliveryOtpHash).toBeUndefined();
    expect(confirmAudits()).toHaveLength(0);
    expect(keysWithPrefix("coin_transactions/")).toHaveLength(0);
  });

  it("the FIRST captured payment still verifies idempotently (retry/race-loser path preserved)", async () => {
    control.seed(
      "orders/order_c03_same",
      confirmedBy("pay_A", {
        id: "order_c03_same",
        routeTransferStatus: "transferred",
        deliveryOtpHash: "ORIGINAL_HASH",
      })
    );
    __setPaymentsFetchForTests(capturedFetch("pay_A"));

    const res: any = await verifyPayment(verifyParams("order_c03_same", "pay_A"));

    expect(res.success).toBe(true);
    const order = docs.get("orders/order_c03_same")!.data;
    expect(order.payment.razorpayPaymentId).toBe("pay_A");
    expect(order.deliveryOtpHash, "a repeat of the SAME capture never heals/regenerates").toBe(
      "ORIGINAL_HASH"
    );
    expect(confirmAudits(), "no fresh confirmation work on a repeat").toHaveLength(0);
    expect(discrepancyParks()).toHaveLength(0);
    expect(transferSpy).not.toHaveBeenCalled();
  });

  it("a first, unmatched capture still confirms and writes exactly one audit", async () => {
    control.seed("orders/order_c03_first", {
      id: "order_c03_first",
      branchId: "branch_c03",
      orderType: "delivery",
      customerId: "cust_c03",
      pricing: { grandTotal: 100, split: { branchTransferPaise: 9500 } },
      paymentStatus: "pending",
      routeTransferStatus: "transferred",
    });
    __setPaymentsFetchForTests(capturedFetch("pay_A"));

    const res: any = await verifyPayment(verifyParams("order_c03_first", "pay_A"));

    expect(res.success).toBe(true);
    expect(res.deliveryOtp).toMatch(/^\d{4}$/);
    const order = docs.get("orders/order_c03_first")!.data;
    expect(order.paymentStatus).toBe("completed");
    expect(order.status).toMatchObject({ code: "CONFIRMED" });
    expect(order["payment.razorpayPaymentId"]).toBe("pay_A");
    expect(order["payment.capturedAmountPaise"]).toBe(10000);
    expect(order.deliveryOtpHash).toBeDefined();
    expect(confirmAudits(), "exactly one confirmation audit for a first capture").toHaveLength(1);
    expect(discrepancyParks()).toHaveLength(0);
    expect(transferSpy).not.toHaveBeenCalled();
  });

  it("the pre-split TERMINAL guard still wins over the second-capture binding", async () => {
    control.seed("orders/order_c03_cancel", {
      id: "order_c03_cancel",
      branchId: "branch_c03",
      orderType: "delivery",
      customerId: "cust_c03",
      pricing: { grandTotal: 100, split: { branchTransferPaise: 9500 } },
      paymentStatus: "pending",
      status: { code: "CANCELLED", label: "Cancelled", kind: "cancelled", terminal: true },
      payment: { razorpayPaymentId: "pay_A", razorpayOrderId: GATEWAY_ORDER },
      routeTransferStatus: "pending_retry",
      routeTransferError: "Route transfer failed",
      routeTransferRetryCount: 0,
    });
    __setPaymentsFetchForTests(capturedFetch("pay_B"));

    const err: any = await verifyPayment(verifyParams("order_c03_cancel", "pay_B")).then(
      () => null,
      (e) => e
    );

    expect(err?.code, "terminal refusal keeps its own code/ordering").toBe("ORDER_TERMINAL");
    expect(err?.statusCode).toBe(409);
    expect(docs.get("unmatched_payments/ump_term_pay_B")).toBeDefined();
    expect(discrepancyParks(), "the terminal branch parks first, not as a discrepancy").toHaveLength(0);
    const order = docs.get("orders/order_c03_cancel")!.data;
    expect(order.status).toMatchObject({ code: "CANCELLED", terminal: true });
    expect(order.routeTransferStatus).toBe("pending_retry");
    expect(transferSpy).not.toHaveBeenCalled();
    expect(confirmAudits()).toHaveLength(0);
  });
});

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
  orderId: string,
  paymentId: string,
  amountPaise: number,
  gatewayOrderId = GATEWAY_ORDER
) => ({
  id: eventId,
  event: "payment.captured",
  created_at: Math.floor(Date.now() / 1000),
  payload: {
    payment: {
      entity: {
        id: paymentId,
        order_id: gatewayOrderId,
        amount: amountPaise,
        currency: "INR",
        notes: { orderId, branchId: "branch_c03" },
      },
    },
  },
});

describe("C03 B8 — webhook never blind-confirms an unknown stored amount", () => {
  let prevMock: boolean;
  let prevPetpooja: boolean;
  let prevSecret: string | undefined;

  beforeEach(() => {
    control.reset();
    prevMock = config.mock.paymentGateway;
    prevPetpooja = config.mock.petpoojaPos;
    prevSecret = config.razorpay.webhookSecret;
    config.mock.paymentGateway = true; // no gateway egress: signed-check covered below
    config.mock.petpoojaPos = true; // mock KOT push — no POS egress
  });

  afterEach(() => {
    config.mock.paymentGateway = prevMock;
    config.mock.petpoojaPos = prevPetpooja;
    (config.razorpay as any).webhookSecret = prevSecret;
  });

  it("unknown stored amount + no server intent → parks confirm_amount_unknown, writes no confirmation (only the B5 reconciliation marker)", async () => {
    // Legacy doc: NO pricing, NO totals — the exact blind-confirm shape.
    control.seed("orders/order_c03_wh_unk", {
      id: "order_c03_wh_unk",
      branchId: "branch_c03",
      customerId: "cust_c03",
      paymentStatus: "pending",
    });

    const call = mockReqRes(capturedPayload("evt_c03_unk", "order_c03_wh_unk", "pay_c03_unk", 25000));
    await handleRazorpayWebhook(call.req, call.res);

    // Captured money is never retry-stormed…
    expect(call.out().statusCode).toBe(200);
    // …and is never confirmed on a guess.
    const order = docs.get("orders/order_c03_wh_unk")!.data;
    expect(order.paymentStatus).toBe("pending");
    expect(order.status).toBeUndefined();
    expect(order["payment.razorpayPaymentId"]).toBeUndefined();
    expect(order.routeTransferStatus).toBeUndefined();
    expect(order.petpoojaOrderId).toBeUndefined();
    expect(keysWithPrefix("coin_transactions/")).toHaveLength(0);
    expect(confirmAudits()).toHaveLength(0);

    expect(docs.get("unmatched_payments/ump_evt_c03_unk")!.data).toMatchObject({
      reason: "confirm_amount_unknown",
      status: "needs_review",
      razorpayPaymentId: "pay_c03_unk",
      claimedOrderId: "order_c03_wh_unk",
      amount: 250,
      amountSource: "unknown",
    });
    // B5: the ONE thing that does change is the customer-visible marker — the
    // order must not read as merely unpaid when the payer's money moved.
    expect(order.reconciliation).toMatchObject({
      state: "payment_review",
      reason: "confirm_amount_unknown",
      razorpayPaymentId: "pay_c03_unk",
    });
  });

  it("unknown stored amount + SOUND server intent (order + ownership bound) confirms with the intent amount", async () => {
    control.seed("orders/order_c03_wh_int", {
      id: "order_c03_wh_int",
      branchId: "branch_c03",
      customerId: "cust_c03",
      paymentStatus: "pending",
      // no pricing / no totals → amount must come from the intent
    });
    control.seed("payment_intents/rzp_c03_intent", {
      razorpayOrderId: GATEWAY_ORDER,
      orderId: "order_c03_wh_int", // order binding
      customerId: "cust_c03", // ownership binding
      amountPaise: 25000,
      branchId: "branch_c03",
      orderType: "delivery",
    });

    const call = mockReqRes(capturedPayload("evt_c03_int", "order_c03_wh_int", "pay_c03_int", 25000));
    await handleRazorpayWebhook(call.req, call.res);

    expect(call.out().statusCode).toBe(200);
    const order = docs.get("orders/order_c03_wh_int")!.data;
    expect(order.paymentStatus).toBe("completed");
    expect(order.status).toMatchObject({ code: "CONFIRMED" });
    expect(order["payment.razorpayPaymentId"]).toBe("pay_c03_int");
    expect(order["payment.capturedAmountPaise"]).toBe(25000);
    expect(docs.get("unmatched_payments/ump_evt_c03_int")).toBeUndefined();
  });

  it("order.paid resolves the intent through the ORDER entity id (canonical second shape)", async () => {
    control.seed("orders/order_c03_wh_paid", {
      id: "order_c03_wh_paid",
      branchId: "branch_c03",
      customerId: "cust_c03",
      paymentStatus: "pending",
    });
    control.seed("payment_intents/rzp_c03_paid", {
      razorpayOrderId: "rzp_c03_paid_order",
      orderId: "order_c03_wh_paid",
      customerId: "cust_c03",
      amountPaise: 25000,
    });

    const payload = {
      id: "evt_c03_paid",
      event: "order.paid",
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        order: {
          entity: {
            id: "rzp_c03_paid_order", // order.paid carries the GATEWAY order id here
            amount: 25000,
            currency: "INR",
            notes: { orderId: "order_c03_wh_paid", branchId: "branch_c03" },
            payments: ["pay_c03_paid"],
          },
        },
      },
    };

    const call = mockReqRes(payload);
    await handleRazorpayWebhook(call.req, call.res);

    expect(call.out().statusCode).toBe(200);
    const order = docs.get("orders/order_c03_wh_paid")!.data;
    expect(order.paymentStatus).toBe("completed");
    expect(order["payment.razorpayPaymentId"]).toBe("pay_c03_paid");
    expect(order["payment.capturedAmountPaise"]).toBe(25000);
    expect(docs.get("unmatched_payments/ump_evt_c03_paid")).toBeUndefined();
  });

  it("intent bound to a DIFFERENT internal order → park (order binding fails closed)", async () => {
    control.seed("orders/order_c03_wh_bind", {
      id: "order_c03_wh_bind",
      branchId: "branch_c03",
      customerId: "cust_c03",
      paymentStatus: "pending",
    });
    control.seed("payment_intents/rzp_c03_bind", {
      razorpayOrderId: GATEWAY_ORDER,
      orderId: "order_someone_else", // ← NOT this order
      customerId: "cust_c03",
      amountPaise: 25000,
    });

    const call = mockReqRes(capturedPayload("evt_c03_bind", "order_c03_wh_bind", "pay_c03_bind", 25000));
    await handleRazorpayWebhook(call.req, call.res);

    expect(call.out().statusCode).toBe(200);
    expect(docs.get("orders/order_c03_wh_bind")!.data.paymentStatus).toBe("pending");
    expect(docs.get("unmatched_payments/ump_evt_c03_bind")!.data).toMatchObject({
      reason: "confirm_amount_unknown",
      status: "needs_review",
    });
  });

  it("intent owned by a DIFFERENT customer → park (ownership binding fails closed)", async () => {
    control.seed("orders/order_c03_wh_own", {
      id: "order_c03_wh_own",
      branchId: "branch_c03",
      customerId: "cust_c03",
      paymentStatus: "pending",
    });
    control.seed("payment_intents/rzp_c03_own", {
      razorpayOrderId: GATEWAY_ORDER,
      orderId: "order_c03_wh_own",
      customerId: "cust_someone_else", // ← conflicts with the order owner
      amountPaise: 25000,
    });

    const call = mockReqRes(capturedPayload("evt_c03_own", "order_c03_wh_own", "pay_c03_own", 25000));
    await handleRazorpayWebhook(call.req, call.res);

    expect(call.out().statusCode).toBe(200);
    expect(docs.get("orders/order_c03_wh_own")!.data.paymentStatus).toBe("pending");
    expect(docs.get("unmatched_payments/ump_evt_c03_own")!.data).toMatchObject({
      reason: "confirm_amount_unknown",
    });
  });

  it("intent amount that contradicts the capture → confirm_amount_mismatch (not a silent confirm)", async () => {
    control.seed("orders/order_c03_wh_mm", {
      id: "order_c03_wh_mm",
      branchId: "branch_c03",
      customerId: "cust_c03",
      paymentStatus: "pending",
    });
    control.seed("payment_intents/rzp_c03_mm", {
      razorpayOrderId: GATEWAY_ORDER,
      orderId: "order_c03_wh_mm",
      customerId: "cust_c03",
      amountPaise: 10000, // ₹100 — capture says 25000
    });

    const call = mockReqRes(capturedPayload("evt_c03_mm", "order_c03_wh_mm", "pay_c03_mm", 25000));
    await handleRazorpayWebhook(call.req, call.res);

    expect(call.out().statusCode).toBe(200);
    expect(docs.get("orders/order_c03_wh_mm")!.data.paymentStatus).toBe("pending");
    expect(docs.get("unmatched_payments/ump_evt_c03_mm")!.data).toMatchObject({
      reason: "confirm_amount_mismatch",
      expectedAmount: 100,
    });
  });

  it("KNOWN stored amount still confirms unchanged (no intent required)", async () => {
    control.seed("orders/order_c03_wh_known", {
      id: "order_c03_wh_known",
      branchId: "branch_c03",
      customerId: "cust_c03",
      paymentStatus: "pending",
      pricing: { grandTotal: 250 },
    });

    const call = mockReqRes(
      capturedPayload("evt_c03_known", "order_c03_wh_known", "pay_c03_known", 25000)
    );
    await handleRazorpayWebhook(call.req, call.res);

    expect(call.out().statusCode).toBe(200);
    const order = docs.get("orders/order_c03_wh_known")!.data;
    expect(order.paymentStatus).toBe("completed");
    expect(order.status).toMatchObject({ code: "CONFIRMED" });
    expect(order["payment.capturedAmountPaise"]).toBe(25000);
    expect(order.petpoojaOrderId).toMatch(/^pp_kot_/);
    expect(docs.get("unmatched_payments/ump_evt_c03_known")).toBeUndefined();
  });

  it("signed-webhook guard unchanged: a forged signature is 401 with zero order writes", async () => {
    control.seed("orders/order_c03_wh_sig", {
      id: "order_c03_wh_sig",
      branchId: "branch_c03",
      customerId: "cust_c03",
      paymentStatus: "pending",
      pricing: { grandTotal: 250 },
    });
    const prevGate = config.mock.paymentGateway;
    try {
      config.mock.paymentGateway = false;
      (config.razorpay as any).webhookSecret = "whsec_c03_local_test_only";
      const payload = capturedPayload("evt_c03_sig", "order_c03_wh_sig", "pay_c03_sig", 25000);
      const goodSig = crypto
        .createHmac("sha256", "whsec_c03_local_test_only")
        .update(JSON.stringify(payload))
        .digest("hex");
      const forged = mockReqRes(payload, goodSig.split("").reverse().join(""));
      await handleRazorpayWebhook(forged.req, forged.res);

      expect(forged.out().statusCode).toBe(401);
      expect(docs.get("orders/order_c03_wh_sig")!.data.paymentStatus).toBe("pending");
      expect(keysWithPrefix("payment_audits/aud_evt_")).toHaveLength(0);
      expect(keysWithPrefix("unmatched_payments/")).toHaveLength(0);
    } finally {
      config.mock.paymentGateway = prevGate;
    }
  });

  it("idempotency unchanged: a replayed delivery is already_processed with no second KOT", async () => {
    control.seed("orders/order_c03_wh_replay", {
      id: "order_c03_wh_replay",
      branchId: "branch_c03",
      customerId: "cust_c03",
      paymentStatus: "pending",
      pricing: { grandTotal: 250 },
    });

    const first = mockReqRes(
      capturedPayload("evt_c03_replay", "order_c03_wh_replay", "pay_c03_rp", 25000)
    );
    await handleRazorpayWebhook(first.req, first.res);
    expect(first.out().body).toMatchObject({ status: "ok" });
    const kotId = docs.get("orders/order_c03_wh_replay")!.data.petpoojaOrderId;
    expect(kotId).toMatch(/^pp_kot_/);

    const second = mockReqRes(
      capturedPayload("evt_c03_replay", "order_c03_wh_replay", "pay_c03_rp", 25000)
    );
    await handleRazorpayWebhook(second.req, second.res);
    expect(second.out().body).toMatchObject({ status: "already_processed" });
    expect(docs.get("orders/order_c03_wh_replay")!.data.petpoojaOrderId).toBe(kotId);
  });
});
