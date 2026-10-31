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
} from "./reconciliation";
import { assertOrderBranchAccess } from "../../core/middleware";
import { calculateOrderPricing, CalculateOrderPricingInput } from "./pricing.engine";
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
 * PAYMENTS_CONTRACT_SPEC §1 gate: the internal orders/{orderId} doc must
 * EXIST, be UNPAID, and belong to the CALLER before any payable gateway
 * order is minted. 404 for an unknown id, 409 for paid/foreign orders, 503
 * when the check itself is unavailable (fail closed — a checkout that cannot
 * prove ownership never opens).
 *
 * Returns the persisted doc: the caller binds the payable basket to what is
 * STORED on this order (see bindBasketToStoredOrder), because the KOT builder
 * fulfills `orders/{orderId}.items` — not the request body.
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

  const requestBranchId = await resolveBranchId(params);

  // PAYMENTS_CONTRACT_SPEC §1: the internal order doc must exist, be unpaid,
  // and belong to the caller BEFORE anything else (fail fast ahead of balance
  // lookups, idempotent reuse, and — critically — the gateway order mint).
  // The persisted doc is returned so the payable basket can be bound to it
  // (the kitchen fulfills orders/{orderId}.items, never the request body).
  const storedOrder = params.orderId
    ? await assertPayableOrderDoc(params.orderId, params.customerId)
    : null;

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
    // The binding refusal is decided OUTSIDE the lookup try/catch: a mismatch
    // is a proven 409, not an unavailable-service 503.
    let reusableIntent: any = null;
    let corruptIntent = false;
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

  // P1 basket binding: price the PERSISTED basket (items/branch/fulfillment)
  // — the exact lines the KOT builder will send to the kitchen — or refuse a
  // request that describes a different basket. Runs after the idempotent
  // reuse fast-path (a live intent already carries the server-priced total
  // for this order) and BEFORE pricing, the intent lease, and the mint, so a
  // mismatch can never open a gateway order.
  const boundBasket = bindBasketToStoredOrder({
    storedOrder,
    requestItems: params.items,
    requestBranchId,
    requestOrderType: params.orderType,
  });
  const branchId = boundBasket.branchId;
  const orderType = boundBasket.orderType;

  const pricing = await calculateOrderPricing({
    items: boundBasket.items,
    branchId,
    orderType,
    deliveryFee: params.deliveryFee,
    packagingFee: params.packagingFee,
    couponCode: params.couponCode,
    loyaltyPointsToRedeem,
  });

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
    razorpayOrderId = `order_mock_${Date.now()}`;
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
      // Branch/orderType ride along so a verify that finds no orders/{orderId}
      // doc (legacy client verifying before creating it) can rebuild the doc
      // from SERVER-owned data only (spec §2 ghost-order guard).
      branchId,
      orderType,
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
        if (resolution.kind === "reuse") return reusedIntentResponse(resolution.intent);
        if (resolution.kind === "superseded") {
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
  // gateway order to the internal orderId + server-priced amount. Missing or
  // mismatched intents degrade to the order-doc path below — and a missing
  // order doc WITHOUT an intent is refused as a ghost (404).
  const intent = await loadPaymentIntent(razorpayOrderId);
  let orderId = params.orderId || "";
  if (!orderId) {
    // Legacy shape: no internal id supplied — resolve it through the intent.
    orderId = typeof intent?.orderId === "string" ? intent.orderId : "";
    if (!orderId || !isSafeDocId(orderId)) {
      const ghost: any = new Error(
        "No payment intent found for this gateway order — refusing to verify a ghost order"
      );
      ghost.statusCode = 404;
      ghost.code = "ORDER_NOT_FOUND";
      throw ghost;
    }
  } else if (
    intent &&
    typeof intent.orderId === "string" &&
    intent.orderId &&
    intent.orderId !== orderId
  ) {
    // The payment intent is bound to a DIFFERENT internal order — never
    // confirm this one with that payment.
    const bound: any = new Error(
      "This payment belongs to a different order — verification refused. Contact support if money left your account."
    );
    bound.statusCode = 409;
    bound.code = "ORDER_MISMATCH";
    throw bound;
  }

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

  // Live gateway truth check (fail-closed on money mismatch, no auto-capture).
  // Expected paise = the stored server-priced total when the order doc has
  // one, else the SERVER-priced intent amount (spec §2: amount must match the
  // intent). Legacy docs with neither keep the legacy path — the HMAC
  // signature above still binds payment↔order, and the transfer claim below
  // still serializes payouts. Mock mode has no gateway truth to fetch, so it
  // keeps its short-circuit.
  const storedGrandTotal = Number(
    (orderData.pricing as any)?.grandTotal ?? (orderData.totals as any)?.grandTotal
  );
  const hasStoredTotal =
    Number.isFinite(storedGrandTotal) && storedGrandTotal > 0;
  const intentPaiseRaw = Number(intent?.amountPaise);
  const intentPaise =
    Number.isFinite(intentPaiseRaw) && intentPaiseRaw > 0 ? intentPaiseRaw : null;
  const expectedPaise = hasStoredTotal ? Math.round(storedGrandTotal * 100) : intentPaise;
  let capturedAmountPaise: number | undefined;
  if (!config.mock.paymentGateway && expectedPaise !== null) {
    capturedAmountPaise = await assertLivePaymentMatchesOrder({
      orderRef,
      orderId,
      orderData,
      razorpayOrderId,
      razorpayPaymentId,
      expectedPaise,
    });
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
  const finished = await finishVerifiedPayment({
    orderRef,
    orderData,
    orderId,
    razorpayOrderId,
    razorpayPaymentId,
    transferResult,
    capturedAmountPaise,
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
  const splitPaise = Number(pricingSplit?.branchTransferPaise);
  if (!Number.isFinite(splitPaise) || splitPaise <= 0) {
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
      return {
        state: "flagged",
        error: `Refused route transfer: order is ${termCheck.orderStatus} (${termCheck.reason})`,
      };
    }
  }

  const attempt = await attemptRouteTransfer(
    razorpayPaymentId,
    branchId,
    pricingSplit,
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
        // CANONICAL nested payment map (the queryable shape). The refund.processed
        // webhook looks orders up by `where("payment.razorpayPaymentId", …)`,
        // i.e. the NESTED path — the dotted literal written here used to be a
        // top-level field named "payment.razorpayPaymentId", invisible to that
        // query, so every refund for an app-verified order parked unmatched.
        payment: {
          status: "completed",
          razorpayPaymentId,
          razorpayOrderId,
          verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
          ...(capturedPaiseStamp !== undefined
            ? { capturedAmountPaise: capturedPaiseStamp }
            : {}),
        },
        // Legacy dotted aliases kept during migration: both-shape readers in
        // the apps and older functions read the literal form directly.
        "payment.status": "completed",
        "payment.razorpayPaymentId": razorpayPaymentId,
        "payment.razorpayOrderId": razorpayOrderId,
        "payment.verifiedAt": admin.firestore.FieldValue.serverTimestamp(),
        ...(capturedPaiseStamp !== undefined
          ? { "payment.capturedAmountPaise": capturedPaiseStamp }
          : {}),
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

  if (txOutcome.conflict) {
    return {
      conflict: true,
      success: false,
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
    // transaction, so no claim-time ledger snapshot is needed here.
    return { existingTotal, gatewayKey: gatewayKeyToUse };
  });
  if ((claimed as any).replay) return (claimed as any).replay;
  const gatewayKey = (claimed as any).gatewayKey;

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
      getRazorpayClient();
      refundResult = await postRefundWithIdempotency(
        razorpayPaymentId,
        refundPayload,
        gatewayKey
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
    return nextTotal;
  });
  void refundedTotal;

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
