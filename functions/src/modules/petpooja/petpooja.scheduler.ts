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
  // Single scan (single-field where, no composite needed): split retryable
  // vs exhausted in memory instead of scanning the collection twice.
  const pendingOrdersSnap = await db
    .collection("orders")
    .where("petpoojaStatus", "==", "pending_retry")
    .limit(40)
    .get();

  let retriedCount = 0;

  let failedCount = 0;

  // Bounded concurrency: each push is 1 read + 1 external POST + writes, so
  // 20 serial pushes stall the 5-min scheduler ~10-60s exactly when the POS
  // is down and the queue is fullest. One bad order still never aborts rest.
  const CHUNK_SIZE = 4;
  const pendingDocs = pendingOrdersSnap.docs.filter(
    (doc: any) => Number(doc.data()?.petpoojaRetryCount || 0) <= 3
  );
  const exhaustedDocs = pendingOrdersSnap.docs.filter(
    (doc: any) => Number(doc.data()?.petpoojaRetryCount || 0) > 3
  );
  for (let i = 0; i < pendingDocs.length; i += CHUNK_SIZE) {
    const chunk = pendingDocs.slice(i, i + CHUNK_SIZE);
    const results = await Promise.allSettled(chunk.map((doc: any) => pushOrderToPetpooja(doc.id)));
    for (let j = 0; j < results.length; j++) {
      const res = results[j];
      if (res.status === "fulfilled" && res.value) {
        retriedCount++;
      } else {
        failedCount++;
        if (res.status === "rejected") {
          console.warn(
            `[Petpooja Retry Worker] Order ${chunk[j].id} threw, continuing batch:`,
            res.reason?.message || res.reason
          );
        }
      }
    }
  }

  // Dead-letter: retries exhausted (>3) would otherwise sit as pending_retry
  // forever, invisible. Flip them to failed with an audit snapshot. Folded
  // into the same scan above — no second collection pass.
  if (exhaustedDocs.length > 0) {
    try {
      const { captureErrorSnapshot } = await import("../../core/errors");
      for (const doc of exhaustedDocs) {
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
  }

  return { retriedCount, failedCount };
}

