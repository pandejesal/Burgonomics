import { db } from "../../core/firebase";
import { captureErrorSnapshot } from "../../core/errors";
import { autoRefund } from "../payments/razorpay.service";
import * as admin from "firebase-admin";

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
}

export interface EscalateTicketInput {
  ticketId: string;
  targetTier: "brand_support" | "developer_team";
  reason: string;
  escalatedBy: string;
  escalatedByName: string;
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
 */
export async function createTicket(input: CreateTicketInput) {
  const ticketId = `tkt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const ticketNumber = generateTicketNumber();
  const now = new Date().toISOString();

  // If priority not specified, derive from category
  let priority: TicketPriority = input.priority || "medium";
  if (input.category === "payment_issue" || input.category === "wrong_item") {
    priority = "high";
  }

  const initialTimeline: TicketTimelineEvent[] = [
    {
      action: "ticket_created",
      actorId: input.customerId,
      actorName: input.customerName || "Customer",
      actorRole: "customer",
      message: `Ticket raised: ${input.subject}`,
      timestamp: now,
    },
  ];

  const ticketData = {
    id: ticketId,
    ticketNumber,
    customerId: input.customerId,
    customerName: input.customerName,
    customerPhone: input.customerPhone || "",
    orderId: input.orderId || null,
    branchId: input.branchId,
    category: input.category,
    priority,
    status: "open" as TicketStatus,
    subject: input.subject,
    description: input.description,
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
 */
export async function addTicketMessage(params: {
  ticketId: string;
  senderId: string;
  senderName: string;
  senderRole: string;
  text: string;
}) {
  const { ticketId, senderId, senderName, senderRole, text } = params;
  const ticketRef = db.collection("support_tickets").doc(ticketId);

  const event: TicketTimelineEvent = {
    action: "message_added",
    actorId: senderId,
    actorName: senderName,
    actorRole: senderRole,
    message: text,
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
  const ticketRef = db.collection("support_tickets").doc(ticketId);
  const ticketSnap = await ticketRef.get();

  if (!ticketSnap.exists) {
    throw new Error(`Ticket ${ticketId} not found`);
  }

  const ticket = ticketSnap.data()!;
  let refundResult: any = null;

  // 1. If full or partial refund, trigger payment autoRefund with Route split reversal.
  // Fail LOUD when no captured payment exists: the old code left refundResult
  // null and still closed the ticket as resolved — staff saw success, the
  // customer never got money, and the closed ticket removed all recourse.
  if (action === "full_refund" || action === "partial_refund") {
    if (!ticket.orderId) {
      throw new Error("Cannot refund: ticket has no linked order (guest ticket — refund via Razorpay dashboard).");
    }
    const orderSnap = await db.collection("orders").doc(ticket.orderId).get();
    if (!orderSnap.exists) {
      throw new Error(`Cannot refund: linked order ${ticket.orderId} not found.`);
    }
    const order = orderSnap.data()!;
    const razorpayPaymentId =
      order.payment?.razorpayPaymentId || ticket.diagnostics?.razorpayPaymentId;
    if (!razorpayPaymentId) {
      throw new Error("Cannot refund: no captured Razorpay payment found for this order (COD or unpaid).");
    }
    refundResult = await autoRefund({
      orderId: ticket.orderId,
      razorpayPaymentId,
      amountRupees: action === "partial_refund" ? amount : undefined,
      reason: `Ticket ${ticket.ticketNumber} resolution: ${notes}`,
    });
  }

  // 2. If loyalty credit, update customer profile
  if (action === "loyalty_credit" && amount && ticket.customerId) {
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
    resolvedBy,
    resolvedByName,
    notes,
    resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  const event: TicketTimelineEvent = {
    action: "ticket_resolved",
    actorId: resolvedBy,
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
  // blocks resolution).
  try {
    const { pushToCustomer } = await import("../notifications/fcmClient");
    await pushToCustomer(
      ticket.customerId,
      "✅ Support ticket resolved",
      `Ticket ${ticket.ticketNumber || ticketId} is resolved${refundResult ? " with a refund" : ""}. Thanks for your patience!`,
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
  const ticketRef = db.collection("support_tickets").doc(ticketId);
  const ticketSnap = await ticketRef.get();

  if (!ticketSnap.exists) {
    throw new Error(`Ticket ${ticketId} not found`);
  }

  const ticket = ticketSnap.data()!;
  let snapshotId: string | null = null;

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
        subject: ticket.subject,
        description: ticket.description,
        escalatedBy: escalatedByName,
      },
    });
  }

  const event: TicketTimelineEvent = {
    action: `escalated_to_${targetTier}`,
    actorId: escalatedBy,
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
