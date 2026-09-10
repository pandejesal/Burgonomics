import { db } from "../../core/firebase";
import * as admin from "firebase-admin";
import { dispatchTicketReminderAlert } from "./notificationDispatcher";

export interface ReminderRunResult {
  remindersSent: number;
}

/**
 * 60-Minute Ticket Reminder Digest Cron
 * Scans for tickets in OPEN or IN_PROGRESS state that have had no response/resolution
 * within 60 minutes and dispatches reminder push notifications to store staff.
 */
export async function runTicketReminderCron(
  customNowMillis?: number
): Promise<ReminderRunResult> {
  const now = customNowMillis || Date.now();
  let remindersSent = 0;

  const snapshot = await db
    .collection("support_tickets")
    .where("status", "in", ["open", "in_progress", "OPEN", "IN_PROGRESS"])
    .limit(50)
    .get();

  const batch = db.batch();
  const alertPromises: Array<Promise<void>> = [];

  for (const doc of snapshot.docs) {
    const data = doc.data();

    const createdAtMillis = data.createdAt?.toMillis
      ? data.createdAt.toMillis()
      : typeof data.createdAt === "string"
      ? new Date(data.createdAt).getTime()
      : now;

    const lastReminderMillis = data.lastReminderSentAt?.toMillis
      ? data.lastReminderSentAt.toMillis()
      : 0;

    // Check if open for >60m and either never reminded or last reminded >60m ago
    const isSittingOver60m = now - createdAtMillis >= 60 * 60 * 1000;
    const canSendReminder = now - lastReminderMillis >= 60 * 60 * 1000;

    if (isSittingOver60m && canSendReminder) {
      batch.update(doc.ref, {
        lastReminderSentAt: admin.firestore.FieldValue.serverTimestamp(),
        reminderCount: (data.reminderCount || 0) + 1,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      if (data.branchId) {
        alertPromises.push(
          dispatchTicketReminderAlert({
            ticketId: doc.id,
            ticketNumber: data.ticketNumber || doc.id,
            subject: data.subject || data.description || "Support Ticket",
            branchId: data.branchId,
          })
        );
      }

      remindersSent++;
    }
  }

  if (remindersSent > 0) {
    await batch.commit();
    await Promise.allSettled(alertPromises);
    console.log(`[Reminder Cron] Sent ${remindersSent} ticket reminders to branch staff.`);
  }

  return { remindersSent };
}
