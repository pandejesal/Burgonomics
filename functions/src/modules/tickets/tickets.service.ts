import * as crypto from "crypto";
import { db } from "../../core/firebase";
import { captureErrorSnapshot, serviceError } from "../../core/errors";
import { truncatePushText } from "../notifications/templates";
import { autoRefund } from "../payments/razorpay.service";
import { creditTicketLoyaltyCoins } from "../customers/customerCoins";
import * as admin from "firebase-admin";

/**
 * B5-S1 server-side transition guard. Routes carry requireRole(...), and the
 * locked firestore.rules block ALL client updates to support_tickets — but a
 * miswired route must still deny inside the function (B3-S1 claimsManager
 * pattern). Callers pass the verified req.user as `caller`; when present its
 * role MUST be staff. Omitted caller = legacy route path (still guarded by
 * route requireRole + rules); the handoff carries the one-line route change
 * to pass req.user through.
 */
export type TicketCaller = { uid?: string; role?: string; branchIds?: string[] } | null | undefined;
const STAFF_ROLES = new Set([
  "brand_owner",
  "developer",
  "support",
  "regional_manager",
  "branch_owner",
  "branch_staff",
]);

function assertStaff(caller: TicketCaller, action: string): void {
  if (!caller) return; // route-level requireRole + rules remain the backstop
  if (!caller.role || !STAFF_ROLES.has(caller.role)) {
    throw serviceError("TICKET_FORBIDDEN", `Forbidden: role ${caller.role || "none"} cannot ${action}`, 403);
  }
}

// RBAC scope classes (references/rbac.md L29-L34; NO new roles invented):
// brand_owner/developer are brand-global; support is "Global Tickets";
// branch_owner/branch_staff/regional_manager act on ASSIGNED branches and
// must prove it. Any future STAFF_ROLES member defaults to scoped (fail-closed).
const GLOBAL_TICKET_ROLES = new Set(["brand_owner", "developer", "support"]);

/**
 * Fail-closed branch scoping for STAFF ticket actions (Loop 7 hardening).
 * The four previous inline checks gated the deny on `branchIds.length > 0`,
 * so a branch-scoped staff claim with a MISSING or EMPTY branchIds list
 * skipped the check entirely and could act on any branch's ticket -
 * including resolveTicket's refund paths. Mirrors assertOrderBranchAccess
 * (core/middleware.ts): a scoped role MUST hold the ticket's branch.
 *
 * Runs AFTER assertStaff and BEFORE any side effect (refunds, snapshots,
 * status writes). Rules:
 * - caller absent or bound with no uid -> 403 (unauthenticated identity;
 *   module callers without an HTTP caller must now pass a caller too).
 * - global roles (brand_owner/developer/support) -> allowed.
 * - every other STAFF role: branchIds must CONTAIN ticket.branchId;
 *   missing/empty/mismatched -> 403.
 * - a ticket WITHOUT branchId is corrupt or legacy: FAILS CLOSED for scoped
 *   roles (cannot scope an unspecifiable doc; Admin SDK writes never pass
 *   through client rules, and requireRole confirms role only). Global roles
 *   bypass branch PROOF only - same-rule corrupt-doc denials are pinned in
 *   tests/tickets.branch-scope.test.ts.
 */
export function assertTicketBranchAccess(
  caller: TicketCaller,
  ticketBranchId: string | undefined,
  action: string
): void {
  if (!caller || !caller.uid) {
    throw serviceError("TICKET_FORBIDDEN", `Forbidden: caller is required (unauthenticated) to ${action}`, 403);
  }
  const role = caller.role;
  // Non-staff callers are owned by assertStaff (resolve/escalate/resolveNote)
  // or the customer-ownership path (addTicketMessage) - helper is inert.
  if (!role || !STAFF_ROLES.has(role)) return;
  if (GLOBAL_TICKET_ROLES.has(role)) return;
  // NO branchless-doc allowance: createTicketSchema proves branchId and the
  // rules require it on new tickets, so any ticket WITHOUT a branch is either
  // corrupt or legacy - and legacy docs still carry refund paths. A scoped
  // role cannot scope an unspecifiable document: fail closed here too.
  if (!ticketBranchId) {
    throw serviceError(
      "TICKET_FORBIDDEN",
      "Forbidden: ticket has no resolvable branch; cannot scope this action",
      403
    );
  }
  const held = Array.isArray(caller.branchIds) ? caller.branchIds : [];
  if (!held.includes(ticketBranchId)) {
    throw serviceError(
      "TICKET_FORBIDDEN",
      "Forbidden: ticket is outside your assigned branches",
      403
    );
  }
}

// Spam/abuse backstops (M14 follow-up; rules bind customerId==uid, routes
// throttle per-IP — this is the per-customer server-side ceiling).
const TICKET_CREATE_WINDOW_MS = 10 * 60 * 1000;
const TICKET_CREATE_MAX_PER_WINDOW = 3;
const TICKET_MAX_OPEN_PER_CUSTOMER = 10;

function timestampMillis(value: any): number | null {
  if (value == null) return null;
  if (typeof value?.toMillis === "function") {
    const ms = value.toMillis();
    return typeof ms === "number" ? ms : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

async function assertTicketSpamGuards(customerId: string): Promise<void> {
  try {
    const col = db.collection("support_tickets") as any;
    if (typeof col.where !== "function") return; // non-Firestore harness
    // ORDER BY createdAt DESC before the limit: without it Firestore returns
    // an ARBITRARY 25 docs (default order is document id), so a customer
    // with a long history could have every RECENT ticket fall outside the
    // sample and sail past the 3-per-10m ceiling entirely.
    const snap = await col
      .where("customerId", "==", customerId)
      .orderBy("createdAt", "desc")
      .limit(25)
      .get();
    const docs = snap?.docs || [];
    const now = Date.now();
    let recent = 0;
    let open = 0;
    for (const d of docs) {
      const t = typeof d.data === "function" ? d.data() : {};
      const createdMs = timestampMillis(t.createdAt);
      if (createdMs != null && now - createdMs < TICKET_CREATE_WINDOW_MS) recent++;
      if (t.status === "open" || t.status === "in_progress" || t.status === "escalated") open++;
    }
    if (recent >= TICKET_CREATE_MAX_PER_WINDOW) {
      throw serviceError(
        "TICKET_RATE_LIMITED",
        `Ticket spam guard: customer ${customerId} created ${recent} tickets in 10m`,
        429
      );
    }
    if (open >= TICKET_MAX_OPEN_PER_CUSTOMER) {
      throw serviceError(
        "TICKET_TOO_MANY_OPEN",
        `Ticket spam guard: customer ${customerId} holds ${open} open tickets`,
        429
      );
    }
  } catch (err: any) {
    if (err?.code === "TICKET_RATE_LIMITED" || err?.code === "TICKET_TOO_MANY_OPEN") throw err;
    // Guard telemetry failed (Firestore blip): warn and proceed — the guard
    // is abuse mitigation, and failing ticket intake closed here would drop
    // genuine distress tickets on an infra wobble.
    console.warn("[Tickets] Spam-guard query failed (proceeding):", err?.message || err);
  }
}

export type TicketCategory =
  | "wrong_item"
  | "late_delivery"
  | "food_quality"
  | "payment_issue"
  | "app_bug"
  | "general_inquiry";

export type TicketPriority = "low" | "medium" | "high" | "urgent";
export type TicketStatus = "open" | "in_progress" | "escalated" | "resolved" | "closed";
export type TicketTier = "branch" | "brand_support" | "developer_team";

export interface TicketTimelineEvent {
  action: string;
  actorId: string;
  actorName: string;
  actorRole: string;
  message?: string;
  timestamp: string;
}

export interface CreateTicketInput {
  customerId: string;
  customerName: string;
  customerPhone?: string;
  orderId?: string;
  branchId: string;
  category: TicketCategory;
  priority?: TicketPriority;
  subject: string;
  description: string;
  attachments?: string[];
  diagnostics?: {
    razorpayPaymentId?: string;
    porterOrderId?: string;
    petpoojaOrderId?: string;
    errorStack?: string;
    clientAppVersion?: string;
    deviceInfo?: string;
  };
}

export interface ResolveTicketInput {
  ticketId: string;
  resolvedBy: string;
  resolvedByName: string;
  action: "full_refund" | "partial_refund" | "discount_coupon" | "loyalty_credit" | "explanation";
  amount?: number;
  couponCode?: string;
  notes: string;
  /** Verified caller (req.user). Binds identity + asserts staff in-function. */
  caller?: TicketCaller;
}

export interface EscalateTicketInput {
  ticketId: string;
  targetTier: "brand_support" | "developer_team";
  reason: string;
  escalatedBy: string;
  escalatedByName: string;
  /** Verified caller (req.user). Binds identity + asserts staff in-function. */
  caller?: TicketCaller;
}

export interface ResolveNoteInput {
  ticketId: string;
  resolution: string;
  /** Verified caller (req.user). Binds identity + asserts staff in-function. */
  caller?: TicketCaller;
}

/**
 * Records a non-money resolution note and flips the ticket to resolved.
 * Staff-only, branch-scoped, timeline-appended server-side — the client
 * direct-write path it replaces skipped all three (and let any authed
 * caller rewrite any ticket's status/resolution).
 */
export async function resolveTicketNote(input: ResolveNoteInput) {
  assertStaff(input.caller, "resolve tickets");
  const actorId = input.caller?.uid || "staff";
  const actorName = "Staff";
  const ticketRef = db.collection("support_tickets").doc(input.ticketId);
  const ticketSnap = await ticketRef.get();
  if (!ticketSnap.exists) {
    throw serviceError("TICKET_NOT_FOUND", `Ticket ${input.ticketId} not found`, 404);
  }
  const ticket = ticketSnap.data()!;
  if (ticket.status === "resolved" || ticket.status === "closed") {
    throw serviceError("TICKET_NOT_PENDING", "Ticket is already resolved.", 409);
  }
  // Loop 7 hardening (fail-closed): scoped staff MUST prove the ticket's
  // branch. Missing/empty/mismatched branchIds -> 403 BEFORE side effects.
  assertTicketBranchAccess(input.caller, ticket.branchId, "resolve tickets");
  // Same resolution lease as the money path: without it two concurrent notes
  // both pass the snapshot guard and the later write overwrites the earlier
  // note/timeline identity (audit trail corruption).
  const { claimToken } = await claimTicketResolution(ticketRef, actorId, "TICKET_NOT_PENDING");
  let committed = false;
  try {
    const resolution = String(input.resolution || "").trim().slice(0, 2000) || "Resolved by staff.";
    const event: TicketTimelineEvent = {
      action: "resolved_note",
      actorId,
      actorName,
      actorRole: "staff",
      message: resolution,
      timestamp: new Date().toISOString(),
    };
    await commitResolvedTicket(ticketRef, claimToken, {
      status: "resolved",
      resolution,
      resolutionClaim: admin.firestore.FieldValue.delete(),
      timeline: admin.firestore.FieldValue.arrayUnion(event),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    committed = true;
  } finally {
    if (!committed) await releaseResolutionClaim(ticketRef, claimToken);
  }
  return { success: true, ticketId: input.ticketId };
}

/**
 * Generates human-friendly ticket numbers like TICK-2026-8942
 */
function generateTicketNumber(): string {
  const year = new Date().getFullYear();
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `TICK-${year}-${rand}`;
}

/**
 * Creates a support ticket with auto-assignment to the branch.
 *
 * B5-S1 honesty + abuse rules:
 * - customerId is server-bound to caller.uid when a verified caller is
 *   present (kills victim-id stamping); subject/description are length-capped.
 * - Explicit priority is HONORED (an "urgent" is never downgraded to "high");
 *   the category default applies only when priority is unspecified.
 * - Per-customer spam guards (burst + open-cap) run before the write.
 */
export async function createTicket(input: CreateTicketInput & { caller?: TicketCaller }) {
  const customerId = input.caller?.uid || input.customerId;
  if (!customerId) {
    throw serviceError("TICKET_INVALID_INPUT", "Ticket create: missing customerId", 400);
  }
  const subject = String(input.subject || "").trim();
  const description = String(input.description || "").trim();
  if (subject.length < 4 || subject.length > 120 || description.length < 1 || description.length > 2000) {
    throw serviceError("TICKET_INVALID_INPUT", "Ticket create: subject/description length invalid", 400);
  }

  await assertTicketSpamGuards(customerId);

  const ticketId = `tkt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const ticketNumber = generateTicketNumber();
  const now = new Date().toISOString();

  // Honest priority: explicit caller choice wins. The old code forced
  // payment_issue/wrong_item to "high" AFTER applying input.priority, so an
  // explicit "urgent" was silently DOWNGRADED and born-urgent tickets never
  // paged anyone.
  let priority: TicketPriority = input.priority || "medium";
  if (!input.priority && (input.category === "payment_issue" || input.category === "wrong_item")) {
    priority = "high";
  }

  const initialTimeline: TicketTimelineEvent[] = [
    {
      action: "ticket_created",
      actorId: customerId,
      actorName: input.customerName || "Customer",
      actorRole: "customer",
      // Timeline stores the subject for staff; it NEVER goes to push bodies.
      message: `Ticket raised: ${subject}`,
      timestamp: now,
    },
  ];

  const ticketData = {
    id: ticketId,
    ticketNumber,
    customerId,
    customerName: input.customerName,
    customerPhone: input.customerPhone || "",
    orderId: input.orderId || null,
    branchId: input.branchId,
    category: input.category,
    priority,
    status: "open" as TicketStatus,
    subject,
    description,
    attachments: input.attachments || [],
    assignedTo: {
      tier: "branch" as TicketTier,
    },
    timeline: initialTimeline,
    diagnostics: input.diagnostics || {},
    branchReminderSent: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    lastActivityAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await db.collection("support_tickets").doc(ticketId).set(ticketData);

  return { ...ticketData };
}

/**
 * Adds a message or reply to a support ticket thread.
 *
 * B5-S1 reply honesty: sender identity/role are server-derived from the
 * verified caller when present — a body-supplied senderRole can no longer
 * flip a customer reply into a staff reply (or vice versa). Empty/overlong
 * text is rejected, never silently stored.
 */
export async function addTicketMessage(params: {
  ticketId: string;
  senderId: string;
  senderName: string;
  senderRole: string;
  text: string;
  caller?: TicketCaller;
}) {
  const { ticketId, senderName, text, caller } = params;
  const senderId = caller?.uid || params.senderId;
  const senderRole = caller?.role || params.senderRole;
  if (!ticketId || !senderId) {
    throw serviceError("TICKET_INVALID_INPUT", "Ticket message: missing ticketId/senderId", 400);
  }
  const cleanText = String(text || "").trim();
  if (cleanText.length < 1) {
    throw serviceError("TICKET_MESSAGE_EMPTY", "Ticket message: empty text", 400);
  }
  if (cleanText.length > 2000) {
    throw serviceError("TICKET_INVALID_INPUT", "Ticket message: text over 2000 chars", 400);
  }
  const ticketRef = db.collection("support_tickets").doc(ticketId);

  // Visibility (Loop 57/58 adversarial finding): identity is already bound
  // above (caller.uid wins over body), but binding alone doesn't check
  // VISIBILITY — any authed customer could still write to anyone's ticket.
  const ticketSnap = await ticketRef.get();
  if (!ticketSnap.exists) {
    throw serviceError("TICKET_NOT_FOUND", `Ticket ${ticketId} not found`, 404);
  }
  const ticket = ticketSnap.data() as any;
  if (!caller || !caller.uid) {
    // Fail-closed: a caller-less message previously skipped the visibility
    // check entirely. Route requireAuth always binds req.user, so the only
    // "caller-less" calls are direct module calls - reject rather than trust
    // the body's senderId.
    throw serviceError("TICKET_FORBIDDEN", "Forbidden: caller is required to message tickets", 403);
  }
  if (caller && caller.uid) {
    if (!caller.role || !STAFF_ROLES.has(caller.role)) {
      if (ticket.customerId !== caller.uid) {
        throw serviceError(
          "TICKET_FORBIDDEN",
          "Forbidden: customers may only message their own tickets",
          403
        );
      }
    } else {
      // Loop 7 hardening (fail-closed): scoped staff MUST prove the branch.
      assertTicketBranchAccess(caller, ticket.branchId, "message tickets");
    }
  }

  const event: TicketTimelineEvent = {
    action: "message_added",
    actorId: senderId,
    actorName: senderName,
    actorRole: senderRole,
    message: cleanText,
    timestamp: new Date().toISOString(),
  };

  await ticketRef.update({
    timeline: admin.firestore.FieldValue.arrayUnion(event),
    status: senderRole === "customer" ? "open" : "in_progress",
    lastActivityAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return event;
}

/**
 * Resolution lease (double-resolution guard hardening — lane 04).
 *
 * The status guard alone is check-then-act: it reads the pre-flight snapshot,
 * runs provider side effects, and writes the final resolution many awaits
 * later. Two concurrent resolutions BOTH pass it; the later write overwrites
 * the earlier `resolution` (the audit trail loses the action that actually
 * ran) and refund paths enter autoRefund twice (whose money safety then rides
 * only on the payments lane's own lease). This lease serializes resolutions:
 * the winner writes `resolutionClaim` in the SAME transaction that re-checks
 * the terminal status, the loser gets 409 TICKET_RESOLUTION_IN_PROGRESS, and
 * the claim is cleared on success and released best-effort on failure. A
 * crashed resolver leaves the claim behind; the TTL lets the next staff
 * member retry without admin intervention.
 *
 * Fencing: the commit and the release are CONDITIONAL on the caller still
 * holding the claim it wrote (claimToken {claimedAt, actorUid} === the stored
 * resolutionClaim's {claimedAt, actorUid}). A
 * resolver whose lease expired and was taken over can therefore neither
 * overwrite the successor's resolution nor wipe the successor's claim.
 *
 * TTL sizing: the resolve routes live under the 60-second api function
 * timeout (index.ts), so a crashed instance cannot outlive a 2.5-minute
 * lease; anything longer would lock staff out for minutes of nothing.
 */
export const RESOLUTION_CLAIM_TTL_MS = 2.5 * 60 * 1000;

type ClaimToken = { claimedAt: number; actorUid: string | null };
type ClaimedTicket = { ticket: Record<string, any>; claimToken: ClaimToken };

async function claimTicketResolution(
  ticketRef: FirebaseFirestore.DocumentReference,
  actorId: string,
  alreadyResolvedCode: "TICKET_ALREADY_RESOLVED" | "TICKET_NOT_PENDING"
): Promise<ClaimedTicket> {
  const claimedAt = Date.now();
  let ticket: Record<string, any>;
  try {
    ticket = await db.runTransaction(async (tx: FirebaseFirestore.Transaction) => {
      const snap = await tx.get(ticketRef);
      if (!snap.exists) {
        throw serviceError("TICKET_NOT_FOUND", `Ticket ${ticketRef.id} not found`, 404);
      }
      const t = (snap.data() || {}) as Record<string, any>;
      if (t.status === "resolved" || t.status === "closed") {
        throw serviceError(
          alreadyResolvedCode,
          `Ticket ${ticketRef.id} is already ${t.status} — reopen it before resolving again.`,
          409
        );
      }
      const claim = t.resolutionClaim;
      if (
        claim &&
        typeof claim.claimedAt === "number" &&
        Date.now() - claim.claimedAt < RESOLUTION_CLAIM_TTL_MS
      ) {
        throw serviceError(
          "TICKET_RESOLUTION_IN_PROGRESS",
          `Ticket ${ticketRef.id} is being resolved by another staff member right now — try again in a moment.`,
          409
        );
      }
      tx.set(
        ticketRef,
        { resolutionClaim: { actorUid: actorId || null, claimedAt } },
        { merge: true }
      );
      return t;
    });
  } catch (err: any) {
    // Contention exhaustion (ABORTED / code 10) is a busy signal, not a
    // server fault: surface a typed retryable 503 instead of a bare 500.
    if (err?.code === 10 || err?.code === "ABORTED") {
      throw serviceError(
        "TICKET_RESOLUTION_RETRY",
        `Ticket ${ticketRef.id} is being updated concurrently — retry in a moment.`,
        503
      );
    }
    throw err;
  }
  return { ticket, claimToken: { claimedAt, actorUid: actorId || null } };
}

/**
 * Conditional final write: the resolution commits ONLY if this caller still
 * holds the lease. A takeover after TTL expiry makes this a typed 409 rather
 * than a silent overwrite of the successor's resolution.
 */
async function commitResolvedTicket(
  ticketRef: FirebaseFirestore.DocumentReference,
  claimToken: ClaimToken,
  payload: Record<string, any>
): Promise<void> {
  await db.runTransaction(async (tx: FirebaseFirestore.Transaction) => {
    const snap = await tx.get(ticketRef);
    const claim = snap.exists ? ((snap.data() || {}) as any).resolutionClaim : undefined;
    // Token = epoch ms + actor: two claims in the SAME millisecond (DS n-8)
    // must not be interchangeable, or a release could erase a successor.
    if (
      !snap.exists ||
      claim?.claimedAt !== claimToken.claimedAt ||
      (claim?.actorUid ?? null) !== claimToken.actorUid
    ) {
      throw serviceError(
        "TICKET_RESOLUTION_CLAIM_LOST",
        `Ticket ${ticketRef.id}: the resolution lease moved on before this write — no overwrite performed.`,
        409
      );
    }
    // set+merge (not update): identical effect on an existing doc and usable
    // by every Firestore shim in the suite (Transaction.update coverage is
    // sparse there).
    tx.set(ticketRef, payload, { merge: true });
  });
}

/** Best-effort conditional lease release after a failed resolution. */
async function releaseResolutionClaim(
  ticketRef: FirebaseFirestore.DocumentReference,
  claimToken: ClaimToken
): Promise<void> {
  try {
    await db.runTransaction(async (tx: FirebaseFirestore.Transaction) => {
      const snap = await tx.get(ticketRef);
      const claim = snap.exists ? ((snap.data() || {}) as any).resolutionClaim : undefined;
      // Never erase a claim this caller no longer holds (takeover safety).
      if (
        claim?.claimedAt !== claimToken.claimedAt ||
        (claim?.actorUid ?? null) !== claimToken.actorUid
      ) {
        return;
      }
      tx.set(ticketRef, { resolutionClaim: admin.firestore.FieldValue.delete() }, { merge: true });
    });
  } catch (err: any) {
    console.warn(
      `[Tickets] resolution claim release failed for ${ticketRef.id}:`,
      err?.message || err
    );
  }
}

/**
 * Validates a loyalty credit amount and returns it narrowed to `number`.
 * Pure, so it can run both before the lease (fail fast, burn no claim) and at
 * the credit site (where the compiler needs the narrowing back).
 */
function assertLoyaltyAmount(amount: number | undefined): number {
  if (!amount) {
    throw serviceError(
      "TICKET_LOYALTY_NO_AMOUNT",
      "Cannot credit loyalty: no coin amount was specified.",
      400
    );
  }
  if (!Number.isInteger(amount) || amount <= 0 || amount > 5000) {
    throw serviceError(
      "TICKET_LOYALTY_AMOUNT_INVALID",
      "Loyalty credit must be a whole number of points between 1 and 5000.",
      400
    );
  }
  return amount;
}

/**
 * Resolves a ticket with specific action (full/partial refund, coupon, loyalty credit, or explanation).
 */
export async function resolveTicket(input: ResolveTicketInput) {
  const { ticketId, resolvedBy, resolvedByName, action, amount, couponCode, notes } = input;
  // Staff-only transition, enforced server-side even if the route miswires.
  assertStaff(input.caller, "resolve tickets");
  const actorId = input.caller?.uid || resolvedBy;
  const ticketRef = db.collection("support_tickets").doc(ticketId);
  const ticketSnap = await ticketRef.get();

  if (!ticketSnap.exists) {
    throw serviceError("TICKET_NOT_FOUND", `Ticket ${ticketId} not found`, 404);
  }

  const ticket = ticketSnap.data()!;
  let refundResult: any = null;

  // Loop 7: branch scoping (mirrors addTicketMessage) — any staff role on
  // the route must not close another branch's ticket. Brand roles bypass.
  // Loop 7 hardening (fail-closed): scoped staff MUST prove the ticket's
  // branch. Missing/empty/mismatched branchIds -> 403 BEFORE side effects.
  assertTicketBranchAccess(input.caller, ticket.branchId, "resolve tickets");

  // Double-refund guard (Loop 57 adversarial finding): a resolved/closed
  // ticket must never resolve again. The second pass would re-fire autoRefund
  // (caller-distinct idempotency keys per call) and double-pay the customer.
  if (ticket.status === "resolved" || ticket.status === "closed") {
    throw serviceError(
      "TICKET_ALREADY_RESOLVED",
      `Ticket ${ticketId} is already ${ticket.status} — reopen it before resolving again.`,
      409
    );
  }

  // Pure input validation runs BEFORE the lease: a bad amount must not burn a
  // claim (and manufacture a transient 409 for a legitimate concurrent
  // resolver). Only ticket-dependent checks stay under the lease.
  if (action === "partial_refund" && !(typeof amount === "number" && amount > 0)) {
    throw serviceError(
      "TICKET_REFUND_AMOUNT_REQUIRED",
      "Partial refund needs an amount greater than zero — use full refund for the whole order.",
      400
    );
  }
  if (action === "loyalty_credit") {
    assertLoyaltyAmount(amount);
  }

  // Atomic resolution lease (race hardening): the pre-read guard above is a
  // fast path only. The authoritative check runs in a transaction with the
  // claim write, so two concurrent resolutions cannot BOTH pass it — the
  // loser 409s before any side effect (refund/credit/notification).
  const { ticket: liveTicket, claimToken } = await claimTicketResolution(
    ticketRef,
    actorId,
    "TICKET_ALREADY_RESOLVED"
  );

  let resolutionCommitted = false;
  let resolution: Record<string, any> = {};
  try {
    // Re-assert branch access against the transaction-fresh snapshot: every
    // other decision moved onto it, so authorization must too.
    assertTicketBranchAccess(input.caller, liveTicket.branchId, "resolve tickets");

  // 1. If full or partial refund, trigger payment autoRefund with Route split reversal.
  // Fail LOUD when no captured payment exists: the old code left refundResult
  // null and still closed the ticket as resolved — staff saw success, the
  // customer never got money, and the closed ticket removed all recourse.
  if (action === "full_refund" || action === "partial_refund") {
    if (!liveTicket.orderId) {
      throw serviceError(
        "TICKET_REFUND_NO_ORDER",
        "Cannot refund: ticket has no linked order (guest ticket — refund via Razorpay dashboard).",
        400
      );
    }
    const orderSnap = await db.collection("orders").doc(liveTicket.orderId).get();
    if (!orderSnap.exists) {
      throw serviceError(
        "TICKET_NOT_FOUND",
        `Cannot refund: linked order ${liveTicket.orderId} not found.`,
        404
      );
    }
    const order = orderSnap.data()!;
    // NOTE: second-charge protection lives in autoRefund itself. Its identity is
    // the durable refund request id derived below (ticket + action): a retry of
    // THIS ticket replays the stored receipt, while a different ticket is a
    // distinct intent that must still satisfy the cumulative captured cap and the
    // ALREADY_REFUNDED guard. The resolution lease above stops two concurrent
    // resolutions (and the status guard stops re-resolution of this ticket).
    // Captured-payment proof, both storage shapes: nested server writes AND
    // the webhook's dotted-literal merge-set form (webhookHandler writes
    // "payment.razorpayPaymentId" literally — reading only the nested shape
    // falsely refused legit refunds on webhook-paid orders).
    const razorpayPaymentId =
      order.payment?.razorpayPaymentId ||
      order["payment.razorpayPaymentId"] ||
      liveTicket.diagnostics?.razorpayPaymentId;
    if (!razorpayPaymentId) {
      throw serviceError(
        "TICKET_REFUND_NO_PAYMENT",
        "Cannot refund: no captured Razorpay payment found for this order (COD or unpaid).",
        400
      );
    }
    const ticketDigest = crypto
      .createHash("sha256")
      .update(JSON.stringify([ticketId, action]))
      .digest("hex")
      .slice(0, 32);
    const deterministicRequestId = `tkt_${ticketDigest}`;
    refundResult = await autoRefund({
      orderId: liveTicket.orderId,
      razorpayPaymentId,
      amountRupees: action === "partial_refund" ? amount : undefined,
      reason: `Ticket ${liveTicket.ticketNumber || ticketId} resolution: ${notes}`,
      refundRequestId: deterministicRequestId,
    });
  }

  // 2. If loyalty credit, update customer profile. Amount is bounded like
  // staff adjustments (±5000, coin_transactions ledger): an unbounded
  // increment mints money-equivalent points, a negative one drains them.
  // Loop 33/120 fail-closed: a loyalty_credit without a customer profile
  // must REFUSE loudly — the old code skipped the credit yet still resolved
  // the ticket as credited.
  if (action === "loyalty_credit") {
    if (!liveTicket.customerId) {
      throw serviceError(
        "TICKET_LOYALTY_NO_CUSTOMER",
        "Cannot credit loyalty: ticket has no customer profile (guest ticket).",
        400
      );
    }
    // Loop 33/120 fix (finding: wrong collection / no ledger): the credit
    // lands on `customers/{uid}.loyaltyPoints` — the balance the redeem
    // gate, staff adjustments, and redemption debits all read — WITH a
    // coin_transactions audit row. The old `users/{uid}` write credited a
    // collection nothing reads and left no ledger trail at all.
    try {
      await creditTicketLoyaltyCoins({
        customerId: liveTicket.customerId,
        ticketId,
        ticketNumber: liveTicket.ticketNumber,
        amount: assertLoyaltyAmount(amount),
        actorUid: actorId,
        actorName: resolvedByName,
      });
    } catch (err: any) {
      if (err?.code === "TICKET_LOYALTY_CUSTOMER_MISSING") {
        // Refuse loudly (Loop 33/120): never resolve a ticket as credited
        // when the money-equivalent points went nowhere.
        throw serviceError("TICKET_LOYALTY_CUSTOMER_MISSING", err.message, 404);
      }
      throw err;
    }
  }

  resolution = {
    action,
    amount: amount || 0,
    couponCode: couponCode || null,
    refundResult,
    resolvedBy: actorId,
    resolvedByName,
    notes,
    resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  const event: TicketTimelineEvent = {
    action: "ticket_resolved",
    actorId,
    actorName: resolvedByName,
    actorRole: "staff",
    message: `Resolved with ${action.replace("_", " ")}: ${notes}`,
    timestamp: new Date().toISOString(),
  };

  await commitResolvedTicket(ticketRef, claimToken, {
    status: "resolved",
    resolution,
    // The lease is consumed by the resolution it guarded.
    resolutionClaim: admin.firestore.FieldValue.delete(),
    timeline: admin.firestore.FieldValue.arrayUnion(event),
    lastActivityAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  resolutionCommitted = true;
  } finally {
    if (!resolutionCommitted) await releaseResolutionClaim(ticketRef, claimToken);
  }

  // Customers never learned their ticket closed. Best-effort push (never
  // blocks resolution). B5-S1: PII-free + honest — generic copy, ticket IDs
  // in data only, refund named only when money actually moved (H17/H33).
  try {
    const { pushToCustomer } = await import("../notifications/fcmClient");
    await pushToCustomer(
      liveTicket.customerId,
      "Support ticket resolved",
      truncatePushText(
        refundResult
          ? `Ticket ${liveTicket.ticketNumber || ticketId} is resolved with a refund. Thanks for your patience!`
          : `Ticket ${liveTicket.ticketNumber || ticketId} is resolved. Thanks for your patience!`
      ),
      { type: "ticket_resolved", ticketId }
    );
  } catch {
    // Non-blocking (see pushToCustomer).
  }

  return { success: true, ticketId, resolution };
}

/**
 * Escalates a ticket to Brand Support or Developer Team.
 */
export async function escalateTicket(input: EscalateTicketInput) {
  const { ticketId, targetTier, reason, escalatedBy, escalatedByName } = input;
  // Staff-only transition, enforced server-side even if the route miswires.
  assertStaff(input.caller, "escalate tickets");
  const actorId = input.caller?.uid || escalatedBy;
  const ticketRef = db.collection("support_tickets").doc(ticketId);
  const ticketSnap = await ticketRef.get();

  if (!ticketSnap.exists) {
    throw serviceError("TICKET_NOT_FOUND", `Ticket ${ticketId} not found`, 404);
  }

  const ticket = ticketSnap.data()!;
  let snapshotId: string | null = null;

  // Loop 7: branch scoping (mirrors addTicketMessage/resolveTicket) — staff
  // must not escalate another branch's ticket. Brand roles bypass.
  // Loop 7 hardening (fail-closed): scoped staff MUST prove the ticket's
  // branch. Missing/empty/mismatched branchIds -> 403 BEFORE side effects.
  assertTicketBranchAccess(input.caller, ticket.branchId, "escalate tickets");

  // If escalated to developer team, create a formal error snapshot & dispatch alert.
  // The operator-supplied reason is NOT persisted here: reporters paste PII
  // (phones, order details) into free text and snapshots are staff-visible.
  // Fetch the reason via ticketId when triaging.
  if (targetTier === "developer_team") {
    snapshotId = await captureErrorSnapshot({
      source: "tickets",
      severity: "high",
      message: `Escalated ticket ${ticket.ticketNumber} to developer team`,
      orderId: ticket.orderId,
      branchId: ticket.branchId,
      customerId: ticket.customerId,
      razorpayPaymentId: ticket.diagnostics?.razorpayPaymentId,
      porterOrderId: ticket.diagnostics?.porterOrderId,
      petpoojaOrderId: ticket.diagnostics?.petpoojaOrderId,
      errorStack: ticket.diagnostics?.errorStack,
      context: {
        ticketId,
        ticketNumber: ticket.ticketNumber,
        escalatedBy: escalatedByName,
      },
    });
  }

  const event: TicketTimelineEvent = {
    action: `escalated_to_${targetTier}`,
    actorId,
    actorName: escalatedByName,
    actorRole: "staff",
    message: `Escalated to ${targetTier.replace("_", " ")}: ${reason}`,
    timestamp: new Date().toISOString(),
  };

  const updateData: Record<string, any> = {
    status: "escalated",
    "assignedTo.tier": targetTier,
    timeline: admin.firestore.FieldValue.arrayUnion(event),
    lastActivityAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (snapshotId) {
    updateData["diagnostics.errorSnapshotId"] = snapshotId;
  }

  await ticketRef.update(updateData);

  return { success: true, ticketId, targetTier, snapshotId };
}

