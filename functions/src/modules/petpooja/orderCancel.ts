import { db } from "../../core/firebase";
import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import { getPetpoojaConfig, isPetpoojaEnabled } from "./client";
import {
  buildPosCancelRequestBody,
  posCancelReasonText,
  readPosCancelAck,
  PETPOOJA_CANCEL_REASON_MAX_CHARS,
  type PosCancelAck,
} from "./cancelPayload";
import {
  PETPOOJA_MAX_RETRY_ATTEMPTS,
  petpoojaRetryScheduledAtMs,
} from "./retryBackoff";
import { dispatchFCM } from "../notifications/fcm.service";
import { processPendingPosCancelSideEffects } from "./cancelSideEffectsObligation";
import { loadBranchSecrets } from "../branches/branchSecrets";

/**
 * Petpooja "Update Order Status" — the CANCEL half of the POS bridge.
 *
 * WHY THIS MODULE EXISTS (audit 2026-11-20, pos-crm.md "Update Order Status
 * (cancel only)"): the vendor API was proven against the sandbox on 2026-11-20
 * (HTTP 200, success:"1", status:"-1" echoed — `petpooja-sandbox-20261120/
 * logs/02-update-order-status.json`), but NOTHING in the app called it. A
 * customer who cancelled was refunded while the POS kept the order live in the
 * kitchen queue: the kitchen cooked food nobody would collect, and staff
 * discovered it at the till. That is a real food-waste and money path.
 *
 * THE SINGLE ENTRY POINT. Every order cancellation in this backend commits its
 * status through `applyCancelSideEffects` (modules/orders/cancelSideEffects.ts):
 *   - the customer's own cancel  — `cancelOrderAsCustomer` (F24),
 *   - a staff cancel from the KDS — `bumpOrderStatus({status:"cancelled"})`,
 *   - a payment that never completed — `expireAbandonedUnpaidOrders` calls the
 *     same `bumpOrderStatus` with `onlyIfUnpaid`, so a capture-after-expiry
 *     cancel arrives here too.
 * The funnel calls `requestPetpoojaOrderCancel`, so no cancellation source can
 * silently skip the POS. A new cancel path that bypasses the funnel is a bug;
 * the funnel is the contract.
 *
 * EXACTLY-ONCE, AND NEVER FOR A NEVER-PUSHED ORDER:
 *   - eligibility is decided from POS FACTS on the order (`petpoojaOrderId`,
 *     `petpoojaAcceptedNoId`, `petpoojaStatus`). An order with no POS history is
 *     recorded `not_pushed` and NO request is ever made. `pending_retry` /
 *     `failed` / `blocked_configuration` rows are also refused: those states
 *     mean the KOT provably never reached the POS (a proven rejection or a
 *     pre-POST failure), and the retry worker retires a closed row without a
 *     POST (Astra F3 in orderPush.ts).
 *   - one transactional lease (`petpoojaCancelClaimedAt`, 10 minutes — the same
 *     TTL the KOT claim uses) means overlapping scheduler instances cannot both
 *     send. The recorded outcome (`cancelled`) is terminal, so a replay of the
 *     same cancellation sends nothing.
 *   - a retried cancel is SAFE, unlike a retried KOT. `update_order_status` with
 *     status "-1" is idempotent at the vendor: the second call re-cancels the
 *     same order. A KOT retry can ring the kitchen twice; a cancel retry
 *     cannot. That is why an AMBIGUOUS outcome (timeout, truncated body, 5xx)
 *     is retried here instead of being parked for reconciliation the way the
 *     KOT push is.
 *
 * RETRY / DEAD-LETTER — the SAME budget as the KOT push (`retryBackoff.ts`,
 * 5/10/20/40 minutes, 4 automatic retries). A cancel that cannot be delivered
 * is never dropped silently: it dead-letters to `failed` with `kotCancelFailed`
 * on the order, an error snapshot and an FCM alert to the branch, telling staff
 * to cancel it at the till by hand.
 *
 * DISABLED BRIDGE: `PETPOOJA_ENABLED=false` sends nothing. The intent is still
 * recorded (`pending`) so a cancellation that happens during a disabled window
 * is queued and resumes when the flag is re-enabled — a refunded customer must
 * not leave a phantom order in the POS because of an ops flag.
 */

/** How long a cancel lease blocks another instance (mirrors the KOT claim). */
export const PETPOOJA_CANCEL_CLAIM_TTL_MS = 10 * 60 * 1000;

/** Vendor `cancelReason` is free text; keep it short and PII-free. */
export { PETPOOJA_CANCEL_REASON_MAX_CHARS };

/**
 * Lanes the retry worker scans (equality-only: no composite index needed).
 *
 * P1: `processing` is a LEASED obligation, not a terminal state. A crash after
 * `claimCancelAttempt` but before the result is persisted leaves the order here;
 * the worker must scan it so an EXPIRED lease can be reclaimed. `claimCancelAttempt`
 * defers while the lease is live and takes it over once stale.
 */
export const PETPOOJA_CANCEL_OPEN_STATUSES = ["pending", "pending_retry", "processing"] as const;

/** Rows per lane per tick — the same bound the KOT retry worker uses. */
const CANCEL_SCAN_LIMIT = 100;

/**
 * Recorded states. `cancelled` / `not_pushed` / `failed` /
 * `blocked_configuration` are terminal: nothing is ever sent again.
 */
export type PosCancelStatus =
  | "pending"
  | "processing"
  | "pending_retry"
  | "cancelled"
  | "not_pushed"
  | "failed"
  | "blocked_configuration";

/** What one call to `requestPetpoojaOrderCancel` achieved. */
export type PosCancelOutcome =
  | "cancelled"
  | "already_cancelled"
  | "pending_retry"
  | "deferred"
  | "busy"
  | "not_pushed"
  | "failed"
  | "blocked_configuration"
  | "disabled"
  | "missing"
  | "unsupported"
  | "not_cancelled";

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "cancelled",
  "not_pushed",
  "failed",
  "blocked_configuration",
]);

/** Numeric-first read: a serverTimestamp sentinel must not read as 0. */
function numberField(raw: any): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (raw && typeof raw.toMillis === "function") {
    const ms = Number(raw.toMillis());
    return Number.isFinite(ms) ? ms : 0;
  }
  if (raw && typeof raw === "object" && typeof raw.seconds === "number") {
    const ms = Number(raw.seconds) * 1000;
    return Number.isFinite(ms) ? ms : 0;
  }
  return 0;
}

/** The status string on an order (legacy docs store it as a plain string). */
function orderStatusCode(order: any): string {
  const raw =
    typeof order?.status === "object" && order?.status !== null
      ? order.status.code
      : order?.status;
  return String(raw ?? "").trim().toUpperCase();
}

/**
 * True when this order can be shown to exist at the POS. This is the ONLY gate
 * that permits a vendor call, so it is deliberately narrow: an acceptance
 * marker, an id-less acceptance, or a parked ambiguity (the POS may hold it).
 *
 * `processing` (a push in flight) is handled separately — it DEFERS, because
 * the KOT may be registered microseconds after this read.
 */
export function isPosCancelEligible(order: any): boolean {
  if (order?.petpoojaOrderId) return true;
  if (order?.petpoojaAcceptedNoId === true) return true;
  const status = String(order?.petpoojaStatus || "");
  if (status === "synced" || status === "accepted_unconfirmed") return true;
  // The POS may hold a ticket whose acknowledgement we could not persist.
  if (status === "reconciliation_required") return true;
  if (order?.petpoojaAmbiguousProcessing === true) return true;
  return false;
}

/** Why an ineligible order must not be cancelled at the POS (audit copy). */
export function posCancelIneligibilityReason(order: any): string {
  const status = String(order?.petpoojaStatus || "(none)");
  if (status === "pending_retry") {
    return "KOT push never reached the POS (pending_retry) — the retry worker retires a closed order without a POST";
  }
  if (status === "failed" || order?.kotSyncFailed === true) {
    return "KOT push dead-lettered — the POS never received this order";
  }
  if (status === "blocked_configuration") {
    return "KOT push was blocked on configuration — the POS never received this order";
  }
  if (status === "not_applicable") {
    // A retired row is still "no recorded acceptance" — keep the audit prefix
    // that every skip reason shares so log searches find all of them, and add
    // the specific cause after it.
    return "no recorded POS acceptance — order was retired as never-sent (not_applicable)";
  }
  return `no recorded POS acceptance (petpoojaStatus=${status})`;
}

/** True while another sender holds the KOT push lease. */
function pushClaimIsLive(order: any, nowMs: number): boolean {
  const claimedAt = numberField(order?.petpoojaPushClaimedAt);
  return claimedAt > 0 && nowMs - claimedAt < PETPOOJA_CANCEL_CLAIM_TTL_MS;
}

export type PosCancelDecision =
  | { kind: "send"; posOrderId: string }
  | { kind: "defer"; reason: string }
  | { kind: "skip"; reason: string };

/**
 * Decide what to do for this order RIGHT NOW, from a fresh snapshot.
 *
 * `defer` is the race guard: a KOT push that already owns the lease will write
 * an acceptance when it returns, and cancelling before that write would leave a
 * live order in the POS. The intent is parked as `pending` and the 5-minute
 * worker re-decides once the push has settled.
 */
export function planPetpoojaOrderCancel(
  order: any,
  nowMs: number = Date.now()
): PosCancelDecision {
  // DEFER FIRST, BEFORE ELIGIBILITY. A push that is still in flight has not
  // written its POS fact yet, so this snapshot cannot prove the order is
  // absent from the POS — judging it ineligible here would record `not_pushed`
  // and race the acceptance write, leaving a live order in the kitchen.
  if (String(order?.petpoojaStatus || "") === "processing") {
    return { kind: "defer", reason: "KOT push in flight (petpoojaStatus=processing)" };
  }
  if (pushClaimIsLive(order, nowMs)) {
    return { kind: "defer", reason: "KOT push lease is live" };
  }
  if (!isPosCancelEligible(order)) {
    return { kind: "skip", reason: posCancelIneligibilityReason(order) };
  }
  return { kind: "send", posOrderId: String(order?.petpoojaOrderId || "") };
}

// `posCancelReasonText`, `readPosCancelAck` and the request-body builder live in
// ./cancelPayload.ts — a dependency-free module that the sandbox probe compiles
// and posts from, so the proof sends the same bytes this module sends.
export { posCancelReasonText, readPosCancelAck, buildPosCancelRequestBody } from "./cancelPayload";
export type { PosCancelAck } from "./cancelPayload";

class PosCancelBlockedConfigurationError extends Error {
  readonly petpoojaCancelBlockedConfiguration = true;
  constructor(message: string) {
    super(message);
    this.name = "PosCancelBlockedConfigurationError";
  }
}

/**
 * One vendor POST. Throws on every non-success; the caller classifies.
 *
 * Body shape is the one proven in the sandbox on 2026-11-20:
 * `{app_key, app_secret, access_token, restID, orderID, clientorderID,
 *   cancelReason, status:"-1"}` against
 * `https://qle1yy2ydc.execute-api.ap-southeast-1.amazonaws.com/V1/update_order_status`.
 * `orderID` is "" when the vendor issued none (the sandbox's normal answer);
 * `clientorderID` is OUR order id, which is what the POS echoes back.
 */
async function postPosCancel(
  orderId: string,
  order: any,
  reason?: string
): Promise<PosCancelAck> {
  const branchId = typeof order?.branchId === "string" ? order.branchId : "";
  if (!branchId) {
    throw new PosCancelBlockedConfigurationError(
      `Order ${orderId} has no branchId — cannot resolve the Petpooja outlet for the cancel`
    );
  }
  // SEC-11: the outlet binding lives in `branch_secrets/{branchId}` (brand-only
  // rules); `branches` is the legacy fallback until the migration is applied.
  const secrets = await loadBranchSecrets(branchId);
  let restId = secrets.petpoojaStoreId;
  if (!restId) {
    const branchSnap = await db.collection("branches").doc(branchId).get();
    restId = branchSnap.exists
      ? ((branchSnap.data() as any)?.petpoojaStoreId as string | undefined) || ""
      : "";
  }
  if (!restId) {
    // Fail closed and loud: cancelling at the wrong outlet (or at a guessed
    // one) would close somebody else's order. Not retryable — the mapping is
    // an ops task.
    throw new PosCancelBlockedConfigurationError(
      `Branch ${branchId} has no linked Petpooja outlet (branch_secrets.petpoojaStoreId) — cannot cancel order ${orderId} at the POS`
    );
  }

  const config = getPetpoojaConfig();
  const response = await fetch(config.cancelUrl, {
    method: "POST",
    // A hung gateway must not hold the function until the platform timeout.
    signal: AbortSignal.timeout(15_000),
    headers: {
      "Content-Type": "application/json",
      "Content-Type-Override": "application/json",
      // Same dual header set the proven save_order call sends.
      "app-key": config.appKey,
      "app-secret": config.appSecret,
      "access-token": config.accessToken,
      Content_key: config.appKey,
      Authorization: `Bearer ${config.accessToken}`,
    },
    body: JSON.stringify(
      buildPosCancelRequestBody({
        orderId,
        posOrderId: order?.petpoojaOrderId || "",
        restId,
        reason,
        credentials: {
          appKey: config.appKey,
          appSecret: config.appSecret,
          accessToken: config.accessToken,
        },
      })
    ),
  });

  if (!response.ok) {
    throw new Error(`Petpooja cancel HTTP ${response.status ?? "(no status)"}`);
  }
  let body: any;
  try {
    body = await response.json();
  } catch (err: any) {
    // A cancel retry is safe (see the header), so an unreadable body is a
    // retryable failure rather than a reconciliation park.
    throw new Error(
      `Petpooja cancel answered HTTP ${response.status ?? 200} with an unreadable body (${err?.message || err})`
    );
  }
  const ack = readPosCancelAck(body);
  if (!ack.ok) {
    throw new Error(`Petpooja cancel refused: ${ack.message}`.slice(0, 300));
  }
  return ack;
}

function cancelReasonClass(reason?: string): string {
  if (reason === "staff_cancelled" || reason === "payment_not_completed") return reason;
  return "order_cancelled";
}

function intentPatch(reason: string | undefined, requestedBy: string, nowMs: number) {
  return {
    petpoojaCancelStatus: "pending",
    petpoojaCancelReason: posCancelReasonText(reason),
    // The CLASS is persisted so a retry reproduces the identical vendor text
    // instead of degrading every retry to the default wording.
    petpoojaCancelReasonClass: cancelReasonClass(reason),
    petpoojaCancelRequestedBy: String(requestedBy || "").slice(0, 120),
    petpoojaCancelRequestedAtMs: nowMs,
    petpoojaCancelRequestedAt: admin.firestore.FieldValue.serverTimestamp(),
    petpoojaCancelNextRetryAtMs: null,
    petpoojaCancelClaimedAt: null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

/**
 * r2 P1: the SAME intent patch is written inside each cancellation transaction
 * (orderStatus / customerCancel) so a crash before the first claim still leaves
 * a durable, server-owned obligation for this worker.
 */
export function posCancelIntentPatch(
  reason: string | undefined,
  requestedBy: string,
  nowMs: number = Date.now()
): Record<string, any> {
  return intentPatch(reason, requestedBy, nowMs);
}

function notPushedPatch(reason: string) {
  return {
    petpoojaCancelStatus: "not_pushed",
    petpoojaCancelSkippedReason: reason.slice(0, 300),
    petpoojaCancelClaimedAt: null,
    petpoojaCancelNextRetryAtMs: null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

function cancelledPatch(ack: PosCancelAck) {
  return {
    petpoojaCancelStatus: "cancelled",
    petpoojaCancelCompletedAt: admin.firestore.FieldValue.serverTimestamp(),
    petpoojaCancelAckMessage: ack.message.slice(0, 200),
    petpoojaCancelPosOrderId: ack.posOrderId || null,
    petpoojaCancelClaimedAt: null,
    petpoojaCancelNextRetryAtMs: null,
    lastPetpoojaCancelError: null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

/**
 * P1: persist a provider acknowledgement ONLY while the caller still owns the
 * lease it claimed. An interrupt/overlap can let another instance take over a
 * stale `processing` lease and send its own cancel; a late success from the old
 * instance must not clobber that newer state. Mirrors `recordCancelFailure`.
 */
export async function recordPosCancelSuccessIfOwned(
  orderId: string,
  ack: PosCancelAck,
  claimedAtMs: number
): Promise<"recorded" | "skipped"> {
  const ref = db.collection("orders").doc(orderId);
  if (!db || typeof (db as any).runTransaction !== "function") {
    // Fail closed: a plain write could overwrite a newer claim.
    return "skipped";
  }
  try {
    return await (db as any).runTransaction(async (tx: any) => {
      const snap = await tx.get(ref);
      const order = (snap.exists ? snap.data() : undefined) as any;
      if (!order) return "skipped" as const;
      if (String(order.petpoojaCancelStatus || "") !== "processing") return "skipped" as const;
      if (numberField(order.petpoojaCancelClaimedAt) !== claimedAtMs) return "skipped" as const;
      tx.set(ref, cancelledPatch(ack), { merge: true });
      return "recorded" as const;
    });
  } catch (err: any) {
    logger.warn(
      `[Petpooja Cancel] acknowledged write failed for order ${orderId}:`,
      err?.message || err
    );
    return "skipped";
  }
}

type ClaimResult =
  | { state: "claimed"; order: any; claimedAtMs: number }
  | { state: "not_cancelled" }
  | { state: "already"; outcome: PosCancelOutcome }
  | { state: "not_pushed"; reason: string }
  | { state: "deferred"; reason: string }
  | { state: "not_due" }
  | { state: "busy" }
  | { state: "missing" }
  | { state: "unsupported" };

/**
 * Take the cancel lease, atomically, only if a send is still warranted.
 *
 * All reads precede the write inside the transaction (real Firestore rejects a
 * read after a write). Without `runTransaction` we FAIL CLOSED: no POST and no
 * mutation, because a plain read-then-send could stack a second cancel on top
 * of a live one.
 */
async function claimCancelAttempt(
  orderId: string,
  reason: string | undefined,
  requestedBy: string
): Promise<ClaimResult> {
  const ref = db.collection("orders").doc(orderId);
  if (!db || typeof (db as any).runTransaction !== "function") return { state: "unsupported" };
  try {
    return await (db as any).runTransaction(async (tx: any): Promise<ClaimResult> => {
      const snap = await tx.get(ref);
      const order = (snap.exists ? snap.data() : undefined) as any;
      if (!order) return { state: "missing" };

      // r2 P1: the vendor may only be contacted for an order whose cancellation
      // is ALREADY durable. Check inside the claim transaction so a stale read
      // cannot send a cancel for a live order.
      if (orderStatusCode(order) !== "CANCELLED") return { state: "not_cancelled" };

      const status = String(order.petpoojaCancelStatus || "");
      if (status === "cancelled") return { state: "already", outcome: "already_cancelled" };
      if (status === "not_pushed") return { state: "already", outcome: "not_pushed" };
      if (status === "failed") return { state: "already", outcome: "failed" };
      if (status === "blocked_configuration") {
        return { state: "already", outcome: "blocked_configuration" };
      }

      const nowMs = Date.now();
      // A retry already on the shared backoff is the WORKER's to send: a client
      // that retries the cancel endpoint must not burn the budget in seconds.
      if (status === "pending_retry") {
        const scheduledAt = numberField(order.petpoojaCancelNextRetryAtMs);
        if (scheduledAt > nowMs) return { state: "not_due" };
      }
      if (status === "processing") {
        const claimedAt = numberField(order.petpoojaCancelClaimedAt);
        if (claimedAt > 0 && nowMs - claimedAt < PETPOOJA_CANCEL_CLAIM_TTL_MS) {
          return { state: "busy" };
        }
        // Stale lease (crashed worker): take it over below.
      }

      const decision = planPetpoojaOrderCancel(order, nowMs);
      if (decision.kind === "skip") {
        tx.set(ref, notPushedPatch(decision.reason), { merge: true });
        return { state: "not_pushed", reason: decision.reason };
      }
      if (decision.kind === "defer") {
        // Park the intent; the worker re-decides once the push has settled.
        if (status !== "pending" && status !== "pending_retry") {
          tx.set(ref, intentPatch(reason, requestedBy, nowMs), { merge: true });
        }
        return { state: "deferred", reason: decision.reason };
      }

      const patch: Record<string, any> = {
        petpoojaCancelStatus: "processing",
        petpoojaCancelClaimedAt: nowMs,
        petpoojaCancelReason: posCancelReasonText(reason),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      // A first attempt records the intent; a retry keeps its budget.
      if (status !== "pending" && status !== "pending_retry" && status !== "processing") {
        patch.petpoojaCancelRequestedBy = String(requestedBy || "").slice(0, 120);
        patch.petpoojaCancelRequestedAtMs = nowMs;
        patch.petpoojaCancelRequestedAt = admin.firestore.FieldValue.serverTimestamp();
      }
      tx.set(ref, patch, { merge: true });
      return { state: "claimed", order, claimedAtMs: nowMs };
    });
  } catch (err: any) {
    logger.warn(
      `[Petpooja Cancel] claim transaction failed for order ${orderId} — no cancel sent:`,
      err?.message || err
    );
    return { state: "unsupported" };
  }
}

/** Commit a failure against OUR lease only. Returns the recorded lane. */
async function recordCancelFailure(
  orderId: string,
  err: any,
  claimedAtMs: number
): Promise<"retry" | "failed" | "blocked_configuration" | "skipped"> {
  const ref = db.collection("orders").doc(orderId);
  const blocked = err?.petpoojaCancelBlockedConfiguration === true;
  if (!db || typeof (db as any).runTransaction !== "function") {
    // Fail closed: a plain write could clobber a newer state (another instance
    // finished the cancel, an operator resolved it). The lease expires on its
    // own and the worker retries.
    logger.warn(
      `[Petpooja Cancel] no transaction support — leaving order ${orderId} on its expired lease`
    );
    return "skipped";
  }
  try {
    return await (db as any).runTransaction(async (tx: any) => {
      const snap = await tx.get(ref);
      const order = (snap.exists ? snap.data() : undefined) as any;
      if (!order) return "skipped" as const;
      if (String(order.petpoojaCancelStatus || "") !== "processing") return "skipped" as const;
      if (numberField(order.petpoojaCancelClaimedAt) !== claimedAtMs) return "skipped" as const;

      const attempts = Number(order.petpoojaCancelAttemptCount || 0) + 1;
      const lastError = String(err?.message || err).slice(0, 300);

      if (blocked) {
        tx.set(
          ref,
          {
            petpoojaCancelStatus: "blocked_configuration",
            petpoojaCancelAttemptCount: attempts,
            lastPetpoojaCancelError: lastError,
            petpoojaCancelClaimedAt: null,
            petpoojaCancelNextRetryAtMs: null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        return "blocked_configuration" as const;
      }

      if (attempts > PETPOOJA_MAX_RETRY_ATTEMPTS) {
        tx.set(
          ref,
          {
            petpoojaCancelStatus: "failed",
            // Staff-visible: the POS still shows this order as live.
            kotCancelFailed: true,
            petpoojaCancelAttemptCount: attempts,
            lastPetpoojaCancelError: lastError,
            petpoojaCancelClaimedAt: null,
            petpoojaCancelNextRetryAtMs: null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        return "failed" as const;
      }

      tx.set(
        ref,
        {
          petpoojaCancelStatus: "pending_retry",
          petpoojaCancelAttemptCount: attempts,
          // Same 5/10/20/40-minute curve as the KOT push.
          petpoojaCancelNextRetryAtMs: petpoojaRetryScheduledAtMs(attempts),
          lastPetpoojaCancelError: lastError,
          petpoojaCancelClaimedAt: null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      return "retry" as const;
    });
  } catch (txErr: any) {
    logger.warn(
      `[Petpooja Cancel] failure write failed for order ${orderId}:`,
      txErr?.message || txErr
    );
    return "skipped";
  }
}

/** Page the branch: the POS still has this order and a human must close it. */
async function alertCancelUndelivered(orderId: string, branchId: string, detail: string) {
  try {
    const { captureErrorSnapshot } = await import("../../core/errors");
    await captureErrorSnapshot({
      source: "petpooja",
      severity: "high",
      message: `POS cancel could not be delivered for order ${orderId} — cancel it at the till by hand (${detail})`,
      orderId,
      branchId,
    });
  } catch {
    // Snapshotting is best-effort; the branch alert below is the loud one.
  }
  if (!branchId) return;
  try {
    await dispatchFCM({
      topic: `branch_${branchId}_orders`,
      title: "Cancel this order in Petpooja",
      body: `Order #${orderId.substring(0, 6)} was cancelled but the POS cancel failed. Remove it at the till so the kitchen stops cooking it.`,
      data: { type: "kot_cancel_failed", orderId },
      purpose: "operational",
      actor: { trusted: true },
    });
  } catch (err: any) {
    logger.warn("[Petpooja Cancel] branch alert failed:", err?.message || err);
  }
}

export interface RequestPosCancelInput {
  orderId: string;
  /** `order_cancelled` | `staff_cancelled` | `payment_not_completed`. */
  reason?: string;
  /** Audit only — NEVER sent to the vendor. */
  requestedBy?: string;
}

/**
 * The funnel entry. NEVER throws: the cancellation is already durable when this
 * runs, and a POS fault must surface as an alert, not as a failed cancel.
 */
export async function requestPetpoojaOrderCancel(
  input: RequestPosCancelInput
): Promise<PosCancelOutcome> {
  const orderId = String(input?.orderId || "").trim();
  if (!orderId) return "missing";
  const reason = input?.reason;
  const requestedBy = String(input?.requestedBy || "system");

  // DISABLED BRIDGE: record the intent, send nothing. The retry worker is a
  // no-op while the flag is off, so the queued cancel resumes untouched when
  // ops re-enables the integration.
  if (!isPetpoojaEnabled()) {
    try {
      const snap = await db.collection("orders").doc(orderId).get();
      const order = (snap.exists ? snap.data() : undefined) as any;
      // r2 P1: even the queued-intent path refuses a live order.
      if (
        order &&
        orderStatusCode(order) === "CANCELLED" &&
        !TERMINAL_STATUSES.has(String(order.petpoojaCancelStatus || ""))
      ) {
        await db
          .collection("orders")
          .doc(orderId)
          .set(intentPatch(reason, requestedBy, Date.now()), { merge: true });
      }
    } catch (err: any) {
      logger.warn(
        `[Petpooja Cancel] could not record the cancel intent for ${orderId} while the bridge is disabled:`,
        err?.message || err
      );
    }
    return "disabled";
  }

  try {
    const claim = await claimCancelAttempt(orderId, reason, requestedBy);
    if (claim.state === "missing") return "missing";
    if (claim.state === "not_cancelled") return "not_cancelled";
    if (claim.state === "unsupported") return "unsupported";
    if (claim.state === "busy") return "busy";
    if (claim.state === "not_due") return "pending_retry";
    if (claim.state === "already") return claim.outcome;
    if (claim.state === "not_pushed") return "not_pushed";
    if (claim.state === "deferred") return "deferred";

    const branchId = typeof claim.order?.branchId === "string" ? claim.order.branchId : "";
    try {
      const ack = await postPosCancel(orderId, claim.order, reason);
      // P1: write the result only if we STILL own the lease we claimed. The
      // vendor cancel is idempotent, so another instance taking over is safe;
      // clobbering its newer state with our late ack is not.
      const recorded = await recordPosCancelSuccessIfOwned(orderId, ack, claim.claimedAtMs);
      if (recorded !== "recorded") {
        logger.warn(
          `[Petpooja Cancel] ack for ${orderId} was not recorded — the lease moved on; no state overwritten`
        );
        return "busy";
      }
      logger.info(
        `[Petpooja Cancel] Order ${orderId} cancelled at the POS (${ack.message || "acknowledged"})`
      );
      return "cancelled";
    } catch (err: any) {
      const recorded = await recordCancelFailure(orderId, err, claim.claimedAtMs);
      if (recorded === "failed" || recorded === "blocked_configuration") {
        await alertCancelUndelivered(orderId, branchId, err?.message || String(err));
        return recorded;
      }
      if (recorded === "retry") {
        logger.warn(
          `[Petpooja Cancel] Order ${orderId} cancel failed, scheduled for retry:`,
          err?.message || err
        );
        return "pending_retry";
      }
      return "pending_retry";
    }
  } catch (err: any) {
    logger.warn(
      `[Petpooja Cancel] unexpected fault cancelling order ${orderId} at the POS:`,
      err?.message || err
    );
    return "failed";
  }
}

/** `petpoojaCancelNextRetryAtMs` as a number (absent ⇒ due now). */
function cancelNextRetryAtMsOf(order: any): number {
  return numberField(order?.petpoojaCancelNextRetryAtMs);
}

function cancelRetryDue(order: any, nowMs: number): boolean {
  const scheduledAt = cancelNextRetryAtMsOf(order);
  return scheduledAt <= 0 || scheduledAt <= nowMs;
}

/**
 * Dead-letter a row whose budget is spent. Transactional re-check: the scan
 * snapshot can be minutes old, and a cancel that landed meanwhile must not be
 * relabelled `failed` (which would page staff for nothing).
 */
async function deadLetterExhaustedCancel(doc: any): Promise<boolean> {
  const ref = doc.ref || db.collection("orders").doc(doc.id);
  if (!db || typeof (db as any).runTransaction !== "function") return false;
  let wrote = false;
  let branchId = "";
  try {
    await (db as any).runTransaction(async (tx: any) => {
      const snap = await tx.get(ref);
      const order = (snap.exists ? snap.data() : undefined) as any;
      if (!order) return;
      const status = String(order.petpoojaCancelStatus || "");
      const isProcessing = status === "processing";
      if (status !== "pending" && status !== "pending_retry" && !isProcessing) return;
      if (isProcessing) {
        // P1: a leased row is dead-lettered only once its lease has EXPIRED.
        // A live lease still belongs to an instance that may be finishing its
        // vendor call; relabelling it would page staff for an in-flight cancel.
        const claimedAt = numberField(order.petpoojaCancelClaimedAt);
        if (claimedAt > 0 && Date.now() - claimedAt < PETPOOJA_CANCEL_CLAIM_TTL_MS) return;
      }
      const attempts = Number(order.petpoojaCancelAttemptCount || 0);
      if (attempts <= PETPOOJA_MAX_RETRY_ATTEMPTS) return;
      branchId = typeof order.branchId === "string" ? order.branchId : "";
      tx.set(
        ref,
        {
          petpoojaCancelStatus: "failed",
          kotCancelFailed: true,
          petpoojaCancelClaimedAt: null,
          petpoojaCancelNextRetryAtMs: null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      wrote = true;
    });
  } catch (err: any) {
    logger.warn(
      `[Petpooja Cancel Worker] dead-letter recheck failed for order ${doc.id}:`,
      err?.message || err
    );
    return false;
  }
  if (wrote) {
    await alertCancelUndelivered(
      doc.id,
      branchId,
      "retry budget exhausted — cancel the order at the till"
    );
  }
  return wrote;
}

/**
 * 5-minute worker: drain `pending` / `pending_retry` cancel intents.
 *
 * DISABLED BRIDGE: no scan, no lease, no POST, no alert — the queued intents
 * survive a disabled window exactly as the KOT queue does.
 */
export async function retryPendingPetpoojaOrderCancelsWorker(): Promise<{
  cancelledCount: number;
  failedCount: number;
  deferredCount: number;
}> {
  let cancelledCount = 0;
  let failedCount = 0;
  let deferredCount = 0;

  // P3/r2: drain persisted POS-originated cleanups FIRST and unconditionally —
  // these obligations never call the vendor, so a disabled outbound bridge must
  // not strand a coupon release or courier cleanup. Reuses this 5-minute tick.
  try {
    await processPendingPosCancelSideEffects();
  } catch (err: any) {
    logger.warn(
      "[Petpooja Cancel Worker] POS cancel side-effect drain failed:",
      err?.message || err
    );
  }

  if (!isPetpoojaEnabled()) {
    logger.info(
      "[Petpooja Cancel Worker] PETPOOJA_ENABLED=false — bridge disabled, skipping the outbound cancel tick"
    );
    return { cancelledCount, failedCount, deferredCount };
  }

  for (const lane of PETPOOJA_CANCEL_OPEN_STATUSES) {
    let docs: any[] = [];
    try {
      // Equality on one field only: Firestore's automatic single-field index
      // serves this, so the lane needs no composite index in
      // firestore.indexes.json.
      const snap = await db
        .collection("orders")
        .where("petpoojaCancelStatus", "==", lane)
        .limit(CANCEL_SCAN_LIMIT)
        .get();
      docs = (snap.docs || []) as any[];
    } catch (err: any) {
      logger.warn(
        `[Petpooja Cancel Worker] ${lane} scan failed, skipping lane:`,
        err?.message || err
      );
      continue;
    }

    const nowMs = Date.now();
    for (const doc of docs) {
      const data = doc.data() || {};
      if (Number(data.petpoojaCancelAttemptCount || 0) > PETPOOJA_MAX_RETRY_ATTEMPTS) {
        if (await deadLetterExhaustedCancel(doc)) failedCount++;
        continue;
      }
      if (!cancelRetryDue(data, nowMs)) continue;

      const outcome = await requestPetpoojaOrderCancel({
        orderId: doc.id,
        reason:
          typeof data.petpoojaCancelReasonClass === "string"
            ? data.petpoojaCancelReasonClass
            : undefined,
        requestedBy:
          typeof data.petpoojaCancelRequestedBy === "string"
            ? data.petpoojaCancelRequestedBy
            : "system",
      });
      if (outcome === "cancelled" || outcome === "already_cancelled") cancelledCount++;
      else if (outcome === "failed" || outcome === "blocked_configuration") failedCount++;
      else if (outcome === "deferred" || outcome === "busy") deferredCount++;
    }
  }

  return { cancelledCount, failedCount, deferredCount };
}
