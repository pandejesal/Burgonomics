import { messaging } from "../../core/firebase";
import { truncatePushText, buildParityExtras } from "../notifications/templates";

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
 *
 * B5-S1 (H17): push copy carries NO free-text subject — reporters paste phones
 * and addresses into subjects, and unbounded text truncates mid-word on trays.
 * `payload.subject` is accepted for source compatibility but NEVER rendered;
 * full detail rides in data.ticketId (open Tickets to read it). Bodies are
 * server-truncated (~120ch) and shipped with shared apns+webpush parity (H34).
 */
export async function dispatchTicketEscalationAlert(payload: TicketAlertPayload): Promise<void> {
  const { ticketId, ticketNumber, branchId, escalationLevel, reason } = payload;
  const attempts: Array<Promise<unknown>> = [];

  let title = `Ticket ${ticketNumber} needs attention`;
  let body = branchId
    ? `Branch ${branchId}: urgent ticket awaiting action — open Tickets to view.`
    : `Urgent ticket awaiting action — open Tickets to view.`;
  let topic = resolveEscalationTopic(escalationLevel, branchId);

  if (escalationLevel === "L1_STORE") {
    title = `New support ticket ${ticketNumber}`;
    body = branchId
      ? `New issue reported at branch ${branchId} — open Tickets to view.`
      : `New support ticket reported — open Tickets to view.`;
    topic = branchId ? `branch_${branchId}_tickets` : "branch_general_tickets";
  } else if (escalationLevel === "L2_REGIONAL") {
    title = `SLA breach (L2): ${ticketNumber}`;
    body = `Unresolved after 15m. Escalated to Regional Operations — open Tickets to view.`;
    topic = "regional_managers";
  } else if (escalationLevel === "L3_EXECUTIVE") {
    title = `Critical SLA breach (L3): ${ticketNumber}`;
    body = `Unresolved after 60m. Escalated to Brand Executives — open Tickets to view.`;
    topic = "superadmins";
  }

  const safeBody = truncatePushText(body);
  // No messaging backend (unit tests, miswired env): page nobody, fail loud
  // in logs, never throw into the calling ticket flow.
  if (!messaging || typeof messaging.send !== "function") {
    console.warn("[Tickets] FCM messaging unavailable — escalation alert logged only:", title);
    return;
  }

  // 1. Send to target escalation topic
  attempts.push(
    messaging.send({
      topic,
      notification: { title, body: safeBody },
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
          // Must match a channel created on device (burgonomics_updates_channel).
          // The old tickets_alerts ID exists nowhere — Android silently drops it.
          sound: "default",
          channelId: "burgonomics_updates_channel",
        },
      },
      // Shared iOS/Web parity (H34): same title/body, no badge on shared
      // staff topic terminals.
      ...buildParityExtras(title, safeBody),
    })
  );

  // 2. Also notify the specific branch topic if L2/L3 so local managers stay in sync.
  // MUST be the suffixed form: bare `branch_<id>` has zero subscribers (the
  // subscribe allowlist only permits branch_*_orders/tickets) — the old bare
  // topic paged nobody.
  if (branchId && (escalationLevel === "L2_REGIONAL" || escalationLevel === "L3_EXECUTIVE")) {
    attempts.push(
      messaging.send({
        topic: `branch_${branchId}_tickets`,
        notification: { title, body: safeBody },
        data: {
          type: "ticket_escalated",
          ticketId,
          ticketNumber,
          escalationLevel,
        },
        android: { priority: "high" },
        ...buildParityExtras(title, safeBody),
      })
    );
  }

  await Promise.allSettled(attempts);
}

/**
 * Dispatches a reminder notification to branch staff for tickets open >60m.
 * PII-free (H17): generic copy + data-only IDs, server-truncated.
 */
export async function dispatchTicketReminderAlert(payload: {
  ticketId: string;
  ticketNumber: string;
  subject: string;
  branchId: string;
}): Promise<void> {
  const { ticketId, ticketNumber, branchId } = payload;
  const topic = `branch_${branchId}_tickets`;
  const title = `Action required: ${ticketNumber}`;
  const body = truncatePushText(
    `Ticket open for over 60 minutes without resolution — open Tickets to view.`
  );

  if (!messaging || typeof messaging.send !== "function") {
    console.warn("[Tickets] FCM messaging unavailable — reminder logged only:", title);
    return;
  }

  await messaging.send({
    topic,
    notification: { title, body },
    data: {
      type: "ticket_reminder",
      ticketId,
      ticketNumber,
    },
    android: { priority: "high" },
    ...buildParityExtras(title, body),
  });
}
