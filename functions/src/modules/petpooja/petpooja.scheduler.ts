import { db } from "../../core/firebase";
import * as admin from "firebase-admin";
import { syncPetpoojaMenu } from "./menuSyncWebhook";
import { pushOrderToPetpooja } from "./orderPush";
import { dispatchFCM } from "../notifications/fcm.service";

/**
 * Hourly Cron job to sync menus from Petpooja for all active branches in parallel chunks.
 *
 * Paginated (B4-S1, H10/M30): the old unbounded `branches` scan loaded every
 * outlet into memory each tick. Pages of 100 via startAfter when the
 * datastore supports it, else one bounded page of 100. Empty ticks return
 * immediately without fanning out any sync work (M31).
 */
export async function syncAllBranchesPetpoojaMenu(): Promise<{
  syncedBranches: number;
}> {
  const PAGE_SIZE = 100;
  const branchDocs: any[] = [];
  const baseQuery = db.collection("branches").where("active", "==", true) as any;

  if (typeof baseQuery.orderBy === "function") {
    let lastDoc: any = null;
    for (;;) {
      let pageQuery = baseQuery.orderBy("__name__").limit(PAGE_SIZE);
      if (lastDoc && typeof pageQuery.startAfter === "function") {
        pageQuery = pageQuery.startAfter(lastDoc);
      }
      const snap = await pageQuery.get();
      const docs = snap.docs || [];
      branchDocs.push(...docs);
      if (docs.length < PAGE_SIZE) break;
      lastDoc = docs[docs.length - 1];
      if (!lastDoc || typeof pageQuery.startAfter !== "function") break;
    }
  } else {
    const snap = await baseQuery.limit(PAGE_SIZE).get();
    branchDocs.push(...(snap.docs || []));
  }

  // Skip empty ticks: no active branches → no sync fan-out, no writes.
  if (branchDocs.length === 0) {
    return { syncedBranches: 0 };
  }

  let syncedBranches = 0;

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

  // Skip empty ticks: nothing pending → no claim transaction, no writes.
  if ((pendingOrdersSnap.docs || []).length === 0) {
    return { retriedCount, failedCount };
  }

  // Claim-then-work: overlapping 5-min scheduler instances used to push the
  // same KOT twice (no lease, just a shared pending_retry flag). Claims flip
  // to `processing` inside one transaction; stale claims (>10 min, crashed
  // worker) are take-over-able. pushOrderToPetpooja releases the claim by
  // writing synced/pending_retry itself.
  const CLAIM_TTL_MS = 10 * 60 * 1000;
  const pendingDocs = pendingOrdersSnap.docs.filter(
    (doc: any) => Number(doc.data()?.petpoojaRetryCount || 0) <= 3
  );
  const exhaustedDocs = pendingOrdersSnap.docs.filter(
    (doc: any) => Number(doc.data()?.petpoojaRetryCount || 0) > 3
  );
  const claimedDocs: any[] = [];
  if (pendingDocs.length > 0 && db && typeof (db as any).runTransaction === "function") {
    try {
      const claimed: any[] = await (db as any).runTransaction(async (tx: any) => {
        const won: any[] = [];
        for (const doc of pendingDocs) {
          const fresh = await tx.get(doc.ref);
          const data = (fresh.exists ? fresh.data() : undefined) as any;
          if (!data || data.petpoojaStatus !== "pending_retry") continue;
          // Fresh claim owned elsewhere — skip. Stale (>TTL, crashed worker)
          // or never-claimed docs are take-over-able.
          const claimedAt =
            data.petpoojaClaimedAt && typeof data.petpoojaClaimedAt.toMillis === "function"
              ? data.petpoojaClaimedAt.toMillis()
              : 0;
          if (data.petpoojaClaimedAt && Date.now() - claimedAt < CLAIM_TTL_MS) continue;
          tx.set(
            doc.ref,
            {
              petpoojaStatus: "processing",
              petpoojaClaimedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
          won.push(doc);
        }
        return won;
      });
      claimedDocs.push(...claimed);
    } catch (err: any) {
      console.warn("[Petpooja Retry Worker] claim transaction failed, skipping tick:", err?.message || err);
      return { retriedCount, failedCount };
    }
  } else {
    claimedDocs.push(...pendingDocs);
  }

  // Bounded concurrency over CLAIMED docs only (see lease above): each push
  // is 1 read + 1 external POST + writes, so 20 serial pushes stall the 5-min
  // scheduler ~10-60s exactly when the POS is down and the queue is fullest.
  // One bad order still never aborts rest.
  const CHUNK_SIZE = 4;
  for (let i = 0; i < claimedDocs.length; i += CHUNK_SIZE) {
    const chunk = claimedDocs.slice(i, i + CHUNK_SIZE);
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
        // kotSyncFailed is the visible flag: partner KDS reads Firestore (not
        // the POS), so the kitchen still sees the order — what failed is the
        // POS/billing sync, and the branch must enter the KOT manually.
        await doc.ref.set(
          {
            petpoojaStatus: "failed",
            kotSyncFailed: true,
            updatedAt: new Date().toISOString(),
          },
          { merge: true }
        );
        await captureErrorSnapshot({
          source: "petpooja",
          severity: "high",
          message: `KOT push retries exhausted for order ${doc.id} — manual KOT entry required`,
          orderId: doc.id,
        });
        const branchId = doc.data()?.branchId;
        if (typeof branchId === "string" && branchId) {
          try {
            await dispatchFCM({
              topic: `branch_${branchId}_orders`,
              title: "KOT sync failed — enter manually",
              body: `Order #${doc.id.substring(0, 6)} is confirmed but POS sync failed after retries. Enter the KOT in Petpooja by hand.`,
              data: { type: "kot_sync_failed", orderId: doc.id },
            });
          } catch (fcmErr: any) {
            console.warn("[Petpooja Retry Worker] KOT-failed branch alert failed:", fcmErr?.message || fcmErr);
          }
        }
        failedCount++;
      }
    } catch (err: any) {
      console.warn("[Petpooja Retry Worker] dead-letter pass failed:", err?.message || err);
    }
  }

  return { retriedCount, failedCount };
}

