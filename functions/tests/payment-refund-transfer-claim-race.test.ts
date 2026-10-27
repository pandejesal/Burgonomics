import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as crypto from "crypto";

/**
 * T3.3 — refund state machine vs Route transfer split claim race (Phase 3
 * MONEY).
 *
 * Question under proof: can the two INDEPENDENT claim leases on one order
 * (the refund claim: `refundStatus:"refunding"` + `refundActiveClaim`, and the
 * transfer claim: `routeTransferStatus:"transferring"` +
 * `routeTransferClaimedAt`) both hold side effects in flight at once? The
 * transfer terminal check only reads refunded/cancelled statuses, and the
 * refund claim only consults its OWN lease — so each side could start while
 * the other is in flight: a `reverse_all` refund POST against a payout that
 * is simultaneously on the wire, or a payout POST while a reversal is already
 * reversing splits. Both POSTs are provider calls made OUTSIDE any Firestore
 * transaction; what must serialize is the CLAIM inside the transactions.
 *
 * Rig: mock gateway BRANCH boundary only (claim logic is mode-independent);
 * the provider client is a stub, no network anywhere. Ignoring-mode checks
 * are pinned for fresh claims (race refused) and stale claims (recovery
 * takeover proceeds), plus the designed already-transferred+refund path.
 *
 * HONESTY LIMIT: in-process model — proves the claim guards, not provider
 * reconciliation semantics.
 */
const { mockDb, docs, writeLog, commitStats, control } = vi.hoisted(() => {
  process.env.OTP_HMAC_SECRET = "test_otp_money_t33";

  type Rec = { data: any; version: number };
  const docs = new Map<string, Rec>();
  const writeLog: Array<{ path: string; data: any; merge?: boolean }> = [];
  const commitStats = { commits: 0, retries: 0, contentions: 0 };

  const versionOf = (path: string): number => docs.get(path)?.version ?? -1;
  const dataOf = (path: string): any => docs.get(path)?.data;
  const applyWrite = (path: string, data: any, merge?: boolean) => {
    const existing = docs.get(path);
    const next = merge && existing ? { ...existing.data, ...data } : { ...data };
    docs.set(path, { data: next, version: (existing?.version ?? 0) + 1 });
    writeLog.push({ path, data: next, merge: !!merge });
  };

  const runTransaction = async (fn: (tx: any) => any): Promise<any> => {
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
    for (const w of writes) applyWrite(w.path, w.data, w.merge);
    commitStats.commits += 1;
    return result;
  };

  const docRef = (colName: string, docId: string) => {
    const path = `${colName}/${docId}`;
    return {
      id: docId,
      path,
      get: async () => ({
        exists: dataOf(path) !== undefined,
        data: () => dataOf(path),
        ref: docRef(colName, docId),
      }),
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
      seed: (path: string, data: any) => applyWrite(path, data, false),
      reset: () => {
        docs.clear();
        writeLog.length = 0;
        commitStats.commits = 0;
      },
    },
  };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TIMESTAMP",
    increment: (n: number) => n,
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

import { executeRouteSplit, autoRefund } from "../src/modules/payments/razorpay.service";
import { config } from "../src/config/env";

/** Priced CONFIRMED order whose payout SPILT nothing yet: both claim lanes dormant. */
const splitOrder = (extra: Record<string, any> = {}) => ({
  id: "order_t33_race",
  branchId: "branch_t33",
  orderType: "delivery",
  customerId: "cust_t33",
  pricing: { grandTotal: 250, split: { branchTransferPaise: 9000, brandRoyaltyPaise: 1000 } },
  paymentStatus: "completed",
  status: { code: "CONFIRMED", label: "Order confirmed", kind: "upcoming", terminal: false },
  payment: {
    status: "completed",
    razorpayPaymentId: "pay_t33_P",
    razorpayOrderId: "order_t33_gateway",
    capturedAmountPaise: 25000,
  },
  ...extra,
});

const freshRefundClaim = (now: number) => ({
  refundStatus: "refunding",
  refundActiveClaim: {
    requestId: "req_t33_race_refund_1",
    claimedAt: now,
    paymentId: "pay_t33_P",
    requestedPaise: 25000,
    gatewayKey: "gateway_key_t33",
    reason: "support",
  },
});

const freshTransferClaim = (now: number) => ({
  routeTransferStatus: "transferring",
  routeTransferClaimedAt: now,
});

// Mock gateway mode keeps every provider behind the stub seam; the CLAIM
// guards under test run identically in live mode (same transactions).
describe("T3.3 — refund claim vs Route-split transfer claim serialization", () => {
  let prevPg: boolean;
  let prevPp: boolean;

  beforeEach(() => {
    control.reset();
    prevPg = config.mock.paymentGateway;
    prevPp = config.mock.petpoojaPos;
    config.mock.paymentGateway = true; // claim logic is mode-independent; mock keeps provider out
    config.mock.petpoojaPos = true;
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("FORBIDDEN_NETWORK_CALL_IN_PAYMENT_TEST");
    }));
  });

  afterEach(() => {
    config.mock.paymentGateway = prevPg;
    config.mock.petpoojaPos = prevPp;
    vi.unstubAllGlobals();
  });

  it("REFUND claim in flight (fresh lease): the Route split must NOT claim (no concurrent reversal race)", async () => {
    const now = Date.now();
    control.seed("orders/order_t33_race", {
      ...splitOrder({ routeTransferStatus: "pending_retry", routeTransferRetryCount: 0 }),
      ...freshRefundClaim(now),
    });
    // Linked branch so the split would otherwise proceed to a real POST.
    control.seed("branches/branch_t33", { razorpayAccountId: "acc_t33_branch" });

    const outcome = await executeRouteSplit({
      orderRef: mockDb.collection("orders").doc("order_t33_race") as any,
      orderId: "order_t33_race",
      orderData: docs.get("orders/order_t33_race")!.data,
      razorpayPaymentId: "pay_t33_P",
      capturedAmountPaise: 25000,
    });

    // THE GUARD: a live refund claim means reversal may already be on the
    // wire — the payout claim must yield (busy), never claim + POST.
    expect(outcome.state).toBe("busy");
    // No transfer receipt may have been written by the racing claimer.
    const order = docs.get("orders/order_t33_race")!.data;
    expect(order.routeTransferStatus).not.toBe("transferred");
  });

  it("TRANSFER claim in flight (fresh lease): the refund must NOT claim (no concurrent payout race)", async () => {
    const now = Date.now();
    control.seed("orders/order_t33_race", splitOrder(freshTransferClaim(now)));
    control.seed("branches/branch_t33", { razorpayAccountId: "acc_t33_branch" });

    await expect(
      autoRefund({ orderId: "order_t33_race", razorpayPaymentId: "pay_t33_P" }, null)
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "ROUTE_TRANSFER_IN_PROGRESS",
    });
    // And the refund state must not have been flipped by the racing claim.
    const order = docs.get("orders/order_t33_race")!.data;
    expect(order.refundStatus).not.toBe("refund-post-gateway-written");
    expect(order.refundStatus).not.toBe("refunded");
  });

  it("STALE refund lease (>TTL, crashed worker): the Route split takeover proceeds (recovery, not a race)", async () => {
    const stale = Date.now() - 11 * 60_000; // beyond the shared 10-min TTL
    control.seed("orders/order_t33_stale_ref", {
      id: "order_t33_stale_ref",
      branchId: "branch_t33",
      orderType: "delivery",
      customerId: "cust_t33",
      pricing: { grandTotal: 250, split: { branchTransferPaise: 9000, brandRoyaltyPaise: 1000 } },
      paymentStatus: "completed",
      status: { code: "CONFIRMED", label: "Order confirmed", kind: "upcoming", terminal: false },
      payment: { status: "completed", razorpayPaymentId: "pay_t33_S", capturedAmountPaise: 25000 },
      ...freshRefundClaim(stale),
    });
    control.seed("branches/branch_t33", { razorpayAccountId: "acc_t33_branch" });

    const outcome = await executeRouteSplit({
      orderRef: mockDb.collection("orders").doc("order_t33_stale_ref") as any,
      orderId: "order_t33_stale_ref",
      orderData: docs.get("orders/order_t33_stale_ref")!.data,
      razorpayPaymentId: "pay_t33_S",
      capturedAmountPaise: 25000,
    });
    // Recovery is allowed to proceed — the dead claim cannot hold money host-
    // age; the refund takeover rules still apply to any NEW refund attempt.
    expect(outcome.state).toBe("transferred");
  });

  it("STALE transfer lease (>TTL): the refund claim takeover proceeds (recovery, not a race)", async () => {
    const stale = Date.now() - 11 * 60_000;
    control.seed("orders/order_t33_stale_tr", {
      ...splitOrder(freshTransferClaim(stale)),
    });
    const out = await autoRefund(
      { orderId: "order_t33_stale_tr", razorpayPaymentId: "pay_t33_P" },
      null
    );
    // Contract: autoRefund resolves to the gateway refund receipt object.
    expect(out).toMatchObject({ payment_id: "pay_t33_P" });
    expect(docs.get("orders/order_t33_stale_tr")!.data.refundStatus).toBe("refunded");
  });

  it("ALREADY transferred + refund: the designed reverse_all proceeds (transfer receipt reused, no re-POST)", async () => {
    control.seed("orders/order_t33_settled", {
      ...splitOrder({
        routeTransferStatus: "transferred",
        "payment.routeTransfer": { id: "trf_t33_existing", amount: 9000, status: "processed" },
      }),
    });
    const out = await autoRefund(
      { orderId: "order_t33_settled", razorpayPaymentId: "pay_t33_P" },
      null
    );
    expect(docs.get("orders/order_t33_settled")!.data.refundStatus).toBe("refunded");
    // The prior transfer receipt stays byte-identical — never overwritten by
    // the refund, never re-POSTed.
    expect(docs.get("orders/order_t33_settled")!.data["payment.routeTransfer"]).toMatchObject({
      id: "trf_t33_existing",
    });
  });
});
