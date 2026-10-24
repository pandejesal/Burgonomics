import { db } from "../../core/firebase";
import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import { syncPetpoojaMenu } from "./menuSyncWebhook";
import { pushOrderToPetpooja, wasPushDeferredBusy } from "./orderPush";
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
        logger.error(`[Petpooja Menu Scheduler] Failed for branch ${doc.id}:`, res.reason);
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
  let retriedCount = 0;
  let failedCount = 0;
  const CLAIM_TTL_MS = 10 * 60 * 1000;

  // 1. Crash visibility scan (Finding 6): detect stale 'processing' orders where
  // a pusher may have crashed mid-flight or timed out during vendor POST.
  // Ambiguous POST outcomes are parked clearly for manual reconciliation with
  // kotSyncFailed: true, with NO new provider POST.
  try {
    const processingSnap = await db
      .collection("orders")
      .where("petpoojaStatus", "==", "processing")
      .limit(50)
      .get();

    const processingDocs = processingSnap.docs || [];
    for (const procDoc of processingDocs) {
      const data = procDoc.data() || {};
      const claimedRaw = data.petpoojaClaimedAt;
      const claimedAt =
        typeof claimedRaw === "number" && Number.isFinite(claimedRaw)
          ? claimedRaw
          : claimedRaw && typeof claimedRaw.toMillis === "function"
            ? claimedRaw.toMillis()
            : 0;
      const isStale = !claimedAt || (Date.now() - claimedAt >= CLAIM_TTL_MS);
      if (!isStale) {
        // Active in-flight push or live competitor — do not touch
        continue;
      }

      // Fresh transaction recheck before parking for manual reconciliation
      let parkResult: "parked" | "skipped" = "skipped";
      if (db && typeof (db as any).runTransaction === "function") {
        try {
          parkResult = await (db as any).runTransaction(async (tx: any) => {
            const fresh = await tx.get(procDoc.ref);
            const freshData = (fresh.exists ? fresh.data() : undefined) as any;
            if (!freshData) return "skipped";

            // If an accepted racer won, never overwrite success!
            if (
              freshData.petpoojaOrderId ||
              freshData.petpoojaAcceptedNoId ||
              freshData.petpoojaStatus === "synced"
            ) {
              return "skipped";
            }

            // If the status has moved away from processing
            if (freshData.petpoojaStatus !== "processing") {
              return "skipped";
            }

            // Check if competitor renewed lease
            const freshClaimedRaw = freshData.petpoojaClaimedAt;
            const freshClaimedAt =
              typeof freshClaimedRaw === "number" && Number.isFinite(freshClaimedRaw)
                ? freshClaimedRaw
                : freshClaimedRaw && typeof freshClaimedRaw.toMillis === "function"
                  ? freshClaimedRaw.toMillis()
                  : 0;
            const freshPushClaimedRaw = freshData.petpoojaPushClaimedAt;
            const freshPushClaimedAt =
              typeof freshPushClaimedRaw === "number" && Number.isFinite(freshPushClaimedRaw)
                ? freshPushClaimedRaw
                : freshPushClaimedRaw && typeof freshPushClaimedRaw.toMillis === "function"
                  ? freshPushClaimedRaw.toMillis()
                  : 0;
            if (
              (freshData.petpoojaClaimedAt && Date.now() - freshClaimedAt < CLAIM_TTL_MS) ||
              (freshData.petpoojaPushClaimedAt && Date.now() - freshPushClaimedAt < CLAIM_TTL_MS)
            ) {
              return "skipped";
            }

            // Ambiguous post-crash state: park for manual reconciliation, NO new provider POST!
            tx.set(
              procDoc.ref,
              {
                petpoojaStatus: "reconciliation_required",
                petpoojaSyncStatus: "reconciliation_required",
                kotSyncFailed: true,
                petpoojaAmbiguousProcessing: true,
                petpoojaClaimedAt: null,
                petpoojaPushClaimedAt: null,
                lastPetpoojaError:
                  "Processing claim expired (potential crash during vendor POST) — parked for manual reconciliation to prevent duplicate KOT",
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              },
              { merge: true }
            );
            return "parked";
          });
        } catch (txErr: any) {
          logger.warn(
            `[Petpooja Retry Worker] Transaction recheck failed for stale processing order ${procDoc.id}:`,
            txErr?.message || txErr
          );
        }
      } else {
        // Fallback for datastores without runTransaction: mark reconciliation_required directly so they are not silently stranded
        try {
          const freshSnap = await procDoc.ref.get();
          const freshData = freshSnap && freshSnap.exists ? freshSnap.data() : data;
          if (
            freshData &&
            !freshData.petpoojaOrderId &&
            !freshData.petpoojaAcceptedNoId &&
            freshData.petpoojaStatus !== "synced" &&
            freshData.petpoojaStatus === "processing"
          ) {
            const freshClaimedRaw = freshData.petpoojaClaimedAt;
            const freshClaimedAt =
              typeof freshClaimedRaw === "number" && Number.isFinite(freshClaimedRaw)
                ? freshClaimedRaw
                : freshClaimedRaw && typeof freshClaimedRaw.toMillis === "function"
                  ? freshClaimedRaw.toMillis()
                  : 0;
            const freshPushClaimedRaw = freshData.petpoojaPushClaimedAt;
            const freshPushClaimedAt =
              typeof freshPushClaimedRaw === "number" && Number.isFinite(freshPushClaimedRaw)
                ? freshPushClaimedRaw
                : freshPushClaimedRaw && typeof freshPushClaimedRaw.toMillis === "function"
                  ? freshPushClaimedRaw.toMillis()
                  : 0;
            const isActive =
              (freshData.petpoojaClaimedAt && Date.now() - freshClaimedAt < CLAIM_TTL_MS) ||
              (freshData.petpoojaPushClaimedAt && Date.now() - freshPushClaimedAt < CLAIM_TTL_MS);
            if (!isActive) {
              await procDoc.ref.set(
                {
                  petpoojaStatus: "reconciliation_required",
                  petpoojaSyncStatus: "reconciliation_required",
                  kotSyncFailed: true,
                  petpoojaAmbiguousProcessing: true,
                  petpoojaClaimedAt: null,
                  petpoojaPushClaimedAt: null,
                  lastPetpoojaError:
                    "Processing claim expired (potential crash during vendor POST) — parked for manual reconciliation to prevent duplicate KOT",
                  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                },
                { merge: true }
              );
              parkResult = "parked";
            }
          }
        } catch (fbErr: any) {
          logger.warn(
            `[Petpooja Retry Worker] Non-tx fallback failed for stale processing order ${procDoc.id}:`,
            fbErr?.message || fbErr
          );
        }
      }

      if (parkResult === "parked") {
        failedCount++;
        try {
          const { captureErrorSnapshot } = await import("../../core/errors");
          await captureErrorSnapshot({
            source: "petpooja",
            severity: "high",
            message: `Stale processing claim detected for order ${procDoc.id} — ambiguous POST outcome parked for manual reconciliation without re-push`,
            orderId: procDoc.id,
          });
        } catch {}
      }
    }
  } catch (procScanErr: any) {
    logger.warn("[Petpooja Retry Worker] stale processing scan failed:", procScanErr?.message || procScanErr);
  }

  // 2. Scan pending_retry orders
  // Single scan (single-field where, no composite needed): split retryable
  // vs exhausted in memory instead of scanning the collection twice.
  // Oldest-first with a 100-doc window: the old unordered limit(40) could
  // starve retryable orders sitting behind exhausted ones forever.
  // Requires the (petpoojaStatus, createdAt) composite in
  // firestore.indexes.json.
  const pendingOrdersSnap = await db
    .collection("orders")
    .where("petpoojaStatus", "==", "pending_retry")
    .orderBy("createdAt", "asc")
    .limit(100)
    .get();

  // Skip empty ticks: nothing pending → no claim transaction, no writes.
  if ((pendingOrdersSnap.docs || []).length === 0) {
    return { retriedCount, failedCount };
  }

  // Claim-then-work: overlapping 5-min scheduler instances used to push the
  // same KOT twice (no lease, just a shared pending_retry flag). Claims flip
  // to `processing` inside one transaction; stale claims (>10 min, crashed
  // worker) are take-over-able. pushOrderToPetpooja releases the claim by
  // writing synced/pending_retry itself.
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
        // Phase 1 (Finding 4): Read ALL candidate snapshots before ANY writes.
        // Real Firestore strictly rejects tx.get() calls after tx.set() / tx.update().
        const readEntries: Array<{ doc: any; freshSnap: any }> = [];
        for (const doc of pendingDocs) {
          const freshSnap = await tx.get(doc.ref);
          readEntries.push({ doc, freshSnap });
        }

        // Phase 2: Evaluate snapshots and execute claim writes.
        const won: any[] = [];
        const now = Date.now();
        for (const { doc, freshSnap } of readEntries) {
          const data = (freshSnap.exists ? freshSnap.data() : undefined) as any;
          if (!data || data.petpoojaStatus !== "pending_retry") continue;

          // Fresh claim owned elsewhere — skip. Stale (>TTL, crashed worker)
          // or never-claimed docs are take-over-able. Numeric-first lease
          // read: serverTimestamp sentinels have no toMillis and read as 0
          // (instant false takeover → double KOT POST).
          const claimedRaw = data.petpoojaClaimedAt;
          const claimedAt =
            typeof claimedRaw === "number" && Number.isFinite(claimedRaw)
              ? claimedRaw
              : claimedRaw && typeof claimedRaw.toMillis === "function"
                ? claimedRaw.toMillis()
                : 0;
          if (data.petpoojaClaimedAt && now - claimedAt < CLAIM_TTL_MS) continue;

          // Also respect active in-flight pusher lease so we never race or clobber an active competitor
          const pushClaimedRaw = data.petpoojaPushClaimedAt;
          const pushClaimedAt =
            typeof pushClaimedRaw === "number" && Number.isFinite(pushClaimedRaw)
              ? pushClaimedRaw
              : pushClaimedRaw && typeof pushClaimedRaw.toMillis === "function"
                ? pushClaimedRaw.toMillis()
                : 0;
          if (data.petpoojaPushClaimedAt && now - pushClaimedAt < CLAIM_TTL_MS) continue;

          tx.set(
            doc.ref,
            {
              petpoojaStatus: "processing",
              petpoojaClaimedAt: now,
            },
            { merge: true }
          );
          won.push(doc);
        }
        return won;
      });
      claimedDocs.push(...claimed);
    } catch (err: any) {
      logger.warn("[Petpooja Retry Worker] claim transaction failed, skipping tick:", err?.message || err);
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
      const doc = chunk[j];
      if (res.status === "fulfilled" && res.value) {
        retriedCount++;
      } else {
        let isBusyDeferred = false;
        if (res.status === "fulfilled" && !res.value) {
          if (wasPushDeferredBusy(doc.id)) {
            isBusyDeferred = true;
          } else {
            try {
              const freshSnap = await doc.ref.get();
              const freshData = freshSnap?.data() || {};
              const pushClaimedRaw = freshData.petpoojaPushClaimedAt;
              const pushClaimedAt =
                typeof pushClaimedRaw === "number" && Number.isFinite(pushClaimedRaw)
                  ? pushClaimedRaw
                  : pushClaimedRaw && typeof pushClaimedRaw.toMillis === "function"
                    ? pushClaimedRaw.toMillis()
                    : 0;
              if (freshData.petpoojaPushClaimedAt && Date.now() - pushClaimedAt < CLAIM_TTL_MS) {
                isBusyDeferred = true;
              }
            } catch {}
          }
        }
        if (isBusyDeferred) {
          logger.info(
            `[Petpooja Retry Worker] Order ${doc.id} push deferred due to in-flight push, skipping failedCount increment`
          );
        } else {
          failedCount++;
          if (res.status === "rejected") {
            logger.warn(
              `[Petpooja Retry Worker] Order ${chunk[j].id} threw, continuing batch:`,
              res.reason?.message || res.reason
            );
          // Release owned scheduler claim on unexpected thrown errors so the doc is not stranded
          // in "processing", without clobbering another owner's current push, accepted ID,
          // successful state, retry counts or active lease.
          try {
            if (db && typeof (db as any).runTransaction === "function") {
              await (db as any).runTransaction(async (tx: any) => {
                const fresh = await tx.get(doc.ref);
                const data = (fresh.exists ? fresh.data() : undefined) as any;
                if (!data) return;
                if (data.petpoojaOrderId || data.petpoojaAcceptedNoId || data.petpoojaStatus === "synced") return;
                const activePushRaw = data.petpoojaPushClaimedAt;
                const activePushAt =
                  typeof activePushRaw === "number" && Number.isFinite(activePushRaw)
                    ? activePushRaw
                    : activePushRaw && typeof activePushRaw.toMillis === "function"
                      ? activePushRaw.toMillis()
                      : 0;
                if (data.petpoojaPushClaimedAt && Date.now() - activePushAt < CLAIM_TTL_MS) return;
                if (data.petpoojaStatus === "processing") {
                  tx.set(
                    doc.ref,
                    {
                      petpoojaStatus: "pending_retry",
                      petpoojaSyncStatus: "pending_retry",
                      petpoojaClaimedAt: null,
                      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                    },
                    { merge: true }
                  );
                }
              });
            }
          } catch (relErr: any) {
            logger.warn(`[Petpooja Retry Worker] Failed to release claim for threw order ${chunk[j].id}:`, relErr);
          }
        }
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
        // K2 stress sweep: re-read INSIDE a transaction before the dead-letter
        // write. The scan snapshot is minutes old — a direct push or an
        // in-flight worker may have synced this order meanwhile, and a plain
        // `failed` merge over `synced` (plus its "enter manually" branch
        // alert) would mint a duplicate kitchen ticket.
        let deadLetterOutcome: "wrote" | "skipped" = "skipped";
        if (db && typeof (db as any).runTransaction === "function") {
          try {
            deadLetterOutcome = await (db as any).runTransaction(async (tx: any) => {
              const fresh = await tx.get(doc.ref);
              const freshData = (fresh.exists ? fresh.data() : undefined) as any;
              if (
                freshData?.petpoojaOrderId ||
                freshData?.petpoojaAcceptedNoId ||
                freshData?.petpoojaStatus === "synced"
              ) {
                return "skipped" as const;
              }
              // kotSyncFailed is the visible flag: partner KDS reads Firestore (not
              // the POS), so the kitchen still sees the order — what failed is the
              // POS/billing sync, and the branch must enter the KOT manually.
              tx.set(
                doc.ref,
                {
                  petpoojaStatus: "failed",
                  kotSyncFailed: true,
                  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                },
                { merge: true }
              );
              return "wrote" as const;
            });
          } catch (txErr: any) {
            logger.warn(
              "[Petpooja Retry Worker] dead-letter recheck failed:",
              txErr?.message || txErr
            );
            continue;
          }
        } else {
          // R2 reviewer fix: with no transaction-capable db, the old default
          // ("wrote") never actually wrote — the order stayed pending_retry
          // forever while ops was already told "manual KOT entry required".
          // Best-effort plain merge flip so KDS sees kotSyncFailed; racers
          // could theoretically clobber a win here, but without runTransaction
          // there is no safe alternative, and fail-closed beats silent-skip.
          await doc.ref.set(
            {
              petpoojaStatus: "failed",
              kotSyncFailed: true,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
          deadLetterOutcome = "wrote";
        }
        if (deadLetterOutcome === "skipped") continue;
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
            logger.warn("[Petpooja Retry Worker] KOT-failed branch alert failed:", fcmErr?.message || fcmErr);
          }
        }
        failedCount++;
      }
    } catch (err: any) {
      logger.warn("[Petpooja Retry Worker] dead-letter pass failed:", err?.message || err);
    }
  }

  return { retriedCount, failedCount };
}

