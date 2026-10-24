import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as crypto from "crypto";

/**
 * STRESS TESTS:
 * 1) FOREIGN BINDING FRESH-TX RACE (verify path):
 *    - Second distinct capture during executeRouteSplit / finishVerifiedPayment
 *    - Must NOT absorb foreign capture into confirmed order
 *    - Must NOT POST Route transfer for foreign capture
 *    - Must NOT mint/leak delivery OTP, write audit, or debit coins
 *    - Must park deterministic payment_discrepancies doc and throw 409 SECOND_CAPTURE_MISMATCH
 *    - Legitimate first-confirm and matching repeat verify must remain idempotent
 *
 * 2) TERMINAL / CANCELLED REFUND SPLIT GUARD:
 *    - Order cancelled or refunded on fresh snapshot before executeRouteSplit claim
 *    - Must NOT POST Route transfer to branch
 *    - Must clear lease, not burn retry count, set terminal refusal marker
 *    - Must atomically persist deterministic unmatched_payments park (ump_term_<paymentId>)
 *    - Deliberately allows legitimate fulfilled terminal states (DELIVERED, COMPLETED, PICKED_UP)
 */

const { mockDb, docs, writeLog, commitStats, control } = vi.hoisted(() => {
  process.env.OTP_HMAC_SECRET = "test_otp_binding_terminal_stress";

  type Rec = { data: any; version: number };
  const docs = new Map<string, Rec>();
  const writeLog: Array<{ path: string; data: any; merge?: boolean }> = [];
  const commitStats = { commits: 0, retries: 0 };
  const MAX_RETRIES = 8;

  let afterPreReadHook: (() => void) | null = null;
  let beforeFinishTxHook: (() => void) | null = null;
  let txCount = 0;

  const versionOf = (path: string): number => docs.get(path)?.version ?? -1;
  const dataOf = (path: string): any => docs.get(path)?.data;
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
      txCount++;
      const currentTxNumber = txCount;

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
          if (currentTxNumber === 1 && afterPreReadHook) {
            const hook = afterPreReadHook;
            afterPreReadHook = null;
            hook();
          }
          return result;
        }

        const outcome = await enqueueCommit(() => {
          if (conflicted()) {
            return { conflicted: true as const };
          }
          for (const w of writes) applyWrite(w.path, w.data, w.merge);
          commitStats.commits += 1;
          return { conflicted: false as const, result };
        });
        if (!outcome.conflicted) {
          if (currentTxNumber === 1 && afterPreReadHook) {
            const hook = afterPreReadHook;
            afterPreReadHook = null;
            hook();
          }
          if (currentTxNumber === 2 && beforeFinishTxHook) {
            const hook = beforeFinishTxHook;
            beforeFinishTxHook = null;
            hook();
          }
          return outcome.result;
        }
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
      delete: async () => {
        docs.delete(path);
      },
    };
  };

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
      injectAfterPreRead: (fn: () => void) => {
        afterPreReadHook = fn;
      },
      injectBeforeFinishTx: (fn: () => void) => {
        beforeFinishTxHook = fn;
      },
      reset: () => {
        docs.clear();
        writeLog.length = 0;
        commitStats.commits = 0;
        commitStats.retries = 0;
        afterPreReadHook = null;
        beforeFinishTxHook = null;
        txCount = 0;
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
  executeRouteSplit,
  __setPaymentsFetchForTests,
} from "../src/modules/payments/razorpay.service";
import { __setRazorpayClientForTests } from "../src/modules/payments/razorpayClient";
import { config } from "../src/config/env";

const LIVE_KEY_ID = "test_key_id_stress";
const LIVE_SECRET = "test_secret_stress_terminal_binding";
const GATEWAY_ORDER = "order_gw_stress_1";

const liveSig = (gatewayOrderId: string, paymentId: string) =>
  crypto.createHmac("sha256", LIVE_SECRET).update(`${gatewayOrderId}|${paymentId}`).digest("hex");

const verifyParams = (orderId: string, paymentId: string) => ({
  orderId,
  razorpayOrderId: GATEWAY_ORDER,
  razorpayPaymentId: paymentId,
  razorpaySignature: liveSig(GATEWAY_ORDER, paymentId),
});

const capturedFetch = (paymentId: string, amountPaise = 25000) =>
  vi.fn(async (requestedId: string) => ({
    id: paymentId,
    order_id: GATEWAY_ORDER,
    amount: amountPaise,
    currency: "INR",
    status: "captured",
    requestedId,
  }));

const keysWithPrefix = (prefix: string) => [...docs.keys()].filter((k) => k.startsWith(prefix));
const confirmAudits = () =>
  keysWithPrefix("payment_audits/aud_").filter((k) => !k.startsWith("payment_audits/aud_evt_"));
const discrepancyParks = () => keysWithPrefix("payment_discrepancies/");
const unmatchedParks = () => keysWithPrefix("unmatched_payments/");

describe("Finding 1: FOREIGN BINDING FRESH-TX RACE", () => {
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
    config.mock.paymentGateway = false;
    config.razorpay.keyId = LIVE_KEY_ID;
    config.razorpay.keySecret = LIVE_SECRET;
    __setPaymentsFetchForTests(capturedFetch("pay_unstubbed"));
    transferSpy = vi.fn(async () => ({ id: "trf_mock_transferred", status: "processed" }));
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

  it("1.1: concurrent pay_A confirm lands between pre-read and executeRouteSplit → verify(pay_B) throws 409 SECOND_CAPTURE_MISMATCH, no transfer POST, parks discrepancy", async () => {
    const orderId = "order_race_split";
    control.seed(`orders/${orderId}`, {
      id: orderId,
      branchId: "branch_stress_1",
      orderType: "delivery",
      customerId: "cust_stress_1",
      pricing: { grandTotal: 250, split: { branchTransferPaise: 20000, brandRoyaltyPaise: 5000 } },
      paymentStatus: "pending",
      routeTransferStatus: "pending_retry",
      status: { code: "PENDING", label: "Pending", kind: "upcoming", terminal: false },
    });
    control.seed("branches/branch_stress_1", { razorpayAccountId: "acc_stress_branch_1" });
    __setPaymentsFetchForTests(capturedFetch("pay_B", 25000));

    // Tx 1 is preSplitTruth read. Right after Tx 1 finishes, pay_A commits confirmation!
    control.injectAfterPreRead(() => {
      control.seed(
        `orders/${orderId}`,
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
      );
    });

    const err: any = await verifyPayment(verifyParams(orderId, "pay_B")).then(
      (res) => res,
      (e) => e
    );

    expect(err?.statusCode, "Must throw 409 when fresh snapshot in executeRouteSplit detects mismatch").toBe(409);
    expect(err?.code).toBe("SECOND_CAPTURE_MISMATCH");

    // Must NOT POST transfer for pay_B
    expect(transferSpy).not.toHaveBeenCalled();

    // Must park discrepancy doc
    expect(discrepancyParks()).toEqual([`payment_discrepancies/dis_${orderId}_pay_B`]);
    expect(docs.get(`payment_discrepancies/dis_${orderId}_pay_B`)!.data).toMatchObject({
      orderId,
      razorpayPaymentId: "pay_B",
      reason: "SECOND_CAPTURE_MISMATCH",
      recordedPaymentId: "pay_A",
    });

    // Authoritative order binding must remain pay_A
    const order = docs.get(`orders/${orderId}`)!.data;
    expect(order.payment.razorpayPaymentId).toBe("pay_A");
    expect(confirmAudits()).toHaveLength(0);
  });

  it("1.2: concurrent pay_A confirm lands between executeRouteSplit and finishVerifiedPayment → throws 409 SECOND_CAPTURE_MISMATCH, no OTP mint, no audit", async () => {
    const orderId = "order_race_finish";
    control.seed(`orders/${orderId}`, {
      id: orderId,
      branchId: "branch_stress_1",
      orderType: "delivery",
      customerId: "cust_stress_1",
      pricing: { grandTotal: 250 }, // no split -> executeRouteSplit returns no_split
      paymentStatus: "pending",
      status: { code: "PENDING", label: "Pending", kind: "upcoming", terminal: false },
    });
    __setPaymentsFetchForTests(capturedFetch("pay_B", 25000));

    // After preSplitTruth (tx 1), pay_A confirms order before finishVerifiedPayment (tx 2)
    control.injectAfterPreRead(() => {
      control.seed(
        `orders/${orderId}`,
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
      );
    });

    const err: any = await verifyPayment(verifyParams(orderId, "pay_B")).then(
      (res) => res,
      (e) => e
    );

    expect(err?.statusCode, "finishVerifiedPayment transactional backstop must throw 409").toBe(409);
    expect(err?.code).toBe("SECOND_CAPTURE_MISMATCH");

    expect(discrepancyParks()).toEqual([`payment_discrepancies/dis_${orderId}_pay_B`]);
    expect(confirmAudits()).toHaveLength(0);
    const order = docs.get(`orders/${orderId}`)!.data;
    expect(order.deliveryOtpHash).toBeUndefined();
  });

  it("1.3: idempotent repeat of pay_A still succeeds and backfills missing OTP exactly once", async () => {
    const orderId = "order_same_capture_idempotent";
    control.seed(`orders/${orderId}`, {
      id: orderId,
      branchId: "branch_stress_1",
      orderType: "delivery",
      customerId: "cust_stress_1",
      pricing: { grandTotal: 250 },
      paymentStatus: "completed",
      "payment.status": "completed",
      payment: {
        status: "completed",
        razorpayPaymentId: "pay_A",
        razorpayOrderId: GATEWAY_ORDER,
      },
      status: { code: "CONFIRMED", label: "Order confirmed", kind: "upcoming", terminal: false },
    });
    __setPaymentsFetchForTests(capturedFetch("pay_A", 25000));

    const res: any = await verifyPayment(verifyParams(orderId, "pay_A"));
    expect(res.ok).toBe(true);
    expect(res.success).toBe(true);

    const order = docs.get(`orders/${orderId}`)!.data;
    expect(order.deliveryOtpHash).toBeDefined();
    expect(discrepancyParks()).toHaveLength(0);
    expect(confirmAudits()).toHaveLength(0);
  });
});

describe("Finding 2: TERMINAL / CANCELLED REFUND SPLIT GUARD", () => {
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
    config.mock.paymentGateway = false;
    config.razorpay.keyId = LIVE_KEY_ID;
    config.razorpay.keySecret = LIVE_SECRET;
    transferSpy = vi.fn(async () => ({ id: "trf_mock_transferred", status: "processed" }));
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

  it("2.1: executeRouteSplit directly on CANCELLED order: NO transfer POST, clears claim, parks unmatched_payments", async () => {
    const orderId = "order_direct_cancel_split";
    const paymentId = "pay_cancel_direct";
    control.seed(`orders/${orderId}`, {
      id: orderId,
      branchId: "branch_stress_1",
      pricing: { grandTotal: 250, split: { branchTransferPaise: 20000, brandRoyaltyPaise: 5000 } },
      routeTransferStatus: "pending_retry",
      status: { code: "CANCELLED", label: "Cancelled", kind: "cancelled", terminal: true },
      payment: { razorpayPaymentId: paymentId, capturedAmountPaise: 25000 },
    });
    control.seed("branches/branch_stress_1", { razorpayAccountId: "acc_stress_branch_1" });

    const orderRef = mockDb.collection("orders").doc(orderId);
    const orderData = docs.get(`orders/${orderId}`)!.data;

    const outcome = await executeRouteSplit({
      orderRef,
      orderId,
      orderData,
      razorpayPaymentId: paymentId,
      capturedAmountPaise: 25000,
    });

    expect(outcome.state).toBe("flagged");
    expect(transferSpy).not.toHaveBeenCalled();

    // Must write deterministic park doc in unmatched_payments
    expect(unmatchedParks()).toContain(`unmatched_payments/ump_term_${paymentId}`);
    const park = docs.get(`unmatched_payments/ump_term_${paymentId}`)!.data;
    expect(park.orderId).toBe(orderId);
    expect(park.reason).toBe("capture_on_cancelled_order");

    // Order doc must be marked failed with terminal refusal, claim lease cleared
    const order = docs.get(`orders/${orderId}`)!.data;
    expect(order.routeTransferStatus).toBe("failed");
    expect(order.routeTransferTerminalRefusal).toBe(true);
    expect(order.routeTransferClaimedAt).toBe("MOCK_DELETE");
  });

  it("2.2: executeRouteSplit directly on REFUNDED order: NO transfer POST, clears claim, parks unmatched_payments", async () => {
    const orderId = "order_direct_refund_split";
    const paymentId = "pay_refund_direct";
    control.seed(`orders/${orderId}`, {
      id: orderId,
      branchId: "branch_stress_1",
      pricing: { grandTotal: 250, split: { branchTransferPaise: 20000, brandRoyaltyPaise: 5000 } },
      routeTransferStatus: "pending_retry",
      status: { code: "REFUNDED", label: "Refunded", kind: "completed", terminal: true },
      payment: { razorpayPaymentId: paymentId, capturedAmountPaise: 25000 },
    });
    control.seed("branches/branch_stress_1", { razorpayAccountId: "acc_stress_branch_1" });

    const orderRef = mockDb.collection("orders").doc(orderId);
    const orderData = docs.get(`orders/${orderId}`)!.data;

    const outcome = await executeRouteSplit({
      orderRef,
      orderId,
      orderData,
      razorpayPaymentId: paymentId,
      capturedAmountPaise: 25000,
    });

    expect(outcome.state).toBe("flagged");
    expect(transferSpy).not.toHaveBeenCalled();

    expect(unmatchedParks()).toContain(`unmatched_payments/ump_term_${paymentId}`);
    const park = docs.get(`unmatched_payments/ump_term_${paymentId}`)!.data;
    expect(park.reason).toBe("capture_on_refunded_order");

    const order = docs.get(`orders/${orderId}`)!.data;
    expect(order.routeTransferStatus).toBe("failed");
    expect(order.routeTransferTerminalRefusal).toBe(true);
  });

  it("2.3: fulfilled terminal state (PICKED_UP / DELIVERED) is NOT terminal for transfer and DOES transfer", async () => {
    const orderId = "order_fulfilled_split";
    const paymentId = "pay_fulfilled";
    control.seed(`orders/${orderId}`, {
      id: orderId,
      branchId: "branch_stress_1",
      pricing: { grandTotal: 250, split: { branchTransferPaise: 20000, brandRoyaltyPaise: 5000 } },
      routeTransferStatus: "pending_retry",
      status: { code: "PICKED_UP", label: "Picked Up", kind: "completed", terminal: true },
      payment: { razorpayPaymentId: paymentId, capturedAmountPaise: 25000 },
    });
    control.seed("branches/branch_stress_1", { razorpayAccountId: "acc_stress_branch_1" });

    const orderRef = mockDb.collection("orders").doc(orderId);
    const orderData = docs.get(`orders/${orderId}`)!.data;

    const outcome = await executeRouteSplit({
      orderRef,
      orderId,
      orderData,
      razorpayPaymentId: paymentId,
      capturedAmountPaise: 25000,
    });

    expect(outcome.state).toBe("transferred");
    expect(transferSpy).toHaveBeenCalledTimes(1);
    expect(unmatchedParks()).toHaveLength(0);
  });

  it("2.4: concurrent cancellation lands between pre-read and executeRouteSplit → NO transfer POST, parks unmatched_payments, verify does not return success", async () => {
    const orderId = "order_race_cancel_split";
    const paymentId = "pay_race_cancel";
    control.seed(`orders/${orderId}`, {
      id: orderId,
      branchId: "branch_stress_1",
      orderType: "delivery",
      customerId: "cust_stress_1",
      pricing: { grandTotal: 250, split: { branchTransferPaise: 20000, brandRoyaltyPaise: 5000 } },
      paymentStatus: "pending",
      routeTransferStatus: "pending_retry",
      status: { code: "PENDING", label: "Pending", kind: "upcoming", terminal: false },
    });
    control.seed("branches/branch_stress_1", { razorpayAccountId: "acc_stress_branch_1" });
    __setPaymentsFetchForTests(capturedFetch(paymentId, 25000));

    // After preSplitTruth reads clean PENDING, order is CANCELLED concurrently
    control.injectAfterPreRead(() => {
      control.seed(
        `orders/${orderId}`,
        {
          status: { code: "CANCELLED", label: "Cancelled", kind: "cancelled", terminal: true },
        },
        true
      );
    });

    const res: any = await verifyPayment(verifyParams(orderId, paymentId)).then(
      (r) => r,
      (e) => e
    );

    // Must NOT transfer
    expect(transferSpy).not.toHaveBeenCalled();

    // Must park in unmatched_payments
    expect(unmatchedParks()).toContain(`unmatched_payments/ump_term_${paymentId}`);
    const park = docs.get(`unmatched_payments/ump_term_${paymentId}`)!.data;
    expect(park.reason).toBe("capture_on_cancelled_order");

    // Must not report successful confirmation
    expect(res?.ok).not.toBe(true);
    expect(res?.success).not.toBe(true);
  });

  it("2.5: active transferring lease blocks concurrent caller (busy / one-winner claim)", async () => {
    const orderId = "order_active_lease_busy";
    const paymentId = "pay_busy_test";
    control.seed(`orders/${orderId}`, {
      id: orderId,
      branchId: "branch_stress_1",
      pricing: { grandTotal: 250, split: { branchTransferPaise: 20000, brandRoyaltyPaise: 5000 } },
      routeTransferStatus: "transferring",
      routeTransferClaimedAt: Date.now(), // fresh active lease
      status: { code: "CONFIRMED", label: "Confirmed", kind: "upcoming", terminal: false },
      payment: { razorpayPaymentId: paymentId, capturedAmountPaise: 25000 },
    });
    control.seed("branches/branch_stress_1", { razorpayAccountId: "acc_stress_branch_1" });

    const orderRef = mockDb.collection("orders").doc(orderId);
    const orderData = docs.get(`orders/${orderId}`)!.data;

    const outcome = await executeRouteSplit({
      orderRef,
      orderId,
      orderData,
      razorpayPaymentId: paymentId,
      capturedAmountPaise: 25000,
    });

    expect(outcome.state).toBe("busy");
    expect(transferSpy).not.toHaveBeenCalled();
  });
});
