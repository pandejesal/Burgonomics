import { db } from "../../core/firebase";
import { syncPetpoojaMenu, pushOrderToPetpooja } from "./petpooja.service";

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
}> {
  const pendingOrdersSnap = await db
    .collection("orders")
    .where("petpoojaStatus", "==", "pending_retry")
    .where("petpoojaRetryCount", "<=", 3)
    .limit(20)
    .get();

  let retriedCount = 0;

  for (const doc of pendingOrdersSnap.docs) {
    const success = await pushOrderToPetpooja(doc.id);
    if (success) {
      retriedCount++;
    }
  }

  return { retriedCount };
}
