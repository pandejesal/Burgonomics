import { db, messaging } from "../../core/firebase";
import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import { truncatePushText, buildParityExtras } from "../notifications/templates";

export type TicketEscalationTier = "branch" | "brand_support" | "developer_team";

const TIER_ORDER: TicketEscalationTier[] = ["branch", "brand_support", "developer_team"];
const TIER_WAIT_MS: Record<TicketEscalationTier, number> = {
  branch: 60 * 60 * 1000, // 60 min: branch must resolve
  brand_support: 2 * 60 * 60 * 1000, // +120 min: brand support must resolve
  developer_team: 4 * 60 * 60 * 1000, // +240 min: developer team (final tier)
};
const ESCALATED_TOPIC = "tickets_escalated";

/**
 * Determines the current active tier for a still-unresolved ticket.
 * If assignedTo.tier is absent/invalid, defaults to branch.
 */
export function currentTier(ticket: any): TicketEscalationTier {
  const tier = ticket?.assignedTo?.tier;
  return TIER_ORDER.includes(tier) ? (tier as TicketEscalationTier) : "branch";
}

/** Best-effort millis for Firestore Timestamps, epoch numbers, and ISO strings. */
function activityMillis(value: any, fallback: number): number {
  if (value == null) return fallback;
  if (typeof value?.toMillis === "function") {
    const ms = value.toMillis();
    return typeof ms === "number" ? ms : fallback;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : fallback;
  }
  return fallback;
}

/**
 * Returns the tier the ticket should be escalated to given how long it has
 * been sitting without an update, or null if no further escalation applies.
 */
export function nextTierForInactivity(ticket: any, nowMillis: number): TicketEscalationTier | null {
  const tier = currentTier(ticket);
  const idx = TIER_ORDER.indexOf(tier);
  if (idx >= TIER_ORDER.length - 1) return null; // already at final tier

  // Compute when the current tier's clock started: from lastActivityAt if present,
  // otherwise from createdAt. Accepts Timestamp objects, epoch numbers, and
  // ISO strings — writers disagree on shape, and an unparseable clock must
  // not silently disable escalation (it did: unknown shapes fell to Date.now()).
  const lastActivity =
    ticket.lastActivityAt != null
      ? activityMillis(ticket.lastActivityAt, nowMillis)
      : activityMillis(ticket.createdAt, nowMillis);
  const waitMs = TIER_WAIT_MS[tier];

  if (nowMillis - lastActivity >= waitMs) {
    return TIER_ORDER[idx + 1];
  }
  return null;
}

/**
 * Publishes an FCM escalation/reminder alert on the shared tickets_escalated
 * topic and the branch topic, so the right tier & branch staff get paged.
 */
async function publishTicketAlert(params: {
  ticket: any;
  ticketId: string;
  title: string;
  body: string;
  dataType: string;
}) {
  const { ticket, ticketId, title, body, dataType } = params;
  const branchId = ticket?.branchId;
  const attempts: Array<Promise<unknown>> = [];
  // PII-free generic copy only (H17) + server truncate backstop (~120ch).
  const safeBody = truncatePushText(body);

  if (!messaging || typeof messaging.send !== "function") {
    logger.warn("[Ticket Escalator] FCM messaging unavailable — alert logged only:", title);
    return;
  }

  attempts.push(
    messaging.send({
      topic: ESCALATED_TOPIC,
      notification: { title, body: safeBody },
      data: {
        type: dataType,
        ticketId,
        ticketNumber: ticket?.ticketNumber || "",
      },
      android: { priority: "high" },
      ...buildParityExtras(title, safeBody),
    })
  );

  if (branchId) {
    // Suffixed form only — bare branch topics have zero subscribers (see
    // /notifications/subscribe allowlist).
    attempts.push(
      messaging.send({
        topic: `branch_${branchId}_tickets`,
        notification: { title, body: safeBody },
        data: {
          type: dataType,
          ticketId,
          ticketNumber: ticket?.ticketNumber || "",
        },
        android: { priority: "high" },
        ...buildParityExtras(title, safeBody),
      })
    );
  }

  await Promise.allSettled(attempts);
}

/**
 * 3-Tier Automatic Ticket Escalation Worker
 * Runs every 15 minutes. Unresolved tickets automatically climb the ladder:
 *   branch (60min) -> brand_support (120min) -> developer_team (240min, final).
 * Each hop publishes on the `tickets_escalated` FCM topic and updates the ticket.
 */
export async function checkTicketInactivityReminders(): Promise<{
  remindedCount: number;
}> {
  // Any ticket still open or escalated and not yet resolved/closed.
  const snapshot = await db
    .collection("support_tickets")
    .where("status", "in", ["open", "escalated"])
    .limit(100)
    .get();

  const now = Date.now();
  let remindedCount = 0;
  const escalationEvents: Array<{ doc: any; targetTier: TicketEscalationTier }> = [];

  // Collect-then-flush: the old code awaited 1 write + up to 2 FCM sends per
  // ticket serially (100 tickets × ~500ms ≈ 60s, risking scheduler overrun).
  // Writes go in one batch; alerts fan out concurrently with allSettled so
  // one slow send never blocks the rest.
  const batch = db.batch();
  let batchedWrites = 0;
  const alertJobs: Array<() => Promise<unknown>> = [];
  // Loop: reminder "sent" flags must only land when their alert actually
  // went out. The old code committed the flag in the pre-batch, so a failed
  // (or crashed-after-commit) send was never retried — silent escalation.
  // Escalation status flips stay pre-committed (time-based truth); reminder
  // flags ride a follow-up batch keyed to fulfilled sends.
  const reminderFlagRefs: Array<{ ref: any; jobIndex: number }> = [];

  for (const doc of snapshot.docs) {
    const ticket = doc.data();

    const targetTier = nextTierForInactivity(ticket, now);

    if (targetTier) {
      const tierLabel = targetTier.replace("_", " ");
      const event = {
        action: `auto_escalated_to_${targetTier}`,
        actorId: "system",
        actorName: "Automated Escalator",
        actorRole: "system",
        message: `No activity within SLA — automatically escalated to ${tierLabel}.`,
        timestamp: new Date().toISOString(),
      };

      batch.update(doc.ref, {
        status: "escalated",
        "assignedTo.tier": targetTier,
        escalationTier: targetTier,
        timeline: admin.firestore.FieldValue.arrayUnion(event),
        lastEscalationAt: admin.firestore.FieldValue.serverTimestamp(),
        lastActivityAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      batchedWrites++;

      escalationEvents.push({ doc, targetTier });
      const ticketSnapshot = ticket;
      const ticketId = doc.id;
      alertJobs.push(() =>
        publishTicketAlert({
          ticket: ticketSnapshot,
          ticketId,
          title: `Escalated: ${ticketSnapshot?.ticketNumber || ticketId}`,
          // No free-text subject on the push (PII paste risk) — branch-first.
          body: `Ticket auto-escalated to ${tierLabel} for lack of activity — open Tickets to view.`,
          dataType: "ticket_escalated",
        })
      );

      remindedCount++;
      continue;
    }

    // No further escalation (already at final tier or within SLA window).
    // Still re-ping branch for open tickets older than 60 minutes that have not
    // yet received even a first reminder.
    const branchTierAgedToRemind =
      currentTier(ticket) === "branch" &&
      ticket.branchReminderSent === false &&
      ticket.createdAt?.toMillis &&
      now - ticket.createdAt.toMillis() >= 60 * 60 * 1000;

    if (branchTierAgedToRemind) {
      const ticketSnapshot = ticket;
      const ticketId = doc.id;
      reminderFlagRefs.push({ ref: doc.ref, jobIndex: alertJobs.length });
      alertJobs.push(() =>
        publishTicketAlert({
          ticket: ticketSnapshot,
          ticketId,
          title: `Unresolved ticket alert (${ticketSnapshot?.ticketNumber || ticketId})`,
          body: `Customer ticket open for over 60 mins — please attend immediately.`,
          dataType: "ticket_reminder",
        })
      );

      remindedCount++;
    }
  }

  if (batchedWrites > 0) await batch.commit();
  if (alertJobs.length > 0) {
    const results = await Promise.allSettled(alertJobs.map((job) => job()));
    const failed = results.filter((r) => r.status === "rejected").length;
    // Flag only the reminders that actually went out — failed sends retry
    // on the next tick instead of going silent.
    const flagBatch = db.batch();
    let flagWrites = 0;
    results.forEach((r, i) => {
      if (r.status !== "fulfilled") return;
      const pending = reminderFlagRefs.find((p) => p.jobIndex === i);
      if (!pending) return;
      flagBatch.update(pending.ref, {
        branchReminderSent: true,
        lastActivityAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      flagWrites++;
    });
    if (flagWrites > 0) await flagBatch.commit();
    if (failed > 0) {
      logger.warn(`[Ticket Escalator] ${failed}/${alertJobs.length} alert sends failed (flags withheld for retry).`);
    }
  }

  if (escalationEvents.length > 0) {
    logger.log(
      `[Ticket Escalator] Auto-escalated ${escalationEvents.length} ticket(s): ${escalationEvents
        .map((e) => e.targetTier)
        .join(", ")}`
    );
  }

  return { remindedCount };
}
