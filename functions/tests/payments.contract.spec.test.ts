import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// PAYMENTS_CONTRACT_SPEC (server half) regression rig — findings 1-3.
// Generic Firestore mock: doc get/set/create/update + chained where() queries
// evaluated in-memory over `savedDocs`, so the payment-intent lookup
// (loadPaymentIntent) and the retry worker's chained where().where().limit()
// both behave like the real client. `__throwOnGet` on a doc simulates a read
// failure (fail-closed paths).
const { mockDb, savedDocs } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const matches = (data: any, filters: Array<[string, string, any]>) =>
    filters.every(([field, op, value]) => {
      const actual = data?.[field];
      if (op === "==") return actual === value;
      if (op === "<=") return typeof actual === "number" && actual <= value;
      return false;
    });
  const docRef = (col: string, id: string) => {
    const path = `${col}/${id}`;
    return {
      id,
      path,
      get: vi.fn(async () => {
        if (savedDocs[path]?.__throwOnGet) {
          const err: any = new Error("Simulated Firestore read failure");
          err.code = 7;
          throw err;
        }
        // Authoritative catalog for the fixtures: the pricing engine now
        // REFUSES a line it cannot look up (no charging the client's price),
        // so the product ids used by these tests must resolve with a price and
        // explicit availability.
        if (col === "products" && !Object.prototype.hasOwnProperty.call(savedDocs, path)) {
          const catalog: Record<string, { price: number; inStock: boolean }> = {
            p1: { price: 199, inStock: true },
          };
          const entry = catalog[id];
          if (entry) {
            return { exists: true, data: () => ({ ...entry }) };
          }
        }
        return {
          exists: Object.prototype.hasOwnProperty.call(savedDocs, path),
          data: () => savedDocs[path],
        };
      }),
      set: vi.fn(async (data: any, opts?: any) => {
        savedDocs[path] =
          opts?.merge && savedDocs[path] ? { ...savedDocs[path], ...data } : data;
      }),
      create: vi.fn(async (data: any) => {
        if (Object.prototype.hasOwnProperty.call(savedDocs, path)) {
          const err: any = new Error("Document already exists");
          err.code = 6;
          throw err;
        }
        savedDocs[path] = data;
      }),
      update: vi.fn(async (data: any) => {
        savedDocs[path] = { ...(savedDocs[path] || {}), ...data };
      }),
    };
  };
  const query = (col: string) => {
    const filters: Array<[string, string, any]> = [];
    const q: any = {
      where: (f: string, op: string, v: any) => {
        filters.push([f, op, v]);
        return q;
      },
      limit: () => q,
      get: vi.fn(async () => ({
        docs: Object.keys(savedDocs)
          .filter((p) => p.startsWith(`${col}/`) && matches(savedDocs[p], filters))
          .map((p) => {
            const id = p.slice(col.length + 1);
            return { id, ref: docRef(col, id), exists: true, data: () => savedDocs[p] };
          }),
      })),
    };
    return q;
  };
  const mockDb: any = {
    collection: (col: string) => ({
      doc: (id: string) => docRef(col, id),
      where: query(col).where,
    }),
    runTransaction: vi.fn(async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
      })
    ),
  };
  return { mockDb, savedDocs };
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
  createPaymentOrder,
  verifyPayment,
  __setPaymentsFetchForTests,
} from "../src/modules/payments/razorpay.service";
import {
  attemptRouteTransfer,
  retryPendingRouteTransfersWorker,
} from "../src/modules/payments/routeTransfers";
import {
  __setRazorpayClientForTests,
  __resetRazorpayClientForTests,
} from "../src/modules/payments/razorpayClient";
import { config } from "../src/config/env";

describe("PAYMENTS_CONTRACT_SPEC server regressions (findings 1-3)", () => {
  let prevMock: boolean;
  let prevKeyId: string;
  let prevKeySecret: string;
  let prevOtp: string | undefined;

  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    __setPaymentsFetchForTests(null);
    __resetRazorpayClientForTests();
    prevMock = config.mock.paymentGateway;
    prevKeyId = config.razorpay.keyId;
    prevKeySecret = config.razorpay.keySecret;
    prevOtp = process.env.OTP_HMAC_SECRET;
    // Checkout/verify suites run in the dev mock-gateway sandbox; the
    // transfer suites below flip this back to live + a stubbed SDK client.
    config.mock.paymentGateway = true;
    process.env.OTP_HMAC_SECRET = "test_otp_contract_spec_only";
    savedDocs["branches/branch_c1"] = { razorpayAccountId: "acc_c1d2e3" };
  });

  afterEach(() => {
    __setPaymentsFetchForTests(null);
    __resetRazorpayClientForTests();
    config.mock.paymentGateway = prevMock;
    config.razorpay.keyId = prevKeyId;
    config.razorpay.keySecret = prevKeySecret;
    if (prevOtp === undefined) delete process.env.OTP_HMAC_SECRET;
    else process.env.OTP_HMAC_SECRET = prevOtp;
  });

  /** Live-gateway context for transfer tests (no "mock" substring in keys —
   *  getRazorpayClient's fail-closed check rejects values containing it). */
  const useLiveGateway = () => {
    config.mock.paymentGateway = false;
    config.razorpay.keyId = "rzp_live_contract_abc";
    config.razorpay.keySecret = "live_secret_contract_abc_123";
  };

  describe("Finding 1 — createPaymentOrder customerId hijack gate (spec §1)", () => {
    const basket = {
      items: [{ id: "p1", productId: "p1", name: "Burger", price: 199, quantity: 1 }],
      branchId: "branch_c1",
      orderType: "takeaway" as const,
    };

    it("refuses checkout when the order belongs to another customer (409, nothing minted)", async () => {
      savedDocs["orders/ord_victim"] = {
        id: "ord_victim",
        customerId: "cust_victim",
        status: "pending_payment",
      };
      await expect(
        createPaymentOrder({ ...basket, orderId: "ord_victim", customerId: "cust_attacker" })
      ).rejects.toMatchObject({ statusCode: 409, code: "ORDER_NOT_OWNED" });
      // The hijack dies BEFORE money: no intent, no gateway order, no stamp.
      expect(Object.keys(savedDocs).filter((p) => p.startsWith("payment_intents/"))).toEqual([]);
      expect(savedDocs["orders/ord_victim"].pricing).toBeUndefined();
    });

    it("refuses checkout for an order that does not exist (404 ghost)", async () => {
      await expect(
        createPaymentOrder({ ...basket, orderId: "ord_ghost", customerId: "cust_a" })
      ).rejects.toMatchObject({ statusCode: 404, code: "ORDER_NOT_FOUND" });
      expect(Object.keys(savedDocs).filter((p) => p.startsWith("payment_intents/"))).toEqual([]);
    });

    it("refuses a second checkout on an already-paid order (409)", async () => {
      savedDocs["orders/ord_paid"] = {
        id: "ord_paid",
        customerId: "cust_a",
        paymentStatus: "completed",
      };
      await expect(
        createPaymentOrder({ ...basket, orderId: "ord_paid", customerId: "cust_a" })
      ).rejects.toMatchObject({ statusCode: 409, code: "ORDER_ALREADY_PAID" });
    });

    it("fails closed 503 when the ownership check itself is unavailable", async () => {
      savedDocs["orders/ord_blip"] = { customerId: "cust_a", __throwOnGet: true };
      await expect(
        createPaymentOrder({ ...basket, orderId: "ord_blip", customerId: "cust_a" })
      ).rejects.toMatchObject({ statusCode: 503, code: "ORDER_VERIFY_UNAVAILABLE" });
    });

    it("owner checkout stamps server pricing on the order + intent binding", async () => {
      savedDocs["orders/ord_ok"] = {
        id: "ord_ok",
        customerId: "cust_a",
        orderType: "takeaway",
        status: "pending_payment",
      };
      const res = await createPaymentOrder({
        ...basket,
        orderId: "ord_ok",
        customerId: "cust_a",
        deliveryFee: 40,
        packagingFee: 15,
        idempotencyKey: "chk_contract_1",
      });
      expect(res.razorpayOrderId).toBeTruthy();
      // Spec §1: server-priced total stamped at intent time, bound to the
      // exact gateway amount.
      const order = savedDocs["orders/ord_ok"];
      expect(typeof order.pricing?.grandTotal).toBe("number");
      expect(res.amountPaise).toBe(Math.round(order.pricing.grandTotal * 100));
      // The SERVER-written intent is the authoritative binding for verify.
      expect(savedDocs["payment_intents/chk_contract_1"]).toMatchObject({
        razorpayOrderId: res.razorpayOrderId,
        orderId: "ord_ok",
        branchId: "branch_c1",
        orderType: "takeaway",
        customerId: "cust_a",
      });
      // Legacy aliases for old clients (spec §1).
      expect((res as any).orderId).toBe(res.razorpayOrderId);
      expect((res as any).amount).toBe(res.amountPaise / 100);
    });
  });

  describe("Findings 1+2 — verifyPayment owner gating (spec §2)", () => {
    const seedOrder = (id: string, customerId: string | null, orderType = "delivery") => {
      savedDocs[`orders/${id}`] = {
        id,
        branchId: "branch_c1",
        customerId,
        orderType,
        pricing: { grandTotal: 100, split: { branchTransferPaise: 9000 } },
      };
    };
    const body = (n: string) => ({
      orderId: "ord_own",
      razorpayOrderId: `rzp_own_${n}`,
      razorpayPaymentId: `pay_own_${n}`,
      razorpaySignature: "sig_valid",
    });

    it("owner caller gets the full payload + order summary", async () => {
      seedOrder("ord_own", "cust_owner");
      const res = await verifyPayment(body("owner"), { uid: "cust_owner" });
      expect(res.ok).toBe(true);
      expect((res as any).success).toBe(true);
      expect((res as any).deliveryOtp).toMatch(/^\d{4}$/);
      expect((res as any).transfer).toBeDefined();
      expect((res as any).order).toMatchObject({ id: "ord_own", customerId: "cust_owner" });
      expect(savedDocs["orders/ord_own"].routeTransferStatus).toBe("transferred");
    });

    it("a DIFFERENT authenticated customer gets only { ok: true } — no order/OTP/transfer leak", async () => {
      seedOrder("ord_own", "cust_owner");
      const res = await verifyPayment(body("attacker"), { uid: "cust_attacker" });
      expect(res).toEqual({ ok: true });
    });

    it("unauthenticated guest gets only { ok: true } for a registered customer's order", async () => {
      seedOrder("ord_own", "cust_owner");
      const res = await verifyPayment(body("guest"), null);
      expect(res).toEqual({ ok: true });
    });

    it("unauthenticated guest with a matching guest intent gets the payload", async () => {
      seedOrder("ord_g1", "guest");
      savedDocs["payment_intents/rzp_g1"] = {
        razorpayOrderId: "rzp_g1",
        orderId: "ord_g1",
        customerId: "guest",
        branchId: "branch_c1",
        orderType: "delivery",
        amountPaise: 10000,
      };
      const res = await verifyPayment(
        {
          orderId: "ord_g1",
          razorpayOrderId: "rzp_g1",
          razorpayPaymentId: "pay_g1",
          razorpaySignature: "sig_valid",
        },
        null
      );
      expect(res.ok).toBe(true);
      expect((res as any).deliveryOtp).toMatch(/^\d{4}$/);
      expect((res as any).order?.customerId).toBe("guest");
    });

    it("resolves the internal orderId from the SERVER intent for a legacy body (no orderId)", async () => {
      seedOrder("ord_leg", "cust_leg", "takeaway");
      savedDocs["payment_intents/rzp_leg"] = {
        razorpayOrderId: "rzp_leg",
        orderId: "ord_leg",
        customerId: "cust_leg",
        branchId: "branch_c1",
        orderType: "takeaway",
        amountPaise: 10000,
      };
      const res = await verifyPayment(
        {
          razorpayOrderId: "rzp_leg",
          razorpayPaymentId: "pay_leg",
          razorpaySignature: "sig_valid",
        },
        { uid: "cust_leg" }
      );
      expect(res.ok).toBe(true);
      expect((res as any).order?.id).toBe("ord_leg");
    });

    it("rebuilds a missing order doc from the SERVER-written intent (spec §2)", async () => {
      savedDocs["payment_intents/rzp_rebuild"] = {
        razorpayOrderId: "rzp_rebuild",
        orderId: "ord_rebuild",
        customerId: "cust_re",
        branchId: "branch_c1",
        orderType: "delivery",
        amountPaise: 15000,
        pricing: { grandTotal: 150, split: { branchTransferPaise: 14250 } },
      };
      const res = await verifyPayment(
        {
          razorpayOrderId: "rzp_rebuild",
          razorpayPaymentId: "pay_re",
          razorpaySignature: "sig_valid",
        },
        { uid: "cust_re" }
      );
      expect(res.ok).toBe(true);
      expect((res as any).success).toBe(true);
      expect(savedDocs["orders/ord_rebuild"]).toMatchObject({
        customerId: "cust_re",
        branchId: "branch_c1",
      });
    });

    it("refuses to verify a ghost order with no server intent (404)", async () => {
      await expect(
        verifyPayment(
          {
            orderId: "ord_nothing",
            razorpayOrderId: "rzp_nothing",
            razorpayPaymentId: "pay_nothing",
            razorpaySignature: "sig_valid",
          },
          { uid: "cust_a" }
        )
      ).rejects.toMatchObject({ statusCode: 404, code: "ORDER_NOT_FOUND" });
    });

    it("refuses a payment whose intent is bound to a DIFFERENT order (409)", async () => {
      seedOrder("ord_other", "cust_a", "takeaway");
      savedDocs["payment_intents/rzp_bound"] = {
        razorpayOrderId: "rzp_bound",
        orderId: "ord_real",
        customerId: "cust_a",
        amountPaise: 10000,
      };
      await expect(
        verifyPayment(
          {
            orderId: "ord_other",
            razorpayOrderId: "rzp_bound",
            razorpayPaymentId: "pay_bound",
            razorpaySignature: "sig_valid",
          },
          { uid: "cust_a" }
        )
      ).rejects.toMatchObject({ statusCode: 409, code: "ORDER_MISMATCH" });
    });
  });

  describe("Finding 3 — reconcile-before-(re)POST, never double-pay", () => {
    it("reuses an equivalent existing transfer instead of re-POSTing", async () => {
      useLiveGateway();
      const transfer = vi.fn();
      __setRazorpayClientForTests({
        payments: {
          fetchTransfer: vi.fn(async () => ({
            items: [
              // Failed transfer first: skipped. The second matches order+amount.
              { id: "trf_failed", amount: 4000, status: "failed", notes: { orderId: "ord_r1" } },
              { id: "trf_existing", amount: 4000, status: "processed", notes: { orderId: "ord_r1" } },
            ],
          })),
          transfer,
        },
      });
      const attempt = await attemptRouteTransfer(
        "pay_r1",
        "branch_c1",
        { branchTransferPaise: 4000 },
        "ord_r1",
        "acc_c1d2e3",
        5000
      );
      expect(attempt.ok).toBe(true);
      expect(attempt.reconciled).toBe(true);
      expect(attempt.result?.id).toBe("trf_existing");
      // The hung-then-landed POST is RECORDED, never re-sent.
      expect(transfer).not.toHaveBeenCalled();
    });

    it("POSTs only when reconcile finds no equivalent transfer", async () => {
      useLiveGateway();
      const transfer = vi.fn(async () => ({ id: "trf_new" }));
      __setRazorpayClientForTests({
        payments: {
          // Another order's transfer + a different amount: neither is ours.
          fetchTransfer: vi.fn(async () => ({
            items: [
              { id: "trf_foreign", amount: 4000, status: "processed", notes: { orderId: "ord_other" } },
              { id: "trf_small", amount: 1000, status: "processed", notes: { orderId: "ord_r2" } },
            ],
          })),
          transfer,
        },
      });
      const attempt = await attemptRouteTransfer(
        "pay_r2",
        "branch_c1",
        { branchTransferPaise: 4000 },
        "ord_r2",
        "acc_c1d2e3",
        5000
      );
      expect(attempt.ok).toBe(true);
      expect(attempt.reconciled).toBeUndefined();
      expect(transfer).toHaveBeenCalledTimes(1);
    });

    it("refuses to POST when the reconcile lookup fails (unknown — park, never blind-pay)", async () => {
      useLiveGateway();
      const transfer = vi.fn();
      __setRazorpayClientForTests({
        payments: {
          fetchTransfer: vi.fn(async () => {
            throw new Error("socket hang up");
          }),
          transfer,
        },
      });
      const attempt = await attemptRouteTransfer(
        "pay_r3",
        "branch_c1",
        { branchTransferPaise: 4000 },
        "ord_r3",
        "acc_c1d2e3",
        5000
      );
      expect(attempt.ok).toBe(false);
      expect(attempt.unknown).toBe(true);
      expect(transfer).not.toHaveBeenCalled();
    });

    it("marks an ambiguous POST failure unknown; a definite 4xx stays retryable", async () => {
      useLiveGateway();
      // Ambiguous: no HTTP status — the POST may have landed. Never blind-retry.
      const ambiguous = vi.fn(async () => {
        throw new Error("read ECONNRESET");
      });
      __setRazorpayClientForTests({
        payments: { fetchTransfer: vi.fn(async () => ({ items: [] })), transfer: ambiguous },
      });
      const a = await attemptRouteTransfer(
        "pay_r4",
        "branch_c1",
        { branchTransferPaise: 4000 },
        "ord_r4",
        "acc_c1d2e3",
        5000
      );
      expect(a.ok).toBe(false);
      expect(a.unknown).toBe(true);

      // Definite 4xx: the gateway rejected it — nothing moved, safe to retry.
      const rejected = vi.fn(async () => {
        const err: any = new Error("Transfer amount is invalid");
        err.statusCode = 400;
        throw err;
      });
      __setRazorpayClientForTests({
        payments: { fetchTransfer: vi.fn(async () => ({ items: [] })), transfer: rejected },
      });
      const b = await attemptRouteTransfer(
        "pay_r5",
        "branch_c1",
        { branchTransferPaise: 4000 },
        "ord_r5",
        "acc_c1d2e3",
        5000
      );
      expect(b.ok).toBe(false);
      expect(b.unknown).toBeUndefined();
    });

    it("worker parks an unknown-outcome order in needs_reconciliation and releases the lease", async () => {
      useLiveGateway();
      const transfer = vi.fn();
      __setRazorpayClientForTests({
        payments: {
          fetchTransfer: vi.fn(async () => {
            throw new Error("gateway 500");
          }),
          transfer,
        },
      });
      savedDocs["orders/ord_park"] = {
        id: "ord_park",
        branchId: "branch_c1",
        routeTransferStatus: "pending_retry",
        routeTransferRetryCount: 0,
        pricing: { grandTotal: 100, split: { branchTransferPaise: 9000 } },
        payment: { razorpayPaymentId: "pay_park", capturedAmountPaise: 10000 },
      };
      const result = await retryPendingRouteTransfersWorker();
      expect(result.retriedCount).toBe(0);
      // No blind retry of a money POST that may already have landed.
      expect(transfer).not.toHaveBeenCalled();
      expect(savedDocs["orders/ord_park"].routeTransferStatus).toBe("needs_reconciliation");
      expect(String(savedDocs["orders/ord_park"].routeTransferError)).toMatch(/unknown/i);
      // Lease released so ops can resolve (and any future retry reconciles first).
      expect(savedDocs["orders/ord_park"].routeTransferClaimedAt).toBe("MOCK_DELETE");
    });
  });
});
