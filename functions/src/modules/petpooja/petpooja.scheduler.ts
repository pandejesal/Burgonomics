import { db } from "../../core/firebase";
import { syncPetpoojaMenu } from "./menuSyncWebhook";
import { pushOrderToPetpooja } from "./orderPush";

/**
 * Hourly Cron job to sync menus from Petpooja for all active branches in parallel chunks.
 */
export async function syncAllBranchesPetpoojaMenu(): Promise<{
  syncedBranches: number;
}> {
  const branchesSnap = await db.collection("branches").where("active", "==", true).get();
  let syncedBranches = 0;

  const branchDocs = branchesSnap.docs;
  const CHUNK_SIZE = 4;

  for (let i = 0; i < branchDocs.length; i += CHUNK_SIZE) {
    const chunk = branchDocs.slice(i, i + CHUNK_SIZE);
    const results = await Promise.allSettled(
      chunk.map((doc: any) => syncPetpoojaMenu(doc.id))
    );

    for (let j = 0; j < results.length; j++) {
      const res = results[j];
      const doc = chunk[j];
      if (res.status === "fulfilled") {
        syncedBranches++;
      } else {
        console.error(`[Petpooja Menu Scheduler] Failed for branch ${doc.id}:`, res.reason);
      }
    }
  }

  return { syncedBranches };
}

/**
 * Worker to retry failed Petpooja KOT order pushes with exponential backoff.
 */
export async function retryPendingPetpoojaOrdersWorker(): Promise<{
  retriedCount: number;
  failedCount: number;
}> {
  const pendingOrdersSnap = await db
    .collection("orders")
    .where("petpoojaStatus", "==", "pending_retry")
    .where("petpoojaRetryCount", "<=", 3)
    .limit(20)
    .get();

  let retriedCount = 0;

  let failedCount = 0;

  for (const doc of pendingOrdersSnap.docs) {
    try {
      // One bad order must not abort the remaining batch.
      const success = await pushOrderToPetpooja(doc.id);
      if (success) {
        retriedCount++;
      } else {
        failedCount++;
      }
    } catch (err: any) {
      failedCount++;
      console.warn(`[Petpooja Retry Worker] Order ${doc.id} threw, continuing batch:`, err?.message || err);
    }
  }

  // Dead-letter: retries exhausted (>3) would otherwise sit as pending_retry
  // forever, invisible. Flip them to failed with an audit snapshot.
  try {
    const exhaustedSnap = await db
      .collection("orders")
      .where("petpoojaStatus", "==", "pending_retry")
      .where("petpoojaRetryCount", ">", 3)
      .limit(20)
      .get();
    const { captureErrorSnapshot } = await import("../../core/errors");
    for (const doc of exhaustedSnap.docs) {
      await doc.ref.set(
        { petpoojaStatus: "failed", updatedAt: new Date().toISOString() },
        { merge: true }
      );
      await captureErrorSnapshot({
        source: "petpooja",
        severity: "high",
        message: `KOT push retries exhausted for order ${doc.id} — manual KOT entry required`,
        orderId: doc.id,
      });
      failedCount++;
    }
  } catch (err: any) {
    console.warn("[Petpooja Retry Worker] dead-letter pass failed:", err?.message || err);
  }

  return { retriedCount, failedCount };
}

