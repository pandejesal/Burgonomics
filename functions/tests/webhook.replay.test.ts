import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// These tests drive the REAL handleRazorpayWebhook (not a local
// re-implementation): replay idempotency via the audit-claim doc, stale-claim
// takeover, and unmatched-payment parking.

const { mockDb, savedDocs } = vi.hoisted(() => {
  // The webhook confirm path now satisfies the delivery-OTP invariant (B6/C12),
  // and getOtpHmacSecret() is FAIL-CLOSED, so this suite must provide the
  // dedicated secret exactly as a real deployment does (functions/.env sets it;
  // it is one of env.ts's REQUIRED_SECRETS). Without this, a delivery confirm
  // would throw instead of minting the handover hash.
  process.env.OTP_HMAC_SECRET = "test_otp_replay_webhook";
  const savedDocs: Record<string, any> = {};
  const docRef = (colName: string, docId: string) => ({
    id: docId,
    path: `${colName}/${docId}`,
    get: vi.fn(async () => ({
      exists: !!savedDocs[`${colName}/${docId}`],
      data: () => savedDocs[`${colName}/${docId}`] || {},
      // orderPush.ts mock path writes through orderDoc.ref
      ref: docRef(colName, docId),
    })),
    set: vi.fn(async (data: any, options?: any) => {
      const docPath = `${colName}/${docId}`;
      savedDocs[docPath] =
        options?.merge && savedDocs[docPath] ? { ...savedDocs[docPath], ...data } : data;
    }),
    // Mirrors Firestore create(): fails when the doc already exists.
    create: vi.fn(async (data: any) => {
      const docPath = `${colName}/${docId}`;
      if (savedDocs[docPath]) {
        const err: any = new Error("ALREADY_EXISTS: Document already exists");
        err.code = 6;
        throw err;
      }
      savedDocs[docPath] = data;
    }),
    update: vi.fn(async (data: any) => {
      const docPath = `${colName}/${docId}`;
      savedDocs[docPath] = { ...(savedDocs[docPath] || {}), ...data };
    }),
  });
  const mockDb = {
    collection: (colName: string) => ({
      doc: (docId?: string) => docRef(colName, docId || `mock_${Math.random().toString(36).slice(2, 8)}`),
      // Refund branch queries orders by payment id; additive — existing tests
      // never call where(), so this only serves the refund-parking test.
      where: (field: string, op: string, value: any) => ({
        limit: (n: number) => ({
          get: vi.fn(async () => {
            const getPath = (obj: any, path: string) =>
              path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
            const docs = Object.entries(savedDocs)
              .filter(([k, v]) => k.startsWith("orders/") && getPath(v, field) === value)
              .map(([k, v]) => ({
                id: k.split("/")[1],
                ref: docRef(k.split("/")[0], k.split("/")[1]),
                data: () => v,
              }));
            return { empty: docs.length === 0, docs };
          }),
        }),
      }),
    }),
    // Transaction seam used by executeRouteSplit's claim and the
    // refund.processed per-refund ledger. Thin shim over the same doc mock.
    runTransaction: vi.fn(async (fn: (tx: any) => Promise<any>) =>
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

const capturedPayload = (eventId: string) => ({
  id: eventId,
  event: "payment.captured",
  payload: {
    payment: {
      entity: {
        id: "pay_test_123",
        amount: 25000,
        currency: "INR",
        notes: { orderId: "order_replay_1", branchId: "branch_surat_01" },
      },
    },
  },
});

describe("Razorpay webhook idempotency (real handler)", () => {
  // Explicit sandbox opt-in (was auto-mock): this suite exercises
  // idempotency, not auth — auth-denial is covered by webhook.reject.test.ts
  // (S1) and env.failclosed.test.ts (S3). Fail-closed env defaults to live.
  let prevPg = false;
  let prevPp = false;
  beforeEach(() => {
    prevPg = config.mock.paymentGateway;
    prevPp = config.mock.petpoojaPos;
    config.mock.paymentGateway = true;
    config.mock.petpoojaPos = true;
  });
  afterEach(() => {
    config.mock.paymentGateway = prevPg;
    config.mock.petpoojaPos = prevPp;
  });

  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    savedDocs["orders/order_replay_1"] = {
      id: "order_replay_1",
      branchId: "branch_surat_01",
      customerPhone: "+91 90000 00000",
      paymentStatus: "pending",
      // B8: an order doc with NO stored amount is no longer blind-confirmed —
      // it parks `confirm_amount_unknown`. These tests are about idempotency
      // and dedupe, not amount resolution, so the fixture carries the known
      // server total (₹250 = the 25000-paise capture every payload here uses).
      pricing: { grandTotal: 250 },
    };
  });

  it("processes once: a replayed event returns already_processed with no second KOT push", async () => {
    const first = mockReqRes(capturedPayload("evt_replay_9"));
    await handleRazorpayWebhook(first.req, first.res);
    expect(first.out().statusCode).toBe(200);
    expect(first.out().body).toMatchObject({ status: "ok" });

    const firstKotId = savedDocs["orders/order_replay_1"].petpoojaOrderId;
    expect(firstKotId).toMatch(/^pp_kot_/);
    expect(savedDocs["orders/order_replay_1"].paymentStatus).toBe("completed");
    // The nested payment object is what the customer app's finalizePaidOrder
    // reads; top-level/dotted markers alone leave it refusing a paid order.
    expect(savedDocs["orders/order_replay_1"].payment).toMatchObject({
      status: "completed",
      razorpayPaymentId: "pay_test_123",
      transactionId: "pay_test_123",
      capturedAmountPaise: 25000,
    });

    const second = mockReqRes(capturedPayload("evt_replay_9"));
    await handleRazorpayWebhook(second.req, second.res);
    expect(second.out().statusCode).toBe(200);
    expect(second.out().body).toMatchObject({ status: "already_processed" });
    // No second KOT push happened — the order doc is untouched by the replay.
    expect(savedDocs["orders/order_replay_1"].petpoojaOrderId).toBe(firstKotId);
  });

  // Robustness, and the opposite failure mode to every other test here: a
  // provider event we do not implement must be ACKed, not 500'd. Razorpay
  // retries a non-2xx delivery forever, so throwing on an unrecognised event
  // would turn a routine provider addition into an unbounded retry storm
  // against our function. The claim must also COMPLETE, so a redelivery of the
  // same event is deduped instead of reprocessed.
  it("ACKs an unrecognised event, leaves the order untouched, and still dedups a redelivery", async () => {
    savedDocs["orders/order_unknown_1"] = {
      id: "order_unknown_1",
      paymentStatus: "pending",
      payment: { razorpayPaymentId: "pay_unknown_1" },
    };
    const untouched = JSON.stringify(savedDocs["orders/order_unknown_1"]);
    const unknownEvent = () => ({
      id: "evt_unknown_1",
      event: "payment.authorized",
      payload: {
        payment: {
          entity: {
            id: "pay_unknown_1",
            amount: 25000,
            currency: "INR",
            notes: { orderId: "order_unknown_1" },
          },
        },
      },
    });

    const first = mockReqRes(unknownEvent());
    await handleRazorpayWebhook(first.req, first.res);
    expect(first.out().statusCode).toBe(200);
    expect(first.out().body).toMatchObject({ status: "ok" });
    expect(JSON.stringify(savedDocs["orders/order_unknown_1"])).toBe(untouched);

    const replay = mockReqRes(unknownEvent());
    await handleRazorpayWebhook(replay.req, replay.res);
    expect(replay.out().statusCode).toBe(200);
    expect(replay.out().body).toMatchObject({ status: "already_processed" });
  });

  // ── ZERO-MOCK runtime guard (defense in depth behind the boot assert).
  // `config.mock` is a plain mutable object, so a process that booted clean can
  // be flipped afterwards; a flipped payment mock in a DECLARED PRODUCTION
  // process would mint order_mock_* orders and skip signature checks. Every
  // payment entrypoint must refuse. The webhook guard is the one this suite can
  // prove, and the claim MUST NOT be written by a refused delivery — otherwise
  // the event would be deduped away and permanently lost once the flag is
  // fixed. ──
  it("refuses a webhook outright when a mock payment flag is active in production (and writes no claim)", async () => {
    const prevEnv = process.env.BURGONOMICS_ENV;
    try {
      process.env.BURGONOMICS_ENV = "production";
      // The suite's own beforeEach already enables the payment mock.
      expect(config.mock.paymentGateway).toBe(true);

      const call = mockReqRes(capturedPayload("evt_mock_guard_1"));
      await handleRazorpayWebhook(call.req, call.res);

      expect(call.out().statusCode).toBe(500);
      expect(call.out().body).toMatchObject({ error: "Webhook processing unavailable" });
      // Nothing was confirmed, and no idempotency claim was taken.
      expect(savedDocs["orders/order_replay_1"].paymentStatus).toBe("pending");
      expect(savedDocs["orders/order_replay_1"].status).toBeUndefined();
      expect(
        Object.keys(savedDocs).filter((k) => k.startsWith("payment_audits/"))
      ).toHaveLength(0);
    } finally {
      if (prevEnv === undefined) delete process.env.BURGONOMICS_ENV;
      else process.env.BURGONOMICS_ENV = prevEnv;
    }
  });

  // ── payment.failed, the outcome customers actually experience: the write
  // that flips the order failed (the guards for the paid/foreign/ghost cases
  // are pinned elsewhere; the LEGITIMATE path had no coverage). ──
  it("flips a genuinely failed own payment to failed, and keeps a stale marker while flagging the contradiction", async () => {
    savedDocs["orders/order_failed_1"] = {
      id: "order_failed_1",
      customerId: "cust_failed_1",
      paymentStatus: "pending",
      payment: { razorpayPaymentId: "pay_failed_1" },
    };
    const failedEvent = (orderId: string, paymentId: string) => ({
      id: `evt_failed_${paymentId}`,
      event: "payment.failed",
      payload: {
        payment: {
          entity: {
            id: paymentId,
            amount: 25000,
            currency: "INR",
            notes: { orderId },
          },
        },
      },
    });

    const call = mockReqRes(failedEvent("order_failed_1", "pay_failed_1"));
    await handleRazorpayWebhook(call.req, call.res);
    expect(call.out().statusCode).toBe(200);
    // BOTH markers, because clients differ on which one they read.
    expect(savedDocs["orders/order_failed_1"]).toMatchObject({
      paymentStatus: "failed",
      "payment.status": "failed",
    });
    // No contradiction snapshot for a clean single-attempt failure.
    expect(
      Object.keys(savedDocs).some((k) => k.startsWith("dev_error_snapshots/"))
    ).toBe(false);

    // Now the contradictory ordering: an order that still carries a B5 marker
    // (an earlier capture was parked) receives a failure for its own payment.
    // The flip stands — it is the gateway's word about THIS attempt — but the
    // earlier money must not be silently forgotten, so the marker is kept AND
    // a high-severity contradiction snapshot is raised.
    savedDocs["orders/order_failed_2"] = {
      id: "order_failed_2",
      customerId: "cust_failed_1",
      paymentStatus: "pending",
      payment: { razorpayPaymentId: "pay_failed_2" },
      reconciliation: {
        state: "payment_review",
        reason: "confirm_amount_mismatch",
        razorpayPaymentId: "pay_earlier_2",
      },
    };
    const second = mockReqRes(failedEvent("order_failed_2", "pay_failed_2"));
    await handleRazorpayWebhook(second.req, second.res);
    expect(second.out().statusCode).toBe(200);
    const secondDoc = savedDocs["orders/order_failed_2"];
    expect(secondDoc.paymentStatus).toBe("failed");
    expect(secondDoc.reconciliation).toMatchObject({ state: "payment_review" });
    const snapshot = Object.entries(savedDocs).find(
      ([k, v]) =>
        k.startsWith("dev_error_snapshots/") &&
        /reconciliation marker is still present/.test(String((v as any)?.message || ""))
    );
    expect(snapshot, "expected a contradiction snapshot").toBeTruthy();
    expect((snapshot![1] as any).severity).toBe("high");
  });

  // ── Route transfer events had NO test coverage anywhere in this repo, yet
  // they are the payout trail: a retried transfer arrives under a NEW eventId,
  // so the doc id must be convergent on transfer+event or every retry forks a
  // divergent duplicate of the same money movement. ──
  it("records Route transfer events convergently: a retry under a new eventId updates ONE doc", async () => {
    const processed = (eventId: string) => ({
      id: eventId,
      event: "transfer.processed",
      payload: {
        transfer: {
          entity: {
            id: "trf_evt_1",
            recipient: "acc_branch_1",
            amount: 9000,
            status: "processed",
          },
        },
      },
    });

    const first = mockReqRes(processed("evt_trf_1"));
    await handleRazorpayWebhook(first.req, first.res);
    expect(first.out().statusCode).toBe(200);
    expect(savedDocs["route_transfer_events/rtevt_trf_evt_1_transfer.processed"]).toMatchObject({
      event: "transfer.processed",
      transferId: "trf_evt_1",
      recipient: "acc_branch_1",
      // Stored in rupees from the paise the provider sends.
      amount: 90,
      status: "processed",
    });

    // The SAME transfer redelivered under a DIFFERENT event id must converge on
    // the same doc — not create a second one.
    const retry = mockReqRes(processed("evt_trf_1_retry"));
    await handleRazorpayWebhook(retry.req, retry.res);
    expect(retry.out().statusCode).toBe(200);
    expect(
      Object.keys(savedDocs).filter((k) => k.startsWith("route_transfer_events/"))
    ).toHaveLength(1);
  });

  it("raises a high-severity snapshot for a failed Route transfer, and records nothing for an id-less one", async () => {
    const failed = mockReqRes({
      id: "evt_trf_fail",
      event: "transfer.failed",
      payload: {
        transfer: {
          entity: { id: "trf_fail_1", recipient: "acc_branch_1", amount: 9000, status: "failed" },
        },
      },
    });
    await handleRazorpayWebhook(failed.req, failed.res);
    expect(failed.out().statusCode).toBe(200);
    expect(savedDocs["route_transfer_events/rtevt_trf_fail_1_transfer.failed"]).toMatchObject({
      event: "transfer.failed",
      transferId: "trf_fail_1",
    });
    const snapshot = Object.entries(savedDocs).find(
      ([k, v]) =>
        k.startsWith("dev_error_snapshots/") &&
        /Route transfer failed: trf_fail_1/.test(String((v as any)?.message || ""))
    );
    expect(snapshot, "expected a high-severity snapshot for the failed transfer").toBeTruthy();
    expect((snapshot![1] as any).severity).toBe("high");

    // An id-less transfer event cannot be correlated to anything, so it must
    // record nothing rather than an orphan doc (and still ACK).
    const idless = mockReqRes({
      id: "evt_trf_idless",
      event: "transfer.processed",
      payload: { transfer: { entity: { recipient: "acc_branch_1", amount: 9000 } } },
    });
    await handleRazorpayWebhook(idless.req, idless.res);
    expect(idless.out().statusCode).toBe(200);
    expect(
      Object.keys(savedDocs).filter((k) => k.startsWith("route_transfer_events/"))
    ).toHaveLength(1);
  });

  it("takes over a stale claim (previous attempt died without completing)", async () => {
    savedDocs["payment_audits/aud_evt_evt_stale_1"] = {
      eventId: "evt_stale_1",
      claimedAt: Date.now() - 20 * 60 * 1000,
      completedAt: null,
    };
    const call = mockReqRes(capturedPayload("evt_stale_1"));
    await handleRazorpayWebhook(call.req, call.res);
    expect(call.out().body).toMatchObject({ status: "ok" });
    expect(savedDocs["orders/order_replay_1"].paymentStatus).toBe("completed");
  });

  it("parks captured money with no order linkage in unmatched_payments (never drops it)", async () => {
    const payload = capturedPayload("evt_orphan_1");
    delete payload.payload.payment.entity.notes;
    const call = mockReqRes(payload);
    await handleRazorpayWebhook(call.req, call.res);
    expect(call.out().statusCode).toBe(200);
    expect(savedDocs["unmatched_payments/ump_evt_orphan_1"]).toMatchObject({
      razorpayPaymentId: "pay_test_123",
      status: "needs_review",
    });
  });

  // ── Monotonic status guard: a late/replayed payment.failed must never
  // downgrade an order that already carries captured payment. ──────────────
  it("ignores payment.failed for an already-paid order (no downgrade)", async () => {
    savedDocs["orders/order_replay_1"] = {
      ...savedDocs["orders/order_replay_1"],
      paymentStatus: "completed",
      payment: { status: "completed", razorpayPaymentId: "pay_test_123" },
    };
    const payload = {
      id: "evt_fail_late_1",
      event: "payment.failed",
      payload: {
        payment: {
          entity: {
            id: "pay_test_123",
            amount: 25000,
            currency: "INR",
            notes: { orderId: "order_replay_1", branchId: "branch_surat_01" },
          },
        },
      },
    };
    const call = mockReqRes(payload);
    await handleRazorpayWebhook(call.req, call.res);
    expect(call.out().statusCode).toBe(200);
    expect(savedDocs["orders/order_replay_1"].paymentStatus).toBe("completed");
    expect(savedDocs["orders/order_replay_1"].payment).toMatchObject({
      status: "completed",
      razorpayPaymentId: "pay_test_123",
    });
    // Nothing parked — this is an expected non-event, not an anomaly.
    expect(savedDocs["unmatched_payments/ump_evt_fail_late_1"]).toBeUndefined();
  });

  it("ignores a foreign payment attempt's failure (pay-fail-retry-pay ordering)", async () => {
    // Order already carries captured attempt B; a late failure for attempt A
    // must not fail it (that is exactly the retry-after-failure flow).
    savedDocs["orders/order_replay_1"] = {
      ...savedDocs["orders/order_replay_1"],
      paymentStatus: "completed",
      payment: { status: "completed", razorpayPaymentId: "pay_attempt_B" },
    };
    const payload = {
      id: "evt_fail_foreign_1",
      event: "payment.failed",
      payload: {
        payment: {
          entity: {
            id: "pay_attempt_A",
            amount: 25000,
            currency: "INR",
            notes: { orderId: "order_replay_1" },
          },
        },
      },
    };
    const call = mockReqRes(payload);
    await handleRazorpayWebhook(call.req, call.res);
    expect(call.out().statusCode).toBe(200);
    expect(savedDocs["orders/order_replay_1"].paymentStatus).toBe("completed");
  });

  // ── OUT-OF-ORDER, the reverse sequence: the FAILURE lands first, then the
  // capture. Razorpay does not promise the happy event arrives first, and the
  // pay-fail-retry-pay flow produces this naturally — attempt A fails while the
  // order is still pending, the customer retries, attempt B captures. The
  // capture MUST win. The failure mode pinned here is the worst one available:
  // an order left "failed" after real money moved, so the customer is told
  // nothing was charged, the kitchen never cooks, and nothing refunds unless a
  // human stumbles onto it. Note the earlier foreign-attempt test cannot cover
  // this: it seeds an ALREADY-PAID order, so the `alreadyPaid` guard answers
  // before the foreign check is ever reached.
  it("confirms when the capture arrives AFTER a failure on the same order (out-of-order)", async () => {
    const failedAttempt = {
      id: "evt_ooo_fail_1",
      event: "payment.failed",
      payload: {
        payment: {
          entity: {
            id: "pay_attempt_A",
            amount: 25000,
            currency: "INR",
            notes: { orderId: "order_replay_1", branchId: "branch_surat_01" },
          },
        },
      },
    };
    const first = mockReqRes(failedAttempt);
    await handleRazorpayWebhook(first.req, first.res);
    expect(first.out().statusCode).toBe(200);
    // While the failure is the only word we have, it is believed.
    expect(savedDocs["orders/order_replay_1"].paymentStatus).toBe("failed");

    // The captured attempt lands second, for the same order, under a new id.
    const second = mockReqRes(capturedPayload("evt_ooo_capture_1"));
    await handleRazorpayWebhook(second.req, second.res);
    expect(second.out().statusCode).toBe(200);
    // Money moved: the capture is the truth that counts, and it must overwrite
    // the failure rather than being refused because the order looks "failed".
    expect(savedDocs["orders/order_replay_1"].paymentStatus).toBe("completed");
    expect(savedDocs["orders/order_replay_1"]["payment.status"]).toBe("completed");
  });

  it("never resurrects a ghost order from payment.failed — parks for review", async () => {
    const payload = {
      id: "evt_fail_ghost_1",
      event: "payment.failed",
      payload: {
        payment: {
          entity: {
            id: "pay_ghost_1",
            amount: 12300,
            currency: "INR",
            notes: { orderId: "order_ghost_9" },
          },
        },
      },
    };
    const call = mockReqRes(payload);
    await handleRazorpayWebhook(call.req, call.res);
    expect(call.out().statusCode).toBe(200);
    // No ghost order doc was created by the merged write.
    expect(savedDocs["orders/order_ghost_9"]).toBeUndefined();
    expect(savedDocs["unmatched_payments/ump_evt_fail_ghost_1"]).toMatchObject({
      razorpayPaymentId: "pay_ghost_1",
      claimedOrderId: "order_ghost_9",
      status: "needs_review",
      reason: "failed_unknown_order",
    });
  });

  // ── RZ2: the webhook is the authoritative settlement channel, but
  // payment.captured AND order.paid both land for one payment — the
  // non-idempotent Route transfer POST must fire exactly once. ────────────
  it("executes the Route split exactly once across payment.captured + order.paid", async () => {
    savedDocs["orders/order_replay_1"] = {
      ...savedDocs["orders/order_replay_1"],
      pricing: {
        grandTotal: 250,
        split: { branchTransferPaise: 23750, brandRoyaltyPaise: 1250, totalAmountPaise: 25000 },
      },
    };
    savedDocs["branches/branch_surat_01"] = { razorpayAccountId: "acc_surat_1" };

    const captured = mockReqRes(capturedPayload("evt_split_once_1"));
    await handleRazorpayWebhook(captured.req, captured.res);
    expect(captured.out().statusCode).toBe(200);
    expect(savedDocs["orders/order_replay_1"].routeTransferStatus).toBe("transferred");
    const transferId = savedDocs["orders/order_replay_1"]["payment.routeTransfer"]?.id;
    expect(transferId).toMatch(/^trf_mock_/);
    const kotId = savedDocs["orders/order_replay_1"].petpoojaOrderId;
    expect(kotId).toMatch(/^pp_kot_/);

    // Swap the stored receipt for a sentinel: if the order.paid delivery
    // re-POSTed the transfer it would overwrite this with a fresh trf_mock_*.
    savedDocs["orders/order_replay_1"]["payment.routeTransfer"] = {
      id: "trf_sentinel_no_repost",
      status: "processed",
    };

    const orderPaid = {
      id: "evt_split_once_2",
      event: "order.paid",
      payload: {
        order: {
          entity: {
            id: "rzp_order_1",
            amount: 25000,
            currency: "INR",
            notes: { orderId: "order_replay_1", branchId: "branch_surat_01" },
            payments: ["pay_test_123"],
          },
        },
      },
    };
    const second = mockReqRes(orderPaid);
    await handleRazorpayWebhook(second.req, second.res);
    expect(second.out().statusCode).toBe(200);

    // Fast-path: already transferred → stored receipt reused, no second POST.
    expect(savedDocs["orders/order_replay_1"]["payment.routeTransfer"].id).toBe(
      "trf_sentinel_no_repost"
    );
    expect(savedDocs["orders/order_replay_1"].routeTransferStatus).toBe("transferred");
    // KOT dedupe: petpoojaOrderId is the "already pushed" marker.
    expect(savedDocs["orders/order_replay_1"].petpoojaOrderId).toBe(kotId);
  });

  // ── Refund accounting: each gateway refund id is counted EXACTLY ONCE —
  // replays must not double-credit, sequential partials must accumulate. ──
  it("counts each refund id once: replay doesn't double-credit, partials accumulate", async () => {
    savedDocs["orders/order_ref_1"] = {
      id: "order_ref_1",
      branchId: "branch_surat_01",
      customerPhone: "+91 90000 00001",
      paymentStatus: "completed",
      payment: { razorpayPaymentId: "pay_ref_1", status: "completed" },
    };
    const refundPayload = (eventId: string, refundId: string, amountPaise: number) => ({
      id: eventId,
      event: "refund.processed",
      payload: {
        refund: {
          entity: { id: refundId, payment_id: "pay_ref_1", amount: amountPaise, currency: "INR" },
        },
      },
    });

    const first = mockReqRes(refundPayload("evt_ref_once_1", "rfnd_1", 10000));
    await handleRazorpayWebhook(first.req, first.res);
    expect(first.out().statusCode).toBe(200);
    expect(savedDocs["orders/order_ref_1"]).toMatchObject({
      refundStatus: "refunded",
      refundedTotalPaise: 10000,
      refundLedger: { rfnd_1: 10000 },
    });

    // Same refund re-delivered under a DIFFERENT event id (stale-claim
    // takeover path): the event-id claim can't dedupe this — the ledger must.
    const replay = mockReqRes(refundPayload("evt_ref_once_2", "rfnd_1", 10000));
    await handleRazorpayWebhook(replay.req, replay.res);
    expect(replay.out().statusCode).toBe(200);
    expect(savedDocs["orders/order_ref_1"].refundedTotalPaise).toBe(10000);

    // A DISTINCT second partial refund must accumulate, not replace.
    const partial = mockReqRes(refundPayload("evt_ref_once_3", "rfnd_2", 5000));
    await handleRazorpayWebhook(partial.req, partial.res);
    expect(partial.out().statusCode).toBe(200);
    expect(savedDocs["orders/order_ref_1"]).toMatchObject({
      refundedTotalPaise: 15000,
      refundAmount: 150,
      refundLedger: { rfnd_1: 10000, rfnd_2: 5000 },
    });
  });

  // ── Money-truth anomaly: a refund that matches the order BY payment id can
  // only ever be a refund of what that payment captured, so a cumulative total
  // above the recorded capture means our recorded reality is wrong somewhere.
  // It must never be silently accepted, and money truth must never be
  // rewritten DOWNWARDS to hide it. ──
  it("flags a cumulative refund above the recorded capture instead of silently accepting it", async () => {
    savedDocs["orders/order_over_ref_1"] = {
      id: "order_over_ref_1",
      branchId: "branch_surat_01",
      paymentStatus: "completed",
      // Live capture truth in paise, exactly as the confirm path writes it
      // (payment.capturedAmountPaise).
      payment: {
        razorpayPaymentId: "pay_over_1",
        status: "completed",
        capturedAmountPaise: 10000,
      },
    };
    const refundPayload = (eventId: string, refundId: string, amountPaise: number) => ({
      id: eventId,
      event: "refund.processed",
      payload: {
        refund: {
          entity: { id: refundId, payment_id: "pay_over_1", amount: amountPaise, currency: "INR" },
        },
      },
    });

    // Exactly the captured amount: credited, and NOT flagged (the cap is the
    // boundary, not an anomaly).
    const atCap = mockReqRes(refundPayload("evt_over_1", "rfnd_cap", 10000));
    await handleRazorpayWebhook(atCap.req, atCap.res);
    expect(atCap.out().statusCode).toBe(200);
    const afterCap = savedDocs["orders/order_over_ref_1"];
    expect(afterCap.refundedTotalPaise).toBe(10000);
    expect(afterCap.refundOverCapturedPaise).toBeUndefined();
    expect(afterCap.refundNeedsReview).toBeUndefined();

    // 5000 paise MORE than was ever captured: the recorded total still moves
    // upwards (that is the provider's truth and we do not rewrite it), but it
    // is flagged and a high-severity snapshot is written for a human.
    const over = mockReqRes(refundPayload("evt_over_2", "rfnd_over", 5000));
    await handleRazorpayWebhook(over.req, over.res);
    expect(over.out().statusCode).toBe(200);
    const afterOver = savedDocs["orders/order_over_ref_1"];
    expect(afterOver.refundedTotalPaise).toBe(15000);
    expect(afterOver.refundOverCapturedPaise).toBe(5000);
    expect(afterOver.refundNeedsReview).toBe(true);

    const snapshot = Object.entries(savedDocs).find(
      ([k, v]) =>
        k.startsWith("dev_error_snapshots/") &&
        /exceeds the recorded capture/.test(String((v as any)?.message || ""))
    );
    expect(snapshot, "expected a high-severity over-refund snapshot").toBeTruthy();
    expect((snapshot![1] as any).severity).toBe("high");
  });

  // ── Out-of-order: a refund can reach us for an order whose capture WE never
  // recorded (capture webhook missed, or delivered after the refund). The money
  // is real and must still be accounted for, but the resulting doc contradicts
  // itself - a refund on an order we believe is unpaid - and support must be
  // told rather than the customer being shown "unpaid" indefinitely. ──
  it("flags a refund for an order with no recorded capture (money kept, contradiction surfaced)", async () => {
    savedDocs["orders/order_rc_1"] = {
      id: "order_rc_1",
      branchId: "branch_surat_01",
      paymentStatus: "pending",
      payment: { razorpayPaymentId: "pay_rc_1", status: "pending" },
    };
    const call = mockReqRes({
      id: "evt_rc_1",
      event: "refund.processed",
      payload: {
        refund: {
          entity: { id: "rfnd_rc_1", payment_id: "pay_rc_1", amount: 10000, currency: "INR" },
        },
      },
    });
    await handleRazorpayWebhook(call.req, call.res);
    expect(call.out().statusCode).toBe(200);

    const order = savedDocs["orders/order_rc_1"];
    // The refund is never dropped - the money moved.
    expect(order.refundedTotalPaise).toBe(10000);
    // ...but it is surfaced, because we hold no capture to justify it.
    expect(order.refundNeedsReview).toBe(true);
    const snapshot = Object.entries(savedDocs).find(
      ([k, v]) =>
        k.startsWith("dev_error_snapshots/") &&
        /no recorded capture/i.test(String((v as any)?.message || ""))
    );
    expect(snapshot, "expected a snapshot for a refund with no recorded capture").toBeTruthy();
  });

  it("parks processed refunds with no matching order in unmatched_payments (never drops money)", async () => {
    const payload = {
      id: "evt_refund_orphan_1",
      event: "refund.processed",
      payload: {
        refund: {
          entity: {
            id: "rfnd_orphan_1",
            payment_id: "pay_ghost_1",
            amount: 9900,
            currency: "INR",
          },
        },
      },
    };
    const call = mockReqRes(payload);
    await handleRazorpayWebhook(call.req, call.res);
    expect(call.out().statusCode).toBe(200);
    expect(savedDocs["unmatched_payments/ump_refund_evt_refund_orphan_1"]).toMatchObject({
      razorpayPaymentId: "pay_ghost_1",
      refundId: "rfnd_orphan_1",
      status: "needs_review",
      reason: "refund_no_match",
    });
  });

  // ── Track 2 (live gateway hardening): INR-only settlement. Every split,
  // refund, and ledger downstream is paise-denominated — a non-INR capture
  // must never flip an order to CONFIRMED. ───────────────────────────────
  it("refuses to confirm a non-INR capture — parks the money for review", async () => {
    const payload = capturedPayload("evt_currency_1");
    payload.payload.payment.entity.currency = "USD";
    const call = mockReqRes(payload);
    await handleRazorpayWebhook(call.req, call.res);
    expect(call.out().statusCode).toBe(200);
    // Order untouched: no CONFIRM, no KOT, no Route split.
    expect(savedDocs["orders/order_replay_1"].paymentStatus).toBe("pending");
    expect(savedDocs["orders/order_replay_1"].status).toBeUndefined();
    expect(savedDocs["orders/order_replay_1"].petpoojaOrderId).toBeUndefined();
    expect(savedDocs["orders/order_replay_1"].routeTransferStatus).toBeUndefined();
    // Money is visible to ops, never dropped.
    expect(savedDocs["unmatched_payments/ump_evt_currency_1"]).toMatchObject({
      status: "needs_review",
      reason: "confirm_currency_mismatch",
      currency: "USD",
      claimedOrderId: "order_replay_1",
    });
  });

  // ── Track 2: order.paid carries the payment id as an OBJECT entry in some
  // payload versions — writing it verbatim poisoned payment.razorpayPaymentId
  // with "[object Object]" (refund binding + coin ledger + attempt guard). ──
  it("extracts a string payment id from object-shaped order.paid payments[]", async () => {
    const payload = {
      id: "evt_objpay_1",
      event: "order.paid",
      payload: {
        order: {
          entity: {
            id: "rzp_order_obj_1",
            amount: 25000,
            currency: "INR",
            notes: { orderId: "order_replay_1", branchId: "branch_surat_01" },
            payments: [{ id: "pay_object_shape_1", amount: 25000, currency: "INR" }],
          },
        },
      },
    };
    const call = mockReqRes(payload);
    await handleRazorpayWebhook(call.req, call.res);
    expect(call.out().statusCode).toBe(200);
    expect(savedDocs["orders/order_replay_1"].paymentStatus).toBe("completed");
    expect(savedDocs["orders/order_replay_1"]["payment.razorpayPaymentId"]).toBe(
      "pay_object_shape_1"
    );
    expect(String(savedDocs["orders/order_replay_1"]["payment.razorpayPaymentId"])).not.toContain(
      "[object"
    );
  });
});
