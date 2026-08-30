import { db, messaging } from "../../core/firebase";
import * as admin from "firebase-admin";

/**
 * 60-Minute Ticket Inactivity Reminder Worker
 * Runs every 15 minutes to re-ping branches with unresolved tickets older than 60 minutes.
 */
export async function checkTicketInactivityReminders(): Promise<{
  remindedCount: number;
}> {
  const sixtyMinutesAgo = new Date(Date.now() - 60 * 60 * 1000);
  const cutoffTimestamp = admin.firestore.Timestamp.fromDate(sixtyMinutesAgo);

  const snapshot = await db
    .collection("support_tickets")
    .where("status", "==", "open")
    .where("branchReminderSent", "==", false)
    .where("createdAt", "<=", cutoffTimestamp)
    .limit(50)
    .get();

  let remindedCount = 0;

  for (const doc of snapshot.docs) {
    const ticket = doc.data();
    const branchId = ticket.branchId;

    if (branchId) {
      try {
        // Send FCM alert to branch topic
        await messaging.send({
          topic: `branch_${branchId}`,
          notification: {
            title: `⚠️ Unresolved Ticket Alert (${ticket.ticketNumber})`,
            body: `Customer ticket '${ticket.subject}' has been open for >60 mins. Please attend immediately.`,
          },
          data: {
            type: "ticket_reminder",
            ticketId: doc.id,
            ticketNumber: ticket.ticketNumber || "",
          },
          android: {
            priority: "high",
          },
        });
      } catch (err) {
        console.warn(`[Ticket Reminder] Failed to dispatch FCM for ticket ${doc.id}:`, err);
      }
    }

    // Mark reminder sent so we do not spam
    await doc.ref.update({
      branchReminderSent: true,
      lastActivityAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    remindedCount++;
  }

  return { remindedCount };
}
