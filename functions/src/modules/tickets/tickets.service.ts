import { db } from "../../core/firebase";
import { captureErrorSnapshot, serviceError } from "../../core/errors";
import { truncatePushText } from "../notifications/templates";
import { autoRefund } from "../payments/razorpay.service";
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
    const snap = await col.where("customerId", "==", customerId).limit(25).get();
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
  if (caller && caller.uid) {
    if (!caller.role || !STAFF_ROLES.has(caller.role)) {
      if (ticket.customerId !== caller.uid) {
        throw serviceError(
          "TICKET_FORBIDDEN",
          "Forbidden: customers may only message their own tickets",
          403
        );
      }
    } else if (
      caller.role !== "brand_owner" &&
      caller.role !== "developer" &&
      Array.isArray(caller.branchIds) &&
      caller.branchIds.length > 0 &&
      !caller.branchIds.includes(ticket.branchId)
    ) {
      throw serviceError(
        "TICKET_FORBIDDEN",
        "Forbidden: ticket is outside your assigned branches",
        403
      );
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
  if (
    input.caller?.uid &&
    input.caller.role !== "brand_owner" &&
    input.caller.role !== "developer" &&
    Array.isArray(input.caller.branchIds) &&
    input.caller.branchIds.length > 0 &&
    !input.caller.branchIds.includes(ticket.branchId)
  ) {
    throw serviceError(
      "TICKET_FORBIDDEN",
      "Forbidden: ticket is outside your assigned branches",
      403
    );
  }

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

  // 1. If full or partial refund, trigger payment autoRefund with Route split reversal.
  // Fail LOUD when no captured payment exists: the old code left refundResult
  // null and still closed the ticket as resolved — staff saw success, the
  // customer never got money, and the closed ticket removed all recourse.
  // Loop 3: a partial_refund with amount 0/omitted would fall through to a
  // FULL gateway refund (autoRefund reverse_all without amount) — require a
  // positive amount up front so a staff typo can't full-refund by accident.
  if (action === "partial_refund" && !(typeof amount === "number" && amount > 0)) {
    throw serviceError(
      "TICKET_REFUND_AMOUNT_REQUIRED",
      "Partial refund needs an amount greater than zero — use full refund for the whole order.",
      400
    );
  }
  if (action === "full_refund" || action === "partial_refund") {
    if (!ticket.orderId) {
      throw serviceError(
        "TICKET_REFUND_NO_ORDER",
        "Cannot refund: ticket has no linked order (guest ticket — refund via Razorpay dashboard).",
        400
      );
    }
    const orderSnap = await db.collection("orders").doc(ticket.orderId).get();
    if (!orderSnap.exists) {
      throw serviceError(
        "TICKET_NOT_FOUND",
        `Cannot refund: linked order ${ticket.orderId} not found.`,
        404
      );
    }
    const order = orderSnap.data()!;
    // NOTE: second-charge protection lives in autoRefund itself
    // (ALREADY_REFUNDED 409 + same-amount idempotent replay); the
    // ticket-status guard above stops re-resolution of this ticket.
    // Captured-payment proof, both storage shapes: nested server writes AND
    // the webhook's dotted-literal merge-set form (webhookHandler writes
    // "payment.razorpayPaymentId" literally — reading only the nested shape
    // falsely refused legit refunds on webhook-paid orders).
    const razorpayPaymentId =
      order.payment?.razorpayPaymentId ||
      order["payment.razorpayPaymentId"] ||
      ticket.diagnostics?.razorpayPaymentId;
    if (!razorpayPaymentId) {
      throw serviceError(
        "TICKET_REFUND_NO_PAYMENT",
        "Cannot refund: no captured Razorpay payment found for this order (COD or unpaid).",
        400
      );
    }
    refundResult = await autoRefund({
      orderId: ticket.orderId,
      razorpayPaymentId,
      amountRupees: action === "partial_refund" ? amount : undefined,
      reason: `Ticket ${ticket.ticketNumber} resolution: ${notes}`,
    });
  }

  // 2. If loyalty credit, update customer profile. Amount is bounded like
  // staff adjustments (±5000, coin_transactions ledger): an unbounded
  // increment mints money-equivalent points, a negative one drains them.
  // Loop 33/120 fail-closed: a loyalty_credit without a customer profile
  // must REFUSE loudly — the old code skipped the credit yet still resolved
  // the ticket as credited.
  if (action === "loyalty_credit") {
    if (!ticket.customerId) {
      throw serviceError(
        "TICKET_LOYALTY_NO_CUSTOMER",
        "Cannot credit loyalty: ticket has no customer profile (guest ticket).",
        400
      );
    }
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
    await db
      .collection("users")
      .doc(ticket.customerId)
      .set(
        {
          loyaltyPoints: admin.firestore.FieldValue.increment(amount),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
  }

  const resolution = {
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

  await ticketRef.update({
    status: "resolved",
    resolution,
    timeline: admin.firestore.FieldValue.arrayUnion(event),
    lastActivityAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Customers never learned their ticket closed. Best-effort push (never
  // blocks resolution). B5-S1: PII-free + honest — generic copy, ticket IDs
  // in data only, refund named only when money actually moved (H17/H33).
  try {
    const { pushToCustomer } = await import("../notifications/fcmClient");
    await pushToCustomer(
      ticket.customerId,
      "Support ticket resolved",
      truncatePushText(
        refundResult
          ? `Ticket ${ticket.ticketNumber || ticketId} is resolved with a refund. Thanks for your patience!`
          : `Ticket ${ticket.ticketNumber || ticketId} is resolved. Thanks for your patience!`
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
  if (
    input.caller?.uid &&
    input.caller.role !== "brand_owner" &&
    input.caller.role !== "developer" &&
    Array.isArray(input.caller.branchIds) &&
    input.caller.branchIds.length > 0 &&
    !input.caller.branchIds.includes(ticket.branchId)
  ) {
    throw serviceError(
      "TICKET_FORBIDDEN",
      "Forbidden: ticket is outside your assigned branches",
      403
    );
  }

  // If escalated to developer team, create a formal error snapshot & dispatch alert
  if (targetTier === "developer_team") {
    snapshotId = await captureErrorSnapshot({
      source: "tickets",
      severity: "high",
      message: `Escalated ticket ${ticket.ticketNumber}: ${reason}`,
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
        // No free-text subject/description here (H17): reporters paste PII
        // into them and snapshots are staff-visible. Fetch via ticketId.
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
