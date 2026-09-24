import * as crypto from "crypto";
import * as admin from "firebase-admin";
import * as https from "https";
import { db } from "../../core/firebase";
import { config } from "../../config/env";
import {
  verifyRazorpaySignature,
  computeHmacSha256,
  getOtpHmacSecret,
} from "../../core/security";
import { captureErrorSnapshot } from "../../core/errors";
import { assertOrderBranchAccess } from "../../core/middleware";
import { calculateOrderPricing, CalculateOrderPricingInput } from "./pricing.engine";
import { getRazorpayClient, getRazorpayKeyId } from "./razorpayClient";
import {
  attemptRouteTransfer,
  retryPendingRouteTransfersWorker,
  calculateRouteSplit,
} from "./routeTransfers";

export { retryPendingRouteTransfersWorker, calculateRouteSplit } from "./routeTransfers";
export { getOtpHmacSecret };

/**
 * Direct Razorpay refund POST with an idempotency fingerprint header.
 * The Node SDK v2 offers no header passthrough, so this bypasses it for
 * refunds only (everything else keeps the SDK). Basic-auth with the live
 * key pair; non-2xx responses throw with the gateway's description so the
 * existing REFUND_GATEWAY_FAILED mapping applies unchanged.
 */
function postRefundWithIdempotency(
  razorpayPaymentId: string,
  refundPayload: Record<string, any>,
  idempotencyKey: string
): Promise<any> {
  const keyId = config.razorpay.keyId;
  const keySecret = config.razorpay.keySecret;
  const body = JSON.stringify(refundPayload);
  const options = {
    hostname: "api.razorpay.in",
    path: `/v1/payments/${encodeURIComponent(razorpayPaymentId)}/refund`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
      "X-Refund-Idempotency": idempotencyKey,
    },
  };
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed: any = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          // Non-JSON gateway response — fall through to status handling.
        }
        const status = res.statusCode ?? 0;
        if (status >= 200 && status < 300 && parsed) {
          resolve(parsed);
          return;
        }
        const desc =
          (parsed && parsed.error && parsed.error.description) ||
          (parsed && parsed.message) ||
          text ||
          `HTTP ${status}`;
        reject(new Error(String(desc).slice(0, 500)));
      });
    });
    req.on("error", (err) => reject(err));
    req.setTimeout(20000, () => req.destroy(new Error("Razorpay refund request timed out")));
    req.write(body);
    req.end();
  });
}

export interface CreateOrderParams {
  orderId?: string;
  items: any[];
  branchId?: string;
  /** Delivery store id — resolved to a branch via stores/{id}.partnerBranchId. */
  storeId?: string;
  orderType: "delivery" | "takeaway" | "dinein";
  deliveryFee?: number;
  packagingFee?: number;
  couponCode?: string;
  loyaltyPointsToRedeem?: number;
  customerId: string;
  customerName?: string;
  customerPhone?: string;
  /** Stable per-checkout key: retries reuse the open gateway order. */
  idempotencyKey?: string;
}

/**
 * Resolves the branch for pricing, transfers, and KOT routing. Explicit
 * branchId wins; otherwise the delivery store record's linked branch.
 */
async function resolveBranchId(params: CreateOrderParams): Promise<string> {
  if (params.branchId) return params.branchId;
  if (params.storeId && db && typeof db.collection === "function") {
    try {
      const snap = await db.collection("stores").doc(params.storeId).get();
      const linked = snap.exists ? (snap.data() as any)?.partnerBranchId : undefined;
      if (typeof linked === "string" && linked) return linked;
    } catch (err) {
      console.warn("[Payments] store→branch resolution failed:", (err as any)?.message || err);
    }
  }
  throw new Error("Branch could not be resolved for this store. Link the outlet first.");
}

/**
 * Loop 62/120: Grill-Coins redemption is server-checked, never trusted.
 * The old code passed client-supplied loyaltyPointsToRedeem straight into
 * pricing (shape-only validation) and nothing ever debited coins — any
 * caller, including guests, could claim up to 20% off with zero balance,
 * forever. Over-claims fail closed with 400; guests have no balance.
 * Exported for tests (same seam pattern as __setPaymentsFetchForTests).
 */
export async function resolveRedeemableCoins(
  customerId: string,
  requested: unknown,
): Promise<number> {
  const want =
    typeof requested === "number" && Number.isFinite(requested)
      ? Math.floor(requested)
      : 0;
  if (want <= 0) return 0;
  let balance = 0;
  if (customerId && customerId !== "guest" && db && typeof db.collection === "function") {
    try {
      const snap = await db.collection("customers").doc(customerId).get();
      const raw = snap.exists ? (snap.data() as any)?.loyaltyPoints : undefined;
      balance = Math.max(0, Math.floor(Number(raw) || 0));
    } catch (err: any) {
      // Fail closed: without a verified balance no coins may be redeemed.
      console.warn("[Payments] loyalty balance lookup failed:", err?.message || err);
      const refused: any = new Error(
        "Could not verify your Grill Coins balance — please retry checkout without redeeming points."
      );
      refused.statusCode = 503;
      throw refused;
    }
  }
  if (want > balance) {
    const err: any = new Error(
      `You only have ${balance} Grill Coins — please lower the redemption or earn more before retrying.`
    );
    err.statusCode = 400;
    throw err;
  }
  return want;
}

/**
 * Loop 63/120: trusted confirm-time redemption lookup. Reads the
 * server-written payment_intents doc by Razorpay order id — never the
 * client-created order doc. Returns null when nothing was redeemed (the
 * common case) or the lookup fails (callers skip debit, never fail pay).
 */
export async function resolveIntentRedemption(
  razorpayOrderId: string
): Promise<{ customerId: string; coins: number } | null> {
  if (!razorpayOrderId || !db || typeof db.collection !== "function") return null;
  try {
    const snap = await db
      .collection("payment_intents")
      .where("razorpayOrderId", "==", razorpayOrderId)
      .limit(1)
      .get();
    const doc = snap?.docs?.[0];
    const data = (doc ? (doc.data() as any) : undefined) as any;
    if (!data) return null;
    // pricing.loyaltyDiscount is rupees at 1pt = ₹1, server-computed at
    // intent from the Loop-62-verified amount — it IS the redeemed count.
    const coins = Math.floor(Number(data?.pricing?.loyaltyDiscount) || 0);
    const customerId =
      typeof data?.customerId === "string" ? data.customerId : "";
    if (!customerId || coins <= 0) return null;
    return { customerId, coins };
  } catch (err: any) {
    // Fail-closed: intent redemption failure must not silently skip coin debit.
    // Log HIGH severity and rethrow so the caller handles it (createPaymentOrder will 503).
    console.error("[Payments] intent redemption lookup failed:", err?.message || err);
    await captureErrorSnapshot({
      source: "payments",
      severity: "high",
      message: `Intent redemption lookup failed: ${err?.message || err}`,
    }).catch(() => undefined);
    throw new Error(`Intent redemption lookup failed: ${err?.message || err}`);
  }
}

/**
 * Creates a Razorpay server order with authoritative price calculation and route notes.
 */
export async function createPaymentOrder(params: CreateOrderParams) {
  const branchId = await resolveBranchId(params);

  // Server-verified redemption: the pricing engine only ever sees coins the
  // customer actually holds (guests hold none).
  const loyaltyPointsToRedeem = await resolveRedeemableCoins(
    params.customerId,
    params.loyaltyPointsToRedeem,
  );

  // Idempotent retries: same key returns the already-open gateway order
  // instead of minting a second payable order (double-charge risk).
  // Bounded by a 24h TTL: Razorpay orders expire and catalog prices move,
  // so a days-old intent must never resurrect a stale total. The client's
  // fingerprint (items+prices+promo+loyalty+tip) already scopes the key to
  // one basket; the TTL scopes it in time. Numeric createdAtMs/expiresAtMs
  // (not serverTimestamp sentinels) so the age check reads without a
  // toMillis trap.
  const INTENT_TTL_MS = 24 * 60 * 60 * 1000;
  if (params.idempotencyKey && db && typeof db.collection === "function") {
    try {
      const prior = await db.collection("payment_intents").doc(params.idempotencyKey).get();
      // Require a real stored order id AND sane numeric totals — ghost docs
      // or corrupted amounts (string/NaN) must not short-circuit into a
      // checkout for the wrong total.
      const data = (prior.exists ? (prior.data() as any) : undefined) as any;
      const storedPaise = data?.amountPaise;
      const expiresAtMs = Number(data?.expiresAtMs);
      if (
        typeof data?.razorpayOrderId === "string" &&
        data.razorpayOrderId.length > 0 &&
        typeof storedPaise === "number" &&
        Number.isFinite(storedPaise) &&
        storedPaise > 0 &&
        Number.isFinite(expiresAtMs) &&
        expiresAtMs > Date.now()
      ) {
        return {
          razorpayOrderId: data.razorpayOrderId,
          amountPaise: data.amountPaise,
          amountRupees: data.amountPaise / 100,
          currency: "INR",
          receipt: data.receipt,
          pricing: data.pricing,
          keyId: getRazorpayKeyId(),
          reused: true as const,
        };
      }
    } catch (err: any) {
      // Fail CLOSED: minting a fresh order when the lookup blips creates a
      // second payable gateway order for the same checkout (double charge).
      // 503 tells the client to retry the SAME idempotencyKey — the retry
      // reuses the original open order instead of paying twice. Stranded
      // payers are recoverable; double charges are not.
      console.warn("[Payments] idempotency lookup failed, refusing fresh order:", err?.message || err);
      const { captureErrorSnapshot } = await import("../../core/errors");
      await captureErrorSnapshot({
        source: "payments",
        severity: "high",
        message: "payment-intent idempotency lookup failed — refused fresh order, client must retry same key",
        errorStack: err?.stack,
      });
      const refused: any = new Error("Payment service is temporarily unavailable — please retry checkout (you will not be charged twice).");
      refused.statusCode = 503;
      throw refused;
    }
  }

  const pricing = await calculateOrderPricing({
    items: params.items,
    branchId,
    orderType: params.orderType,
    deliveryFee: params.deliveryFee,
    packagingFee: params.packagingFee,
    couponCode: params.couponCode,
    loyaltyPointsToRedeem,
  });

  if (!(pricing.grandTotal > 0)) {
    // User-facing copy (no screaming codes): the route maps this to 400.
    const err: any = new Error("Your cart total is empty — please add an item before paying.");
    err.code = "INVALID_AMOUNT";
    err.statusCode = 400;
    throw err;
  }

  const amountPaise = Math.round(pricing.grandTotal * 100);
  const receipt = `rcpt_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;

  let razorpayOrderId: string;

  if (config.mock.paymentGateway) {
    razorpayOrderId = `order_mock_${Date.now()}`;
  } else {
    try {
      const razorpay = getRazorpayClient();
      const rzpOrder = await razorpay.orders.create({
        amount: amountPaise,
        currency: "INR",
        receipt,
        // Required for Razorpay Route: transfers only execute on captured
        // payments of orders with partial payments disabled.
        partial_payment: false,
        notes: {
          orderId: params.orderId || "",
          branchId,
          customerId: params.customerId,
          orderType: params.orderType,
          brandRoyaltyPaise: pricing.split.brandRoyaltyPaise,
          branchTransferPaise: pricing.split.branchTransferPaise,
        },
      });
      razorpayOrderId = rzpOrder.id;
    } catch (err: any) {
      await captureErrorSnapshot({
        source: "payments",
        severity: "high",
        message: `Failed to create Razorpay order: ${err.message || err}`,
        errorStack: err.stack,
        branchId,
        customerId: params.customerId,
      });
      throw new Error(`Payment gateway order creation failed: ${err.message}`);
    }
  }

  if (params.idempotencyKey && db && typeof db.collection === "function") {
    const intentRef = db.collection("payment_intents").doc(params.idempotencyKey);
    const nowMs = Date.now();
    const intentDoc = {
      razorpayOrderId,
      amountPaise,
      receipt,
      pricing,
      orderId: params.orderId || null,
      customerId: params.customerId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAtMs: nowMs,
      expiresAtMs: nowMs + INTENT_TTL_MS,
    };
    try {
      // Loop 4 (F2): CLAIM, not blind write. Concurrent same-key checkouts
      // both miss the read above and both POST to Razorpay — the loser's
      // gateway order strands (expires unpaid, never charged). create()
      // throws when the winner already claimed, so exactly one order is
      // ever handed out per key. Datastores without create() keep the old
      // merge-set path.
      if (intentRef && typeof intentRef.create === "function") {
        await intentRef.create(intentDoc);
      } else {
        await intentRef.set(intentDoc, { merge: true });
      }
    } catch (err: any) {
      const alreadyClaimed =
        err?.code === 6 || /already exists|ALREADY_EXISTS/i.test(err?.message || "");
      if (!alreadyClaimed) {
        console.warn("[Payments] idempotency store failed (non-blocking):", err?.message || err);
      } else {
        // Lost the claim race — reuse the winner's order (same shape as the
        // read-hit path above). A corrupt winner doc fails closed to 503:
        // the client retries the SAME key and converges on the winner.
        try {
          const winnerSnap = await intentRef.get();
          const winner = (winnerSnap.exists ? (winnerSnap.data() as any) : undefined) as any;
          const winnerPaise = winner?.amountPaise;
          if (
            typeof winner?.razorpayOrderId === "string" &&
            winner.razorpayOrderId.length > 0 &&
            typeof winnerPaise === "number" &&
            Number.isFinite(winnerPaise) &&
            winnerPaise > 0
          ) {
            return {
              razorpayOrderId: winner.razorpayOrderId,
              amountPaise: winner.amountPaise,
              amountRupees: winner.amountPaise / 100,
              currency: "INR",
              receipt: winner.receipt,
              pricing: winner.pricing,
              keyId: getRazorpayKeyId(),
              reused: true as const,
            };
          }
        } catch {
          // Fall through to 503 below.
        }
        console.warn("[Payments] idempotency claim lost with unreadable winner — refusing fresh order (retry same key)");
        const { captureErrorSnapshot } = await import("../../core/errors");
        await captureErrorSnapshot({
          source: "payments",
          severity: "high",
          message: "payment-intent claim race lost and winner unreadable — refused fresh order, client must retry same key",
        });
        const refused: any = new Error("Payment service is temporarily unavailable — please retry checkout (you will not be charged twice).");
        refused.statusCode = 503;
        throw refused;
      }
    }
  }

  return {
    razorpayOrderId,
    amountPaise,
    amountRupees: pricing.grandTotal,
    currency: "INR",
    receipt,
    pricing,
    keyId: getRazorpayKeyId(),
  };
}

export interface VerifyPaymentParams {
  orderId: string;
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
}

/**
 * Verifies Razorpay payment signature, binds the live gateway payment to the
 * server-priced order (fail-closed on amount/capture mismatch — never confirms,
 * never auto-captures), executes the Razorpay Route transfer split, and
 * updates order status.
 *
 * Fail-closed contract (B2-S1): in live mode with a stored server-side total,
 * the gateway payment is fetched and must match (order binding + paise amount
 * + captured status + INR). Any mismatch parks a payment_discrepancies doc for
 * ops and throws — the order is never flipped to CONFIRMED on these paths.
 * Transfer contention resolves to an immediate 202 retry signal (no blocking
 * poll — the client retries verify with the same key).
 */
export async function verifyPayment(params: VerifyPaymentParams) {
  const { orderId, razorpayOrderId, razorpayPaymentId, razorpaySignature } = params;

  // 1. Signature verification
  let isValid = false;
  if (config.mock.paymentGateway) {
    isValid = razorpaySignature !== "force_fail";
  } else {
    isValid = verifyRazorpaySignature(
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature,
      config.razorpay.keySecret
    );
  }

  if (!isValid) {
    await captureErrorSnapshot({
      source: "payments",
      severity: "high",
      message: "Razorpay HMAC payment signature verification failed",
      orderId,
      razorpayPaymentId,
    });
    const badSig: any = new Error("Invalid payment signature");
    badSig.statusCode = 401;
    badSig.code = "INVALID_SIGNATURE";
    throw badSig;
  }

  // 2. Fetch order to perform Route split. Unknown orderId is a 404 —
  // the old code built `orderData = {}` and resurrected a partial CONFIRMED
  // doc (payment fields, no items/pricing) for a typo'd or deleted id.
  const orderRef = db.collection("orders").doc(orderId);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) {
    const ghost: any = new Error(
      `Order ${orderId} not found — refusing to verify payment against a ghost order`
    );
    ghost.statusCode = 404;
    ghost.code = "ORDER_NOT_FOUND";
    throw ghost;
  }
  const orderData = orderSnap.data() || {};
  const branchId = orderData.branchId;

  // Live gateway truth check (fail-closed on money mismatch, no auto-capture).
  // Runs only in live mode AND when the order carries a stored server-side
  // total to compare against. Legacy/test docs without pricing keep the
  // legacy path — the HMAC signature above still binds payment↔order, and the
  // transfer claim below still serializes payouts. Mock mode has no gateway
  // truth to fetch, so it keeps its short-circuit.
  const storedGrandTotal = Number(orderData.pricing?.grandTotal);
  const hasStoredTotal =
    Number.isFinite(storedGrandTotal) && storedGrandTotal > 0;
  let capturedAmountPaise: number | undefined;
  if (!config.mock.paymentGateway && hasStoredTotal) {
    capturedAmountPaise = await assertLivePaymentMatchesOrder({
      orderRef,
      orderId,
      orderData,
      razorpayOrderId,
      razorpayPaymentId,
      expectedPaise: Math.round(storedGrandTotal * 100),
    });
  }

  let transferResult: any = null;

  // 3. Execute Razorpay Route split transfer if linked account exists.
  // Claim-then-work inside a transaction: two concurrent verifies used to
  // both read `!== "transferred"` and both POST the non-idempotent transfer
  // API. The winner flips `transferring`; the loser reuses the result.
  if (orderData.routeTransferStatus === "transferred") {
    transferResult = orderData.payment?.routeTransfer ?? orderData["payment.routeTransfer"] ?? null;
  } else if (db && typeof (db as any).runTransaction === "function") {
    const claim: "claimed" | "done" | "busy" = await (db as any).runTransaction(
      async (tx: any) => {
        const fresh = await tx.get(orderRef as any);
        const freshData = (fresh.exists ? fresh.data() : undefined) as any;
        if (!freshData) return "busy";
        if (freshData.routeTransferStatus === "transferred") {
          transferResult =
            freshData.payment?.routeTransfer ?? freshData["payment.routeTransfer"] ?? null;
          return "done";
        }
        // Another verify/worker owns the transfer right now — never POST ours.
        // Stale-claim takeover: a crash between claim and POST must not park
        // the order in `transferring` forever (every future verify would 503).
        if (freshData.routeTransferStatus === "transferring") {
          const claimedAt = freshData.routeTransferClaimedAt;
          const claimedMs =
            claimedAt && typeof claimedAt.toMillis === "function" ? claimedAt.toMillis() : 0;
          if (Date.now() - claimedMs < 10 * 60 * 1000) return "busy";
        }
        tx.set(
          orderRef as any,
          {
            routeTransferStatus: "transferring",
            routeTransferClaimedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        return "claimed";
      }
    );
    if (claim === "done" && transferResult) {
      // Lost the race after a winner completed — reuse, skip our own POST.
      return finishVerifiedPayment({
        orderRef,
        orderData: { ...orderData, routeTransferStatus: "transferred" },
        orderId,
        razorpayOrderId,
        razorpayPaymentId,
        transferResult,
      });
    }
    if (claim === "busy") {
      // Winner still mid-flight: return a 202 retry signal IMMEDIATELY (no
      // blocking poll — the old 4x500ms serial loop stalled checkout ~2s per
      // M32). The client retries verify with the same key; by then the
      // transfer has settled. Posting our own transfer here is exactly the
      // double-spend this guards. NOTE: /payments/verifyPayment route mapping
      // to HTTP 202 is batch-4 owned — the message below carries the retry
      // instruction so clients retry even while the route degrades this to 400.
      const retry: any = new Error(
        "Transfer in progress elsewhere — please retry payment verification in a couple of seconds (you will not be charged twice)."
      );
      retry.statusCode = 202;
      retry.code = "TRANSFER_IN_PROGRESS";
      retry.retryAfterMs = 2000;
      throw retry;
    }
  }
  const pricingSplit = orderData.pricing?.split;
  if (
    transferResult === null &&
    branchId &&
    pricingSplit &&
    pricingSplit.branchTransferPaise > 0
  ) {
    const attempt = await attemptRouteTransfer(razorpayPaymentId, branchId, pricingSplit, orderId, undefined, capturedAmountPaise);

    if (attempt.ok && attempt.result) {
      transferResult = attempt.result;
      await orderRef.set(
        {
          routeTransferStatus: "transferred",
          "payment.routeTransfer": attempt.result,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    } else if (!attempt.skipped) {
      await captureErrorSnapshot({
        source: "payments",
        severity: "high",
        message: `Razorpay Route transfer failed for order ${orderId}: ${attempt.error}`,
        orderId,
        branchId,
        razorpayPaymentId,
      });
      await orderRef.set(
        {
          routeTransferStatus: "pending_retry",
          routeTransferError: attempt.error,
          routeTransferRetryAt: admin.firestore.FieldValue.serverTimestamp(),
          routeTransferRetryCount: 0,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
  }

  // 4+5. Confirm state + audit (shared by the normal and race-loser paths).
  return finishVerifiedPayment({
    orderRef,
    orderData,
    orderId,
    razorpayOrderId,
    razorpayPaymentId,
    transferResult,
    capturedAmountPaise,
  });
}

/**
 * Test seam for the live gateway fetch (B2-S1): unit tests inject a stub so
 * no test ever touches the Razorpay network. Production always uses the SDK.
 */
let paymentsFetchOverride: ((paymentId: string) => Promise<any>) | null = null;

/** Test-only: stub/unstub the live Razorpay payment fetch. */
export function __setPaymentsFetchForTests(
  fn: ((paymentId: string) => Promise<any>) | null
): void {
  paymentsFetchOverride = fn;
}

/**
 * Fetches the live Razorpay payment and binds it to the server-priced order.
 * Fail-closed: order binding, paise amount, captured status, and currency must
 * ALL match. Any mismatch writes a payment_discrepancies doc for ops review
 * and throws — the caller never confirms the order on these paths.
 *
 * NO AUTO-CAPTURE: an authorized-but-uncaptured payment is parked as
 * awaiting_capture and refused. Capturing server-side without an explicit
 * capture intent would charge customers outside the checkout they approved.
 *
 * Returns the captured amount in paise for downstream transfer-cap checks.
 */
async function assertLivePaymentMatchesOrder(args: {
  orderRef: any;
  orderId: string;
  orderData: any;
  razorpayOrderId: string;
  razorpayPaymentId: string;
  expectedPaise: number;
}): Promise<number> {
  const { orderRef, orderId, razorpayOrderId, razorpayPaymentId, expectedPaise } = args;

  let payment: any;
  try {
    // Test seam first: unit tests stub the fetch so no test ever touches the
    // Razorpay network. Production always goes through the SDK client.
    payment = paymentsFetchOverride
      ? await paymentsFetchOverride(razorpayPaymentId)
      : await getRazorpayClient().payments.fetch(razorpayPaymentId);
  } catch (err: any) {
    // Fail CLOSED: an unreadable payment is never confirmed — the client
    // retries verify with the same key (no double charge; no stranded charge
    // confirmed blind).
    await captureErrorSnapshot({
      source: "payments",
      severity: "high",
      message: `Razorpay payment fetch failed for ${razorpayPaymentId} — refusing verify, client must retry`,
      orderId,
      razorpayPaymentId,
      errorStack: err?.stack,
    });
    const unknown: any = new Error(
      "Payment status is temporarily unavailable — please retry verification (you will not be charged twice)."
    );
    unknown.statusCode = 503;
    unknown.code = "PAYMENT_STATUS_UNKNOWN";
    unknown.retryAfterMs = 2000;
    throw unknown;
  }

  const slug = (v: unknown): string => String(v ?? "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "unknown";
  const parkDiscrepancy = async (reason: string, extra: Record<string, any>) => {
    const docId = `dis_${slug(orderId)}_${slug(razorpayPaymentId)}`;
    await db.collection("payment_discrepancies").doc(docId).set(
      {
        orderId,
        razorpayOrderId,
        razorpayPaymentId,
        expectedPaise,
        actualPaise: typeof payment?.amount === "number" ? payment.amount : null,
        gatewayStatus: payment?.status || null,
        reason,
        status: "needs_review",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        ...extra,
      },
      { merge: true }
    );
    await captureErrorSnapshot({
      source: "payments",
      severity: "high",
      message: `Payment discrepancy for order ${orderId}: ${reason} — parked for review, order NOT confirmed`,
      orderId,
      razorpayPaymentId,
    });
  };

  if (payment?.order_id !== razorpayOrderId) {
    await parkDiscrepancy("ORDER_MISMATCH", { gatewayOrderId: payment?.order_id || null });
    const err: any = new Error(
      "This payment belongs to a different order — verification refused. Contact support if money left your account."
    );
    err.statusCode = 409;
    err.code = "ORDER_MISMATCH";
    throw err;
  }

  if (Number(payment?.amount) !== expectedPaise) {
    await parkDiscrepancy("AMOUNT_MISMATCH", {});
    const err: any = new Error(
      "The amount paid does not match your order total — verification refused. Contact support if money left your account."
    );
    err.statusCode = 409;
    err.code = "AMOUNT_MISMATCH";
    throw err;
  }

  if (payment?.currency && payment.currency !== "INR") {
    await parkDiscrepancy("CURRENCY_MISMATCH", { currency: payment.currency });
    const err: any = new Error(
      "This payment is not in INR — verification refused. Contact support if money left your account."
    );
    err.statusCode = 409;
    err.code = "CURRENCY_MISMATCH";
    throw err;
  }

  if (payment?.status !== "captured") {
    // Parked, never auto-captured (see doc comment above).
    await orderRef.set(
      {
        paymentStatus: "awaiting_capture",
        "payment.status": "awaiting_capture",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    await parkDiscrepancy("PAYMENT_NOT_CAPTURED", {});
    const err: any = new Error(
      "Your payment has not been captured yet — verification refused and nothing was charged beyond authorization. Please retry; contact support if the hold does not release."
    );
    err.statusCode = 409;
    err.code = "PAYMENT_NOT_CAPTURED";
    throw err;
  }

  return Number(payment.amount);
}

/**
 * Writes the CONFIRMED order state, OTP hash, and payment audit after a
 * verified payment. Split out so the transfer-claim race loser reuses the
 * winner's result through the identical write path (no divergent copies).
 */
async function finishVerifiedPayment(args: {
  orderRef: any;
  orderData: any;
  orderId: string;
  razorpayOrderId: string;
  razorpayPaymentId: string;
  transferResult: any;
  /** Live-fetched captured paise (undefined on mock/legacy paths). */
  capturedAmountPaise?: number;
}) {
  const { orderRef, orderData, orderId, razorpayOrderId, razorpayPaymentId, transferResult, capturedAmountPaise } = args;

  // Update order state in Firestore — crypto-secure OTP for India compliance
  const deliveryOtp =
    orderData.deliveryOtp ||
    (orderData.orderType === "delivery" || !orderData.orderType
      ? String(crypto.randomInt(1000, 10000))
      : undefined);

  // Canonical object form: Partner normalizes it, Delivery reads .code, and
  // server triggers accept both shapes. Never write a bare string status.
  const updatePayload: Record<string, any> = {
    paymentStatus: "completed",
    "payment.status": "completed",
    "payment.razorpayPaymentId": razorpayPaymentId,
    "payment.razorpayOrderId": razorpayOrderId,
    "payment.verifiedAt": admin.firestore.FieldValue.serverTimestamp(),
    // Live gateway truth for downstream transfer-cap checks (lane B worker
    // refuses splits above what the customer actually paid). Mock/legacy
    // paths leave this unset and the worker falls back to pricing paise.
    ...(typeof capturedAmountPaise === "number" && Number.isFinite(capturedAmountPaise)
      ? { "payment.capturedAmountPaise": capturedAmountPaise }
      : {}),
    status: {
      code: "CONFIRMED",
      label: "Order confirmed",
      kind: "upcoming",
      terminal: false,
    },
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (deliveryOtp) {
    // Fail-closed OTP secret (H-M24): dedicated OTP_HMAC_SECRET, never the
    // webhook secret. Mechanical fallout of security.ts — logic unchanged.
    updatePayload.deliveryOtpHash = computeHmacSha256(
      deliveryOtp,
      getOtpHmacSecret()
    );
  }

  await orderRef.set(updatePayload, { merge: true });

  // Append payment audit
  const auditId = `aud_${Date.now()}_${razorpayPaymentId.substring(0, 10)}`;
  await db.collection("payment_audits").doc(auditId).set({
    orderId,
    razorpayOrderId,
    razorpayPaymentId,
    status: "success",
    action: "payment_captured",
    amountPaise: orderData.pricing?.grandTotal ? Math.round(orderData.pricing.grandTotal * 100) : null,
    transferResult,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Loop 63/120: confirm-time Grill-Coins debit (manual-verify path; the
  // webhook path debits independently — both converge via the deterministic
  // ledger id). Best-effort: never fail a verified payment over this.
  try {
    const redemption = await resolveIntentRedemption(razorpayOrderId);
    if (redemption) {
      const { debitRedeemedCoins } = await import("../customers/customerCoins");
      await debitRedeemedCoins({ ...redemption, orderId, razorpayOrderId });
    }
  } catch (err: any) {
    console.warn(
      `[Payments] confirm-time coin debit failed for order ${orderId}:`,
      err?.message || err
    );
    await captureErrorSnapshot({
      source: "payments",
      severity: "high",
      message: `Confirm-time Grill-Coins debit failed for order ${orderId} — remediate via adjustCustomerCoins`,
      orderId,
      razorpayPaymentId,
      errorStack: err?.stack,
    });
  }

  return {
    success: true,
    confirmedOrderId: orderId,
    paymentId: razorpayPaymentId,
    transfer: transferResult,
    deliveryOtp,
  };
}

export interface RefundParams {
  orderId: string;
  razorpayPaymentId: string;
  amountRupees?: number;
  reason?: string;
}

/**
 * Executes a full or partial refund with proportional Route transfer reversal.
 *
 * Fail-closed + idempotent (B2-S1, H-M6/C9 companion): the order must exist
 * and carry the captured payment being refunded (refuses COD/unpaid with
 * 409 — never a silent success the UI could celebrate); partial amounts are
 * capped at the server-priced total; a completed refund replays idempotently
 * instead of re-POSTing to Razorpay. Every refusal carries a statusCode.
 */
export async function autoRefund(
  params: RefundParams,
  caller?: { uid?: string; email?: string | null } | null
) {
  const { orderId, razorpayPaymentId, amountRupees, reason } = params;

  const orderRef = db.collection("orders").doc(orderId);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) {
    const missing: any = new Error(`Cannot refund: order ${orderId} not found.`);
    missing.statusCode = 404;
    missing.code = "ORDER_NOT_FOUND";
    throw missing;
  }
  const order = (orderSnap.data() || {}) as any;
  // Staff boundary: a staffer may only refund their own branches' orders.
  // System callers (ticket auto-refunds, 86-ing compensation) pass no caller
  // and keep working — their paths are covered by scheduler/route RBAC.
  if (caller) await assertOrderBranchAccess(caller, order);
  // Captured-payment proof, both storage shapes: nested (server writes via
  // object form) and dotted-literal (merge-set writes). Either is acceptable;
  // neither present means COD/unpaid — refuse LOUD, never silent success.
  const capturedPaymentId =
    order.payment?.razorpayPaymentId ?? order["payment.razorpayPaymentId"] ?? null;
  if (!capturedPaymentId || capturedPaymentId !== razorpayPaymentId) {
    await captureErrorSnapshot({
      source: "payments",
      severity: "high",
      message: `Refund refused for order ${orderId}: no captured payment matching ${razorpayPaymentId} (COD or unpaid)`,
      orderId,
      razorpayPaymentId,
    });
    const unpaid: any = new Error(
      "Cannot refund: no captured Razorpay payment found for this order (COD or unpaid)."
    );
    unpaid.statusCode = 409;
    unpaid.code = "NO_CAPTURED_PAYMENT";
    throw unpaid;
  }

  const storedGrandTotal = Number(order.pricing?.grandTotal);
  if (
    amountRupees !== undefined &&
    (!Number.isFinite(amountRupees) ||
      amountRupees <= 0 ||
      (Number.isFinite(storedGrandTotal) &&
        storedGrandTotal > 0 &&
        amountRupees > storedGrandTotal))
  ) {
    const over: any = new Error(
      "Refund amount is invalid or exceeds the order total — refused."
    );
    over.statusCode = 400;
    over.code = "REFUND_AMOUNT_EXCEEDS";
    throw over;
  }

  // Claim-then-work lease (double-refund race): concurrent refund attempts
  // for the same order serialize inside ONE transaction. The first claimer
  // sets refundStatus="refunding" with a numeric local-clock lease (never a
  // serverTimestamp sentinel — it has no toMillis on read and would cause
  // instant false takeover). A live lease refuses latecomers with 409
  // REFUND_IN_PROGRESS; a stale lease (>10m, crashed worker) is taken over.
  // The same transaction enforces the cumulative partial-refund cap and the
  // idempotent same-amount replay, so check and act are atomic.
  //
  // runTx: real Firestore transactions in production; a direct read/write
  // fallback for datastore shims without transactions (tests only) — same
  // checks, no cross-process atomicity (matches bookPorterRider +
  // routeTransfers convention).
  const runTx: (fn: (tx: any) => Promise<any>) => Promise<any> =
    db && typeof (db as any).runTransaction === "function"
      ? (fn) => (db as any).runTransaction(fn)
      : async (fn) =>
          fn({
            get: (ref: any) => ref.get(),
            set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
          });
  const REFUND_CLAIM_TTL_MS = 10 * 60_000;
  const requestedPaise =
    amountRupees !== undefined && amountRupees !== null
      ? Math.round(Number(amountRupees) * 100)
      : null;
  const capturedPaise =
    Number.isFinite(storedGrandTotal) && storedGrandTotal > 0
      ? Math.round(storedGrandTotal * 100)
      : null;
  const claimed = await runTx(async (tx) => {
    const snap = await tx.get(orderRef);
    const data = ((snap.exists ? snap.data() : {}) || {}) as any;
    const existingTotal = Number(data.refundedTotalPaise) || 0;

    // Idempotent replay: the same (payment, amount) refund returns the stored
    // receipt instead of POSTing a second refund. A completed full refund
    // followed by a DIFFERENT amount is a double-spend attempt — refuse.
    if (data.refundStatus === "refunded" && data.refundId) {
      const sameAmount =
        (data.refundAmount ?? undefined) === (amountRupees ?? undefined);
      if (sameAmount) {
        return { replay: { id: data.refundId, payment_id: razorpayPaymentId, status: "processed", reused: true as const } };
      }
      const dup: any = new Error("Order is already fully refunded — refusing a second refund.");
      dup.statusCode = 409;
      dup.code = "ALREADY_REFUNDED";
      throw dup;
    }

    if (data.refundStatus === "refunding") {
      const claimedAt = Number(data.refundClaimedAt) || 0;
      if (Date.now() - claimedAt < REFUND_CLAIM_TTL_MS) {
        const busy: any = new Error("A refund for this order is already in progress — do not retry.");
        busy.statusCode = 409;
        busy.code = "REFUND_IN_PROGRESS";
        throw busy;
      }
      // Stale lease: previous worker died mid-flight. Take over (the old
      // worker's gateway POST, if it landed, is reconciled by the
      // refund.processed webhook's monotonic totals).
    }

    // Cumulative partial-refund cap: sequential partials may never exceed
    // the captured total. A "full" request after partials is refused with
    // the exact remaining paise (operator refunds the remainder explicitly —
    // no magic remainder that could double-pay).
    if (requestedPaise !== null && capturedPaise !== null) {
      if (requestedPaise + existingTotal > capturedPaise) {
        const over: any = new Error(
          `Refund of ${requestedPaise}pa exceeds the remaining refundable ${capturedPaise - existingTotal}pa — refused.`
        );
        over.statusCode = 400;
        over.code = "REFUND_EXCEEDS_REMAINING";
        throw over;
      }
    }
    if (requestedPaise === null && existingTotal > 0 && capturedPaise !== null) {
      const partials: any = new Error(
        `Order already has partial refunds (${existingTotal}pa) — refund the remaining ${capturedPaise - existingTotal}pa explicitly.`
      );
      partials.statusCode = 409;
      partials.code = "REFUND_PARTIALS_EXIST";
      throw partials;
    }

    tx.set(
      orderRef,
      {
        refundStatus: "refunding",
        refundClaimedAt: Date.now(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return { existingTotal };
  });
  if ((claimed as any).replay) return (claimed as any).replay;
  const existingTotalPaise = (claimed as { existingTotal: number }).existingTotal;

  const refundPayload: any = {
    reverse_all: true, // Automatically reverses split transfer proportionally from branch
    notes: {
      orderId,
      reason: reason || "Customer support resolution / item rejection",
    },
  };

  if (amountRupees && amountRupees > 0) {
    refundPayload.amount = Math.round(amountRupees * 100);
  }

  let refundResult: any;

  if (config.mock.paymentGateway) {
    refundResult = {
      id: `rfnd_mock_${Date.now()}`,
      payment_id: razorpayPaymentId,
      amount: refundPayload.amount || 10000,
      status: "processed",
    };
  } else {
    try {
      // Key validation + mock-mode refusal live in getRazorpayClient; the
      // POST itself goes over raw HTTPS (not the SDK) so we can send
      // X-Refund-Idempotency: a stable per-(order, amount) fingerprint.
      // Razorpay dedupes retries with the same key server-side — a
      // lost-response retry replays the ORIGINAL refund instead of posting
      // a second one. A retry with a DIFFERENT body is rejected outright.
      getRazorpayClient();
      refundResult = await postRefundWithIdempotency(
        razorpayPaymentId,
        refundPayload,
        `refund_${orderId}_${requestedPaise ?? "full"}`
      );
    } catch (err: any) {
      await captureErrorSnapshot({
        source: "payments",
        severity: "high",
        message: `Refund execution failed for payment ${razorpayPaymentId}: ${err.message}`,
        orderId,
        razorpayPaymentId,
      });
      const failed: any = new Error(`Refund failed: ${err.message}`);
      failed.statusCode = 502;
      failed.code = "REFUND_GATEWAY_FAILED";
      throw failed;
    }
  }

  // Update order record. refundedTotalPaise accumulates monotonically so
  // sequential partials and webhook replays converge instead of overwriting
  // (see webhookHandler refund.processed). The lease marker is cleared.
  const refundedPaise = Number(refundResult.amount) || 0;
  await orderRef.set(
    {
      refundStatus: "refunded",
      refundAmount: amountRupees ?? null,
      refundedTotalPaise: existingTotalPaise + refundedPaise,
      refundClaimedAt: admin.firestore.FieldValue.delete(),
      refundId: refundResult.id,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  // Append audit trail
  const auditId = `aud_rfnd_${Date.now()}_${refundResult.id}`;
  await db.collection("payment_audits").doc(auditId).set({
    orderId,
    razorpayPaymentId,
    refundId: refundResult.id,
    amountRupees: amountRupees ?? null,
    action: "refund_processed",
    reason: reason ?? null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Readiness-7: security-registry row (best-effort — never fails the refund).
  const { writeAuditLog } = await import("../audit/auditLog");
  await writeAuditLog({
    actorUid: caller?.uid ?? null,
    actorEmail: caller?.email ?? null,
    action: "refund_processed",
    targetType: "order",
    targetId: orderId,
    metadata: {
      razorpayPaymentId,
      refundId: refundResult.id,
      amountRupees: amountRupees ?? null,
    },
  });

  return refundResult;
}
