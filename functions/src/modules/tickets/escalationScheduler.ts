import { db } from "../../core/firebase";
import * as admin from "firebase-admin";
import {
  dispatchTicketEscalationAlert,
  type EscalationLevelCode,
} from "./notificationDispatcher";

export interface EscalationRunResult {
  l1EscalatedCount: number;
  l2EscalatedCount: number;
  totalProcessed: number;
}

/**
 * 3-Tier SLA Escalation Engine
 * - L1 (>15m unresolved): Escalates to L2_REGIONAL (Regional Operations)
 * - L2 (>60m unresolved): Escalates to L3_EXECUTIVE (Brand Executives, marked CRITICAL)
 */
export async function runTicketEscalationCheck(
  customNowMillis?: number
): Promise<EscalationRunResult> {
  const now = customNowMillis || Date.now();
  const fifteenMinsAgo = admin.firestore.Timestamp.fromMillis(now - 15 * 60 * 1000);
  const sixtyMinsAgo = admin.firestore.Timestamp.fromMillis(now - 60 * 60 * 1000);

  let l1EscalatedCount = 0;
  let l2EscalatedCount = 0;

  const batch = db.batch();
  const notificationPromises: Array<Promise<void>> = [];

  // 1. Query L1 Breached Tickets (> 15 minutes old and still at L1_STORE / branch)
  const l1Snap = await db
    .collection("support_tickets")
    .where("status", "in", ["open", "in_progress", "OPEN", "IN_PROGRESS"])
    .limit(50)
    .get();

  for (const doc of l1Snap.docs) {
    const data = doc.data();
    const currentLevel: EscalationLevelCode =
      data.escalationLevel || (data.escalationTier === "brand_support" ? "L2_REGIONAL" : "L1_STORE");

    const createdAtMillis = data.createdAt?.toMillis
      ? data.createdAt.toMillis()
      : typeof data.createdAt === "string"
      ? new Date(data.createdAt).getTime()
      : now;

    // A. Check L2 -> L3 breach (> 60m)
    if (currentLevel === "L2_REGIONAL" && now - createdAtMillis >= 60 * 60 * 1000) {
      const event = {
        action: "auto_escalated_to_L3_EXECUTIVE",
        actorId: "system_cron",
        actorName: "SLA Auto-Escalator",
        actorRole: "system",
        message: "Unresolved after 60 mins. Auto-escalated to Brand Executive team.",
        timestamp: new Date().toISOString(),
      };

      batch.update(doc.ref, {
        status: "escalated",
        escalationLevel: "L3_EXECUTIVE",
        escalationTier: "developer_team",
        priority: "CRITICAL",
        timeline: admin.firestore.FieldValue.arrayUnion(event),
        lastEscalatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      notificationPromises.push(
        dispatchTicketEscalationAlert({
          ticketId: doc.id,
          ticketNumber: data.ticketNumber || doc.id,
          subject: data.subject || data.description || "Support ticket",
          branchId: data.branchId,
          escalationLevel: "L3_EXECUTIVE",
          reason: "60-minute SLA breach",
        })
      );

      l2EscalatedCount++;
      continue;
    }

    // B. Check L1 -> L2 breach (> 15m)
    if (currentLevel === "L1_STORE" && now - createdAtMillis >= 15 * 60 * 1000) {
      const event = {
        action: "auto_escalated_to_L2_REGIONAL",
        actorId: "system_cron",
        actorName: "SLA Auto-Escalator",
        actorRole: "system",
        message: "Unresolved after 15 mins. Auto-escalated to Regional Operations Manager.",
        timestamp: new Date().toISOString(),
      };

      batch.update(doc.ref, {
        status: "escalated",
        escalationLevel: "L2_REGIONAL",
        escalationTier: "brand_support",
        timeline: admin.firestore.FieldValue.arrayUnion(event),
        lastEscalatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      notificationPromises.push(
        dispatchTicketEscalationAlert({
          ticketId: doc.id,
          ticketNumber: data.ticketNumber || doc.id,
          subject: data.subject || data.description || "Support ticket",
          branchId: data.branchId,
          escalationLevel: "L2_REGIONAL",
          reason: "15-minute SLA breach",
        })
      );

      l1EscalatedCount++;
    }
  }

  if (l1EscalatedCount > 0 || l2EscalatedCount > 0) {
    await batch.commit();
    await Promise.allSettled(notificationPromises);
    console.log(
      `[SLA Escalator] Auto-escalated ${l1EscalatedCount} tickets to L2_REGIONAL, ${l2EscalatedCount} tickets to L3_EXECUTIVE.`
    );
  }

  return {
    l1EscalatedCount,
    l2EscalatedCount,
    totalProcessed: l1Snap.docs.length,
  };
}
