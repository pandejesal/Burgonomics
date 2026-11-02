import * as crypto from "crypto";
import * as admin from "firebase-admin";
import * as https from "https";
import { db } from "../../core/firebase";
import { config, assertLivePaymentsContext } from "../../config/env";
import {
  verifyRazorpaySignature,
  computeHmacSha256,
  getOtpHmacSecret,
  isSafeDocId,
} from "../../core/security";
import { captureErrorSnapshot } from "../../core/errors";
import {
  markOrderReconciliation,
  parkTerminalPaymentCapture,
  claimCapturedPaymentInTx,
  isMoneyClaimFresh,
} from "./reconciliation";
import { assertOrderBranchAccess } from "../../core/middleware";
import {
  markPaymentVerificationInFlight,
  clearPaymentVerificationInFlight,
} from "../orders/paymentGate";
import { calculateOrderPricing, assertCatalogLinesSellable, CalculateOrderPricingInput } from "./pricing.engine";
import { guardCaptureFulfillment, captureGateAllowsConfirm } from "./captureFulfillment";
import { PAYMENT_INTENT_TTL_MS } from "./lifetimes";
import { resolveBranchId } from "./branchResolver";
import { ensureMonthlyFeeHold, applyRefundToMonthlyFee, type MonthlyFeeHold } from "./monthlyFee";
import { bindDeliveryQuote, deliveryQuoteError } from "./deliveryQuotes";
import { getRazorpayClient, getRazorpayKeyId } from "./razorpayClient";
import {
  attemptRouteTransfer,
  retryPendingRouteTransfersWorker,
  calculateRouteSplit,
  isOrderTerminalForRouteTransfer,
  recordTerminalRefusalInTx,
} from "./routeTransfers";

export { retryPendingRouteTransfersWorker, calculateRouteSplit } from "./routeTransfers";
export { getOtpHmacSecret };
// Grill-Coins redemption is disabled for launch (D31-D33); the reservation-aware
// debit is no longer exported from the payment lane. The function itself stays
// in `coinCapture.ts` for a future, explicitly enabled launch.

/**
 * Delivery-OTP invariant, SHARED by every channel that can confirm payment
 * (client verify primary, client-verify backfill, Razorpay webhook).
 *
 * The webhook path used to write CONFIRMED with no `deliveryOtpHash` at all,
 * so an app-closed payer's delivery order could never be handed over —
 * `verifyDeliveryOtp` throws "No delivery OTP found" — for exactly the payers
 * the authoritative webhook channel exists to serve. One implementation keeps
 * the rule identical everywhere:
 *
 *   eligible  = orderType is "delivery", or absent (legacy docs predate the
 *               field; refusing those would strand paid orders);
 *   mint      = only when NO hash is present yet — an existing hash is never
 *               overwritten, which is what makes replays idempotent.
 *
 * The plaintext is returned ONLY so the client-verify channel can show it to
 * the payer (the single defined delivery of the code — a product decision,
 * A08 P2). The webhook path satisfies the hash invariant but must NOT surface
 * a code it never showed the customer.
 */
export function isDeliveryOtpEligible(doc: any): boolean {
  const ot = typeof doc?.orderType === "string" ? doc.orderType.trim() : doc?.orderType;
  return ot === "delivery" || !ot;
}

export function hasDeliveryOtpHash(doc: any): boolean {
  return typeof doc?.deliveryOtpHash === "string" && doc.deliveryOtpHash.length > 0;
}

/** Fresh mint for an eligible order with no hash yet; `undefined` otherwise. */
export function mintDeliveryOtp(
  doc: any
): { otp: string; deliveryOtpHash: string } | undefined {
  if (!isDeliveryOtpEligible(doc) || hasDeliveryOtpHash(doc)) return undefined;
  const otp = String(crypto.randomInt(1000, 10000));
  return { otp, deliveryOtpHash: computeHmacSha256(otp, getOtpHmacSecret()) };
}

/**
 * The only currency Burgonomics settles in. Route splits, refund reversal
 * (`reverse_all`), paise rounding, and the reconciliation ledgers are all
 * INR-specific — an unsupported currency must fail closed at order creation
 * instead of reaching an INR-only gateway (or, worse, being coerced).
 */
const ORDER_CURRENCY = "INR";
const SUPPORTED_CURRENCIES = ["INR"];

function assertSupportedCurrency(currency: string): void {
  if (!SUPPORTED_CURRENCIES.includes(currency)) {
    const err: any = new Error(
      `Currency ${currency} is not supported for payment — we settle in ${SUPPORTED_CURRENCIES.join(", ")}.`
    );
    err.code = "CURRENCY_NOT_SUPPORTED";
    err.statusCode = 400;
    throw err;
  }
}

/**
 * Fail-closed payable-amount gate (whole paise). `<= 0`, `NaN`, `±Infinity`,
 * and any rupee total that cannot be represented as an integer paise count
 * are refused BEFORE a gateway order is minted — Razorpay rejects them, and a
 * coerced float would silently charge the wrong number of paise.
 */
function assertPayableAmount(amountPaise: number): number {
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
    const err: any = new Error(
      "Your cart total is empty or cannot be settled in whole paise — please review your cart and retry."
    );
    err.code = "INVALID_AMOUNT";
    err.statusCode = 400;
    throw err;
  }
  return amountPaise;
}

/**
 * Deterministic id slug for discrepancy docs: ONE stable doc id per
 * (order, payment) pair, so a retried verification converges on the same
 * `payment_discrepancies/dis_*` park instead of forking duplicates for ops.
 * Shared by the live-bind refusals (`assertLivePaymentMatchesOrder`) and the
 * pre-split second-capture binding below.
 */
function slug(v: unknown): string {
  return String(v ?? "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "unknown";
}

/**
 * Reads a server-recorded payment binding from BOTH shapes an order doc can
 * legitimately carry: the nested `payment` object literal
 * (`payment.razorpayPaymentId`) and the legacy dotted top-level key
 * (`"payment.razorpayPaymentId"`). A legacy scalar `payment` value (a bare
 * status literal) is never treated as a binding — only a non-empty STRING
 * field counts, so malformed data can never refuse a legitimate confirmation.
 * Nested wins when both exist (that is the canonical shape verify writes).
 */
function readRecordedPaymentField(
  doc: any,
  field: "razorpayPaymentId" | "razorpayOrderId" | "capturedPaymentId"
): string | null {
  const nested =
    doc?.payment && typeof doc.payment === "object" ? doc.payment[field] : undefined;
  const dotted = doc?.[`payment.${field}`];
  if (typeof nested === "string" && nested) return nested;
  if (typeof dotted === "string" && dotted) return dotted;
  return null;
}

/**
 * Deterministically parks a second distinct captured payment into
 * `payment_discrepancies/dis_<order>_<payment>` with reason SECOND_CAPTURE_MISMATCH,
 * captures an error snapshot, and throws structured 409 SECOND_CAPTURE_MISMATCH.
 * Shared across the pre-read guard, executeRouteSplit claim backstop, and
 * finishVerifiedPayment transactional backstop.
 */
async function parkSecondCaptureMismatch(params: {
  orderId: string;
  razorpayOrderId?: string | null;
  razorpayPaymentId: string;
  expectedPaise?: number | null;
  capturedAmountPaise?: number | null;
  recordedPaymentId?: string | null;
  recordedRazorpayOrderId?: string | null;
  orderStatus?: string | null;
}): Promise<never> {
  const {
    orderId,
    razorpayOrderId,
    razorpayPaymentId,
    expectedPaise,
    capturedAmountPaise,
    recordedPaymentId,
    recordedRazorpayOrderId,
    orderStatus,
  } = params;

  await db
    .collection("payment_discrepancies")
    .doc(`dis_${slug(orderId)}_${slug(razorpayPaymentId)}`)
    .set(
      {
        orderId,
        razorpayOrderId: razorpayOrderId || null,
        razorpayPaymentId,
        expectedPaise: Number.isFinite(expectedPaise) ? expectedPaise : null,
        actualPaise: typeof capturedAmountPaise === "number" ? capturedAmountPaise : null,
        gatewayStatus: typeof capturedAmountPaise === "number" ? "captured" : null,
        reason: "SECOND_CAPTURE_MISMATCH",
        status: "needs_review",
        recordedPaymentId: recordedPaymentId || null,
        recordedRazorpayOrderId: recordedRazorpayOrderId || null,
        orderStatus: orderStatus || null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  await captureErrorSnapshot({
    source: "payments",
    severity: "high",
    message: `Second distinct captured payment ${razorpayPaymentId} for order ${orderId} already confirmed by ${recordedPaymentId || recordedRazorpayOrderId || "an earlier capture"} — parked in payment_discrepancies, order NOT re-confirmed, no split`,
    orderId,
    razorpayPaymentId,
  }).catch(() => undefined);
  const secondCaptureErr: any = new Error(
    "This order is already confirmed by a different payment — verification refused. Contact support if money left your account."
  );
  secondCaptureErr.statusCode = 409;
  secondCaptureErr.code = "SECOND_CAPTURE_MISMATCH";
  throw secondCaptureErr;
}

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
    hostname: "api.razorpay.com",
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
  /**
   * IGNORED (R6): the customer-facing delivery fee comes from the persisted
   * courier quote named by `deliveryQuoteId`. A body may still carry this
   * legacy field; it is never read.
   */
  deliveryFee?: number;
  /** IGNORED: packaging is a server branch value (shared pricing helper). */
  packagingFee?: number;
  /**
   * The id returned by POST /checkout/fees. REQUIRED for delivery: it names
   * the persisted courier quote whose fee is charged and which is bound to
   * this order (R6).
   */
  deliveryQuoteId?: string;
  couponCode?: string;
  loyaltyPointsToRedeem?: number;
  customerId: string;
  customerName?: string;
  customerPhone?: string;
  /** Stable per-checkout key: retries reuse the open gateway order. */
  idempotencyKey?: string;
}

/**
 * Branch resolution lives in ./branchResolver so POST /checkout/fees resolves
 * the branch EXACTLY like createPaymentOrder (R5): explicit branchId wins,
 * otherwise stores/{id}.partnerBranchId; an unlinked store is 409.
 */

/**
 * R6: loads the persisted courier quote and binds it to this order inside a
 * transaction, returning the fee to charge.
 *
 * The quote is the ONLY source of a delivery fee. Every binding is enforced
 * here, atomically with the single-use claim:
 *   - same uid, same branch, same drop coordinates as the order's address,
 *   - not expired,
 *   - `usedByOrderId` null (fresh) or THIS order (a legitimate retry).
 * Anything else refuses checkout before a payable gateway order is minted, so
 * a delivery is never charged 0, a default, or another order's price.
 */
async function bindDeliveryQuoteForOrder(args: {
  quoteId: string | undefined;
  orderId: string | undefined;
  uid: string;
  branchId: string;
}): Promise<number> {
  const { quoteId, orderId, uid, branchId } = args;
  if (!quoteId) {
    throw deliveryQuoteError(
      "DELIVERY_QUOTE_REQUIRED",
      "A delivery checkout needs a delivery price — get one and retry."
    );
  }
  if (!orderId) {
    // The quote binds to an order; without one there is nothing to protect.
    throw deliveryQuoteError(
      "DELIVERY_QUOTE_REQUIRED",
      "A delivery checkout needs an order to attach its delivery price to — retry from the cart."
    );
  }
  // Shared transactional binder: same rules whether the order is paid online
  // (expiry judged now) or accepted as cash later (R6b, judged at creation).
  return bindDeliveryQuote({ quoteId, orderId, uid, branchId, expiryMode: "now" });
}

/**
 * PAY-15: the order document names the branch. An explicit `branchId` on the
 * doc wins outright; otherwise the doc's own store maps to its branch. The
 * REQUEST is never consulted — a caller-supplied branch used to move the
 * packaging fee and the Route transfer target.
 */
async function resolveOrderBranchForPayment(orderData: any): Promise<string> {
  const docBranch =
    typeof orderData?.branchId === "string" && orderData.branchId.trim()
      ? orderData.branchId.trim()
      : "";
  if (docBranch) return docBranch;

  const docStoreId =
    (typeof orderData?.storeId === "string" && orderData.storeId) ||
    (typeof orderData?.store?.id === "string" && orderData.store.id) ||
    "";
  // Same resolution (and same typed 409/503) as POST /checkout/fees.
  return resolveBranchId({ storeId: docStoreId });
}

/**
 * PAYMENTS_CONTRACT_SPEC §1 gate: the internal orders/{orderId} doc must
 * EXIST, be UNPAID, and belong to the CALLER before any payable gateway
 * order is minted. 404 for an unknown id, 409 for paid/foreign orders, 503
 * when the check itself is unavailable (fail closed — a checkout that cannot
 * prove ownership never opens).
 *
 * PAY-13: it also RETURNS the order document, because that document — not the
 * request body — is the cart the money is computed from (the KOT builder
 * fulfils `orders/{orderId}.items`).
 */
async function assertPayableOrderDoc(
  orderId: string,
  customerId: string
): Promise<Record<string, any>> {
  if (!db || typeof db.collection !== "function") {
    const err: any = new Error("Order verification is temporarily unavailable — please retry checkout.");
    err.statusCode = 503;
    err.code = "ORDER_VERIFY_UNAVAILABLE";
    throw err;
  }
  let snap: any;
  try {
    snap = await db.collection("orders").doc(orderId).get();
  } catch (err: any) {
    console.warn("[Payments] order-doc lookup failed, refusing checkout:", err?.message || err);
    const unavailable: any = new Error("Order verification is temporarily unavailable — please retry checkout (you will not be charged twice).");
    unavailable.statusCode = 503;
    unavailable.code = "ORDER_VERIFY_UNAVAILABLE";
    throw unavailable;
  }
  if (!snap?.exists) {
    const err: any = new Error(`Order ${orderId} not found — start checkout from an existing cart.`);
    err.statusCode = 404;
    err.code = "ORDER_NOT_FOUND";
    throw err;
  }
  const data = (snap.data() || {}) as any;
  const paid =
    data.paymentStatus === "completed" ||
    data["payment.status"] === "completed" ||
    data.payment?.status === "completed";
  if (paid) {
    const err: any = new Error("This order is already paid — refusing to mint a second gateway order.");
    err.statusCode = 409;
    err.code = "ORDER_ALREADY_PAID";
    throw err;
  }
  // Ownership: an authenticated customer may only pay for THEIR order; a
  // guest may only pay an order that carries no other customer's id. Never
  // trust the requested customerId here — the route binds it to the token.
  const owner =
    typeof data.customerId === "string" && data.customerId ? data.customerId : "guest";
  if (owner !== customerId) {
    const err: any = new Error("This order belongs to a different customer — refusing checkout.");
    err.statusCode = 409;
    err.code = "ORDER_NOT_OWNED";
    throw err;
  }
  return data;
}

/**
 * PAY-13 helpers. The ORDER DOCUMENT is the cart: `items`, the coupon and the
 * order type are read from it, normalized to the engine's line shape, and
 * fingerprinted so an idempotent retry can never hand back a gateway order
 * minted for a different cart.
 */
function orderDocRequiredError(): Error {
  const err: any = new Error(
    "Start checkout from an existing cart — this payment attempt names no order to price."
  );
  err.statusCode = 409;
  err.code = "ORDER_REQUIRED";
  return err;
}

function unpriceableOrderError(detail: string): Error {
  const err: any = new Error(`Cannot price this order: ${detail}`);
  err.statusCode = 422;
  err.code = "UNPRICEABLE";
  return err;
}

/** The doc's order type (canonical), falling back to the request's. */
function orderDocType(orderData: any, requested: string): string {
  const raw = String(orderData?.orderType || orderData?.fulfillmentType || "").toLowerCase();
  if (raw === "delivery") return "delivery";
  if (raw === "takeaway" || raw === "pickup") return "takeaway";
  if (raw === "dinein" || raw === "dine_in" || raw === "dine-in") return "dinein";
  return requested;
}

/** Doc items in the pricing engine's validated line shape, or UNPRICEABLE. */
function priceableDocItems(orderData: any): any[] {
  const items = orderData?.items;
  if (!Array.isArray(items) || items.length === 0) {
    throw unpriceableOrderError("the order has no priceable items.");
  }
  return items.map((item: any) => ({
    id: String(item?.lineId || item?.id || item?.productId || ""),
    productId: String(item?.productId || item?.id || ""),
    name: String(item?.name || ""),
    // Shape only: the engine replaces this with the authoritative catalog
    // price. Never used as money on its own.
    price: Number(item?.price ?? item?.unitPrice ?? item?.basePrice ?? 0),
    quantity: Number(item?.quantity) || 1,
    customizations: item?.customizations,
    modifiers: item?.modifiers || item?.selectedAddons,
  }));
}

/** Stable hash of everything that decides the amount for this cart. */
export function cartFingerprintForOrder(
  items: any[],
  couponCode: string | undefined,
  loyaltyPointsToRedeem: number
): string {
  const lines = items.map((item: any) => ({
    id: item?.id || "",
    productId: item?.productId || "",
    quantity: Number(item?.quantity) || 1,
    price: Number(item?.price) || 0,
    customizations: (Array.isArray(item?.customizations) ? item.customizations : []).map(
      (c: any) => [String(c?.id || ""), Number(c?.price) || 0]
    ),
    modifiers: (Array.isArray(item?.modifiers) ? item.modifiers : []).map((m: any) => [
      String(m?.id || ""),
      Number(m?.priceDelta ?? m?.price) || 0,
    ]),
  }));
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ lines, couponCode: couponCode || null, loyaltyPointsToRedeem }))
    .digest("hex");
}

/** Internal alias (the exported name exists so retry tests can pre-seed one). */
const cartFingerprint = cartFingerprintForOrder;

/** An open gateway order minted for a cart this order no longer has. */
function paymentIntentCartMismatchError(): Error {
  const err: any = new Error(
    "This cart changed after the payment attempt was created — nothing was charged. Please review your cart and start a new order."
  );
  err.statusCode = 409;
  err.code = "PAYMENT_INTENT_CART_MISMATCH";
  return err;
}

/**
 * P1-M — persist what IS known about a refund whose gateway response carried no
 * usable id, WITHOUT touching any proven-refund accounting.
 *
 * Deliberately merge-only and undefined-free:
 *  - the refund CLAIM is left in place (no second POST can start),
 *  - `refundUncertain` records the attempt for ops + the retry,
 *  - `refundStatus` / `refundId` / `refundedTotalPaise` / the ledger / the fee
 *    release are NOT written, because none of them is proven,
 *  - the request record is marked `reconciliation_required` rather than
 *    `completed`, so a same-key retry refuses instead of re-POSTing.
 */
async function recordUncertainRefund(args: {
  orderRef: any;
  orderId: string;
  razorpayPaymentId: string;
  refundRequestId?: string;
  gatewayKey: string;
  attemptedPaise: number | null;
  reason?: string;
  responseStatus: string | null;
  responseAmount: number | null;
  reqRef: any;
}): Promise<void> {
  const at = Date.now();
  try {
    await args.orderRef.set(
      {
        refundUncertain: {
          attempted: true,
          razorpayPaymentId: args.razorpayPaymentId,
          requestId: args.refundRequestId ?? null,
          gatewayKey: args.gatewayKey,
          amountPaise:
            typeof args.attemptedPaise === "number" && Number.isFinite(args.attemptedPaise)
              ? args.attemptedPaise
              : null,
          responseStatus: args.responseStatus,
          responseAmountPaise: args.responseAmount,
          reason: args.reason ?? null,
          detectedAt: at,
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  } catch (err: any) {
    console.warn(
      `[Payments] uncertain-refund marker write failed for order ${args.orderId}:`,
      err?.message || err
    );
  }

  if (args.reqRef && args.refundRequestId) {
    try {
      await args.reqRef.set(
        {
          status: "reconciliation_required",
          uncertaintyReason: "gateway_response_missing_refund_id",
          gatewayKey: args.gatewayKey,
          detectedAt: at,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    } catch (err: any) {
      console.warn(
        `[Payments] uncertain refund-request write failed for ${args.refundRequestId}:`,
        err?.message || err
      );
    }
  }

  // Park where ops already look for unapplied money.
  try {
    await db
      .collection("unmatched_payments")
      .doc(`ump_refund_uncertain_${args.razorpayPaymentId}_${args.refundRequestId || args.gatewayKey}`)
      .set(
        {
          event: "refund_uncertain",
          razorpayPaymentId: args.razorpayPaymentId,
          orderId: args.orderId,
          refundRequestId: args.refundRequestId ?? null,
          gatewayKey: args.gatewayKey,
          amountPaise:
            typeof args.attemptedPaise === "number" && Number.isFinite(args.attemptedPaise)
              ? args.attemptedPaise
              : null,
          responseStatus: args.responseStatus,
          reason: "refund_response_missing_id",
          status: "needs_review",
          receivedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
  } catch (err: any) {
    console.warn(
      `[Payments] uncertain-refund park write failed for ${args.orderId}:`,
      err?.message || err
    );
  }
}

/**
 * P1-I — reconcile an ambiguous mint.
 *
 * The gateway order is created FIRST (Razorpay offers no cancel), so any
 * storage failure afterwards leaves a payable order this server cannot bind.
 * Fail closed here: release the coin funding that backed the mint, write ONE
 * durable reconciliation record for ops, page, and rethrow a retryable 503 so
 * the client retries the SAME idempotency key (which then reaches a persisted
 * intent or is superseded normally). Exposing the order instead is what let a
 * customer pay for an intent that mandatory-intent verification then refused.
 */
/**
 * P1-I / ambiguous-persistence reconciliation.
 *
 * The gateway order is created FIRST (Razorpay offers no cancel), so a storage
 * failure afterwards is ambiguous: the intent may be absent, may be partially
 * written, or may in fact be durably bound (a write that returned 2xx reports
 * success but a read can fail for an unrelated reason). The old code released
 * the mint unconditionally, which could orphan a payable intent that ANOTHER
 * request then reuses.
 *
 * So: re-read first.
 *
 *  - The intent IS bound to this exact gateway order → nothing is wrong. Say so
 *    and let the caller converge on it (it may be reused, never duplicated).
 *  - The read itself fails → persistence cannot be DISPROVEN, so release
 *    nothing: record the mint for ops and refuse. A later retry converges.
 *  - The read succeeds and shows NO binding → proven unbacked: release the mint
 *    for ops, refuse, and never expose it.
 *
 * Nothing here ever hands a payable gateway order to a client.
 */
type MintBindingTruth = "bound" | "absent" | "unknown";

async function readMintBinding(args: {
  intentRef: any;
  razorpayOrderId: string;
}): Promise<{ truth: MintBindingTruth; intent?: any }> {
  if (!args.intentRef || typeof args.intentRef.get !== "function") {
    return { truth: "unknown" };
  }
  try {
    const snap = await args.intentRef.get();
    const stored = (snap?.exists ? snap.data() : null) as any;
    if (!stored) return { truth: "absent" };
    if (stored.razorpayOrderId === args.razorpayOrderId) {
      return { truth: "bound", intent: stored };
    }
    return { truth: "absent" };
  } catch (err: any) {
    console.warn(
      "[Payments] intent read-back failed — persistence cannot be disproved:",
      err?.message || err
    );
    return { truth: "unknown" };
  }
}

async function recordMintReconciliation(args: {
  razorpayOrderId: string;
  orderId?: string;
  reason: string;
  status: "needs_review" | "persistence_unknown";
  error: any;
}): Promise<void> {
  try {
    await db.collection("payment_intent_reconciliation").doc(slug(args.razorpayOrderId)).set(
      {
        razorpayOrderId: args.razorpayOrderId,
        orderId: args.orderId || null,
        reason: args.reason,
        status: args.status,
        detail: String(args.error?.message || args.error || "").slice(0, 500),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  } catch (writeErr: any) {
    console.warn(
      "[Payments] unbacked-mint reconciliation write failed:",
      writeErr?.message || writeErr
    );
  }
  await captureErrorSnapshot({
    source: "payments",
    severity: "high",
    message: `Payable gateway order ${args.razorpayOrderId} could not be bound to a durable payment intent (${args.reason}, ${args.status}) — order NOT exposed`,
    orderId: args.orderId,
    errorStack: args.error?.stack,
  }).catch(() => undefined);
}

/**
 * Refuse a mint after an ambiguous persistence outcome, preserving whatever
 * state can be proven. Returns "bound" so the caller can converge on an intent
 * that turned out to exist; otherwise throws the retryable 503 after recording.
 */
async function refuseAmbiguousMint(args: {
  intentRef: any;
  razorpayOrderId: string;
  orderId?: string;
  reason: string;
  error: any;
}): Promise<{ bound: true; intent: any }> {
  const binding = await readMintBinding({
    intentRef: args.intentRef,
    razorpayOrderId: args.razorpayOrderId,
  });
  if (binding.truth === "bound") {
    // Persistence is PROVEN: do not record a failure or release anything.
    console.warn(
      `[Payments] intent write reported an error for ${args.razorpayOrderId} but the binding IS durable — converging on it`
    );
    return { bound: true, intent: binding.intent };
  }
  await recordMintReconciliation({
    razorpayOrderId: args.razorpayOrderId,
    orderId: args.orderId,
    reason: args.reason,
    // An unreadable read proves nothing, so it must not be treated as "the
    // intent is gone" by whoever clears these records.
    status: binding.truth === "unknown" ? "persistence_unknown" : "needs_review",
    error: args.error,
  });
  const refused: any = new Error(
    "Payment service is temporarily unavailable — please retry checkout (you will not be charged twice)."
  );
  refused.statusCode = 503;
  refused.code = "PAYMENT_INTENT_UNAVAILABLE";
  refused.retryAfterMs = 2000;
  throw refused;
}

/**
 * P1-I — the capture-side availability gate lives in `captureFulfillment.ts`
 * so the client verify channel and the `payment.captured` webhook run the SAME
 * first-capture decision. See `guardCaptureFulfillment`.
 */

/**
 * P1-I — is the cart still sellable RIGHT NOW?
 *
 * Razorpay orders stay payable for their whole TTL, and a reused idempotency
 * intent hands that live order straight back. The recheck must therefore read
 * the catalogue fresh and raise the SAME typed `ITEM_UNAVAILABLE` refusal the
 * first attempt would have.
 *
 * It deliberately does NOT re-run `calculateOrderPricing`: that needs the full
 * money inputs, and a delivery intent can only be priced with a persisted
 * courier quote. Re-pricing here refused EVERY ordinary delivery retry (a
 * dropped connection, a refresh mid-payment) with DELIVERY_FEE_REQUIRED even
 * though nothing was unavailable. The catalogue probe checks exactly the thing
 * this gate exists for — can the kitchen still cook these lines — without
 * re-deciding the amount the customer is already paying.
 */
async function assertCartStillSellable(args: {
  items: any[];
  branchId: string;
  orderType: string;
  orderId?: string;
}): Promise<void> {
  try {
    await assertCatalogLinesSellable(args.items);
  } catch (err: any) {
    if (err?.code === "ITEM_UNAVAILABLE") {
      await captureErrorSnapshot({
        source: "payments",
        severity: "medium",
        message: `Payable intent refused on reuse: the cart is no longer sellable (${err.message})`,
        orderId: args.orderId,
        branchId: args.branchId,
      }).catch(() => undefined);
    }
    throw err;
  }
}

/**
 * Loads the SERVER-WRITTEN payment intent for a Razorpay order id. This is
 * the authoritative binding rzp order -> internal orderId -> server-priced
 * amount (PAYMENTS_CONTRACT_SPEC §2). Returns null when nothing trustworthy
 * is stored — never a client-written doc (the razorpayOrderId field must
 * match exactly, so a datastore query shim returning junk is ignored).
 *
 * Exported for the `payment.captured` / `order.paid` webhook, which needs the
 * same server-truth amount when an order doc carries no stored total (C03/B8:
 * never confirm an amount the server cannot prove).
 */
export async function loadPaymentIntent(razorpayOrderId: string): Promise<any | null> {
  if (!razorpayOrderId || !db || typeof db.collection !== "function") return null;
  try {
    const snap = await db
      .collection("payment_intents")
      .where("razorpayOrderId", "==", razorpayOrderId)
      .limit(1)
      .get();
    const doc = snap?.docs?.[0];
    const data = (doc ? (doc.data() as any) : undefined) as any;
    if (!data || data.razorpayOrderId !== razorpayOrderId) return null;
    return data;
  } catch (err: any) {
    console.warn("[Payments] payment-intent lookup failed:", err?.message || err);
    return null;
  }
}

/**
 * Grill-Coins redemption gate for checkout (D31-D33).
 *
 * The launch customer app shows no loyalty balance and pins
 * `loyaltyPointsToRedeem` to 0, so redemption is a NON-LAUNCH feature: any
 * non-zero request is refused with a typed 409 before a gateway order is
 * minted, before a reservation exists, and before pricing can apply a coin
 * discount. Keeping the refusal here — one place, synchronous, ahead of every
 * money decision — is what makes "no coin code runs on the payment path" true
 * rather than aspirational.
 *
 * A zero (or absent) redemption returns 0, which is the ordinary launch path.
 * Flipping `config.loyalty.redemptionEnabled` is the single switch that would
 * re-enable the feature; the pre-existing balance/cap validation is preserved
 * behind it so a future launch does not silently trust a client count.
 */
export function resolveRedeemableCoins(
  customerId: string,
  requested: unknown,
): number {
  const want =
    typeof requested === "number" && Number.isFinite(requested)
      ? Math.floor(requested)
      : 0;
  if (want <= 0) return 0;
  if (!config.loyalty.redemptionEnabled) {
    const disabled: any = new Error(
      "Grill-Coins redemption is not available at the moment — please complete checkout without redeeming points."
    );
    disabled.statusCode = 409;
    disabled.code = "COIN_REDEMPTION_DISABLED";
    throw disabled;
  }
  // Feature enabled: the balance is still server-checked, never trusted. The
  // caller awaits `verifyRedeemableCoinBalance` for the authoritative count.
  return want;
}

/**
 * Balance check for a redemption when the feature is deliberately enabled.
 * Unreachable at launch (the gate above refuses first), kept so re-enabling
 * cannot reintroduce the "claim 20% off with zero balance" hole.
 */
export async function verifyRedeemableCoinBalance(
  customerId: string,
  coins: number
): Promise<void> {
  const want = Math.max(0, Math.floor(Number(coins) || 0));
  if (want <= 0) return;
  let balance = 0;
  if (customerId && customerId !== "guest" && db && typeof db.collection === "function") {
    try {
      const snap = await db.collection("customers").doc(customerId).get();
      const raw = snap.exists ? (snap.data() as any)?.loyaltyPoints : undefined;
      balance = Math.max(0, Math.floor(Number(raw) || 0));
    } catch (err: any) {
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
    err.code = "COINS_INSUFFICIENT";
    throw err;
  }
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
 * Payment-intent reuse contract (lane 7).
 *
 * The stored intent is the server-written binding gatewayOrder -> internal
 * orderId. Returning it for a DIFFERENT internal order would only surface at
 * `verifyPayment` (409 ORDER_MISMATCH) — after the customer's money moved, as
 * happens when the client mints a new internal order after a modal dismiss or
 * a reload while the basket fingerprint (and so the idempotency key) stays the
 * same. A live reused intent is therefore handed out ONLY to the order it is
 * bound to; a missing/corrupt binding is refused, never guessed.
 *
 * Expiry is decided first: an expired lease holds no live binding, so the
 * freshly minted order supersedes it (this is also what makes the 24h TTL
 * effective — the lost-claim path used to resurrect the stale winner).
 */
function hasUsableGatewayIntent(intent: any): boolean {
  // STRICT numeric amount: a numeric string/boolean is a corrupt money field,
  // not a reusable total (the pre-existing read-hit gate is strict too).
  const paise = intent?.amountPaise;
  return (
    typeof intent?.razorpayOrderId === "string" &&
    intent.razorpayOrderId.length > 0 &&
    typeof paise === "number" &&
    Number.isFinite(paise) &&
    paise > 0
  );
}

function isIntentExpired(intent: any): boolean {
  const expiresAtMs = Number(intent?.expiresAtMs);
  // A non-finite lease is corrupt, not live: it must never be reused.
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now();
}

function intentBoundOrderId(intent: any): string {
  return typeof intent?.orderId === "string" ? intent.orderId : "";
}

/** Refusal is a typed, metadata-free 409: no stored ids leak to the client. */
function paymentIntentOrderMismatchError(): Error {
  const err: any = new Error(
    "This checkout cannot reuse an earlier payment attempt for a different order. Nothing was charged — please review your cart and start a new order."
  );
  err.statusCode = 409;
  err.code = "PAYMENT_INTENT_ORDER_MISMATCH";
  return err;
}

/**
 * A legacy caller that names no internal order keeps today's behaviour (the
 * intent itself is the only binding it has). Once an internal order is named,
 * the live intent must match it exactly.
 */
function assertIntentBoundToOrder(intent: any, orderId?: string): void {
  if (!orderId) return;
  if (intentBoundOrderId(intent) !== orderId) throw paymentIntentOrderMismatchError();
}

function newOrderResponse(args: {
  razorpayOrderId: string;
  amountPaise: number;
  receipt: string;
  pricing: any;
}) {
  return {
    razorpayOrderId: args.razorpayOrderId,
    amountPaise: args.amountPaise,
    amountRupees: args.pricing.grandTotal,
    // Legacy aliases (PAYMENTS_CONTRACT_SPEC §1): `orderId` here is the
    // GATEWAY order id (what old checkout code read), `amount` is rupees.
    orderId: args.razorpayOrderId,
    amount: args.pricing.grandTotal,
    currency: ORDER_CURRENCY,
    receipt: args.receipt,
    pricing: args.pricing,
    keyId: getRazorpayKeyId(),
  };
}

function reusedIntentResponse(intent: any) {
  return {
    razorpayOrderId: intent.razorpayOrderId,
    amountPaise: intent.amountPaise,
    amountRupees: intent.amountPaise / 100,
    // Legacy aliases (PAYMENTS_CONTRACT_SPEC §1) — same shape as a fresh order.
    orderId: intent.razorpayOrderId,
    amount: intent.amountPaise / 100,
    currency: ORDER_CURRENCY,
    receipt: intent.receipt,
    pricing: intent.pricing,
    keyId: getRazorpayKeyId(),
    reused: true as const,
  };
}

type LostClaimResolution =
  | { kind: "reuse"; intent: any }
  | { kind: "superseded" }
  | { kind: "mismatch" }
  | { kind: "unreadable" };

/**
 * Replaces an EXPIRED intent with the freshly minted one, keeping the prior
 * gateway id for audit. Transactional so an intent that became live while we
 * were deciding is never overwritten (the caller re-reads and re-applies the
 * live-binding rule).
 */
async function supersedeExpiredIntent(
  intentRef: any,
  freshIntent: Record<string, any>,
  prior: any
): Promise<boolean> {
  const supersededId = typeof prior?.razorpayOrderId === "string" ? prior.razorpayOrderId : null;
  const doc = { ...freshIntent, supersedes: supersededId };
  if (db && typeof (db as any).runTransaction === "function") {
    return !!(await (db as any).runTransaction(async (tx: any) => {
      const snap = await tx.get(intentRef);
      const current = snap && snap.exists ? snap.data() : null;
      if (current && hasUsableGatewayIntent(current) && !isIntentExpired(current)) return false;
      tx.set(intentRef, doc);
      return true;
    }));
  }
  // No transactional datastore: a blind overwrite could clobber an intent that
  // became live concurrently, so fail closed (caller re-reads → 503).
  return false;
}

/**
 * Lost the `create()` claim race: converge on the winner, but never on a
 * winner that belongs to another internal order.
 */
async function resolveLostClaim(args: {
  intentRef: any;
  freshIntent: Record<string, any>;
  orderId?: string;
}): Promise<LostClaimResolution> {
  const { intentRef, freshIntent, orderId } = args;
  let winner: any;
  try {
    const snap = await intentRef.get();
    winner = snap && snap.exists ? snap.data() : null;
  } catch {
    return { kind: "unreadable" };
  }
  if (!hasUsableGatewayIntent(winner)) return { kind: "unreadable" };

  if (isIntentExpired(winner)) {
    let superseded = false;
    try {
      superseded = await supersedeExpiredIntent(intentRef, freshIntent, winner);
    } catch {
      // Transaction contention/abort must not escape as an unclassified 500:
      // fail closed to the existing 503 retry-same-key path.
      return { kind: "unreadable" };
    }
    if (superseded) {
      return { kind: "superseded" };
    }
    try {
      const again = await intentRef.get();
      const next = again && again.exists ? again.data() : null;
      if (!hasUsableGatewayIntent(next) || isIntentExpired(next)) return { kind: "unreadable" };
      if (orderId && intentBoundOrderId(next) !== orderId) return { kind: "mismatch" };
      return { kind: "reuse", intent: next };
    } catch {
      return { kind: "unreadable" };
    }
  }

  if (orderId && intentBoundOrderId(winner) !== orderId) return { kind: "mismatch" };
  return { kind: "reuse", intent: winner };
}

/**
 * P1 basket binding: the request body is NOT the order of record.
 *
 * `createPaymentOrder` used to price the request-body `items`/`branchId`/
 * `orderType` and stamp only `pricing` onto the existing orders/{orderId} doc.
 * The customer paid for THAT basket while the KOT builder
 * (`pushOrderPetpooja` → `order.items`, `order.fulfillmentType || order.orderType`)
 * fulfilled the STORED one — a different basket, at a different branch, for a
 * different fulfillment type, charged to the same customer.
 *
 * The persisted doc is therefore the single source of truth whenever it
 * carries a usable basket:
 *   • items        — priced AS STORED (the exact lines the kitchen will cook);
 *   • branchId     — priced AS STORED (royalty/packaging belong to that branch);
 *   • orderType    — canonicalized from orderType/fulfillmentType/fulfillment;
 * and any request that disagrees is refused BEFORE pricing, before the intent
 * lease, and before any gateway order is minted. `BASKET_MISMATCH` is a
 * non-retryable 409: retrying the same body can never converge.
 *
 * A legacy order doc with no `items` array has no basket to bind, so the
 * historical request-priced behaviour is preserved (nothing else could be
 * priced, and refusing would strand every pre-`items` checkout).
 */
const STORED_ORDER_TYPE_ALIASES: Record<string, "delivery" | "takeaway" | "dinein"> = {
  delivery: "delivery",
  takeaway: "takeaway",
  pickup: "takeaway",
  dinein: "dinein",
  "dine-in": "dinein",
};

/** Canonical fulfillment literal for a persisted order doc, or null when absent/unknown. */
function readStoredOrderType(
  doc: any
): "delivery" | "takeaway" | "dinein" | null {
  const candidates = [doc?.orderType, doc?.fulfillmentType, doc?.fulfillment];
  for (const raw of candidates) {
    if (typeof raw !== "string") continue;
    const canonical = STORED_ORDER_TYPE_ALIASES[raw.trim().toLowerCase()];
    if (canonical) return canonical;
  }
  return null;
}

/**
 * Price-agnostic identity of ONE basket line: product, quantity, and the
 * addon deltas the customer chose. Item *prices* are deliberately excluded —
 * the catalog (not the client) is the price authority, so a stale cart price
 * is repriced rather than treated as a different basket. Addon deltas ARE
 * included: they are client-supplied money the pricing engine trusts, so a
 * (cheap garnish → expensive garnish) swap is a different basket.
 */
function basketLineKey(item: any): string {
  const productId = String(item?.productId || item?.id || "").trim();
  const quantity = Math.floor(Number(item?.quantity) || 0);
  const addons = [
    ...(Array.isArray(item?.customizations) ? item.customizations : []).map(
      (c: any) => `c:${String(c?.id ?? c?.name ?? "")}:${Number(c?.price) || 0}`
    ),
    ...(Array.isArray(item?.modifiers) ? item.modifiers : []).map(
      (m: any) => `m:${String(m?.id ?? m?.name ?? "")}:${Number(m?.priceDelta) || 0}`
    ),
  ].sort();
  return `${productId}|${quantity}|${addons.join(",")}`;
}

/** Order-independent fingerprint of a basket's line identities. */
function basketFingerprint(items: any): string {
  const lines = Array.isArray(items) ? items : [];
  return lines.map(basketLineKey).sort().join("||");
}

function basketMismatchError(): Error {
  const err: any = new Error(
    "Your cart no longer matches the order on file — nothing was charged. Please review your basket and start a new order."
  );
  err.statusCode = 409;
  err.code = "BASKET_MISMATCH";
  return err;
}

/**
 * Binds the payable basket to the persisted order. Throws BASKET_MISMATCH when
 * the request describes a different basket/branch/fulfillment than the one
 * stored on orders/{orderId}; returns the STORED basket to price otherwise.
 */
function bindBasketToStoredOrder(args: {
  storedOrder: Record<string, any> | null;
  requestItems: any[];
  requestBranchId: string;
  requestOrderType: "delivery" | "takeaway" | "dinein";
}): { items: any[]; branchId: string; orderType: "delivery" | "takeaway" | "dinein" } {
  const { storedOrder, requestItems, requestBranchId, requestOrderType } = args;

  const storedItems =
    storedOrder && Array.isArray(storedOrder.items) && storedOrder.items.length > 0
      ? storedOrder.items
      : null;
  if (!storedItems) {
    // No persisted basket to bind (legacy doc): keep request pricing.
    return { items: requestItems, branchId: requestBranchId, orderType: requestOrderType };
  }

  if (basketFingerprint(storedItems) !== basketFingerprint(requestItems)) {
    throw basketMismatchError();
  }

  const storedBranchId =
    typeof storedOrder?.branchId === "string" && storedOrder.branchId
      ? storedOrder.branchId
      : "";
  if (storedBranchId && storedBranchId !== requestBranchId) {
    throw basketMismatchError();
  }

  const storedOrderType = readStoredOrderType(storedOrder);
  if (storedOrderType && storedOrderType !== requestOrderType) {
    throw basketMismatchError();
  }

  return {
    items: storedItems,
    branchId: storedBranchId || requestBranchId,
    orderType: storedOrderType || requestOrderType,
  };
}

/**
 * Creates a Razorpay server order with authoritative price calculation and route notes.
 */
export async function createPaymentOrder(params: CreateOrderParams) {
  // ZERO-MOCK production guard: a production process must never mint an
  // `order_mock_*` payable id, no matter how the config object got flipped.
  assertLivePaymentsContext("createPaymentOrder");

  // PAY-13: the ORDER DOCUMENT is the cart. `params.items` is accepted for
  // wire compatibility and IGNORED — pricing a request body while the kitchen
  // cooks the order document is how one cheap item could pay for ten burgers.
  const orderData = params.orderId
    ? await assertPayableOrderDoc(params.orderId, params.customerId)
    : null;
  if (!orderData) throw orderDocRequiredError();

  // PAY-15: the branch comes from the ORDER too. It decides the packaging fee
  // and the Route transfer target, so a request branch must never move money.
  // The doc's branch wins; its store mapping is the only fallback.
  const branchId = await resolveOrderBranchForPayment(orderData);
  const orderType = orderDocType(orderData, params.orderType) as
    | "delivery"
    | "takeaway"
    | "dinein";
  const cartItems = priceableDocItems(orderData);
  // The doc is the offer too: a coupon written on the order is the coupon the
  // customer saw. A body-only coupon is a fallback for legacy docs.
  const docCoupon =
    typeof orderData.couponCode === "string" && orderData.couponCode.trim()
      ? orderData.couponCode
      : undefined;
  const couponCode = docCoupon ?? params.couponCode;

  // Grill-Coins redemption is DISABLED for launch (D31-D33). The customer app
  // pins `loyaltyPointsToRedeem` to 0, so a non-zero request can only come from
  // a stale client, a replayed body, or a direct caller — and the launch server
  // must refuse it rather than run a reservation/debit path nobody can
  // legitimately reach. Refused BEFORE any gateway order is minted, before any
  // reservation is created, and before pricing can apply a coin discount.
  //
  // A zero redemption keeps the exact pre-existing behaviour: the value flows
  // into the cart fingerprint (so cached retries stay honest) and the pricing
  // engine's own `loyaltyPointsToRedeem > 0` guard leaves the bill untouched.
  const loyaltyPointsToRedeem = resolveRedeemableCoins(
    params.customerId,
    params.loyaltyPointsToRedeem,
  );

  // Everything that decides money for THIS cart, so a retry can prove it is
  // still paying for the same thing.
  const fingerprint = cartFingerprint(cartItems, couponCode, loyaltyPointsToRedeem);

  // P1-H: the balance CHECK above only proves the coins exist right now. The
  // RESERVATION below (written with the intent) is what makes them unavailable
  // to a second checkout, so one balance can never back two payable discounts.
  // A reused intent keeps its existing reservation.
  //
  // The reservation amount is decided AFTER pricing, from the effective
  // `pricing.loyaltyDiscount` (1 coin = ₹1, capped at 20% of the food
  // subtotal) — see `coinsForDiscountRupees`. Reserving the REQUESTED count
  // locked coins the customer never spent (ask 100 on a ₹100 cart, get a ₹20
  // discount, and 100 were held), which is how a balance of 100 ended up with
  // 100 debited for a ₹20 discount.

  // Idempotent retries: same key returns the already-open gateway order
  // instead of minting a second payable order (double-charge risk).
  // Bounded by a 24h TTL: Razorpay orders expire and catalog prices move,
  // so a days-old intent must never resurrect a stale total. The client's
  // fingerprint (items+prices+promo+loyalty+tip) already scopes the key to
  // one basket; the TTL scopes it in time. Numeric createdAtMs/expiresAtMs
  // (not serverTimestamp sentinels) so the age check reads without a
  // toMillis trap.
  //
  // P1-F: the intent is MANDATORY, so the key is never optional. A caller that
  // omits it gets a SERVER-GENERATED key derived from the order + cart
  // fingerprint (not a timestamp): retries of the same checkout still converge
  // on the same intent, and no payable gateway order can exist without a
  // durable server binding. (The old key-less path minted exactly the orphan
  // gateway order the exploit consumed.)
  const INTENT_TTL_MS = PAYMENT_INTENT_TTL_MS;
  const idempotencyKey =
    typeof params.idempotencyKey === "string" && params.idempotencyKey.trim()
      ? params.idempotencyKey.trim()
      : `srv_${crypto
          .createHash("sha256")
          .update(
            JSON.stringify([
              params.orderId ?? "",
              cartFingerprint(cartItems, couponCode, loyaltyPointsToRedeem),
              params.customerId ?? "",
            ])
          )
          .digest("hex")
          .slice(0, 40)}`;
  if (db && typeof db.collection === "function") {
    // The binding refusal is decided OUTSIDE the lookup try/catch: a mismatch
    // is a proven 409, not an unavailable-service 503.
    let reusableIntent: any = null;
    let corruptIntent = false;
    try {
      const prior = await db.collection("payment_intents").doc(idempotencyKey).get();
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
        reusableIntent = data;
      } else if (prior.exists && data && !isIntentExpired(data)) {
        // Present, not expired, but its gateway id/amount is corrupt. Never
        // mint behind an unreadable binding: that strands one gateway order
        // per retry. Refuse before the mint (same 503 retry contract).
        corruptIntent = true;
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
    if (reusableIntent) {
      // Bound to the SAME internal order? A live intent from another order is
      // refused here — before any gateway order is handed out — instead of
      // surfacing as a post-capture ORDER_MISMATCH at verify.
      assertIntentBoundToOrder(reusableIntent, params.orderId);
      // PAY-13: and bound to the SAME cart. The intent stores the fingerprint
      // of the doc-derived cart it was priced for; an order whose items,
      // coupon or redemption changed (or an intent predating this contract,
      // which has no fingerprint) can never be reused at a stale amount. This
      // is the same non-retryable refusal polish's basket binding produced,
      // now keyed on the order document (PAY-13) instead of the request.
      if (reusableIntent.cartFingerprint !== fingerprint) {
        throw paymentIntentCartMismatchError();
      }
      // P1-I: a reused intent was priced when the cart was SELLABLE. Between
      // then and now the kitchen may have 86'd an item (or closed), and
      // Razorpay's order stays payable for its whole TTL — the customer would
      // pay for food nobody can cook and the capture would ring the KOT. So
      // availability is re-read on EVERY reuse, before any payment can happen.
      // This reuses the SAME catalog check the fresh path runs (and the same
      // typed refusal), not a second mechanism.
      await assertCartStillSellable({
        items: cartItems,
        branchId,
        orderType,
        orderId: params.orderId,
      });
      return reusedIntentResponse(reusableIntent);
    }
    if (corruptIntent) {
      // No key in the log/snapshot: the idempotency key is a client basket
      // fingerprint, not an operational reference.
      console.warn("[Payments] stored payment intent is unreadable — refused before minting");
      const { captureErrorSnapshot } = await import("../../core/errors");
      await captureErrorSnapshot({
        source: "payments",
        severity: "high",
        message: "stored payment intent unreadable (bad gateway id/amount) — refused before minting a fresh order",
      });
      const refusedCorrupt: any = new Error("Payment service is temporarily unavailable — please retry checkout (you will not be charged twice).");
      refusedCorrupt.statusCode = 503;
      throw refusedCorrupt;
    }
  }

  // R6: a delivery is priced from the persisted courier quote ONLY. The quote
  // is loaded and bound to this order inside a transaction before any gateway
  // order is minted; the client `deliveryFee` and the old static ₹35 are gone.
  // A delivery without a usable quote refuses here — never 0, never a default.
  const serverDeliveryFee =
    orderType === "delivery"
      ? await bindDeliveryQuoteForOrder({
          quoteId: params.deliveryQuoteId,
          orderId: params.orderId,
          uid: params.customerId,
          branchId,
        })
      : undefined;

  const pricing = await calculateOrderPricing({
    // PAY-13: the DOCUMENT's cart, not the request's.
    items: cartItems,
    branchId,
    orderType,
    serverDeliveryFee,
    couponCode,
    loyaltyPointsToRedeem,
  });

  // Grill-Coins redemption is refused above (D31-D33), so pricing can never
  // apply a coin discount here — the engine's own `> 0` guard keeps the bill
  // unchanged for the launch value of 0. No reservation, no balance read and no
  // debit exists on this path any more.

  // Paise math stays in integers end to end: grandTotal is rupees (ruled to
  // whole paise by the engine), amountPaise is the exact gateway amount.
  // Both gates (finite/positive + whole paise) run BEFORE any gateway call.
  assertSupportedCurrency(ORDER_CURRENCY);
  const amountPaise = assertPayableAmount(Math.round(Number(pricing.grandTotal) * 100));
  const receipt = `rcpt_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;

  // PAYMENTS_CONTRACT_SPEC §1: stamp the SERVER-computed `pricing` onto the
  // order doc at intent time so the webhook + verify amount binding always
  // has a trustworthy total (previously the field was often missing and the
  // binding silently skipped). Fail CLOSED: no stamp, no payable order.
  if (params.orderId && db && typeof db.collection === "function") {
    try {
      await db.collection("orders").doc(params.orderId).set(
        {
          pricing,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    } catch (err: any) {
      console.warn("[Payments] pricing stamp failed, refusing fresh order:", err?.message || err);
      await captureErrorSnapshot({
        source: "payments",
        severity: "high",
        message: `Failed to stamp server pricing on order ${params.orderId} — refused fresh gateway order`,
        errorStack: err?.stack,
        orderId: params.orderId,
        branchId,
      });
      const refused: any = new Error("Payment service is temporarily unavailable — please retry checkout (you will not be charged twice).");
      refused.statusCode = 503;
      throw refused;
    }
  }

  let razorpayOrderId: string;

  if (config.mock.paymentGateway) {
    // Unique per mint: a millisecond-only id collided for two checkouts starting
    // in the same tick, which made them share one gateway order (and therefore
    // one coin reservation) in sandbox runs.
    razorpayOrderId = `order_mock_${Date.now().toString(36)}_${crypto
      .randomBytes(4)
      .toString("hex")}`;
  } else {
    try {
      const razorpay = getRazorpayClient();
      const rzpOrder = await razorpay.orders.create({
        amount: amountPaise,
        currency: ORDER_CURRENCY,
        receipt,
        // Required for Razorpay Route: transfers only execute on captured
        // payments of orders with partial payments disabled.
        partial_payment: false,
        notes: {
          orderId: params.orderId || "",
          branchId,
          customerId: params.customerId,
          orderType,
          // F3: no per-order royalty. Notes carry the branch's earnings only.
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

  if (db && typeof db.collection === "function") {
    const intentRef = db.collection("payment_intents").doc(idempotencyKey);
    const nowMs = Date.now();
    const intentDoc = {
      razorpayOrderId,
      amountPaise,
      receipt,
      pricing,
      orderId: params.orderId || null,
      // Branch/orderType ride along so a verify that finds no orders/{orderId}
      // doc (legacy client verifying before creating it) can rebuild the doc
      // from SERVER-owned data only (spec §2 ghost-order guard).
      branchId,
      orderType,
      customerId: params.customerId,
      // PAY-13: the fingerprint of the DOC-derived cart this amount was priced
      // for. A retry must match it exactly or it is refused (stale amount).
      cartFingerprint: fingerprint,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAtMs: nowMs,
      expiresAtMs: nowMs + INTENT_TTL_MS,
    };
    // No coin reservation is created: redemption is refused before this point
    // (D31-D33), so a payable intent never holds coins and never needs funding
    // reconciliation. That removes an entire class of stuck-lock states.
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
      // P1-I proof-of-persistence: a write that reports success is not proof
      // the binding exists (a datastore shim, a partial failure, a routed
      // write to the wrong project). Read OUR key back and require the exact
      // gateway order id we just minted. Anything less is an ambiguous
      // persistence outcome and MUST fail closed — the customer would otherwise
      // pay a gateway order that mandatory-intent verification then refuses.
      if (intentRef && typeof intentRef.get === "function") {
        const persisted = await intentRef.get();
        const stored = (persisted?.exists ? persisted.data() : null) as any;
        if (!stored || stored.razorpayOrderId !== razorpayOrderId) {
          const unbound: any = new Error(
            "payment intent was not durably stored for the minted gateway order"
          );
          unbound.code = "PAYMENT_INTENT_NOT_PERSISTED";
          throw unbound;
        }
      }
    } catch (err: any) {
      const alreadyClaimed =
        err?.code === 6 || /already exists|ALREADY_EXISTS/i.test(err?.message || "");
      if (!alreadyClaimed) {
        // FAIL CLOSED (P1-I): the gateway order is ALREADY minted, so an
        // unpersisted intent leaves money payable that this server cannot
        // bind or verify — the customer pays and mandatory-intent
        // verification then refuses their capture. Never hand it out.
        //
        // RECONCILE FIRST: a write error does not prove the binding is gone
        // (the write may have landed, or the read itself may be what failed).
        // Releasing on an unproven state could orphan an intent another request
        // then reuses, so `refuseAmbiguousMint` re-reads and only refuses —
        // it never releases.
        const reconciled = await refuseAmbiguousMint({
          intentRef,
          razorpayOrderId,
          orderId: params.orderId,
          reason: "intent_store_failed",
          error: err,
        }).then(
          (value) => ({ value, thrown: null as any }),
          (thrown) => ({ value: null, thrown })
        );
        if (reconciled.value && reconciled.value.bound === true) {
          // Persistence IS durable: converge exactly like a reused intent.
          const durable = reconciled.value.intent;
          assertIntentBoundToOrder(durable, params.orderId);
          if (durable.cartFingerprint !== fingerprint) {
            throw paymentIntentCartMismatchError();
          }
          return reusedIntentResponse(durable);
        }
        throw reconciled.thrown;
      } else {
        // Lost the claim race — converge on the winner, but NEVER on a winner
        // bound to a different internal order: that is a pre-payment 409, not
        // a post-capture surprise. An EXPIRED winner is superseded by our
        // freshly minted order (the TTL has to be effective here too); an
        // unreadable winner keeps the existing 503 refusal.
        const resolution = await resolveLostClaim({
          intentRef,
          freshIntent: intentDoc,
          orderId: params.orderId,
        });
        if (resolution.kind === "reuse") {
          // PAY-13: the winner must also be for the SAME doc-derived cart.
          if (resolution.intent.cartFingerprint !== fingerprint) {
            throw paymentIntentCartMismatchError();
          }
          return reusedIntentResponse(resolution.intent);
        }
        if (resolution.kind === "superseded") {
          // Our intent doc REPLACED the expired winner, so it is persisted and
          // this order is legitimately payable.
          return newOrderResponse({ razorpayOrderId, amountPaise, receipt, pricing });
        }
        if (resolution.kind === "mismatch") throw paymentIntentOrderMismatchError();

        console.warn("[Payments] idempotency claim lost with unreadable winner — refusing fresh order (retry same key)");
        const { captureErrorSnapshot } = await import("../../core/errors");
        await captureErrorSnapshot({
          source: "payments",
          severity: "high",
          message: "payment-intent claim race lost and winner unreadable — refused fresh order, client must retry same key",
        });
        const refused: any = new Error("Payment service is temporarily unavailable — please retry checkout (you will not be charged twice).");
        refused.statusCode = 503;
        refused.code = "PAYMENT_INTENT_UNAVAILABLE";
        refused.retryAfterMs = 2000;
        throw refused;
      }
    }
  }

  return newOrderResponse({ razorpayOrderId, amountPaise, receipt, pricing });
}

export interface VerifyPaymentParams {
  /** Internal order id. OPTIONAL: legacy checkout shims verify with gateway ids only — the internal id then resolves through the payment intent (spec §2). */
  orderId?: string;
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
 *
 * PAYMENTS_CONTRACT_SPEC §2:
 *  - the orders/{orderId} doc need NOT pre-exist: the SERVER-written payment
 *    intent (keyed by razorpayOrderId) is the authoritative binding rzp order
 *    -> internal orderId -> server-priced amount. Without an intent, a
 *    missing order doc is still a 404 ghost refusal (never resurrected).
 *  - the response payload (order object, delivery OTP, transfer receipt) is
 *    returned ONLY to the order's owner: the authenticated caller whose uid
 *    matches the order's customerId/userId, or an unauthenticated guest whose
 *    matching intent carries no registered customer. Everyone else gets
 *    `{ ok: true }` with no order data. `caller === undefined` means a
 *    trusted internal call (scheduler/tests — same convention as StaffCaller).
 */
export async function verifyPayment(
  params: VerifyPaymentParams,
  caller?: { uid?: string } | null
) {
  // ZERO-MOCK production guard: a live checkout must never be "verified" by
  // the mock short-circuit below.
  assertLivePaymentsContext("verifyPayment");

  const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = params;

  // 1. Signature verification
  let isValid = false;
  if (config.mock.paymentGateway) {
    // Dev/test sandbox ONLY (the guard above refuses it in production).
    // A signature must still be present — an empty string is never valid.
    isValid =
      typeof razorpaySignature === "string" &&
      razorpaySignature.length > 0 &&
      razorpaySignature !== "force_fail";
  } else {
    // Fail-closed on missing key secret: with nothing to verify against there
    // is no signature check at all. 503 (misconfiguration — retryable, ops
    // paged) rather than 401 (a forged signature), and either way the order
    // is never confirmed.
    if (!config.razorpay.keySecret) {
      await captureErrorSnapshot({
        source: "payments",
        severity: "high",
        message:
          "RAZORPAY_KEY_SECRET is unset — payment signature verification is unavailable, refusing verify (fail-closed)",
        orderId: params.orderId,
        razorpayPaymentId,
      }).catch(() => undefined);
      const unavailable: any = new Error(
        "Payment verification is temporarily unavailable — please retry (nothing was charged)."
      );
      unavailable.statusCode = 503;
      unavailable.code = "PAYMENT_VERIFICATION_UNAVAILABLE";
      unavailable.retryAfterMs = 2000;
      throw unavailable;
    }
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
      orderId: params.orderId,
      razorpayPaymentId,
    });
    const badSig: any = new Error("Invalid payment signature");
    badSig.statusCode = 401;
    badSig.code = "INVALID_SIGNATURE";
    throw badSig;
  }

  // 2. Payment-intent binding (spec §2): the server-written intent ties the
  // gateway order to the internal orderId + the SERVER-PRICED amount. It is
  // MANDATORY (P1-F):
  //
  // The old code treated a missing intent as "degrade to the order-doc path",
  // and when the order doc carried no totals either, `expectedPaise` became
  // null and the live amount check was SKIPPED entirely. An attacker minted a
  // cheap gateway order with no idempotency key (so no intent), then verified
  // it against their own expensive order — which has no totals — and had the
  // expensive order confirmed at the cheap price, pushed to the KOT as paid.
  //
  // Now: no durable intent ⇒ no verification. The intent must name BOTH this
  // internal order and this exact gateway order, and its amount is the
  // authority for the gateway comparison (the order doc's optional totals can
  // never widen or narrow it).
  const intent = await loadPaymentIntent(razorpayOrderId);
  const intentOrderId = typeof intent?.orderId === "string" ? intent.orderId : "";
  const intentAmountPaise = Number(intent?.amountPaise);
  if (
    !intent ||
    !isSafeDocId(intentOrderId) ||
    typeof intent.razorpayOrderId !== "string" ||
    intent.razorpayOrderId !== razorpayOrderId ||
    !Number.isFinite(intentAmountPaise) ||
    intentAmountPaise <= 0
  ) {
    await captureErrorSnapshot({
      source: "payments",
      severity: "high",
      message: `verifyPayment refused: no durable payment intent binds gateway order ${razorpayOrderId} to an internal order — possible paid-at-cheap-price attempt`,
      orderId: params.orderId,
      razorpayPaymentId,
    }).catch(() => undefined);
    const unbound: any = new Error(
      "This payment is not bound to an order on our side — verification refused. Contact support if money left your account."
    );
    unbound.statusCode = 409;
    unbound.code = "ORDER_MISMATCH";
    throw unbound;
  }

  const orderId = params.orderId || intentOrderId;
  if (!orderId || !isSafeDocId(orderId) || intentOrderId !== orderId) {
    // The payment intent is bound to a DIFFERENT internal order — never
    // confirm this one with that payment.
    const bound: any = new Error(
      "This payment belongs to a different order — verification refused. Contact support if money left your account."
    );
    bound.statusCode = 409;
    bound.code = "ORDER_MISMATCH";
    throw bound;
  }
  // The authoritative amount for every gateway comparison below.
  const authoritativePaise = intentAmountPaise;

  // 3. Resolve the order doc. A missing doc is rebuilt ONLY from a matching
  // server-written intent (legacy client verified before creating it);
  // anything else stays the B2-S1 ghost refusal.
  const orderRef = db.collection("orders").doc(orderId);
  const orderSnap = await orderRef.get();
  let orderData: Record<string, any> = {};
  if (orderSnap.exists) {
    orderData = (orderSnap.data() || {}) as Record<string, any>;
  } else {
    if (!intent || intent.orderId !== orderId) {
      const ghost: any = new Error(
        `Order ${orderId} not found — refusing to verify payment against a ghost order`
      );
      ghost.statusCode = 404;
      ghost.code = "ORDER_NOT_FOUND";
      throw ghost;
    }
    // Rebuild from SERVER-owned intent data only (never client input): the
    // intent already binds rzp order -> orderId -> server-priced amount.
    orderData = {
      branchId: typeof intent.branchId === "string" ? intent.branchId : null,
      orderType: typeof intent.orderType === "string" ? intent.orderType : null,
      customerId: typeof intent.customerId === "string" ? intent.customerId : "guest",
      pricing: intent.pricing || {},
    };
    try {
      await orderRef.create({
        ...orderData,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (err: any) {
      // Lost a race with the client creating its own pending doc — use the
      // winner's doc (it carries the same orderId binding).
      const again = await orderRef.get();
      if (!again.exists) throw err;
      orderData = (again.data() || {}) as Record<string, any>;
    }
  }

  // P1-C layer 1 (WRITER): mark the order as a payment attempt in flight before
  // this capture touches the gateway or the money decision. The expiry sweep
  // reads exactly this marker (`hasLivePaymentAttempt` → `isUnsafeToExpire`),
  // so a customer paying while the sweep is running can no longer have their
  // order cancelled mid-capture. Best effort: a marker failure never fails a
  // customer's payment (the sweep's own transaction re-read still guards).
  await markPaymentVerificationInFlight(orderRef, {
    razorpayOrderId,
    razorpayPaymentId,
  });

  // Live gateway truth check (fail-closed on money mismatch, no auto-capture).
  // THE AMOUNT AUTHORITY IS THE SERVER INTENT (P1-F). The order doc's optional
  // `pricing.grandTotal` is a display/reporting copy that a caller-controlled
  // doc might omit — which is exactly how the exploit skipped this check. The
  // intent is written by the server at mint time and cannot be absent (the
  // guard above refuses), so `expectedPaise` is always a real number and the
  // comparison ALWAYS runs whenever there is a gateway to ask. Mock mode has no
  // gateway truth at all (and is refused outright in production by
  // assertLivePaymentsContext), so it keeps its documented short-circuit —
  // the mandatory-intent binding above is what protects that path.
  const expectedPaise = authoritativePaise;
  let capturedAmountPaise: number | undefined;
  let gatewayCreatedAtMs: number | undefined;
  if (!config.mock.paymentGateway) {
    const gatewayTruth = await assertLivePaymentMatchesOrder({
      orderRef,
      orderId,
      orderData,
      razorpayOrderId,
      razorpayPaymentId,
      expectedPaise,
    });
    capturedAmountPaise = gatewayTruth.amountPaise;
    gatewayCreatedAtMs = gatewayTruth.createdAtMs;
  }

  // R06 corrective: terminal orders (cancelled/refunded) must be detected
  // before any external Route split/payment settlement. This read is performed
  // transactionally so a race that cancels the order after the amount check
  // cannot trigger a new payout.
  if (!db || typeof (db as any).runTransaction !== "function") {
    throw new Error("verifyPayment requires a transactional datastore");
  }
  // Same fresh read also captures the RECORDED payment binding (B7 below):
  // it must come from this transaction, never from the step-3 `orderData`
  // snapshot, so a competing confirm that lands after that read — or a doc
  // already confirmed by a first capture — is always visible before any
  // money moves.
  const preSplitTruth = await (db as any).runTransaction(async (tx: any) => {
    const snap = await tx.get(orderRef);
    const fresh = (snap && snap.exists ? snap.data() : orderData) || {};
    const code = typeof (fresh as any)?.status === "string" ? (fresh as any).status : (fresh as any)?.status?.code;
    return {
      statusCode: String(code || "").toUpperCase(),
      recordedPaymentId:
        readRecordedPaymentField(fresh, "razorpayPaymentId") ||
        readRecordedPaymentField(fresh, "capturedPaymentId"),
      recordedRazorpayOrderId: readRecordedPaymentField(fresh, "razorpayOrderId"),
    };
  });
  const statusBeforeSplit = preSplitTruth.statusCode;
  const TERMINAL_CANCEL_REFUND = statusBeforeSplit === "CANCELLED" || statusBeforeSplit === "REFUNDED";
  if (TERMINAL_CANCEL_REFUND) {
    // P1-C layer 2 — the expiry race's tail. Razorpay cannot close an order, so
    // a capture can still land after the expiry sweep cancelled it. Parking it
    // alone left the customer charged for an order nobody will cook. The late
    // capture is refunded in FULL through the shared automatic-refund path
    // (idempotent on `latecap_<order>_<payment>`); the order stays CANCELLED and
    // is never resurrected.
    //
    // Scope is the expiry cancellation only: a staff/customer cancel (or a
    // dispute resolution) is a conversation this automation cannot see, and
    // `refundLateCaptureForExpiredOrder` refuses those by reason.
    if (statusBeforeSplit === "CANCELLED") {
      const { refundLateCaptureForExpiredOrder } = await import("./lateCaptureRefund");
      await refundLateCaptureForExpiredOrder({
        orderId,
        razorpayPaymentId,
        razorpayOrderId,
        capturedAmountPaise:
          typeof capturedAmountPaise === "number" ? capturedAmountPaise : null,
        source: "verify_capture_after_expiry",
      });
    }
    await captureErrorSnapshot({
      source: "payments",
      severity: "high",
      message: `Captured payment ${razorpayPaymentId} landed on ${statusBeforeSplit} order ${orderId} - parked in unmatched_payments, no confirmation`,
      orderId,
      razorpayPaymentId,
    }).catch(() => undefined);
    await db.collection("unmatched_payments").doc(`ump_term_${razorpayPaymentId}`).set(
      {
        eventId: `verify_${razorpayPaymentId}`,
        event: "verify_payment",
        razorpayPaymentId,
        razorpayOrderId,
        orderId,
        amount: typeof capturedAmountPaise === "number" ? capturedAmountPaise / 100 : null,
        currency: "INR",
        claimedOrderId: orderId,
        receivedAt: admin.firestore.FieldValue.serverTimestamp(),
        status: "needs_review",
        reason: statusBeforeSplit === "REFUNDED" ? "capture_on_refunded_order" : "capture_on_cancelled_order",
        orderStatus: statusBeforeSplit,
      },
      { merge: true }
    );
    const terminalErr: any = new Error(
      `Order ${orderId} is ${statusBeforeSplit.toLowerCase()} - payment captured and parked for reconciliation`
    );
    terminalErr.statusCode = 409;
    terminalErr.code = "ORDER_TERMINAL";
    // B5: the payer's money moved but the order is cancelled/refunded, so they
    // would otherwise see only their own terminal status with nothing pointing
    // at the money. The order doc is their one readable surface; without this
    // marker only support could ever know.
    await markOrderReconciliation(orderRef, {
      state: "payment_review",
      reason: statusBeforeSplit === "REFUNDED" ? "capture_on_refunded_order" : "capture_on_cancelled_order",
      razorpayPaymentId,
    });
    throw terminalErr;
  }

  // B7 — SECOND DISTINCT CAPTURE. The order already records a different
  // captured payment than the one being verified (recorded pay_A vs incoming
  // pay_B, or a different gateway order behind the recorded binding). The old
  // path fell through to `finishVerifiedPayment`, which checked only
  // `alreadyCompleted` and answered `{success:true, confirmedOrderId}` —
  // silently absorbing payer B's money into payer A's confirmed order.
  //
  // Bind BOTH recorded gateway/payment ids from the FRESH read above and
  // refuse BEFORE `executeRouteSplit`: a mismatch must never move money
  // (no claim, no `payments.transfer` POST), mint an OTP, heal a hash, write
  // a confirmation audit, debit Grill-Coins, or push a KOT. The FIRST
  // captured payment stays authoritative — this block only ever reads the
  // recorded ids; nothing here rewrites them. A retried refusal converges on
  // ONE deterministic `payment_discrepancies/dis_<order>_<payment>` doc.
  //
  // "Proven captured": live mode only reaches this point when the gateway
  // fetch returned `captured` with a matching paise amount
  // (`capturedAmountPaise`), and mock/sandbox mode treats every accepted
  // signature as captured (it has no gateway truth to fetch at all).
  const provenCaptured =
    typeof capturedAmountPaise === "number" || config.mock.paymentGateway === true;
  const firstCapturedPaymentId = preSplitTruth.recordedPaymentId;
  const firstCapturedGatewayOrderId = preSplitTruth.recordedRazorpayOrderId;
  const foreignPayment =
    !!firstCapturedPaymentId && !!razorpayPaymentId && firstCapturedPaymentId !== razorpayPaymentId;
  const foreignGatewayOrder =
    !!firstCapturedGatewayOrderId && !!razorpayOrderId && firstCapturedGatewayOrderId !== razorpayOrderId;
  if (provenCaptured && (foreignPayment || foreignGatewayOrder)) {
    await parkSecondCaptureMismatch({
      orderId,
      razorpayOrderId,
      razorpayPaymentId,
      expectedPaise,
      capturedAmountPaise,
      recordedPaymentId: firstCapturedPaymentId,
      recordedRazorpayOrderId: firstCapturedGatewayOrderId,
      orderStatus: statusBeforeSplit || null,
    });
  }

  // 4. Execute the Razorpay Route split. Claim-then-work lives inside
  // executeRouteSplit, which is SHARED with the authoritative
  // `payment.captured` webhook — both channels can fire for one payment and
  // the underlying `payments.transfer` POST is not idempotent.
  const splitOutcome = await executeRouteSplit({
    orderRef,
    orderId,
    orderData,
    razorpayPaymentId,
    razorpayOrderId,
    capturedAmountPaise,
  });

  if (splitOutcome.state === "conflict") {
    await parkSecondCaptureMismatch({
      orderId,
      razorpayOrderId,
      razorpayPaymentId,
      expectedPaise,
      capturedAmountPaise,
      recordedPaymentId: splitOutcome.recordedPaymentId,
      recordedRazorpayOrderId: splitOutcome.recordedRazorpayOrderId,
      orderStatus: splitOutcome.orderStatus,
    });
  }

  if (splitOutcome.state === "busy") {
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

  // Flagged (manual settlement / pending_retry) and no_split both leave the
  // transfer unresolved on purpose: the customer's PAID order still confirms
  // below — a payout bookkeeping problem must never fail a charged customer.
  const transferResult = splitOutcome.state === "transferred" ? splitOutcome.transfer : null;

  // 5+6. Confirm state + audit (shared by the normal and race-loser paths),
  // then gate the response on ownership (spec §2).
  //
  // P1-I: BEFORE confirming, prove the cart is still sellable. A capture can
  // land minutes after the intent (order TTL 24h), and the kitchen may have
  // 86'd an item in that window. Confirming would ring the KOT for food nobody
  // can cook, so an unfulfillable capture is COMPENSATED through the same
  // automatic-refund accounting a manual refund uses, and the order is never
  // confirmed.
  //
  // COMPENSATION IS FIRST-CAPTURE ONLY (transactionally decided inside
  // `guardCaptureFulfillment`). An order already paid and in the kitchen that
  // is re-verified — the normal "refresh mid-payment" retry — must be
  // side-effect free: the old unconditional gate refunded food that was
  // already being made because an item was 86'd after the sale.
  const fulfillment = await guardCaptureFulfillment({
    orderRef,
    orderId,
    razorpayPaymentId,
    razorpayOrderId,
    orderData,
    capturedAmountPaise,
  });
  if (fulfillment.outcome === "pending") {
    // Another channel owns the fulfilment decision right now (or its lease is
    // still live). Confirming here would risk food plus refund, so this is a
    // RETRY — the client re-verifies with the same key and converges.
    const pendingErr: any = new Error(
      "Your payment is being confirmed — please retry in a moment (you will not be charged twice)."
    );
    pendingErr.statusCode = 202;
    pendingErr.code = "CAPTURE_FULFILLMENT_PENDING";
    pendingErr.retryAfterMs = 2000;
    throw pendingErr;
  }
  if (fulfillment.outcome === "already_compensated") {
    const compensatedErr: any = new Error(
      "This payment was already refunded because an item became unavailable — nothing more was charged. Contact support if you need help."
    );
    compensatedErr.statusCode = 409;
    compensatedErr.code = "ORDER_ITEM_UNAVAILABLE_REFUNDED";
    throw compensatedErr;
  }
  if (fulfillment.outcome === "refunded") {
    const refundedErr: any = new Error(
      "An item in your order is no longer available, so your payment has been refunded in full. Nothing was charged."
    );
    refundedErr.statusCode = 409;
    refundedErr.code = "ORDER_ITEM_UNAVAILABLE_REFUNDED";
    throw refundedErr;
  }
  if (fulfillment.outcome === "refund_failed") {
    const failedErr: any = new Error(
      "An item in your order is no longer available and the automatic refund needs attention. Contact support — do not pay again."
    );
    failedErr.statusCode = 409;
    failedErr.code = "ORDER_ITEM_UNAVAILABLE";
    throw failedErr;
  }

  // No Grill-Coins step exists here any more: redemption is refused at intent
  // creation (D31-D33), so a payable intent can never carry a coin discount and
  // there is nothing to fund, re-acquire or debit at capture.

  const finished = await finishVerifiedPayment({
    orderRef,
    orderData,
    orderId,
    razorpayOrderId,
    razorpayPaymentId,
    transferResult,
    capturedAmountPaise,
    gatewayCreatedAtMs,
  });

  if (finished.conflict) {
    await parkSecondCaptureMismatch({
      orderId,
      razorpayOrderId,
      razorpayPaymentId,
      expectedPaise,
      capturedAmountPaise,
      recordedPaymentId: finished.recordedPaymentId,
      recordedRazorpayOrderId: finished.recordedRazorpayOrderId,
      orderStatus: finished.orderStatus,
    });
  }

  // KOT PARITY WITH THE WEBHOOK CHANNEL. `payment.captured` pushes a paid order
  // to the POS right after it confirms (webhookHandler.ts), but this channel
  // used to confirm and never tell the kitchen: a verify-only payer — webhook
  // delayed, dropped, or not yet configured — got a confirmed order that never
  // rang at the outlet.
  //
  // Idempotency is owned by pushOrderToPetpooja itself: it dedupes on the
  // persisted `petpoojaOrderId` / `petpoojaAcceptedNoId` markers and serializes
  // concurrent callers through its own claim transaction, so a webhook racing
  // this push (or the customer re-verifying) cannot ring the kitchen twice.
  //
  // A POS failure must NEVER un-confirm a captured payment: orderPush parks the
  // order in its existing retry/reconciliation state and returns false, and the
  // helper swallows unexpected throws. The payment result below is reported
  // truthfully either way.
  if (finished.success) {
    await pushConfirmedOrderToPos(orderId);
  }

  // P1-C layer 1 (RELEASER): the attempt reached a decision, so the order
  // becomes expirable again if it is genuinely unpaid. Every earlier refusal
  // above throws before this point, which is safe: the sweep refuses on a FRESH
  // marker and a crashed/refused attempt ages out via the marker TTL.
  await clearPaymentVerificationInFlight(
    orderRef,
    finished.success ? "CAPTURE_CONFIRMED" : "CAPTURE_NOT_CONFIRMED"
  );

  const orderSummary = {
    id: orderId,
    orderId,
    paymentStatus: "completed",
    status: {
      code: "CONFIRMED",
      label: "Order confirmed",
      kind: "upcoming",
      terminal: false,
    },
    branchId: (orderData as any).branchId ?? null,
    customerId: (orderData as any).customerId ?? null,
    orderType: (orderData as any).orderType ?? null,
    pricing: (orderData as any).pricing ?? intent?.pricing ?? null,
    deliveryOtp: finished.deliveryOtp ?? null,
  };

  // Ownership gate (spec §2): never leak the order object (or the delivery
  // OTP) to a non-owner. undefined caller = trusted internal path (tests,
  // schedulers) and keeps the full payload; the HTTP route always passes
  // uid-or-null, so an anonymous request can only ever reach the guest arm.
  let owned: boolean;
  if (caller === undefined) {
    owned = true;
  } else if (caller?.uid) {
    owned =
      (orderData as any).customerId === caller.uid ||
      (orderData as any).userId === caller.uid;
  } else {
    // Unauthenticated guest: only a matching guest intent (same internal
    // order, no registered customer on it) proves this verify belongs to
    // the caller.
    owned =
      !!intent &&
      intent.orderId === orderId &&
      (!intent.customerId || intent.customerId === "guest") &&
      ((orderData as any).customerId == null ||
        (orderData as any).customerId === "guest");
  }
  if (!finished.success) {
    // Payment proof exists, but the order is cancelled/refunded/terminal: do
    // not report a fresh verified confirmation for it.
    return { ok: false as const, ...finished };
  }
  if (!owned) {
    return { ok: true as const };
  }
  return { ok: true as const, ...finished, order: orderSummary };
}

/** Stale-lease TTL for the Route split claim (shared with the retry worker). */
const TRANSFER_CLAIM_TTL_MS = 10 * 60 * 1000;

export type RouteSplitOutcome =
  | { state: "transferred"; transfer: any }
  | { state: "busy" }
  | { state: "flagged"; error: string }
  | { state: "not_required" }
  | { state: "no_split" }
  | {
      state: "conflict";
      recordedPaymentId?: string | null;
      recordedRazorpayOrderId?: string | null;
      orderStatus?: string | null;
    };

/**
 * Executes the Razorpay Route payout split for ONE captured payment.
 *
 * Shared by both money-truth channels — the client `verifyPayment` shim and
 * the authoritative `payment.captured` webhook (RZ2 in
 * references/razorpay_payments.md) — so the non-idempotent
 * `payments.transfer` POST can never fire twice for one order:
 *  - an order already marked `transferred` returns the stored receipt and
 *    never re-POSTs (even when that receipt itself is missing);
 *  - a claim-then-work Firestore transaction serializes concurrent callers
 *    (winner POSTs, losers get `busy`), with a stale-lease takeover so a
 *    crash between claim and POST cannot park the payout forever — the
 *    scheduled worker also sweeps expired `transferring` leases;
 *  - a missing branch/linked account is FLAGGED for manual settlement
 *    (`routeTransferNeedsManualSettlement`) and never fails the paid order;
 *  - a transient gateway failure lands in `pending_retry` with the claim
 *    lease released, so the retry worker can claim it on the next tick
 *    instead of idling out the lease.
 */
/**
 * RECOVERY-ONLY confirmation (scheduled capture-gate sweep).
 *
 * Used when a paid order's fulfilment decision is `fulfillable` but no channel
 * ever finished the confirmation (the process died between the gate write and
 * the confirm, or every webhook redelivery was lost). It deliberately does NOT
 * re-run the gateway truth checks: the capture was already proven by the
 * channel that made the decision, and this path is only reachable while the
 * gate says `fulfillable` for this payment. It reuses `finishVerifiedPayment`
 * so the CONFIRMED write, OTP hash, audit and the transactional compensation
 * lock are identical to both capture channels, and it pushes the KOT exactly
 * like they do (the POS de-dupes on its own markers).
 *
 * Returns false when the order is no longer confirmable — never throws, so one
 * bad order cannot stop the sweep.
 */
export async function completeRecoveredCapture(args: {
  orderId: string;
  razorpayPaymentId: string;
  orderData?: Record<string, any>;
}): Promise<boolean> {
  const orderId = typeof args.orderId === "string" ? args.orderId.trim() : "";
  const razorpayPaymentId =
    typeof args.razorpayPaymentId === "string" ? args.razorpayPaymentId.trim() : "";
  if (!orderId || !razorpayPaymentId || !db) return false;

  try {
    const orderRef = db.collection("orders").doc(orderId);
    const snap = await orderRef.get();
    if (!snap.exists) return false;
    const orderData = ((snap.data() || {}) as Record<string, any>) || {};

    // The transactional lock inside finishVerifiedPayment still applies; this
    // pre-check keeps "already confirmed" idempotent and cheap.
    if (!captureGateAllowsConfirm(orderData, razorpayPaymentId)) return false;

    const razorpayOrderId = readRecordedPaymentField(orderData, "razorpayOrderId") || "";
    const capturedPaise =
      Number(orderData?.payment?.capturedAmountPaise) ||
      Number(orderData?.["payment.capturedAmountPaise"]) ||
      (Number(orderData?.pricing?.grandTotal) > 0
        ? Math.round(Number(orderData.pricing.grandTotal) * 100)
        : undefined);

    // A payout failure must never fail the recovery of a paid customer: the
    // existing retry worker owns settlement.
    let transferResult: any = null;
    try {
      const split = await executeRouteSplit({
        orderRef,
        orderId,
        orderData,
        razorpayPaymentId,
        razorpayOrderId,
        capturedAmountPaise: capturedPaise,
      });
      transferResult = split.state === "transferred" ? split.transfer : null;
    } catch (err: any) {
      console.warn(
        `[Capture Recovery] route split skipped for order ${orderId}:`,
        err?.message || err
      );
    }

    const finished: any = await finishVerifiedPayment({
      orderRef,
      orderData,
      orderId,
      razorpayOrderId,
      razorpayPaymentId,
      transferResult,
      capturedAmountPaise: capturedPaise,
    });
    if (!finished?.success) return false;

    await pushConfirmedOrderToPos(orderId);
    await captureErrorSnapshot({
      source: "payments",
      severity: "medium",
      message: `Capture fulfilment recovered: order ${orderId} confirmed by the scheduled sweep after its gate stalled (payment ${razorpayPaymentId})`,
      orderId,
      razorpayPaymentId,
    }).catch(() => undefined);
    return true;
  } catch (err: any) {
    console.warn(
      `[Capture Recovery] confirmation failed for order ${orderId} — retried next tick:`,
      err?.message || err
    );
    return false;
  }
}

export async function executeRouteSplit(args: {
  orderRef: any;
  orderId: string;
  orderData: any;
  razorpayPaymentId: string;
  razorpayOrderId?: string;
  capturedAmountPaise?: number;
}): Promise<RouteSplitOutcome> {
  const { orderRef, orderId, orderData, razorpayPaymentId, razorpayOrderId, capturedAmountPaise } = args;

  if (orderData.routeTransferStatus === "transferred") {
    // Already settled — reuse the receipt. A missing receipt here is a data
    // anomaly, NOT permission to re-POST money that already moved.
    return {
      state: "transferred",
      transfer: orderData.payment?.routeTransfer ?? orderData["payment.routeTransfer"] ?? null,
    };
  }

  const branchId = orderData.branchId;
  const pricingSplit = orderData.pricing?.split;
  const earningsPaise = Number(pricingSplit?.branchTransferPaise);
  const courierFeePaise = Number(pricingSplit?.courierFeePaise) || 0;
  if (!Number.isFinite(earningsPaise)) {
    // Nothing to split (legacy/no-pricing doc): no claim, no write, no POST.
    return { state: "no_split" };
  }

  const flagManualSettlement = async (error: string): Promise<RouteSplitOutcome> => {
    await captureErrorSnapshot({
      source: "payments",
      severity: "high",
      message: `Route split needs manual settlement for order ${orderId}: ${error}`,
      orderId,
      branchId,
      razorpayPaymentId,
    }).catch(() => undefined);
    await orderRef.set(
      {
        routeTransferStatus: "failed",
        routeTransferNeedsManualSettlement: true,
        routeTransferError: error,
        // Release the claim lease so a human-fixable order is re-claimable
        // as soon as ops links the branch (a live lease would block it).
        routeTransferClaimedAt: admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return { state: "flagged", error };
  };

  /**
   * F5/F7 ordering (review): a REFUNDED-before-transfer order still gets its
   * ZERO hold stamped, so the order carries one payout truth (`monthlyFeeHold`)
   * and no earnings are ever counted. Non-refunded terminal refusals are left
   * unstamped — there is no refunded money to reconcile. The hold helper itself
   * recognises the refunded shape and never touches the month ledger.
   */
  const stampRefundedHold = async (): Promise<void> => {
    const refunded = Number(orderData?.refundedTotalPaise);
    const hasRefundMarker =
      (Number.isFinite(refunded) && refunded > 0) ||
      (orderData?.refundStatus !== undefined &&
        orderData?.refundStatus !== null &&
        orderData?.refundStatus !== "");
    if (!hasRefundMarker || !branchId) return;
    try {
      await ensureMonthlyFeeHold({
        orderRef,
        orderId,
        branchId: branchId as string,
        earnedPaise: 0,
        courierFeePaise: 0,
        gatewayCreatedAtMs:
          Number(orderData?.payment?.gatewayCreatedAtMs) ||
          Number(orderData?.["payment.gatewayCreatedAtMs"]) ||
          undefined,
      });
    } catch (err: any) {
      // The refusal itself already parks the payment; the stamp is best effort.
      console.warn(
        `[Payments] zero monthly-fee hold stamp failed for ${orderId}:`,
        err?.message || err
      );
    }
  };

  if (!branchId) {
    return flagManualSettlement("Order has no branchId — cannot execute Route split");
  }

  let racedTransfer: any = null;

  if (db && typeof (db as any).runTransaction === "function") {
    type ClaimResult =
      | { kind: "claimed" }
      | { kind: "done" }
      | { kind: "busy" }
      | {
          kind: "conflict";
          recordedPaymentId?: string | null;
          recordedRazorpayOrderId?: string | null;
          orderStatus?: string | null;
        }
      | {
          kind: "terminal_refusal";
          reason: string;
          orderStatus: string;
        };

    const claimResult: ClaimResult = await (db as any).runTransaction(
      async (tx: any) => {
        const fresh = await tx.get(orderRef as any);
        if (!fresh || !fresh.exists) {
          // Fail closed: never use stale snapshot if fresh read fails!
          return { kind: "busy" };
        }
        const freshData = fresh.data() as any;
        if (!freshData) {
          return { kind: "busy" };
        }

        if (
          freshData.routeTransferStatus === "transferred" ||
          freshData.payment?.routeTransfer ||
          freshData["payment.routeTransfer"]
        ) {
          racedTransfer =
            freshData.payment?.routeTransfer ?? freshData["payment.routeTransfer"] ?? null;
          return { kind: "done" };
        }

        // 1. FRESH SNAPSHOT BINDING CHECK (Finding 1)
        const provenCaptured =
          typeof capturedAmountPaise === "number" || config.mock.paymentGateway === true;
        const recordedPaymentId =
          readRecordedPaymentField(freshData, "razorpayPaymentId") ||
          readRecordedPaymentField(freshData, "capturedPaymentId");
        const recordedRazorpayOrderId =
          readRecordedPaymentField(freshData, "razorpayOrderId");
        const foreignPayment =
          !!recordedPaymentId && !!razorpayPaymentId && recordedPaymentId !== razorpayPaymentId;
        const incomingGatewayOrderId =
          razorpayOrderId ||
          orderData.payment?.razorpayOrderId ||
          orderData.razorpayOrderId ||
          null;
        const foreignGatewayOrder =
          !!recordedRazorpayOrderId &&
          !!incomingGatewayOrderId &&
          recordedRazorpayOrderId !== incomingGatewayOrderId;

        if (provenCaptured && (foreignPayment || foreignGatewayOrder)) {
          // Return conflict: NO writes, NO transfer claim!
          return {
            kind: "conflict",
            recordedPaymentId,
            recordedRazorpayOrderId,
            orderStatus:
              typeof freshData.status === "string"
                ? freshData.status
                : freshData.status?.code,
          };
        }

        // Another worker may already have a payout POST in flight. Preserve
        // its live lease even if cancellation arrived meanwhile; recording a
        // refusal here would falsely imply that no payout was sent.
        if (freshData.routeTransferStatus === "transferring") {
          const claimedAt = freshData.routeTransferClaimedAt;
          const claimedMs =
            typeof claimedAt === "number" && Number.isFinite(claimedAt)
              ? claimedAt
              : claimedAt && typeof claimedAt.toMillis === "function"
                ? claimedAt.toMillis()
                : 0;
          if (Date.now() - claimedMs < TRANSFER_CLAIM_TTL_MS) return { kind: "busy" };
        }

        // T3.3 — REFUND-SIDE-EFFECT SERIALIZATION (Phase 3 MONEY): a FRESH
        // refund claim (refundActiveClaim / legacy refundClaimedAt, < the
        // shared TTL in reconciliation.ts) means a reverse_all refund may
        // already be on the wire — claiming a payout behind it would race a
        // reversal at the provider. Yield (busy): after the refund settles
        // the order reads refunded and the terminal check refuses it, or a
        // new attempt re-claims. A STALE refund lease is a dead claim — the
        // recovery takeover proceeds (never held hostage by a crashed claim).
        {
          const refundClaimActive =
            freshData.refundActiveClaim && typeof freshData.refundActiveClaim === "object"
              ? freshData.refundActiveClaim.claimedAt
              : freshData.refundClaimedAt ?? null;
          if (refundClaimActive != null && isMoneyClaimFresh(refundClaimActive)) {
            return { kind: "busy" };
          }
        }

        // 2. TERMINAL / CANCELLED REFUND SPLIT GUARD (Finding 2)
        const termCheck = isOrderTerminalForRouteTransfer(freshData);
        if (termCheck.isTerminal) {
          recordTerminalRefusalInTx(tx, db, {
            orderRef,
            orderId,
            paymentId: razorpayPaymentId,
            razorpayOrderId:
              razorpayOrderId ||
              recordedRazorpayOrderId ||
              freshData.payment?.razorpayOrderId ||
              freshData.razorpayOrderId ||
              null,
            capturedAmountPaise:
              typeof capturedAmountPaise === "number"
                ? capturedAmountPaise
                : typeof freshData.payment?.capturedAmountPaise === "number"
                  ? freshData.payment.capturedAmountPaise
                  : typeof freshData.pricing?.grandTotal === "number"
                    ? Math.round(freshData.pricing.grandTotal * 100)
                    : undefined,
            reason: termCheck.reason!,
            orderStatus: termCheck.orderStatus || "TERMINAL",
            source: "route_transfers_verify",
          });
          return {
            kind: "terminal_refusal",
            reason: termCheck.reason!,
            orderStatus: termCheck.orderStatus || "TERMINAL",
          };
        }

        // Claim a new or expired lease only after the fresh guards.
        tx.set(
          orderRef as any,
          {
            routeTransferStatus: "transferring",
            routeTransferClaimedAt: Date.now(),
          },
          { merge: true }
        );
        return { kind: "claimed" };
      }
    );

    if (claimResult.kind === "busy") return { state: "busy" };
    if (claimResult.kind === "done") return { state: "transferred", transfer: racedTransfer };
    if (claimResult.kind === "conflict") {
      return {
        state: "conflict",
        recordedPaymentId: claimResult.recordedPaymentId,
        recordedRazorpayOrderId: claimResult.recordedRazorpayOrderId,
        orderStatus: claimResult.orderStatus,
      };
    }
    if (claimResult.kind === "terminal_refusal") {
      const refusalError = `Refused route transfer: order is ${claimResult.orderStatus} (${claimResult.reason})`;
      await stampRefundedHold();
      await captureErrorSnapshot({
        source: "payments",
        severity: "high",
        message: `Route transfer refused for order ${orderId}: order is ${claimResult.orderStatus} (${claimResult.reason}) — parked in unmatched_payments`,
        orderId,
        branchId,
        razorpayPaymentId,
      }).catch(() => undefined);
      return { state: "flagged", error: refusalError };
    }
  } else {
    const termCheck = isOrderTerminalForRouteTransfer(orderData);
    if (termCheck.isTerminal) {
      await parkTerminalPaymentCapture(db, {
        orderId,
        razorpayPaymentId,
        razorpayOrderId,
        amountPaise: capturedAmountPaise,
        reason: termCheck.reason!,
        orderStatus: termCheck.orderStatus || "TERMINAL",
        source: "route_transfers_verify",
      });
      await orderRef.set(
        {
          routeTransferStatus: "failed",
          routeTransferTerminalRefusal: true,
          routeTransferError: `Refused route transfer: order is ${termCheck.orderStatus} (${termCheck.reason})`,
          routeTransferClaimedAt: admin.firestore.FieldValue.delete(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      await stampRefundedHold();
      return {
        state: "flagged",
        error: `Refused route transfer: order is ${termCheck.orderStatus} (${termCheck.reason})`,
      };
    }
  }

  // F5: hold the monthly fee in its OWN transaction, after the lease is won
  // and before any transfer POST. Independently idempotent, so a crash between
  // the lease and the POST is harmless: the next caller re-reads the stamp.
  let hold: MonthlyFeeHold;
  try {
    const held = await ensureMonthlyFeeHold({
      orderRef,
      orderId,
      branchId: branchId as string,
      earnedPaise: earningsPaise,
      courierFeePaise,
      gatewayCreatedAtMs:
        Number(orderData?.payment?.gatewayCreatedAtMs) ||
        Number(orderData?.["payment.gatewayCreatedAtMs"]) ||
        undefined,
    });
    hold = held.hold;
    if (held.manualSettlement) {
      // A payout bookkeeping problem must never fail the charged customer.
      return flagManualSettlement(held.reason || "monthly fee hold could not be applied");
    }
  } catch (err: any) {
    return flagManualSettlement(
      `monthly fee hold failed (${err?.message || err}) — settle manually`
    );
  }

  // F6: nothing to pay the branch. This is a successful outcome, not a
  // failure: never retried, never flagged.
  if (hold.branchTransferPaise <= 0) {
    await orderRef.set(
      {
        routeTransferStatus: "not_required",
        routeTransferClaimedAt: admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return { state: "not_required" };
  }

  const attempt = await attemptRouteTransfer(
    razorpayPaymentId,
    branchId,
    {
      branchTransferPaise: hold.branchTransferPaise,
      monthlyFeeHoldPaise: hold.holdPaise,
    },
    orderId,
    undefined,
    capturedAmountPaise
  );

  if (attempt.ok && attempt.result) {
    await orderRef.set(
      {
        routeTransferStatus: "transferred",
        "payment.routeTransfer": attempt.result,
        routeTransferNeedsManualSettlement: admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return { state: "transferred", transfer: attempt.result };
  }

  if ((attempt as any).unknown) {
    // Outcome UNKNOWN (gateway timeout, ambiguous network failure, or the
    // pre-POST reconcile lookup itself failed): a blind retry could double-
    // pay the branch. Park for ops reconciliation — the claim lease is
    // released so the order is not wedged, and attemptRouteTransfer always
    // reconciles existing transfers before any future POST.
    const unknownError = attempt.error || "Route transfer outcome unknown";
    await captureErrorSnapshot({
      source: "payments",
      severity: "high",
      message: `Razorpay Route transfer outcome UNKNOWN for order ${orderId}: ${unknownError} — parked in needs_reconciliation (no blind retry)`,
      orderId,
      branchId,
      razorpayPaymentId,
    }).catch(() => undefined);
    await orderRef.set(
      {
        routeTransferStatus: "needs_reconciliation",
        routeTransferError: unknownError,
        routeTransferClaimedAt: admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return { state: "flagged", error: unknownError };
  }

  if (attempt.skipped) {
    return flagManualSettlement(
      `${attempt.error || "No linked Razorpay account for branch"} — link the branch in the Razorpay dashboard and settle this payout manually`
    );
  }

  const error = attempt.error || "Route transfer failed";
  await captureErrorSnapshot({
    source: "payments",
    severity: "high",
    message: `Razorpay Route transfer failed for order ${orderId}: ${error}`,
    orderId,
    branchId,
    razorpayPaymentId,
  }).catch(() => undefined);
  await orderRef.set(
    {
      routeTransferStatus: "pending_retry",
      routeTransferError: error,
      routeTransferRetryAt: admin.firestore.FieldValue.serverTimestamp(),
      routeTransferRetryCount: 0,
      // Release the claim lease: the POST already failed, so the scheduled
      // retry worker may claim this order on its next tick instead of
      // idling out the full lease.
      routeTransferClaimedAt: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  return { state: "flagged", error };
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
 * Test seam for the refund POST: unit tests inject a failing stub so the
 * gateway-failure path (claim release) is exercised without the network.
 */
let refundPostOverride:
  | ((paymentId: string, payload: Record<string, any>, key: string) => Promise<any>)
  | null = null;

/** Test-only: stub/unstub the live Razorpay refund POST. */
export function __setRefundPostForTests(
  fn: ((paymentId: string, payload: Record<string, any>, key: string) => Promise<any>) | null
): void {
  refundPostOverride = fn;
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
}): Promise<{ amountPaise: number; createdAtMs?: number }> {
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

  // P1-F: when the gateway payment CARRIES a notes.orderId (every order we mint
  // does — RZ1 writes it at creation), it must name this same internal order.
  // A capture created for another internal order can never confirm this one,
  // however well the amounts line up. A payment with NO notes predates RZ1;
  // the mandatory intent binding above is then the authority, so it is not
  // refused for the absence alone.
  const notedOrderId = payment?.notes?.orderId;
  if (
    typeof notedOrderId === "string" &&
    notedOrderId.length > 0 &&
    notedOrderId !== args.orderId
  ) {
    await parkDiscrepancy("ORDER_NOTE_MISMATCH", {
      gatewayOrderId: payment?.order_id || null,
      gatewayNotedOrderId: notedOrderId,
    });
    const err: any = new Error(
      "This payment was created for a different order — verification refused. Contact support if money left your account."
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

  const capturedPaise = Number(payment.amount);
  const gatewayCreatedRaw = Number(payment.created_at);
  return {
    amountPaise: capturedPaise,
    ...(Number.isFinite(gatewayCreatedRaw) && gatewayCreatedRaw > 0
      ? { createdAtMs: Math.round(gatewayCreatedRaw * 1000) }
      : {}),
  };
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
  /** F2: the gateway payment's own time (ms), so the fee month cannot move. */
  gatewayCreatedAtMs?: number;
}) {
  const { orderRef, orderData, orderId, razorpayOrderId, razorpayPaymentId, transferResult, capturedAmountPaise, gatewayCreatedAtMs } = args;

  // R06 corrective pass: real transactions only. Tests implement the
  // required `db.runTransaction` interface instead of a non-atomic shim.
  if (!db || typeof (db as any).runTransaction !== "function") {
    throw new Error("finishVerifiedPayment requires a transactional datastore");
  }

  const CONFIRMED_LATER_STATUSES = new Set([
    "PREPARING",
    "READY",
    "OUT_FOR_DELIVERY",
    "IN_TRANSIT",
    "DELIVERED",
    "COMPLETED",
    "PICKED_UP",
    "CANCELLED",
    "REFUNDED",
  ]);
  const txOutcome: any = await (db as any).runTransaction(async (tx: any) => {
    const snap = await tx.get(orderRef);
    if (!snap || !snap.exists) {
      const missing: any = new Error(`Cannot confirm payment: order ${orderId} no longer exists.`);
      missing.code = "ORDER_NOT_FOUND";
      missing.statusCode = 404;
      throw missing;
    }
    const fresh: any = snap.data() || {};

    // COMPENSATION LOCK, checked FIRST (see captureFulfillment.ts). A
    // compensated capture stamps payment truth, so every "already paid" guard
    // below would otherwise fall through and re-confirm refunded food.
    if (!captureGateAllowsConfirm(fresh, razorpayPaymentId)) {
      return {
        gateRefused: true,
        gateState: fresh?.captureFulfillment?.state ?? null,
        orderStatus: String(
          typeof fresh?.status === "string" ? fresh.status : fresh?.status?.code ?? ""
        ).toUpperCase(),
      };
    }

    // FRESH SNAPSHOT BINDING CHECK (Finding 1 transactional backstop)
    const provenCaptured =
      typeof capturedAmountPaise === "number" || config.mock.paymentGateway === true;
    const recordedPaymentId =
      readRecordedPaymentField(fresh, "razorpayPaymentId") ||
      readRecordedPaymentField(fresh, "capturedPaymentId");
    const recordedRazorpayOrderId =
      readRecordedPaymentField(fresh, "razorpayOrderId");
    const foreignPayment =
      !!recordedPaymentId && !!razorpayPaymentId && recordedPaymentId !== razorpayPaymentId;
    const foreignGatewayOrder =
      !!recordedRazorpayOrderId && !!razorpayOrderId && recordedRazorpayOrderId !== razorpayOrderId;

    if (provenCaptured && (foreignPayment || foreignGatewayOrder)) {
      // Return conflict outcome: NO writes, NO OTP mint, NO audit, NO coin debit
      return {
        conflict: true,
        recordedPaymentId,
        recordedRazorpayOrderId,
        orderStatus: typeof fresh?.status === "string" ? fresh.status : fresh?.status?.code,
      };
    }

    // T3.2 — ATOMIC CAPTURED-PAYMENT CLAIM (verify path): mirrored from the
    // webhook confirm tx. One captured payment may confirm at most ONE
    // internal order; a claim owned by a DIFFERENT order suppresses this
    // confirmation before any write, OTP mint, audit or coin debit. No
    // live-API fetch here — the binding decision stays inside the tx.
    const t32Claim = await (async () => {
      return claimCapturedPaymentInTx(tx, db, {
        razorpayPaymentId,
        orderId,
        razorpayOrderId,
        amountPaise:
          typeof capturedAmountPaise === "number"
            ? capturedAmountPaise
            : Number(fresh?.pricing?.grandTotal) > 0
            ? Math.round(Number(fresh.pricing.grandTotal) * 100)
            : null,
      });
    })();
    if (t32Claim.kind === "reused_by_other_order") {
      return {
        conflict: true,
        reusedCapture: true,
        recordedPaymentId,
        recordedRazorpayOrderId,
        reusedByOrderId: t32Claim.recordedOrderId,
        orderStatus: typeof fresh?.status === "string" ? fresh.status : fresh?.status?.code,
      };
    }

    const statusCodeRaw =
      typeof fresh?.status === "string" ? fresh.status : fresh?.status?.code;
    const normalized = String(statusCodeRaw || "").toUpperCase();
    const alreadyCompleted =
      fresh?.paymentStatus === "completed" ||
      fresh?.["payment.status"] === "completed" ||
      normalized === "CONFIRMED";
    const laterStatus =
      CONFIRMED_LATER_STATUSES.has(normalized) ||
      fresh?.status?.terminal === true ||
      fresh?.terminal === true;
    const terminalCanceledOrRefunded =
      normalized === "CANCELLED" ||
      normalized === "REFUNDED" ||
      isOrderTerminalForRouteTransfer(fresh).isTerminal;
    const hasHash = hasDeliveryOtpHash(fresh);

    const performedConfirm = !alreadyCompleted && !laterStatus && !terminalCanceledOrRefunded;

    // Brand-new confirmation path. One shared mint (see mintDeliveryOtp): the
    // hash is written in the SAME transaction as CONFIRMED, and an existing
    // hash is never overwritten.
    if (performedConfirm) {
      const mintedOtp = mintDeliveryOtp(fresh);
      const capturedPaiseStamp =
        typeof capturedAmountPaise === "number" && Number.isFinite(capturedAmountPaise)
          ? capturedAmountPaise
          : undefined;
      const updatePayload: Record<string, any> = {
        paymentStatus: "completed",
        // Legacy dotted aliases kept during migration: both-shape readers in
        // the apps and older functions read the literal form directly.
        "payment.status": "completed",
        // F8: the payment stream marker. Clients can never write it, so an
        // analytics reader can tell a gateway capture from cash/counter.
        paymentChannel: "razorpay",
        "payment.razorpayPaymentId": razorpayPaymentId,
        "payment.razorpayOrderId": razorpayOrderId,
        "payment.verifiedAt": admin.firestore.FieldValue.serverTimestamp(),
        // F2: the gateway payment's own creation time (ms) — the monthly-fee
        // month is decided by when the customer paid, not by our clock.
        ...(typeof gatewayCreatedAtMs === "number" && Number.isFinite(gatewayCreatedAtMs)
          ? { "payment.gatewayCreatedAtMs": gatewayCreatedAtMs }
          : {}),
        ...(capturedPaiseStamp !== undefined
          ? { "payment.capturedAmountPaise": capturedPaiseStamp }
          : {}),
        // Mirror the same truth into the nested object the apps actually read.
        // CANONICAL nested payment map (the queryable shape) — the refund.processed
        // webhook looks orders up by `where("payment.razorpayPaymentId", …)`,
        // i.e. the NESTED path; a top-level dotted-literal field is invisible to
        // that query. Without this the customer app also sees
        // payment.status=pending after a successful capture and refuses to
        // finalize the paid order.
        payment: {
          ...(fresh?.payment && typeof fresh.payment === "object" && !Array.isArray(fresh.payment)
            ? fresh.payment
            : {}),
          status: "completed",
          razorpayPaymentId,
          razorpayOrderId,
          transactionId: razorpayPaymentId,
          ...(capturedPaiseStamp !== undefined
            ? { capturedAmountPaise: capturedPaiseStamp }
            : {}),
          ...(typeof gatewayCreatedAtMs === "number" && Number.isFinite(gatewayCreatedAtMs)
            ? { gatewayCreatedAtMs }
            : {}),
          verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        status: {
          code: "CONFIRMED",
          label: "Order confirmed",
          kind: "upcoming",
          terminal: false,
        },
        // B5: a successful confirmation RETIRES any earlier reconciliation
        // marker. Without this, a park that is later resolved (customer retry,
        // ops fix) would leave the order confirmed AND still telling the payer
        // "payment not confirmed yet — do not pay again". `null` rather than a
        // field delete so every datastore/mock agrees the marker is gone.
        reconciliation: null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      if (mintedOtp) {
        updatePayload.deliveryOtpHash = mintedOtp.deliveryOtpHash;
      }
      tx.set(orderRef, updatePayload, { merge: true });
      return {
        performedConfirm: true,
        generatedOtp: mintedOtp?.otp,
        fresh,
        terminalCanceledOrRefunded: false,
        statusCode: normalized,
      };
    }

    // Atomic exactly-once OTP/hash backfill for payments that were confirmed by
    // the webhook (or another transaction) without a delivery OTP hash. Only
    // when the order did not already carry a hash. Never overwrite an existing
    // hash (idempotent), and never leak a wrong/random OTP on retry.
    let generatedOtp: string | undefined;
    const backfillEligible =
      isDeliveryOtpEligible(fresh) &&
      alreadyCompleted &&
      !hasHash &&
      !terminalCanceledOrRefunded &&
      (normalized === "CONFIRMED" || laterStatus === false);
    if (backfillEligible) {
      const minted = mintDeliveryOtp(fresh);
      if (minted) {
        generatedOtp = minted.otp;
        tx.set(
          orderRef,
          {
            deliveryOtpHash: minted.deliveryOtpHash,
            // B5: this path only runs for an ALREADY-confirmed order, so it is
            // also the natural place to retire a stale reconciliation marker.
            reconciliation: null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }
    }

    return {
      performedConfirm: false,
      generatedOtp,
      fresh,
      terminalCanceledOrRefunded,
      statusCode: normalized,
    };
  });

  if (txOutcome.gateRefused) {
    const refused: any = new Error(
      "This payment's fulfilment is still being decided, or it was already refunded — nothing further was charged. Please retry in a moment."
    );
    refused.statusCode = 202;
    refused.code = "CAPTURE_FULFILLMENT_PENDING";
    refused.retryAfterMs = 2000;
    throw refused;
  }

  if (txOutcome.conflict) {
    return {
      conflict: true,
      success: false,
      reusedCapture: !!txOutcome.reusedCapture,
      reusedByOrderId: txOutcome.reusedByOrderId ?? null,
      recordedPaymentId: txOutcome.recordedPaymentId,
      recordedRazorpayOrderId: txOutcome.recordedRazorpayOrderId,
      orderStatus: txOutcome.orderStatus,
      confirmedOrderId: orderId,
      paymentId: razorpayPaymentId,
      transfer: null,
      deliveryOtp: undefined,
    };
  }

  if (txOutcome.performedConfirm) {
    const auditId = `aud_${Date.now()}_${razorpayPaymentId.substring(0, 10)}`;
    await db.collection("payment_audits").doc(auditId).set({
      orderId,
      razorpayOrderId,
      razorpayPaymentId,
      status: "success",
      action: "payment_captured",
      amountPaise: txOutcome.fresh?.pricing?.grandTotal
        ? Math.round(txOutcome.fresh.pricing.grandTotal * 100)
        : null,
      transferResult,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // No Grill-Coins debit runs here any more: redemption is refused at intent
    // creation (D31-D33), so no captured order can carry a coin discount. The
    // coin ledger, earn path and staff adjustments are untouched — only the
    // redemption path on the payment lane is gone.
  }

  const terminalCode = txOutcome.terminalCanceledOrRefunded ? "ORDER_TERMINAL" : undefined;
  return {
    success: !txOutcome.terminalCanceledOrRefunded,
    ...(terminalCode ? { code: terminalCode } : {}),
    confirmedOrderId: orderId,
    paymentId: razorpayPaymentId,
    transfer: transferResult,
    deliveryOtp: txOutcome.generatedOtp,
  };
}

/**
 * Post-confirm KOT dispatch for the client verify channel (webhook parity).
 *
 * Deliberately never throws. The payment is already captured, so a POS problem
 * is a kitchen-sync problem, not a payment problem: `pushOrderToPetpooja`
 * writes the authoritative failure state itself (`pending_retry`, or
 * `reconciliation_required` for a transport-ambiguous POST) and releases its
 * claim, and swallowing here keeps that state from being masked by a 500 to
 * the payer.
 */
async function pushConfirmedOrderToPos(orderId: string): Promise<void> {
  try {
    // Lazy: the POS barrel is not on the payment path's import cost, and tests
    // that never confirm never load it.
    const { pushOrderToPetpooja } = await import("../petpooja");
    const pushed = await pushOrderToPetpooja(orderId);
    if (!pushed) {
      console.warn(
        `[Payments] KOT push deferred for order ${orderId} — POS sync outstanding, existing retry/reconciliation state owns it`
      );
    }
  } catch (err: any) {
    console.warn(
      `[Payments] KOT push failed for order ${orderId}:`,
      err?.message || err
    );
    await captureErrorSnapshot({
      source: "payments",
      severity: "high",
      message: `Post-confirm KOT push threw for order ${orderId} — paid order stays confirmed, POS retry/reconciliation owns the sync`,
      orderId,
      errorStack: err?.stack,
    }).catch(() => undefined);
  }
}

export interface RefundParams {
  orderId: string;
  razorpayPaymentId: string;
  amountRupees?: number;
  reason?: string;
  refundRequestId?: string;
}

/**
 * Fixed-width collision-resistant hash of unambiguous [orderId, paymentId, requestId].
 * Formats a bounded, safe idempotency key for the Razorpay X-Refund-Idempotency header.
 */
export function computeGatewayRefundKey(orderId: string, paymentId: string, requestId: string): string {
  const unambiguous = JSON.stringify([orderId, paymentId, requestId]);
  const digest = crypto.createHash("sha256").update(unambiguous).digest("hex");
  return `rfnd_${digest}`;
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
  // ZERO-MOCK production guard: a production refund must never be faked by
  // the mock branch below (a customer would be told "refunded" with no money
  // ever leaving the gateway).
  assertLivePaymentsContext("autoRefund");

  const { orderId, razorpayPaymentId, amountRupees, reason, refundRequestId } = params;

  // Validation: refundRequestId format (8-128 chars [A-Za-z0-9_-])
  if (refundRequestId !== undefined) {
    if (
      typeof refundRequestId !== "string" ||
      refundRequestId.length < 8 ||
      refundRequestId.length > 128 ||
      !/^[A-Za-z0-9_-]+$/.test(refundRequestId)
    ) {
      const invalid: any = new Error(
        "Invalid refundRequestId: must be 8-128 characters matching [A-Za-z0-9_-]"
      );
      invalid.statusCode = 400;
      invalid.code = "INVALID_REFUND_REQUEST_ID";
      throw invalid;
    }
  }

  // Fail-closed live guard: LIVE refunds REQUIRE a caller-provided refundRequestId.
  // Missing-id mock/test-only calls retain legacy pinned behavior.
  if (!config.mock.paymentGateway && !refundRequestId) {
    const missing: any = new Error(
      "Cannot refund: refundRequestId is required for live refund execution."
    );
    missing.statusCode = 400;
    missing.code = "REFUND_REQUEST_ID_REQUIRED";
    throw missing;
  }

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
  const defaultGatewayKey = refundRequestId
    ? computeGatewayRefundKey(orderId, capturedPaymentId, refundRequestId)
    : `refund_${orderId}_${requestedPaise ?? "full"}`;
  const reqDocId = refundRequestId
    ? `prfnd_${crypto.createHash("sha256").update(JSON.stringify([orderId, capturedPaymentId, refundRequestId])).digest("hex").slice(0, 48)}`
    : null;
  const reqRef = reqDocId ? db.collection("payment_refund_requests").doc(reqDocId) : null;
  const claimed = await runTx(async (tx) => {
    const snap = await tx.get(orderRef);
    const reqSnap = reqRef ? await tx.get(reqRef) : null;
    if (!snap.exists) {
      const missing: any = new Error(`Cannot refund: order ${orderId} not found.`);
      missing.statusCode = 404;
      missing.code = "ORDER_NOT_FOUND";
      throw missing;
    }
    const data = ((snap.exists ? snap.data() : {}) || {}) as any;

    // Transactionally re-verify branch access and captured payment proof inside tx
    if (caller) await assertOrderBranchAccess(caller, data);
    const capturedInTx =
      data.payment?.razorpayPaymentId ?? data["payment.razorpayPaymentId"] ?? null;
    if (!capturedInTx || capturedInTx !== razorpayPaymentId) {
      const unpaid: any = new Error(
        "Cannot refund: no captured Razorpay payment found for this order (COD or unpaid)."
      );
      unpaid.statusCode = 409;
      unpaid.code = "NO_CAPTURED_PAYMENT";
      throw unpaid;
    }

    const existingTotal = Number(data.refundedTotalPaise) || 0;

    // F7a: a refund must not race a live transfer lease. A `transferring`
    // order under an unexpired lease is actively paying the branch; reversing
    // or releasing against a moving target is what this refuses.
    const TRaNSFER_TTL_MS = 10 * 60 * 1000;
    if (data.routeTransferStatus === "transferring") {
      const claimedAt = Number(data.routeTransferClaimedAt) || 0;
      if (Date.now() - claimedAt < TRaNSFER_TTL_MS) {
        const wait: any = new Error(
          "A Route transfer is in progress for this order — retry the refund in a few minutes."
        );
        wait.statusCode = 409;
        wait.code = "REFUND_WAIT_TRANSFER";
        throw wait;
      }
    }

    // Legacy scalar receipt (pre-ledger shape): a gateway refund recorded only
    // as refundId/refundAmount. It is NOT an adoptable identity (no request id,
    // no per-refund ledger entry), but it IS money already returned and must
    // both consume the cumulative cap and refuse same-amount re-payouts.
    const scalarRefundId =
      typeof data.refundId === "string" && data.refundId.trim() ? data.refundId.trim() : null;
    const scalarRefundAmountPaise =
      typeof data.refundAmount === "number" && Number.isFinite(data.refundAmount)
        ? Math.round(data.refundAmount * 100)
        : null;
    const ledgerHasScalarReceipt =
      !!scalarRefundId &&
      !!data.refundLedger &&
      typeof data.refundLedger === "object" &&
      !Array.isArray(data.refundLedger) &&
      Object.prototype.hasOwnProperty.call(data.refundLedger, scalarRefundId);
    // Only fold when the ledger does not already account for this receipt,
    // otherwise max(total, ledger, scalar) would double-count the same money.
    const scalarReceiptUnrepresented =
      !!scalarRefundId && scalarRefundAmountPaise !== null && !ledgerHasScalarReceipt;

    // Refund-claim guard's FULLNESS is decided by the recorded LEDGER against
    // the known capture — never by the bare status string. The webhook +
    // autoRefund post-gateway writes stamp "partially_refunded" while the
    // cumulative total is below the capture (see refund.processed), and
    // stamping the first partial "refunded" here used to 409-block the
    // designed remainder refund (ALREADY_REFUNDED) its own cap logic invites.
    const ledgerSum =
      data.refundLedger && typeof data.refundLedger === "object" && !Array.isArray(data.refundLedger)
        ? Object.values(data.refundLedger as Record<string, number>).reduce(
            (sum, v) => sum + (Number(v) || 0),
            0
          )
        : 0;
    const recordedRefundedPaise = Math.max(
      existingTotal,
      ledgerSum + (scalarReceiptUnrepresented ? (scalarRefundAmountPaise as number) : 0)
    );
    // Capture AUTHORITY (B1): the live gateway capture truth
    // (payment.capturedAmountPaise, both storage shapes) outranks the priced
    // total — a points-discounted payable captures LESS than grandTotal, and
    // capping/status-computing against the price would grant refunds beyond
    // the money Razorpay actually holds. Priced total stays the fallback for
    // docs written before the capture stamp existed.
    const recordedCapturePaise =
      Number(data?.payment?.capturedAmountPaise) ||
      Number(data?.["payment.capturedAmountPaise"]) ||
      0;
    const authorityCapturePaise =
      Number.isFinite(recordedCapturePaise) && recordedCapturePaise > 0
        ? recordedCapturePaise
        : capturedPaise;

    // Server-only top-level payment_refund_requests doc.
    const existingReq = reqSnap && reqSnap.exists ? (reqSnap.data() as any) : null;

    // Known pending identity recovery check:
    let isMatchingPendingRecovery = false;
    let gatewayKeyToUse = defaultGatewayKey;

    // 1. KEYED REPLAY & PENDING RECOVERY (B2 companion):
    if (refundRequestId && existingReq) {
      if (existingReq.status === "completed") {
        const paymentMatches = existingReq.paymentId === razorpayPaymentId;
        const amountMatches = existingReq.requestedPaise === requestedPaise;
        const reasonMatches = (existingReq.reason ?? null) === (reason ?? null);
        if (!paymentMatches || !amountMatches || !reasonMatches) {
          const conflict: any = new Error(
            `Refund request ${refundRequestId} was previously completed with a different payload — conflict refused.`
          );
          conflict.statusCode = 409;
          conflict.code = "REFUND_REQUEST_CONFLICT";
          throw conflict;
        }
        if (!existingReq.refundId || typeof existingReq.refundId !== "string" || !existingReq.refundId.trim()) {
          const corrupt: any = new Error(
            "Cannot replay refund: stored record is missing valid gateway refund ID — reconciliation required."
          );
          corrupt.statusCode = 409;
          corrupt.code = "REFUND_RECONCILIATION_REQUIRED";
          throw corrupt;
        }
        return {
          replay: {
            id: existingReq.refundId,
            payment_id: razorpayPaymentId,
            status: "processed",
            reused: true as const,
          },
        };
      } else if (existingReq.status === "pending") {
        // Pending attempt validation: must strictly bind all fields (paymentId, amount, reason, gatewayKey)
        const paymentMatches = existingReq.paymentId === razorpayPaymentId;
        const amountMatches = existingReq.requestedPaise === requestedPaise;
        const reasonMatches = (existingReq.reason ?? null) === (reason ?? null);
        const keyMatches = existingReq.gatewayKey && existingReq.gatewayKey === defaultGatewayKey;
        if (!paymentMatches || !amountMatches || !reasonMatches || !keyMatches) {
          const conflict: any = new Error(
            `Pending refund request ${refundRequestId} payload or gateway key mismatch — conflict refused.`
          );
          conflict.statusCode = 409;
          conflict.code = "REFUND_REQUEST_CONFLICT";
          throw conflict;
        }
        isMatchingPendingRecovery = true;
        gatewayKeyToUse = existingReq.gatewayKey;
      }
    }

    if (!refundRequestId) {
      // 2. UNKEYED LEGACY REPLAY (Mock/test-only pinned behavior):
      const replayEntry =
        requestedPaise !== null
          ? Object.entries(ledgerSum > 0 ? (data.refundLedger as Record<string, number>) : {}).find(
              ([, paise]) => Math.round(Number(paise) || 0) === requestedPaise
            )
          : undefined;
      if (replayEntry) {
        return { replay: { id: replayEntry[0], payment_id: razorpayPaymentId, status: "processed", reused: true as const } };
      }
      if (
        ledgerSum === 0 &&
        (data.refundStatus === "refunded" || data.refundStatus === "partially_refunded") &&
        data.refundId &&
        (data.refundAmount ?? undefined) === (amountRupees ?? undefined)
      ) {
        return { replay: { id: data.refundId, payment_id: razorpayPaymentId, status: "processed", reused: true as const } };
      }
    }

    // Outstanding identity / active lease check:
    // Enforced independently of scalar refundStatus (webhookHandler sets partially_refunded/refunded
    // while autoRefund still has an active pending attempt).
    const hasActiveClaimObj =
      data.refundActiveClaim &&
      typeof data.refundActiveClaim === "object" &&
      !Array.isArray(data.refundActiveClaim) &&
      typeof data.refundActiveClaim.claimedAt === "number" &&
      Number.isFinite(data.refundActiveClaim.claimedAt) &&
      data.refundActiveClaim.claimedAt > 0;

    const hasClaimedAt =
      typeof data.refundClaimedAt === "number" &&
      Number.isFinite(data.refundClaimedAt) &&
      data.refundClaimedAt > 0;

    const activeClaim = hasActiveClaimObj
      ? data.refundActiveClaim
      : hasClaimedAt
      ? {
          requestId: data.refundClaimedRequestId ?? null,
          claimedAt: Number(data.refundClaimedAt),
          paymentId: data.refundClaimedPaymentId ?? null,
          requestedPaise: data.refundClaimedPaise ?? null,
          gatewayKey: data.refundClaimedKey ?? null,
          reason: data.refundClaimedReason ?? null,
        }
      : null;

    if (activeClaim) {
      const claimedAt = Number(activeClaim.claimedAt) || 0;
      const isLeaseActive = Date.now() - claimedAt < REFUND_CLAIM_TTL_MS;
      if (isLeaseActive) {
        const busy: any = new Error("A refund for this order is already in progress — do not retry.");
        busy.statusCode = 409;
        busy.code = "REFUND_IN_PROGRESS";
        throw busy;
      }
      // Stale lease (>10m): previous worker died mid-flight. Take over safety requirements:
      // - Stale same-id lease takeover reuses same gateway key and asserts immutable payload (including reason);
      // - Different unresolved identity (including old unkeyed in-flight attempt) requires reconciliation,
      //   no blind new-key POST.
      if (refundRequestId && activeClaim.requestId === refundRequestId) {
        const claimedPayment = activeClaim.paymentId;
        const claimedPaise = activeClaim.requestedPaise;
        const claimedReason = activeClaim.reason;
        if (
          (claimedPayment && claimedPayment !== razorpayPaymentId) ||
          (claimedPaise !== undefined && claimedPaise !== requestedPaise) ||
          (claimedReason !== undefined && (claimedReason ?? null) !== (reason ?? null))
        ) {
          const conflict: any = new Error(
            `Stale in-flight refund claim ${refundRequestId} payload mismatch — conflict refused.`
          );
          conflict.statusCode = 409;
          conflict.code = "REFUND_REQUEST_CONFLICT";
          throw conflict;
        }
        if (activeClaim.gatewayKey) {
          gatewayKeyToUse = activeClaim.gatewayKey;
        }
      } else {
        const unrec: any = new Error(
          "Cannot refund: an earlier in-flight refund attempt with different or unresolved identity is pending reconciliation."
        );
        unrec.statusCode = 409;
        unrec.code = "REFUND_RECONCILIATION_REQUIRED";
        throw unrec;
      }
    }

    // Fail-closed unkeyed legacy completed ledger ambiguity:
    // If an explicit new ID is submitted, but the order already contains an UNKEYED completed
    // ledger entry matching the requested amount, we cannot adopt it and cannot blindly pay again.
    // Matching pending recovery is immune because its money was already accounted for / may be in ledger from webhook.
    if (!isMatchingPendingRecovery && refundRequestId && requestedPaise !== null) {
      const keyedRefundIds = new Set<string>();
      if (data.refundKeyedReceipts && typeof data.refundKeyedReceipts === "object") {
        for (const rid of Object.keys(data.refundKeyedReceipts)) keyedRefundIds.add(rid);
      }
      const matchingUnkeyedLegacy = Object.entries(
        (data.refundLedger || {}) as Record<string, number>
      ).find(([rid, p]) => !keyedRefundIds.has(rid) && Math.round(Number(p) || 0) === requestedPaise);

      // Same rule for the pre-ledger scalar shape: the amount may already have
      // been returned by the receipt, and nothing proves this key is a new
      // intent. Never adopt it as this request's identity, and never pay the
      // same amount twice. A bare "refunded" status is deliberately left to
      // the fullness check below: the webhook's positive-amount partial stamp
      // must still allow the designed remainder refund.
      const scalarMatchesRequest =
        scalarReceiptUnrepresented && scalarRefundAmountPaise === requestedPaise;

      if (matchingUnkeyedLegacy || scalarMatchesRequest) {
        const unrec: any = new Error(
          "Cannot process refund: an unkeyed completed legacy refund of matching amount exists on this order. Reconciliation is required before issuing new refunds."
        );
        unrec.statusCode = 409;
        unrec.code = "REFUND_RECONCILIATION_REQUIRED";
        throw unrec;
      }
    }

    // Terminal-without-proof: "refunded" is trusted as FULL only when
    //   (a) the recorded ledger/total actually reaches the capture, or
    //   (b) it is the full-request shape — refundAmount === null is written
    //       ONLY by a full (amountRupees-unset) autoRefund call, so the
    //       intent is unambiguous even when the gateway echo (or the mock)
    //       disagrees with the priced capture (M4).
    // A webhook/A-partial stamp below the capture ("refunded" + a positive
    // per-refund amount) is NOT full — the designed remainder refund proceeds.
    const fullIntentShape =
      data.refundStatus === "refunded" &&
      !!data.refundId &&
      (data.refundAmount ?? null) === null;
    const fullyRefunded =
      authorityCapturePaise !== null
        ? recordedRefundedPaise >= authorityCapturePaise || fullIntentShape
        : data.refundStatus === "refunded" && !!data.refundId;
    if (fullyRefunded && !isMatchingPendingRecovery) {
      const dup: any = new Error("Order is already fully refunded — refusing a second refund.");
      dup.statusCode = 409;
      dup.code = "ALREADY_REFUNDED";
      throw dup;
    }

    // Cumulative partial-refund cap: sequential partials may never exceed
    // the captured total, and the cap is LEDGER-AUTHORITATIVE (M1) — the
    // scalar total can lag a webhook-updated ledger, so the refundable
    // remaining is computed against max(total, ledgerSum). A "full" request
    // after partials is refused with the exact remaining paise (operator
    // refunds the remainder explicitly — no magic remainder that could
    // double-pay).
    if (!isMatchingPendingRecovery) {
      if (requestedPaise !== null && authorityCapturePaise !== null) {
        if (requestedPaise + recordedRefundedPaise > authorityCapturePaise) {
          const over: any = new Error(
            `Refund of ${requestedPaise}pa exceeds the remaining refundable ${authorityCapturePaise - recordedRefundedPaise}pa — refused.`
          );
          over.statusCode = 400;
          over.code = "REFUND_EXCEEDS_REMAINING";
          throw over;
        }
      }
      // Fail-closed (B6): with an unknown capture a second partial cannot be
      // bounded — refuse rather than refund blindly. Same-request replays above
      // still work (identity is the durable refund request id); the legacy
      // unkeyed amount replay is the only path that still matches by amount.
      if (requestedPaise !== null && authorityCapturePaise === null && recordedRefundedPaise > 0) {
        const unsure: any = new Error(
          "Refund amount cannot be bounded against an unknown captured total — record the capture first."
        );
        unsure.statusCode = 409;
        unsure.code = "REFUND_CAPTURE_UNKNOWN";
        throw unsure;
      }
      if (requestedPaise === null && recordedRefundedPaise > 0 && authorityCapturePaise !== null) {
        const partials: any = new Error(
          `Order already has partial refunds (${recordedRefundedPaise}pa) — refund the remaining ${authorityCapturePaise - recordedRefundedPaise}pa explicitly.`
        );
        partials.statusCode = 409;
        partials.code = "REFUND_PARTIALS_EXIST";
        throw partials;
      }
    }

    // T3.3 — TRANSFER-SIDE-EFFECT SERIALIZATION (Phase 3 MONEY): a FRESH
    // Route-transfer claim (`routeTransferStatus:"transferring"` with a live
    // lease) means the payout POST may already be on the wire — a concurrent
    // reverse_all refund would race it at the provider. Refuse (409, no
    // blind retry, no state flip): the operator retries after the transfer
    // settles — the terminal/fullness checks then handle the outcome. A
    // STALE transfer lease is a dead claim (recovery domain) and does NOT
    // block the refund; existing reconciliation covers its unknown outcome.
    {
      const transferClaimMs = data?.routeTransferClaimedAt ?? null;
      if (
        data?.routeTransferStatus === "transferring" &&
        transferClaimMs != null &&
        isMoneyClaimFresh(transferClaimMs)
      ) {
        const conflicting: any = new Error(
          "A Route transfer payout for this order is currently in flight — refund after it settles (do not refund mid-payout)."
        );
        conflicting.statusCode = 409;
        conflicting.code = "ROUTE_TRANSFER_IN_PROGRESS";
        throw conflicting;
      }
    }

    const orderClaimData: Record<string, any> = {
      refundStatus: "refunding",
      refundClaimedAt: Date.now(),
      refundClaimedRequestId: refundRequestId ?? null,
      refundClaimedPaymentId: razorpayPaymentId,
      refundClaimedPaise: requestedPaise,
      refundClaimedKey: gatewayKeyToUse,
      refundClaimedReason: reason ?? null,
      refundActiveClaim: {
        requestId: refundRequestId ?? null,
        claimedAt: Date.now(),
        paymentId: razorpayPaymentId,
        requestedPaise,
        gatewayKey: gatewayKeyToUse,
        reason: reason ?? null,
      },
      ...(scalarReceiptUnrepresented
        ? {
            refundLedger: {
              ...(data.refundLedger &&
              typeof data.refundLedger === "object" &&
              !Array.isArray(data.refundLedger)
                ? (data.refundLedger as Record<string, number>)
                : {}),
              [scalarRefundId as string]: scalarRefundAmountPaise as number,
            },
          }
        : {}),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    tx.set(orderRef, orderClaimData, { merge: true });

    if (reqRef && refundRequestId) {
      tx.set(
        reqRef,
        {
          orderId,
          paymentId: razorpayPaymentId,
          refundRequestId,
          requestedPaise,
          reason: reason ?? null,
          status: "pending",
          gatewayKey: gatewayKeyToUse,
          claimedAt: Date.now(),
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    // The post-gateway record write re-reads the ledger fresh inside its own
    // transaction, so no claim-time ledger snapshot is needed here. The prior
    // status is returned so a gateway failure can release the claim WITHOUT
    // erasing a "partially_refunded" state.
    return {
      existingTotal,
      priorRefundStatus: typeof data.refundStatus === "string" ? data.refundStatus : null,
      routeTransferStatus:
        typeof data.routeTransferStatus === "string" ? data.routeTransferStatus : null,
      gatewayKey: gatewayKeyToUse,
    };
  });
  if ((claimed as any).replay) return (claimed as any).replay;
  const priorRefundStatus = (claimed as any).priorRefundStatus as
    | string
    | null
    | undefined;
  const gatewayKey = (claimed as any).gatewayKey as string;
  // F7a: `reverse_all` is sent ONLY when a transfer actually exists to reverse.
  // Razorpay's partial-refund behaviour is undocumented, so the key is omitted
  // for every non-settled lane instead of asking the gateway to decide.
  const transferStatusForRefund = (claimed as any).routeTransferStatus as string | null;
  const canReverseTransfer =
    transferStatusForRefund === "transferred" ||
    transferStatusForRefund === "needs_reconciliation";

  const refundPayload: any = {
    ...(canReverseTransfer ? { reverse_all: true } : {}),
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
    const mockRefundId = refundRequestId
      ? `rfnd_mock_${crypto.createHash("sha256").update(gatewayKey).digest("hex").slice(0, 16)}`
      : `rfnd_mock_${Date.now()}`;
    refundResult = {
      id: mockRefundId,
      payment_id: razorpayPaymentId,
      amount: refundPayload.amount || 10000,
      status: "processed",
    };
  } else {
    try {
      // Key validation + mock-mode refusal live in getRazorpayClient; the
      // POST itself goes over raw HTTPS (not the SDK) so we can send
      // X-Refund-Idempotency: a fixed-width deterministic hash of
      // [orderId, paymentId, refundRequestId] via computeGatewayRefundKey.
      // Razorpay dedupes retries with the same key server-side — a
      // lost-response retry replays the ORIGINAL refund instead of posting
      // a second one. A retry with a DIFFERENT body is rejected outright.
      if (refundPostOverride) {
        refundResult = await refundPostOverride(
          razorpayPaymentId,
          refundPayload,
          gatewayKey
        );
      } else {
        getRazorpayClient();
        refundResult = await postRefundWithIdempotency(
          razorpayPaymentId,
          refundPayload,
          gatewayKey
        );
      }
    } catch (err: any) {
      await captureErrorSnapshot({
        source: "payments",
        severity: "high",
        message: `Refund execution failed for payment ${razorpayPaymentId}: ${err.message}`,
        orderId,
        razorpayPaymentId,
      });
      // Release the claim lease so a retry is not wedged behind
      // REFUND_IN_PROGRESS for the full 10-minute TTL (same pattern as
      // executeRouteSplit). Safe because the gateway POST above used a STABLE
      // idempotency key (`refund_{orderId}_{paise|full}`): a retry after a
      // lost response replays the original refund instead of posting a second
      // one. Restore the pre-claim status so a "partially_refunded" order keeps
      // its history. If the release write fails, the original 502 still wins.
      try {
        await orderRef.set(
          {
            refundStatus: priorRefundStatus
              ? priorRefundStatus
              : admin.firestore.FieldValue.delete(),
            refundClaimedAt: admin.firestore.FieldValue.delete(),
            // The ACTIVE claim lease is the guard a retry actually hits
            // (`REFUND_IN_PROGRESS`), so it must be released too — otherwise a
            // failed attempt wedges the refund for the full TTL and every
            // recovery retry is refused. `null` (not a delete sentinel) so the
            // object-shape guard reads it as "no active claim"; the pending
            // request record keeps the same idempotency identity for the retry.
            refundActiveClaim: null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      } catch (releaseErr: any) {
        console.warn(
          `[Payments] refund claim release failed for order ${orderId} (retry will wait for the lease TTL):`,
          releaseErr?.message || releaseErr
        );
      }
      const failed: any = new Error(`Refund failed: ${err.message}`);
      failed.statusCode = 502;
      failed.code = "REFUND_GATEWAY_FAILED";
      throw failed;
    }
  }

  // P1-M — UNCERTAIN OUTCOME. A 2xx response with no usable refund id means
  // the money has left but we cannot prove WHICH refund it became. Writing that
  // through (the old behaviour) put `undefined` into the order doc, the ledger,
  // the request record and the audit row, so real Firestore rejected the whole
  // transaction: the accounting rolled back while the refund stood, the order
  // looked refundable again, and a later refund could pay out twice.
  //
  // Instead: keep the claim (so no second POST can start), record what is
  // KNOWN on the order, park it for ops, and require reconciliation. Nothing is
  // rolled back — the claim and the `refundUncertain` marker are the recovery
  // handle, and the SAME idempotency key makes a retry safe (Razorpay replays
  // the original refund rather than creating another one).
  const responseRefundId =
    typeof refundResult?.id === "string" && refundResult.id.trim() ? refundResult.id.trim() : "";
  if (!responseRefundId) {
    const attemptedPaise =
      typeof refundPayload.amount === "number" ? Number(refundPayload.amount) : capturedPaise;
    await recordUncertainRefund({
      orderRef,
      orderId,
      razorpayPaymentId,
      refundRequestId,
      gatewayKey,
      attemptedPaise,
      reason,
      responseStatus: typeof refundResult?.status === "string" ? refundResult.status : null,
      responseAmount:
        typeof refundResult?.amount === "number" ? Number(refundResult.amount) : null,
      reqRef,
    });
    await captureErrorSnapshot({
      source: "payments",
      severity: "high",
      message: `Refund for payment ${razorpayPaymentId} (order ${orderId}) returned 2xx with NO refund id — money may have moved; parked for reconciliation, claim retained, no rollback of accounting`,
      orderId,
      razorpayPaymentId,
    }).catch(() => undefined);
    const uncertain: any = new Error(
      "The refund was sent but the gateway did not confirm an id — it is parked for reconciliation. Do not retry blindly; the same request will replay rather than refund again."
    );
    uncertain.statusCode = 409;
    uncertain.code = "REFUND_RECONCILIATION_REQUIRED";
    throw uncertain;
  }
  // Everything downstream writes this PROVEN id.
  refundResult = { ...refundResult, id: responseRefundId };

  // Update order record. refundedTotalPaise accumulates monotonically so
  // sequential partials and webhook replays converge instead of overwriting
  // (see webhookHandler refund.processed). The lease marker is cleared if still owned.
  //
  // Written INSIDE one transaction with a FRESH read (M3): a refund.processed
  // webhook can land between the claim and this write, and a plain merge-set
  // computed from the claim-time snapshot could silently DECREASE the doc's
  // scalar total below what the webhook had recorded. The fresh max(total,
  // ledgerSum) is monotonic by construction.
  //
  // refundLedger counts each gateway refund id EXACTLY ONCE (M2): autoRefund
  // and the refund.processed webhook both land for the same refund under
  // different triggers, and the gateway can also ECHO BACK an id that is
  // already in the ledger (lost-response retry of the same gateway key).
  // A replayed id adds NO new money — merging it only refreshes the map;
  // never `total + refundedPaise` again on top of an already-counted id.
  // (M3) The full-vs-partial intent marker is decided once, from the request.
  const isFullRequest = amountRupees === undefined || amountRupees === null;
  // Update order record. refundedTotalPaise accumulates monotonically so
  // sequential partials and webhook replays converge instead of overwriting —
  // see the full context above.
  const refundedTotal = await runTx(async (tx) => {
    const snap = await tx.get(orderRef);
    const fresh = ((snap && snap.exists ? snap.data() : {}) || {}) as any;
    const freshLedger: Record<string, number> =
      fresh.refundLedger && typeof fresh.refundLedger === "object" && !Array.isArray(fresh.refundLedger)
        ? { ...(fresh.refundLedger as Record<string, number>) }
        : {};
    const refundId = typeof refundResult.id === "string" ? refundResult.id : "";
    if (refundId && (Number(refundResult.amount) || 0) > 0 && freshLedger[refundId] === undefined) {
      freshLedger[refundId] = Number(refundResult.amount);
    }
    const freshScalarId = typeof fresh.refundId === "string" ? fresh.refundId : null;
    const freshScalarPaise =
      freshScalarId &&
      freshScalarId !== refundResult.id &&
      freshLedger[freshScalarId] === undefined &&
      typeof fresh.refundAmount === "number" &&
      Number.isFinite(fresh.refundAmount)
        ? Math.round(fresh.refundAmount * 100)
        : 0;
    if (freshScalarId && freshScalarPaise > 0) {
      freshLedger[freshScalarId] = freshScalarPaise;
    }
    const ledgerTotal = Object.values(freshLedger).reduce((sum, v) => sum + (Number(v) || 0), 0);
    const freshTotal = Number(fresh.refundedTotalPaise) || 0;
    const nextTotal = Math.max(freshTotal, ledgerTotal);
    // State honesty (mirrors refund.processed): the terminal "refunded" stamp
    // means the order is genuinely done, not merely "a refund happened".
    // - A FULL request (amountRupees unset) refunds the whole capture by
    //   intent — the terminal stamp applies even though the gateway echo
    //   (and in mock mode, especially) may not match the priced capture; the
    //   claim guard accepts that shape via fullIntentShape (refundAmount null).
    // - A partial request is terminal only when the cumulative total has
    //   reached the capture authority; below it records "partially_refunded"
    //   so the claim guard still allows the designed remainder refund.
    // - Unknown capture keeps the legacy "refunded" stamp (nothing to compare).
    const freshCapture =
      Number(fresh?.payment?.capturedAmountPaise) ||
      Number(fresh?.["payment.capturedAmountPaise"]) ||
      0;
    const captureAuthority =
      Number.isFinite(freshCapture) && freshCapture > 0 ? freshCapture : capturedPaise;
    const refundStatusValue =
      isFullRequest || captureAuthority === null || nextTotal >= captureAuthority
        ? "refunded"
        : "partially_refunded";

    const freshHasClaimObj =
      fresh.refundActiveClaim &&
      typeof fresh.refundActiveClaim === "object" &&
      !Array.isArray(fresh.refundActiveClaim) &&
      typeof fresh.refundActiveClaim.claimedAt === "number" &&
      Number.isFinite(fresh.refundActiveClaim.claimedAt) &&
      fresh.refundActiveClaim.claimedAt > 0;

    const freshHasClaimedAt =
      typeof fresh.refundClaimedAt === "number" &&
      Number.isFinite(fresh.refundClaimedAt) &&
      fresh.refundClaimedAt > 0;

    const freshClaim = freshHasClaimObj
      ? fresh.refundActiveClaim
      : freshHasClaimedAt
      ? {
          requestId: fresh.refundClaimedRequestId ?? null,
        }
      : null;

    // Stale completed-record transaction must NOT delete or overwrite another owner's active lease!
    const stillOwnsClaim =
      !freshClaim || (freshClaim.requestId ?? null) === (refundRequestId ?? null);

    const orderCompleteData: Record<string, any> = {
      refundAmount: amountRupees ?? null,
      refundedTotalPaise: nextTotal,
      refundLedger: freshLedger,
      refundId: refundResult.id,
      refundKeyedReceipts: {
        ...(fresh.refundKeyedReceipts || {}),
        ...(refundRequestId ? { [refundResult.id]: refundRequestId } : {}),
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (stillOwnsClaim) {
      orderCompleteData.refundStatus = refundStatusValue;
      orderCompleteData.refundClaimedAt = admin.firestore.FieldValue.delete();
      orderCompleteData.refundClaimedRequestId = admin.firestore.FieldValue.delete();
      orderCompleteData.refundClaimedPaymentId = admin.firestore.FieldValue.delete();
      orderCompleteData.refundClaimedPaise = admin.firestore.FieldValue.delete();
      orderCompleteData.refundClaimedKey = admin.firestore.FieldValue.delete();
      orderCompleteData.refundClaimedReason = admin.firestore.FieldValue.delete();
      orderCompleteData.refundActiveClaim = admin.firestore.FieldValue.delete();
    }

    tx.set(orderRef, orderCompleteData, { merge: true });
    // F7: release the held monthly fee (and count the refund) in the SAME
    // transaction as the refund record, so no recovery worker is needed. Runs
    // even on a lost-lease takeover: the money moved, and the release is
    // idempotent through releasedPaise/refundLedgeredPaise.
    applyRefundToMonthlyFee(tx, orderRef, fresh, nextTotal);

    if (reqRef && refundRequestId) {
      tx.set(
        reqRef,
        {
          orderId,
          paymentId: razorpayPaymentId,
          refundRequestId,
          requestedPaise,
          reason: reason ?? null,
          status: "completed",
          refundId: refundResult.id,
          gatewayKey,
          completedAt: Date.now(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
    // Coins are restored only when the WHOLE captured amount is back with the
    // customer. A partial refund leaves the order live, so its redeemed coins
    // stay spent (PAY-03).
    const fullyRefunded =
      isFullRequest || (captureAuthority !== null && nextTotal >= captureAuthority);
    return { nextTotal, fullyRefunded };
  });
  const refundState = refundedTotal as { nextTotal: number; fullyRefunded: boolean };
  void refundState.nextTotal;

  if (refundState.fullyRefunded) {
    try {
      const { restoreRedeemedCoins } = await import("../customers/customerCoins");
      await restoreRedeemedCoins({
        orderId,
        razorpayOrderId:
          (typeof order?.payment?.razorpayOrderId === "string"
            ? order.payment.razorpayOrderId
            : typeof order?.["payment.razorpayOrderId"] === "string"
              ? order["payment.razorpayOrderId"]
              : undefined) || undefined,
      });
    } catch (err: any) {
      // A coin-restore failure must never fail (or retry) a completed refund.
      console.warn(
        `[Payments] coin restore failed after full refund for order ${orderId}:`,
        err?.message || err
      );
      await captureErrorSnapshot({
        source: "payments",
        severity: "high",
        message: `Grill-Coins restore failed after full refund for order ${orderId} — remediate via adjustCustomerCoins`,
        orderId,
        razorpayPaymentId,
        errorStack: err?.stack,
      }).catch(() => undefined);
    }
  }

  // Append audit trail
  const auditId = `aud_rfnd_${Date.now()}_${refundResult.id}`;
  await db.collection("payment_audits").doc(auditId).set({
    orderId,
    razorpayPaymentId,
    refundId: refundResult.id,
    amountRupees: amountRupees ?? null,
    action: "refund_processed",
    reason: reason ?? null,
    refundRequestId: refundRequestId ?? null,
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
      refundRequestId: refundRequestId ?? null,
    },
  });

  return refundResult;
}
