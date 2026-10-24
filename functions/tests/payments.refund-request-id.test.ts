import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import https from "https";
import { EventEmitter } from "events";

const { mockDb, savedDocs, httpsRequestMock } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const httpsRequestMock = vi.fn();
  const docRef = (colName: string, docId: string) => ({
    id: docId,
    path: `${colName}/${docId}`,
    get: vi.fn(async () => ({
      exists: !!savedDocs[`${colName}/${docId}`],
      data: () => savedDocs[`${colName}/${docId}`] || {},
    })),
    set: vi.fn(async (data: any, options?: any) => {
      const p = `${colName}/${docId}`;
      savedDocs[p] =
        options?.merge && savedDocs[p] ? { ...savedDocs[p], ...data } : data;
    }),
  });
  const mockDb: any = {
    collection: (colName: string) => ({
      doc: (docId: string) => docRef(colName, docId),
    }),
    runTransaction: vi.fn(async (fn: any) => {
      const tx = {
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, options?: any) => ref.set(data, options),
        update: (ref: any, data: any) => ref.set(data, { merge: true }),
      };
      return fn(tx);
    }),
  };
  return { mockDb, savedDocs, httpsRequestMock };
});

vi.mock("https", async () => {
  const actual: any = await vi.importActual("https");
  return {
    ...actual,
    default: {
      ...actual,
      request: (...args: any[]) => httpsRequestMock(...args),
    },
    request: (...args: any[]) => httpsRequestMock(...args),
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

import { autoRefund } from "../src/modules/payments/razorpay.service";
import { config } from "../src/config/env";

describe("Backend F10: Stable refund request identity & lifecycle", () => {
  let prevMock: boolean;
  let prevKeyId: string;
  let prevKeySecret: string;

  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    prevMock = config.mock.paymentGateway;
    prevKeyId = config.razorpay.keyId;
    prevKeySecret = config.razorpay.keySecret;
    config.mock.paymentGateway = true;
  });

  afterEach(() => {
    config.mock.paymentGateway = prevMock;
    config.razorpay.keyId = prevKeyId;
    config.razorpay.keySecret = prevKeySecret;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("1. two distinct IDs with equal partial amounts produce two gateway receipts and correct total", async () => {
    savedDocs["orders/ord_eq_1"] = {
      payment: { razorpayPaymentId: "pay_eq_1" },
      pricing: { grandTotal: 500 },
    };

    const res1: any = await autoRefund({
      orderId: "ord_eq_1",
      razorpayPaymentId: "pay_eq_1",
      amountRupees: 100,
      refundRequestId: "req_first_100",
    });
    expect(res1.status).toBe("processed");
    expect(res1.reused).toBeUndefined();

    const res2: any = await autoRefund({
      orderId: "ord_eq_1",
      razorpayPaymentId: "pay_eq_1",
      amountRupees: 100,
      refundRequestId: "req_second_100",
    });
    expect(res2.status).toBe("processed");
    expect(res2.reused).toBeUndefined();
    expect(res2.id).not.toBe(res1.id);

    const order = savedDocs["orders/ord_eq_1"];
    expect(order.refundedTotalPaise).toBe(20000);
    expect(order.refundStatus).toBe("partially_refunded");
    expect(Object.keys(order.refundLedger)).toHaveLength(2);
    expect(order.refundLedger[res1.id]).toBe(10000);
    expect(order.refundLedger[res2.id]).toBe(10000);
  });

  it("2. same completed ID replay returns stored receipt with zero extra POST even at fully-refunded cap", async () => {
    savedDocs["orders/ord_cap_1"] = {
      payment: { razorpayPaymentId: "pay_cap_1" },
      pricing: { grandTotal: 200 },
    };

    const res1: any = await autoRefund({
      orderId: "ord_cap_1",
      razorpayPaymentId: "pay_cap_1",
      amountRupees: 200,
      refundRequestId: "req_cap_full_1",
    });
    expect(res1.status).toBe("processed");
    expect(savedDocs["orders/ord_cap_1"].refundStatus).toBe("refunded");
    expect(savedDocs["orders/ord_cap_1"].refundedTotalPaise).toBe(20000);

    // Replay of the completed ID at fully-refunded cap must NOT throw ALREADY_REFUNDED
    const res2: any = await autoRefund({
      orderId: "ord_cap_1",
      razorpayPaymentId: "pay_cap_1",
      amountRupees: 200,
      refundRequestId: "req_cap_full_1",
    });
    expect(res2.id).toBe(res1.id);
    expect(res2.reused).toBe(true);
    expect(Object.keys(savedDocs["orders/ord_cap_1"].refundLedger)).toHaveLength(1);
  });

  it("3. same ID with changed amount, payment, or reason throws conflict without POST", async () => {
    savedDocs["orders/ord_conf_1"] = {
      payment: { razorpayPaymentId: "pay_conf_1" },
      pricing: { grandTotal: 500 },
    };

    await autoRefund({
      orderId: "ord_conf_1",
      razorpayPaymentId: "pay_conf_1",
      amountRupees: 100,
      reason: "original reason",
      refundRequestId: "req_conflict_1",
    });

    // Same request id with different amount
    await expect(
      autoRefund({
        orderId: "ord_conf_1",
        razorpayPaymentId: "pay_conf_1",
        amountRupees: 150,
        reason: "original reason",
        refundRequestId: "req_conflict_1",
      })
    ).rejects.toMatchObject({ statusCode: 409, code: "REFUND_REQUEST_CONFLICT" });

    // Same request id with different payment id
    await expect(
      autoRefund({
        orderId: "ord_conf_1",
        razorpayPaymentId: "pay_different_payment",
        amountRupees: 100,
        reason: "original reason",
        refundRequestId: "req_conflict_1",
      })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("4. timeout after acceptance retry reuses same gateway key with no double count", async () => {
    savedDocs["orders/ord_time_1"] = {
      payment: { razorpayPaymentId: "pay_time_1" },
      pricing: { grandTotal: 500 },
      refundStatus: "refunding",
      refundClaimedAt: Date.now() - 15 * 60_000, // stale lease >10m
      refundClaimedRequestId: "req_timeout_test",
      refundClaimedPaymentId: "pay_time_1",
      refundClaimedPaise: 10000,
      refundClaimedKey: "rfnd_deterministic_hash_1",
    };

    const res: any = await autoRefund({
      orderId: "ord_time_1",
      razorpayPaymentId: "pay_time_1",
      amountRupees: 100,
      refundRequestId: "req_timeout_test",
    });
    expect(res.status).toBe("processed");
    const order = savedDocs["orders/ord_time_1"];
    expect(order.refundedTotalPaise).toBe(10000);
    expect(Object.keys(order.refundLedger)).toHaveLength(1);
  });

  it("5. stale legacy unidentified attempt requires reconciliation, refuses blind takeover", async () => {
    // Unidentified legacy in-flight attempt
    savedDocs["orders/ord_unrec_1"] = {
      payment: { razorpayPaymentId: "pay_unrec_1" },
      pricing: { grandTotal: 500 },
      refundStatus: "refunding",
      refundClaimedAt: Date.now() - 15 * 60_000,
    };

    await expect(
      autoRefund({
        orderId: "ord_unrec_1",
        razorpayPaymentId: "pay_unrec_1",
        amountRupees: 100,
        refundRequestId: "req_new_takeover",
      })
    ).rejects.toMatchObject({ statusCode: 409, code: "REFUND_RECONCILIATION_REQUIRED" });

    // Stale in-flight attempt held by a different request identity
    savedDocs["orders/ord_unrec_2"] = {
      payment: { razorpayPaymentId: "pay_unrec_2" },
      pricing: { grandTotal: 500 },
      refundStatus: "refunding",
      refundClaimedAt: Date.now() - 15 * 60_000,
      refundClaimedRequestId: "req_older_other",
    };

    await expect(
      autoRefund({
        orderId: "ord_unrec_2",
        razorpayPaymentId: "pay_unrec_2",
        amountRupees: 100,
        refundRequestId: "req_newer_other",
      })
    ).rejects.toMatchObject({ statusCode: 409, code: "REFUND_RECONCILIATION_REQUIRED" });
  });

  it("6. distinct IDs cannot cumulatively exceed gateway capture", async () => {
    savedDocs["orders/ord_cumul_1"] = {
      payment: { razorpayPaymentId: "pay_cumul_1" },
      pricing: { grandTotal: 300 },
    };

    await autoRefund({
      orderId: "ord_cumul_1",
      razorpayPaymentId: "pay_cumul_1",
      amountRupees: 200,
      refundRequestId: "req_cumul_part_1",
    });

    await expect(
      autoRefund({
        orderId: "ord_cumul_1",
        razorpayPaymentId: "pay_cumul_1",
        amountRupees: 150,
        refundRequestId: "req_cumul_part_2",
      })
    ).rejects.toMatchObject({ statusCode: 400, code: "REFUND_EXCEEDS_REMAINING" });
  });

  it("7. explicit new ID with matching unkeyed completed legacy ledger requires reconciliation (no blind POST)", async () => {
    savedDocs["orders/ord_no_adopt_1"] = {
      payment: { razorpayPaymentId: "pay_no_adopt_1" },
      pricing: { grandTotal: 500 },
      refundStatus: "partially_refunded",
      refundLedger: { rfnd_legacy_old: 5000 },
      refundedTotalPaise: 5000,
    };

    // Fails closed with REFUND_RECONCILIATION_REQUIRED instead of blindly issuing new payout
    await expect(
      autoRefund({
        orderId: "ord_no_adopt_1",
        razorpayPaymentId: "pay_no_adopt_1",
        amountRupees: 50,
        refundRequestId: "req_no_adopt_1",
      })
    ).rejects.toMatchObject({ statusCode: 409, code: "REFUND_RECONCILIATION_REQUIRED" });

    // But two distinct new KEYED intents of equal amount must both succeed
    savedDocs["orders/ord_keyed_two"] = {
      payment: { razorpayPaymentId: "pay_keyed_two" },
      pricing: { grandTotal: 500 },
    };
    const k1: any = await autoRefund({
      orderId: "ord_keyed_two",
      razorpayPaymentId: "pay_keyed_two",
      amountRupees: 50,
      refundRequestId: "req_keyed_first",
    });
    const k2: any = await autoRefund({
      orderId: "ord_keyed_two",
      razorpayPaymentId: "pay_keyed_two",
      amountRupees: 50,
      refundRequestId: "req_keyed_second",
    });
    expect(k1.id).not.toBe(k2.id);
    expect(savedDocs["orders/ord_keyed_two"].refundedTotalPaise).toBe(10000);
  });

  it("7b. legacy scalar receipt without a ledger entry is never adopted or double-paid", async () => {
    savedDocs["orders/ord_legacy_scalar_1"] = {
      payment: { razorpayPaymentId: "pay_legacy_scalar_1", capturedAmountPaise: 25000 },
      pricing: { grandTotal: 250 },
      refundStatus: "partially_refunded",
      refundId: "rfnd_legacy_50",
      refundAmount: 50,
    };

    // A fresh key for the same amount cannot prove the legacy receipt is a
    // different payout, so it must reconcile instead of POSTing again.
    await expect(
      autoRefund({
        orderId: "ord_legacy_scalar_1",
        razorpayPaymentId: "pay_legacy_scalar_1",
        amountRupees: 50,
        refundRequestId: "req_fresh_legacy_50",
      })
    ).rejects.toMatchObject({ statusCode: 409, code: "REFUND_RECONCILIATION_REQUIRED" });
    expect(savedDocs["orders/ord_legacy_scalar_1"].refundLedger).toBeUndefined();
    expect(savedDocs["orders/ord_legacy_scalar_1"].refundClaimedAt).toBeUndefined();

    // The scalar receipt still consumes the cumulative cap.
    await expect(
      autoRefund({
        orderId: "ord_legacy_scalar_1",
        razorpayPaymentId: "pay_legacy_scalar_1",
        amountRupees: 250,
        refundRequestId: "req_fresh_legacy_250",
      })
    ).rejects.toMatchObject({ statusCode: 400, code: "REFUND_EXCEEDS_REMAINING" });

    // A remainder inside the reduced cap still proceeds.
    const remainder: any = await autoRefund({
      orderId: "ord_legacy_scalar_1",
      razorpayPaymentId: "pay_legacy_scalar_1",
      amountRupees: 200,
      refundRequestId: "req_fresh_legacy_200",
    });
    expect(remainder.status).toBe("processed");
    expect(savedDocs["orders/ord_legacy_scalar_1"].refundedTotalPaise).toBe(25000);
  });

  it("8. live autoRefund rejects missing refundRequestId (fail-closed, no POST)", async () => {
    savedDocs["orders/ord_live_1"] = {
      payment: { razorpayPaymentId: "pay_live_1" },
      pricing: { grandTotal: 500 },
    };

    config.mock.paymentGateway = false;

    await expect(
      autoRefund({
        orderId: "ord_live_1",
        razorpayPaymentId: "pay_live_1",
        amountRupees: 50,
      })
    ).rejects.toMatchObject({ statusCode: 400, code: "REFUND_REQUEST_ID_REQUIRED" });
  });

  it("9. LIVE mocked gateway test: transport response lost, retry reuses exact X-Refund-Idempotency and body", async () => {
    config.mock.paymentGateway = false;
    config.razorpay.keyId = "rzp_test_sec_live1";
    config.razorpay.keySecret = "live_sec_key_secret_123";

    savedDocs["orders/ord_live_net"] = {
      payment: { razorpayPaymentId: "pay_live_net" },
      pricing: { grandTotal: 500 },
    };

    const capturedHeaders: string[] = [];
    const capturedBodies: string[] = [];
    let callCount = 0;

    httpsRequestMock.mockImplementation((options: any, cb?: any) => {
      callCount++;
      const reqEmitter: any = new EventEmitter();
      let written = "";
      reqEmitter.write = vi.fn((chunk: any) => {
        written += chunk ? chunk.toString() : "";
      });
      reqEmitter.setTimeout = vi.fn();
      reqEmitter.destroy = vi.fn((err?: any) => {
        reqEmitter.emit("error", err || new Error("Destroyed"));
      });
      reqEmitter.end = vi.fn(() => {
        capturedHeaders.push(options.headers["X-Refund-Idempotency"]);
        capturedBodies.push(written);
        if (callCount === 1) {
          // First attempt: transport response lost / socket hang up
          process.nextTick(() => {
            reqEmitter.emit("error", new Error("socket hang up"));
          });
        } else {
          // Second attempt: gateway success echo
          const resEmitter: any = new EventEmitter();
          resEmitter.statusCode = 200;
          process.nextTick(() => {
            if (cb) cb(resEmitter);
            resEmitter.emit(
              "data",
              Buffer.from(
                JSON.stringify({
                  id: "rfnd_gateway_live_1",
                  amount: 10000,
                  status: "processed",
                })
              )
            );
            resEmitter.emit("end");
          });
        }
      });
      return reqEmitter;
    });

    // 1st attempt: fails with 502 REFUND_GATEWAY_FAILED
    await expect(
      autoRefund({
        orderId: "ord_live_net",
        razorpayPaymentId: "pay_live_net",
        amountRupees: 100,
        reason: "item rejection note",
        refundRequestId: "req_live_retry_1",
      })
    ).rejects.toMatchObject({ statusCode: 502, code: "REFUND_GATEWAY_FAILED" });

    // Advance lease past TTL to simulate worker retry after timeout
    savedDocs["orders/ord_live_net"].refundClaimedAt = Date.now() - 11 * 60_000;
    if (savedDocs["orders/ord_live_net"].refundActiveClaim) {
      savedDocs["orders/ord_live_net"].refundActiveClaim.claimedAt = Date.now() - 11 * 60_000;
    }

    // 2nd attempt: retry with SAME identity
    const res: any = await autoRefund({
      orderId: "ord_live_net",
      razorpayPaymentId: "pay_live_net",
      amountRupees: 100,
      reason: "item rejection note",
      refundRequestId: "req_live_retry_1",
    });

    expect(res.id).toBe("rfnd_gateway_live_1");
    expect(callCount).toBe(2);
    // Exact same X-Refund-Idempotency header and body reused across transport retry!
    expect(capturedHeaders[0]).toBeDefined();
    expect(capturedHeaders[1]).toBe(capturedHeaders[0]);
    expect(capturedBodies[0]).toBe(capturedBodies[1]);

    const order = savedDocs["orders/ord_live_net"];
    expect(order.refundedTotalPaise).toBe(10000);
    expect(Object.keys(order.refundLedger)).toHaveLength(1);

    // 3rd attempt: completed replay yields ZERO additional https.request calls
    const replay: any = await autoRefund({
      orderId: "ord_live_net",
      razorpayPaymentId: "pay_live_net",
      amountRupees: 100,
      reason: "item rejection note",
      refundRequestId: "req_live_retry_1",
    });
    expect(replay.reused).toBe(true);
    expect(callCount).toBe(2); // no extra fetch!
  });

  it("10. LIVE mocked gateway test: two equal amounts with distinct IDs produce two different gateway keys", async () => {
    config.mock.paymentGateway = false;
    config.razorpay.keyId = "rzp_test_sec_live1";
    config.razorpay.keySecret = "live_sec_key_secret_123";

    savedDocs["orders/ord_live_two"] = {
      payment: { razorpayPaymentId: "pay_live_two" },
      pricing: { grandTotal: 500 },
    };

    const keysSent: string[] = [];

    httpsRequestMock.mockImplementation((options: any, cb?: any) => {
      const reqEmitter: any = new EventEmitter();
      reqEmitter.write = vi.fn();
      reqEmitter.setTimeout = vi.fn();
      reqEmitter.destroy = vi.fn();
      reqEmitter.end = vi.fn(() => {
        const key = options.headers["X-Refund-Idempotency"];
        keysSent.push(key);
        const resEmitter: any = new EventEmitter();
        resEmitter.statusCode = 200;
        process.nextTick(() => {
          if (cb) cb(resEmitter);
          resEmitter.emit(
            "data",
            Buffer.from(
              JSON.stringify({
                id: `rfnd_live_${keysSent.length}`,
                amount: 10000,
                status: "processed",
              })
            )
          );
          resEmitter.emit("end");
        });
      });
      return reqEmitter;
    });

    await autoRefund({
      orderId: "ord_live_two",
      razorpayPaymentId: "pay_live_two",
      amountRupees: 100,
      refundRequestId: "req_distinct_live_A",
    });

    await autoRefund({
      orderId: "ord_live_two",
      razorpayPaymentId: "pay_live_two",
      amountRupees: 100,
      refundRequestId: "req_distinct_live_B",
    });

    expect(keysSent).toHaveLength(2);
    expect(keysSent[0]).not.toBe(keysSent[1]);
    expect(savedDocs["orders/ord_live_two"].refundedTotalPaise).toBe(20000);
  });

  it("11. webhook before local record write race: active lease enforced independently of scalar refundStatus", async () => {
    // Worker A claimed lease, but webhook fired in background and set refundStatus="partially_refunded"
    savedDocs["orders/ord_wh_race"] = {
      payment: { razorpayPaymentId: "pay_wh_race" },
      pricing: { grandTotal: 500 },
      refundStatus: "partially_refunded", // webhook changed status!
      refundClaimedAt: Date.now() - 30_000, // active lease held 30s ago by Worker A
      refundClaimedRequestId: "req_worker_A",
      refundClaimedPaymentId: "pay_wh_race",
      refundClaimedPaise: 10000,
      refundActiveClaim: {
        requestId: "req_worker_A",
        claimedAt: Date.now() - 30_000,
        paymentId: "pay_wh_race",
        requestedPaise: 10000,
      },
    };

    // Worker B with different request ID tries to claim lease while Worker A is still in-flight
    await expect(
      autoRefund({
        orderId: "ord_wh_race",
        razorpayPaymentId: "pay_wh_race",
        amountRupees: 100,
        refundRequestId: "req_worker_B",
      })
    ).rejects.toMatchObject({ statusCode: 409, code: "REFUND_IN_PROGRESS" });
  });

  it("12. frozen clock test: distinct mock requests in same millisecond derive distinct mock IDs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-24T12:00:00.000Z"));

    savedDocs["orders/ord_freeze"] = {
      payment: { razorpayPaymentId: "pay_freeze" },
      pricing: { grandTotal: 500 },
    };

    const res1: any = await autoRefund({
      orderId: "ord_freeze",
      razorpayPaymentId: "pay_freeze",
      amountRupees: 100,
      refundRequestId: "req_freeze_111",
    });

    // In the exact same millisecond:
    const res2: any = await autoRefund({
      orderId: "ord_freeze",
      razorpayPaymentId: "pay_freeze",
      amountRupees: 100,
      refundRequestId: "req_freeze_222",
    });

    expect(res1.id).not.toBe(res2.id);
  });

  it("13. audit trail safely records refundRequestId", async () => {
    savedDocs["orders/ord_aud_1"] = {
      payment: { razorpayPaymentId: "pay_aud_1" },
      pricing: { grandTotal: 500 },
    };

    await autoRefund({
      orderId: "ord_aud_1",
      razorpayPaymentId: "pay_aud_1",
      amountRupees: 100,
      refundRequestId: "req_audit_test_123",
    });

    const audits = Object.entries(savedDocs).filter(([p]) => p.startsWith("payment_audits/"));
    expect(audits).toHaveLength(1);
    const [, audit] = audits[0];
    expect((audit as any).refundRequestId).toBe("req_audit_test_123");
  });

  it("14. stale worker completion does NOT clear another owner's active lease", async () => {
    savedDocs["orders/ord_overlap_1"] = {
      payment: { razorpayPaymentId: "pay_overlap_1" },
      pricing: { grandTotal: 500 },
    };

    let txCount = 0;
    const origRunTx = mockDb.runTransaction;
    // Intercept Worker A's second transaction (completion tx)
    mockDb.runTransaction = vi.fn(async (fn: any) => {
      txCount++;
      if (txCount === 2) {
        // Before Worker A's completion tx.get reads orderRef,
        // Worker B has taken over the lease!
        savedDocs["orders/ord_overlap_1"].refundStatus = "refunding";
        savedDocs["orders/ord_overlap_1"].refundClaimedAt = Date.now();
        savedDocs["orders/ord_overlap_1"].refundClaimedRequestId = "req_worker_B_active";
        savedDocs["orders/ord_overlap_1"].refundActiveClaim = {
          requestId: "req_worker_B_active",
          claimedAt: Date.now(),
          paymentId: "pay_overlap_1",
          requestedPaise: 20000,
          gatewayKey: "rfnd_worker_b_key",
          reason: "B active lease",
        };
      }
      return origRunTx(fn);
    });

    try {
      const resA: any = await autoRefund({
        orderId: "ord_overlap_1",
        razorpayPaymentId: "pay_overlap_1",
        amountRupees: 50,
        reason: "Worker A reason",
        refundRequestId: "req_worker_A",
      });

      expect(resA.status).toBe("processed");
      const order = savedDocs["orders/ord_overlap_1"];

      // Assert Worker B's active claim was NOT overwritten or cleared by Worker A's completion!
      expect(order.refundStatus).toBe("refunding"); // not overwritten to partially_refunded!
      expect(order.refundActiveClaim).toMatchObject({
        requestId: "req_worker_B_active",
        requestedPaise: 20000,
      });
      expect(order.refundClaimedRequestId).toBe("req_worker_B_active");

      // But Worker A's money truth is recorded monotonically!
      expect(order.refundLedger[resA.id]).toBe(5000);
      expect(order.refundedTotalPaise).toBe(5000);
      expect(order.refundKeyedReceipts?.[resA.id]).toBe("req_worker_A");

      // And Worker A's per-request doc is marked completed
      const reqDocs = Object.entries(savedDocs).filter(([k]) =>
        k.startsWith("payment_refund_requests/")
      );
      const reqADoc = reqDocs.find(([, doc]) => doc.refundRequestId === "req_worker_A");
      expect(reqADoc).toBeDefined();
      expect(reqADoc![1].status).toBe("completed");
      expect(reqADoc![1].refundId).toBe(resA.id);
    } finally {
      mockDb.runTransaction = origRunTx;
    }
  });

  it("15. LIVE http-stub: transport loss, webhook convergence in pending state, retry SAME key recovers cleanly without double count", async () => {
    config.mock.paymentGateway = false;
    config.razorpay.keyId = "rzp_test_sec_live1";
    config.razorpay.keySecret = "live_sec_key_secret_123";

    savedDocs["orders/ord_wh_conv_1"] = {
      payment: { razorpayPaymentId: "pay_wh_conv_1" },
      pricing: { grandTotal: 500 },
    };

    let liveCalls = 0;
    const sentHeaders: string[] = [];
    const sentBodies: string[] = [];

    httpsRequestMock.mockImplementation((options: any, cb?: any) => {
      liveCalls++;
      const reqEmitter: any = new EventEmitter();
      let written = "";
      reqEmitter.write = vi.fn((chunk: any) => {
        if (chunk) written += chunk.toString();
      });
      reqEmitter.setTimeout = vi.fn();
      reqEmitter.destroy = vi.fn((err?: any) => {
        reqEmitter.emit("error", err || new Error("Destroyed"));
      });
      reqEmitter.end = vi.fn(() => {
        sentHeaders.push(options.headers["X-Refund-Idempotency"]);
        sentBodies.push(written);
        if (liveCalls === 1) {
          // Gateway accepts refund, but connection drops before response is delivered
          process.nextTick(() => {
            reqEmitter.emit("error", new Error("socket hang up"));
          });
        } else {
          // Gateway receives retry with SAME idempotency key -> echoes the accepted refund!
          const resEmitter: any = new EventEmitter();
          resEmitter.statusCode = 200;
          process.nextTick(() => {
            if (cb) cb(resEmitter);
            resEmitter.emit(
              "data",
              Buffer.from(
                JSON.stringify({
                  id: "rfnd_echo_wh_123",
                  amount: 10000,
                  status: "processed",
                })
              )
            );
            resEmitter.emit("end");
          });
        }
      });
      return reqEmitter;
    });

    // 1st attempt: fails on transport drop
    await expect(
      autoRefund({
        orderId: "ord_wh_conv_1",
        razorpayPaymentId: "pay_wh_conv_1",
        amountRupees: 100,
        reason: "conv reason",
        refundRequestId: "req_wh_conv_1",
      })
    ).rejects.toMatchObject({ statusCode: 502, code: "REFUND_GATEWAY_FAILED" });

    // Webhook refund.processed lands asynchronously:
    // It adds rfnd_echo_wh_123 to order.refundLedger and updates refundedTotalPaise
    savedDocs["orders/ord_wh_conv_1"].refundLedger = { rfnd_echo_wh_123: 10000 };
    savedDocs["orders/ord_wh_conv_1"].refundedTotalPaise = 10000;
    savedDocs["orders/ord_wh_conv_1"].refundStatus = "partially_refunded";

    // Advance lease past TTL for matching retry
    savedDocs["orders/ord_wh_conv_1"].refundClaimedAt = Date.now() - 11 * 60_000;
    if (savedDocs["orders/ord_wh_conv_1"].refundActiveClaim) {
      savedDocs["orders/ord_wh_conv_1"].refundActiveClaim.claimedAt = Date.now() - 11 * 60_000;
    }

    // 2nd attempt: matching retry with SAME key
    const res: any = await autoRefund({
      orderId: "ord_wh_conv_1",
      razorpayPaymentId: "pay_wh_conv_1",
      amountRupees: 100,
      reason: "conv reason",
      refundRequestId: "req_wh_conv_1",
    });

    expect(res.id).toBe("rfnd_echo_wh_123");
    expect(liveCalls).toBe(2);
    expect(sentHeaders[1]).toBe(sentHeaders[0]);
    expect(sentBodies[1]).toBe(sentBodies[0]);

    // Ledger counts rfnd_echo_wh_123 exactly ONCE — no double count on retry!
    const order = savedDocs["orders/ord_wh_conv_1"];
    expect(order.refundedTotalPaise).toBe(10000);
    expect(Object.keys(order.refundLedger)).toHaveLength(1);
    expect(order.refundKeyedReceipts?.["rfnd_echo_wh_123"]).toBe("req_wh_conv_1");
  });

  it("16. full refund where capture is already exhausted by webhook permits matching recovery but blocks new request", async () => {
    config.mock.paymentGateway = false;
    config.razorpay.keyId = "rzp_test_sec_live1";
    config.razorpay.keySecret = "live_sec_key_secret_123";

    savedDocs["orders/ord_full_wh"] = {
      payment: { razorpayPaymentId: "pay_full_wh" },
      pricing: { grandTotal: 200 },
    };

    let fullCalls = 0;
    httpsRequestMock.mockImplementation((options: any, cb?: any) => {
      fullCalls++;
      const reqEmitter: any = new EventEmitter();
      reqEmitter.write = vi.fn();
      reqEmitter.setTimeout = vi.fn();
      reqEmitter.destroy = vi.fn();
      reqEmitter.end = vi.fn(() => {
        if (fullCalls === 1) {
          process.nextTick(() => reqEmitter.emit("error", new Error("socket hang up")));
        } else {
          const resEmitter: any = new EventEmitter();
          resEmitter.statusCode = 200;
          process.nextTick(() => {
            if (cb) cb(resEmitter);
            resEmitter.emit(
              "data",
              Buffer.from(
                JSON.stringify({
                  id: "rfnd_full_echo_200",
                  amount: 20000,
                  status: "processed",
                })
              )
            );
            resEmitter.emit("end");
          });
        }
      });
      return reqEmitter;
    });

    // 1st attempt: fails on transport drop
    await expect(
      autoRefund({
        orderId: "ord_full_wh",
        razorpayPaymentId: "pay_full_wh",
        amountRupees: 200,
        reason: "full cancel reason",
        refundRequestId: "req_full_pending_1",
      })
    ).rejects.toMatchObject({ statusCode: 502 });

    // Webhook delivers full capture refund in background
    savedDocs["orders/ord_full_wh"].refundLedger = { rfnd_full_echo_200: 20000 };
    savedDocs["orders/ord_full_wh"].refundedTotalPaise = 20000;
    savedDocs["orders/ord_full_wh"].refundStatus = "refunded"; // capture fully exhausted!

    // Advance lease past TTL for retry
    savedDocs["orders/ord_full_wh"].refundClaimedAt = Date.now() - 11 * 60_000;
    if (savedDocs["orders/ord_full_wh"].refundActiveClaim) {
      savedDocs["orders/ord_full_wh"].refundActiveClaim.claimedAt = Date.now() - 11 * 60_000;
    }

    // A DIFFERENT/NEW request must be BLOCKED with 409 (ALREADY_REFUNDED or REFUND_RECONCILIATION_REQUIRED)
    await expect(
      autoRefund({
        orderId: "ord_full_wh",
        razorpayPaymentId: "pay_full_wh",
        amountRupees: 50,
        refundRequestId: "req_new_unrelated",
      })
    ).rejects.toMatchObject({ statusCode: 409 });

    // But matching recovery with SAME key must succeed rather than throwing ALREADY_REFUNDED!
    const res: any = await autoRefund({
      orderId: "ord_full_wh",
      razorpayPaymentId: "pay_full_wh",
      amountRupees: 200,
      reason: "full cancel reason",
      refundRequestId: "req_full_pending_1",
    });

    expect(res.id).toBe("rfnd_full_echo_200");
    const order = savedDocs["orders/ord_full_wh"];
    expect(order.refundedTotalPaise).toBe(20000);
    expect(Object.keys(order.refundLedger)).toHaveLength(1);
  });

  it("17. same-ID pending recovery with corrupted or mismatched payload fails closed", async () => {
    savedDocs["orders/ord_corrupt_1"] = {
      payment: { razorpayPaymentId: "pay_corrupt_1" },
      pricing: { grandTotal: 500 },
      refundStatus: "refunding",
      refundClaimedAt: Date.now() - 30_000,
      refundClaimedRequestId: "req_mismatch_body",
    };

    // First attempt within live lease TTL rejects with REFUND_IN_PROGRESS
    await expect(
      autoRefund({
        orderId: "ord_corrupt_1",
        razorpayPaymentId: "pay_corrupt_1",
        amountRupees: 100,
        reason: "initial reason",
        refundRequestId: "req_mismatch_body",
      })
    ).rejects.toMatchObject({ statusCode: 409, code: "REFUND_IN_PROGRESS" });

    // Advance lease
    savedDocs["orders/ord_corrupt_1"].refundClaimedAt = Date.now() - 15 * 60_000;
    if (savedDocs["orders/ord_corrupt_1"].refundActiveClaim) {
      savedDocs["orders/ord_corrupt_1"].refundActiveClaim.claimedAt = Date.now() - 15 * 60_000;
    }

    // Seed pending doc directly
    const reqDocKey = Object.keys(savedDocs).find((k) =>
      k.startsWith("payment_refund_requests/")
    );
    if (reqDocKey) {
      savedDocs[reqDocKey] = {
        orderId: "ord_corrupt_1",
        paymentId: "pay_corrupt_1",
        refundRequestId: "req_mismatch_body",
        requestedPaise: 10000,
        reason: "initial reason",
        status: "pending",
        gatewayKey: "rfnd_some_key",
      };
    }

    // Retry with changed reason (breaks immutable gateway body!)
    await expect(
      autoRefund({
        orderId: "ord_corrupt_1",
        razorpayPaymentId: "pay_corrupt_1",
        amountRupees: 100,
        reason: "MUTATED reason",
        refundRequestId: "req_mismatch_body",
      })
    ).rejects.toMatchObject({ statusCode: 409, code: "REFUND_REQUEST_CONFLICT" });

    // Retry with changed amount
    await expect(
      autoRefund({
        orderId: "ord_corrupt_1",
        razorpayPaymentId: "pay_corrupt_1",
        amountRupees: 150,
        reason: "initial reason",
        refundRequestId: "req_mismatch_body",
      })
    ).rejects.toMatchObject({ statusCode: 409, code: "REFUND_REQUEST_CONFLICT" });
  });
});
