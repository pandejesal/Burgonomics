import { messaging } from "../../core/firebase";

export type EscalationLevelCode = "L1_STORE" | "L2_REGIONAL" | "L3_EXECUTIVE";

export interface TicketAlertPayload {
  ticketId: string;
  ticketNumber: string;
  subject: string;
  branchId?: string;
  escalationLevel: EscalationLevelCode;
  reason?: string;
}

/**
 * Pure topic routing for escalation levels — exported so tests pin the exact
 * topics production pages (a drift here pages the wrong humans silently).
 */
export function resolveEscalationTopic(
  escalationLevel: EscalationLevelCode,
  branchId?: string
): string {
  if (escalationLevel === "L1_STORE") {
    return branchId ? `branch_${branchId}_tickets` : "branch_general_tickets";
  }
  if (escalationLevel === "L2_REGIONAL") {
    return "regional_managers";
  }
  return "superadmins";
}

/**
 * Dispatches high-priority multicast/topic FCM alerts across 3-tier escalation topics.
 */
export async function dispatchTicketEscalationAlert(payload: TicketAlertPayload): Promise<void> {
  const { ticketId, ticketNumber, subject, branchId, escalationLevel, reason } = payload;
  const attempts: Array<Promise<unknown>> = [];

  // Push copy carries NO free-text subject: reporters paste phones and
  // addresses into subjects, and unbounded text truncates mid-word on trays.
  // Full subject rides in data.ticketId (open Tickets to read it).
  let title = `🎫 Ticket #${ticketNumber} needs attention`;
  let body = branchId
    ? `Branch ${branchId}: urgent ticket awaiting action — open Tickets to view.`
    : `Urgent ticket awaiting action — open Tickets to view.`;
  let topic = resolveEscalationTopic(escalationLevel, branchId);

  if (escalationLevel === "L1_STORE") {
    title = `🎫 New Support Ticket: #${ticketNumber}`;
    body = `New issue reported at branch: ${subject}`;
    topic = branchId ? `branch_${branchId}_tickets` : "branch_general_tickets";
  } else if (escalationLevel === "L2_REGIONAL") {
    title = `⚠️ SLA Breach (L2): #${ticketNumber}`;
    body = `Unresolved after 15m. Escalated to Regional Operations: ${subject}`;
    topic = "regional_managers";
  } else if (escalationLevel === "L3_EXECUTIVE") {
    title = `🚨 CRITICAL SLA Breach (L3): #${ticketNumber}`;
    body = `Unresolved after 60m. Escalated to Brand Executives: ${subject}`;
    topic = "superadmins";
  }

  // 1. Send to target escalation topic
  attempts.push(
    messaging.send({
      topic,
      notification: { title, body },
      data: {
        type: "ticket_escalated",
        ticketId,
        ticketNumber,
        escalationLevel,
        reason: reason || "",
      },
      android: {
        priority: "high",
        notification: {
          sound: "default",
          channelId: "tickets_alerts",
        },
      },
    })
  );

  // 2. Also notify the specific branch topic if L2/L3 so local managers stay in sync
  if (branchId && (escalationLevel === "L2_REGIONAL" || escalationLevel === "L3_EXECUTIVE")) {
    attempts.push(
      messaging.send({
        topic: `branch_${branchId}`,
        notification: { title, body },
        data: {
          type: "ticket_escalated",
          ticketId,
          ticketNumber,
          escalationLevel,
        },
        android: { priority: "high" },
      })
    );
  }

  await Promise.allSettled(attempts);
}

/**
 * Dispatches a reminder notification to branch staff for tickets open >60m.
 */
export async function dispatchTicketReminderAlert(payload: {
  ticketId: string;
  ticketNumber: string;
  subject: string;
  branchId: string;
}): Promise<void> {
  const { ticketId, ticketNumber, subject, branchId } = payload;
  const topic = `branch_${branchId}_tickets`;

  await messaging.send({
    topic,
    notification: {
      title: `⏰ Action Required: #${ticketNumber}`,
      body: `Ticket has been in progress for >60 minutes without resolution: ${subject}`,
    },
    data: {
      type: "ticket_reminder",
      ticketId,
      ticketNumber,
    },
    android: { priority: "high" },
  });
}
