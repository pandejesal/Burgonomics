import { db } from "../../core/firebase";
import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import { pushToCustomer } from "../notifications/fcmClient";

/**
 * Customer-facing support publishers (contract N-07 / §10 + §11).
 *
 * Three sends live here — reply, customer-visible escalation, resolution — all
 * classified `supportReplies` and all routed through the notifications core so
 * suppression, quarantine and inbox persistence stay owned by one place.
 *
 * Invariants this module enforces:
 * - Identity is the SERVER-DERIVED author (`caller.role` bound by the ticket
 *   service), never a body field. A customer reply never pushes to itself.
 * - Every send carries a STABLE id, and a `notification_dispatch/{purpose}:{id}`
 *   claim is written BEFORE the transport call. A duplicate/retry is therefore
 *   never a second push, and a failed push is never retried into a duplicate.
 * - Dispatch happens after the caller's DB commit — never inside
 *   `runTransaction` (the ticket service calls these after its write resolves).
 * - Delivery is never claimed: `pushToCustomer` writes the inbox row and the
 *   OS push but returns no provider acknowledgement, so the ledger records
 *   `unknown`. Only a result-returning core sender could upgrade that.
 * - Push failure never throws into the caller: a persisted message stays
 *   persisted even when the push fails.
 */

/** Customer purpose this module owns (contract §2 purposes). */
export const SUPPORT_PURPOSE = "supportReplies" as const;
/** Order/payment senders (N-08) classify with this purpose. */
export const ORDER_PURPOSE = "orderUpdates" as const;

export type CustomerPurpose = typeof SUPPORT_PURPOSE | typeof ORDER_PURPOSE;

/**
 * The single contract-shaped request every customer account send passes.
 * `targetId` is supplied by the sender (ticket id / order id) — never guessed.
 * The notifications core turns it into the inbox document's `targetId`; it is
 * not rendered in OS copy.
 *
 * No `category` field: the core derives it from `purpose`
 * (`CATEGORY_BY_CUSTOMER_PURPOSE`). Two sources of truth would drift.
 */
export interface CustomerAccountNotification {
  readonly purpose: CustomerPurpose;
  readonly recipientUid: string;
  readonly targetId: string;
  /** Inbox `type` compatibility alias (clients still read it). */
  readonly type: string;
  readonly title: string;
  /** Display copy only — server-built, no names, snippets, addresses or ids. */
  readonly body: string;
}

/**
 * What a sender can PROVE. `sent`/`suppressed` are deliberately absent: the
 * core sender returns no provider acknowledgement, so those labels would be
 * claims this module cannot support.
 */
export type DeliveryOutcome = "failed" | "unknown";

export interface AccountSendResult {
  readonly outcome: DeliveryOutcome;
  /** Inbox ref, when the core sender reports one (it does not, today). */
  readonly ref?: string;
  /** Non-PII diagnostic label (e.g. `no_provider_ack`, `sender_threw`). */
  readonly detail?: string;
}

export type SupportNotificationSkipReason =
  | "no_recipient"
  | "self_reply"
  | "not_staff"
  | "no_stable_id"
  | "duplicate"
  | "ledger_unavailable";

export interface SupportNotificationOutcome {
  readonly dispatched: boolean;
  readonly attemptId: string | null;
  readonly reason?: SupportNotificationSkipReason;
  readonly result?: AccountSendResult;
}

export const NOTIFICATION_DISPATCH_COLLECTION = "notification_dispatch";

/**
 * Mirrors `STAFF_ROLES` in tickets.service.ts. Duplicated rather than imported
 * because the service imports this module (a reverse import would be a cycle);
 * the notify suite pins membership so a silently widened set fails a test.
 */
export const SUPPORT_STAFF_ROLES: ReadonlySet<string> = new Set([
  "brand_owner",
  "developer",
  "support",
  "regional_manager",
  "branch_owner",
  "branch_staff",
]);

export function isSupportStaffRole(role: unknown): boolean {
  return typeof role === "string" && SUPPORT_STAFF_ROLES.has(role);
}

/** Customer-safe copy. Generic by construction: no ticket numbers, no names. */
export const SUPPORT_REPLY_TITLE = "New support reply";
export const SUPPORT_REPLY_BODY = "Support replied to your ticket — open Support to read the message.";
export const SUPPORT_ESCALATION_TITLE = "Support ticket escalated";
export const SUPPORT_ESCALATION_BODY =
  "Your ticket moved to our specialist team — we will keep you posted.";
export const SUPPORT_RESOLUTION_TITLE = "Support ticket resolved";

export function supportResolutionBody(refunded: boolean): string {
  return refunded
    ? "Your ticket is resolved with a refund. Thanks for your patience!"
    : "Your ticket is resolved. Thanks for your patience!";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAlreadyExistsError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  if (code === 6 || code === "6" || code === "already-exists") return true;
  return /already exists/i.test(errorMessage(err));
}

/**
 * Sends one customer account notification. Never throws: a transport failure
 * is a reported outcome, not an exception that could roll back a caller's
 * already-committed message.
 */
export async function dispatchCustomerAccountNotification(
  request: CustomerAccountNotification
): Promise<AccountSendResult> {
  if (!request || !request.recipientUid) {
    // A customer-purpose send with no recipient is refused before any
    // transport call (contract §2: zero messaging calls).
    return { outcome: "failed", detail: "missing_recipient" };
  }
  try {
    await pushToCustomer(
      request.recipientUid,
      request.title,
      request.body,
      // `targetId` seeds the inbox document; the core rewrites the wire data to
      // {purpose, category, recipientUid, ref}, so no id reaches the OS tray.
      { type: request.type, targetId: request.targetId },
      { purpose: request.purpose }
    );
    // `pushToCustomer` returns void: the push may have been delivered,
    // suppressed, or dropped with no tokens. Without a provider ACK the only
    // honest label is `unknown` (contract §15).
    return { outcome: "unknown", detail: "no_provider_ack" };
  } catch (err) {
    logger.warn("[Support Notifications] Account send failed; persisted message is unaffected", {
      purpose: request.purpose,
      detail: errorMessage(err),
    });
    return { outcome: "unknown", detail: "sender_threw" };
  }
}

/** `notification_dispatch/{purpose}:{stableId}` — the at-most-once ledger key. */
export function notificationAttemptId(purpose: string, stableId: string): string {
  const segment = (value: string) => String(value).replace(/[/\\]/g, "_").slice(0, 200);
  return `${segment(purpose)}:${segment(stableId)}`;
}

interface AttemptClaimInput {
  readonly purpose: CustomerPurpose;
  readonly stableId: string;
  readonly recipientUid: string;
  readonly targetId: string;
}

/**
 * Claims the dispatch slot. `create()` is the real dedupe; the get/set form
 * only exists for harnesses whose document reference has no `create`. When the
 * ledger cannot be written we WITHHOLD the send: an unrecorded dispatch could
 * be replayed into a duplicate push, which the contract forbids.
 */
async function claimNotificationAttempt(
  input: AttemptClaimInput
): Promise<"claimed" | "duplicate" | "ledger_unavailable"> {
  const attemptId = notificationAttemptId(input.purpose, input.stableId);
  const record = {
    purpose: input.purpose,
    stableId: input.stableId,
    recipientUid: input.recipientUid,
    targetId: input.targetId,
    outcome: "pending",
    attemptedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  try {
    const ref = db.collection(NOTIFICATION_DISPATCH_COLLECTION).doc(attemptId);
    const create = (ref as unknown as { create?: (data: unknown) => Promise<unknown> }).create;
    if (typeof create === "function") {
      await create.call(ref, record);
      return "claimed";
    }
    const snapshot = await ref.get();
    if (snapshot?.exists) return "duplicate";
    await ref.set(record);
    return "claimed";
  } catch (err) {
    if (isAlreadyExistsError(err)) return "duplicate";
    logger.warn("[Support Notifications] Dispatch ledger unavailable — send withheld", {
      purpose: input.purpose,
      detail: errorMessage(err),
    });
    return "ledger_unavailable";
  }
}

async function recordNotificationOutcome(
  purpose: CustomerPurpose,
  stableId: string,
  result: AccountSendResult
): Promise<void> {
  try {
    await db
      .collection(NOTIFICATION_DISPATCH_COLLECTION)
      .doc(notificationAttemptId(purpose, stableId))
      .update({
        outcome: result.outcome,
        ref: result.ref ?? null,
        detail: result.detail ?? null,
        resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
  } catch (err) {
    // Observability only: the push already happened (or did not), so a ledger
    // write failure must not turn into a caller-visible error.
    logger.warn("[Support Notifications] Could not record dispatch outcome", {
      purpose,
      detail: errorMessage(err),
    });
  }
}

interface StableDispatchInput extends AttemptClaimInput {
  readonly title: string;
  readonly body: string;
  readonly type: string;
}

async function dispatchStable(input: StableDispatchInput): Promise<SupportNotificationOutcome> {
  const claim = await claimNotificationAttempt(input);
  const attemptId = notificationAttemptId(input.purpose, input.stableId);
  if (claim !== "claimed") {
    return { dispatched: false, attemptId, reason: claim };
  }
  const result = await dispatchCustomerAccountNotification({
    purpose: input.purpose,
    recipientUid: input.recipientUid,
    targetId: input.targetId,
    type: input.type,
    title: input.title,
    body: input.body,
  });
  await recordNotificationOutcome(input.purpose, input.stableId, result);
  return { dispatched: true, attemptId, result };
}

export interface SupportReplyNotificationInput {
  readonly ticketId: string;
  readonly customerId?: string;
  /** Persisted timeline author (`caller.uid` when a verified caller exists). */
  readonly authorUid: string;
  /** Persisted timeline author role — the server-derived `caller.role`. */
  readonly authorRole: string;
  /** Stable id of the persisted message this push announces. */
  readonly messageId: string;
}

/** Staff reply ⇒ one `supportReplies` push. Self-reply ⇒ none. */
export async function notifySupportReply(
  input: SupportReplyNotificationInput
): Promise<SupportNotificationOutcome> {
  try {
    if (!input.customerId) return { dispatched: false, attemptId: null, reason: "no_recipient" };
    if (!input.messageId) return { dispatched: false, attemptId: null, reason: "no_stable_id" };
    // A customer writing on their own ticket is not a "reply to the customer".
    if (input.authorUid === input.customerId) {
      return { dispatched: false, attemptId: null, reason: "self_reply" };
    }
    if (!isSupportStaffRole(input.authorRole)) {
      return { dispatched: false, attemptId: null, reason: "not_staff" };
    }
    return await dispatchStable({
      purpose: SUPPORT_PURPOSE,
      stableId: input.messageId,
      recipientUid: input.customerId,
      targetId: input.ticketId,
      type: "support_reply",
      title: SUPPORT_REPLY_TITLE,
      body: SUPPORT_REPLY_BODY,
    });
  } catch (err) {
    logger.warn("[Support Notifications] Reply push skipped", { detail: errorMessage(err) });
    return { dispatched: false, attemptId: null, reason: "ledger_unavailable" };
  }
}

export interface SupportEscalationNotificationInput {
  readonly ticketId: string;
  readonly customerId?: string;
  readonly targetTier: string;
  /** Stable id of the persisted escalation transition. */
  readonly transitionId: string;
}

/** Customer-visible escalation notice (generic copy; tier is never exposed). */
export async function notifySupportEscalation(
  input: SupportEscalationNotificationInput
): Promise<SupportNotificationOutcome> {
  try {
    if (!input.customerId) return { dispatched: false, attemptId: null, reason: "no_recipient" };
    if (!input.transitionId) return { dispatched: false, attemptId: null, reason: "no_stable_id" };
    return await dispatchStable({
      purpose: SUPPORT_PURPOSE,
      stableId: input.transitionId,
      recipientUid: input.customerId,
      targetId: input.ticketId,
      type: "ticket_escalated",
      title: SUPPORT_ESCALATION_TITLE,
      body: SUPPORT_ESCALATION_BODY,
    });
  } catch (err) {
    logger.warn("[Support Notifications] Escalation push skipped", { detail: errorMessage(err) });
    return { dispatched: false, attemptId: null, reason: "ledger_unavailable" };
  }
}

export interface SupportResolutionNotificationInput {
  readonly ticketId: string;
  readonly customerId?: string;
  readonly refunded: boolean;
  /** Stable id of the persisted resolution transition. */
  readonly transitionId: string;
}

/** Resolution notice. Copy drops the ticket number (contract §10). */
export async function notifySupportResolution(
  input: SupportResolutionNotificationInput
): Promise<SupportNotificationOutcome> {
  try {
    if (!input.customerId) return { dispatched: false, attemptId: null, reason: "no_recipient" };
    if (!input.transitionId) return { dispatched: false, attemptId: null, reason: "no_stable_id" };
    return await dispatchStable({
      purpose: SUPPORT_PURPOSE,
      stableId: input.transitionId,
      recipientUid: input.customerId,
      targetId: input.ticketId,
      type: "ticket_resolved",
      title: SUPPORT_RESOLUTION_TITLE,
      body: supportResolutionBody(input.refunded),
    });
  } catch (err) {
    logger.warn("[Support Notifications] Resolution push skipped", { detail: errorMessage(err) });
    return { dispatched: false, attemptId: null, reason: "ledger_unavailable" };
  }
}
