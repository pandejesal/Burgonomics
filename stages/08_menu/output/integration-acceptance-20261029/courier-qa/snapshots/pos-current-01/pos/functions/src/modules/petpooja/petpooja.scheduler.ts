import { db } from "../../core/firebase";
import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import { captureErrorSnapshot } from "../../core/errors";
import { syncPetpoojaMenu } from "./menuSyncWebhook";
import {
  RECONCILIATION_REQUIRED,
  SEND_INTENT_AMBIGUOUS,
  SEND_INTENT_PROVABLY_UNSENT,
  isPetpoojaPushBlocked,
  isProvablyUnsentPetpoojaRetry,
  pushOrderToPetpooja,
} from "./orderPush";
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

  let retriedCount = 0;

  let failedCount = 0;

  const snapshotDocs: any[] = pendingOrdersSnap.docs || [];
  // Skip empty ticks: nothing pending → no claim transaction, no writes.
  if (snapshotDocs.length === 0) {
    return { retriedCount, failedCount };
  }

  // Claim-then-work: overlapping 5-min scheduler instances used to push the
  // same KOT twice (no lease, just a shared pending_retry flag). Claims flip
  // to `processing` inside one transaction; a FRESH lease owned elsewhere is
  // skipped. Claims are never taken over on TTL alone — see the legacy rule.
  const CLAIM_TTL_MS = 10 * 60 * 1000;
  const retryCountOf = (doc: any) => Number(doc.data()?.petpoojaRetryCount || 0);
  const isAccepted = (data: any) =>
    !!(data?.petpoojaOrderId || data?.petpoojaAcceptedNoId);

  // POSITIVE retry-safety marker only. A pending_retry row left by the old
  // code has no marker even though its timeout/5xx may have reached the POS;
  // absence of an ambiguity flag is NOT proof that nothing was sent.
  const retryableDocs = snapshotDocs.filter(
    (doc: any) =>
      retryCountOf(doc) <= 3 && isProvablyUnsentPetpoojaRetry(doc.data())
  );

  // Anything in pending_retry that is neither accepted, already parked, nor
  // positively proven pre-send is quarantined. This covers legacy rows from
  // the old post-send retry lane and stale timestamp-only claims.
  const quarantineDocs = snapshotDocs.filter((doc: any) => {
    const data = doc.data();
    if (!data || data.petpoojaStatus !== "pending_retry") return false;
    if (isAccepted(data)) return false;
    if (isPetpoojaPushBlocked(data)) return false;
    return !isProvablyUnsentPetpoojaRetry(data);
  });

  // Only provably-unsent rows may be dead-lettered (and told to enter the KOT
  // manually). A possibly-sent row must never receive that instruction.
  const deadLetterDocs = snapshotDocs.filter(
    (doc: any) =>
      retryCountOf(doc) > 3 && isProvablyUnsentPetpoojaRetry(doc.data())
  );

  let claimedDocs: any[] = [];
  if (retryableDocs.length > 0) {
    if (!db || typeof (db as any).runTransaction !== "function") {
      // Fail closed: without a transaction there is no atomic claim, and a
      // blind batch POST risks duplicate KOTs.
      logger.warn(
        "[Petpooja Retry Worker] runTransaction unavailable — refusing to claim retries (fail-closed)"
      );
      return { retriedCount, failedCount };
    }
    try {
      claimedDocs = await (db as any).runTransaction(async (tx: any) => {
        // Firestore forbids reading after ANY write inside one transaction.
        // Read every candidate first, then apply the claim writes.
        const reads: Array<{ doc: any; data: any }> = [];
        for (const doc of retryableDocs) {
          const fresh = await tx.get(doc.ref);
          reads.push({
            doc,
            data: (fresh.exists ? fresh.data() : undefined) as any,
          });
        }

        const won: any[] = [];
        for (const { doc, data } of reads) {
          if (!data || data.petpoojaStatus !== "pending_retry") continue;
          if (isPetpoojaPushBlocked(data)) continue;
          if (!isProvablyUnsentPetpoojaRetry(data)) continue;
          // Numeric-first lease read: serverTimestamp sentinels have no
          // toMillis and read as 0 (instant false takeover → double POST).
          const claimedRaw = data.petpoojaClaimedAt;
          const claimedAt =
            typeof claimedRaw === "number" && Number.isFinite(claimedRaw)
              ? claimedRaw
              : claimedRaw && typeof claimedRaw.toMillis === "function"
                ? claimedRaw.toMillis()
                : 0;
          if (data.petpoojaClaimedAt && Date.now() - claimedAt < CLAIM_TTL_MS) continue;
          // A stale lease is only takeover-able for a POSITIVELY provably
          // unsent row (checked above). Legacy timestamp-only claims are
          // quarantined by the filter, never claimed.
          tx.set(
            doc.ref,
            {
              petpoojaStatus: "processing",
              petpoojaClaimedAt: Date.now(),
            },
            { merge: true }
          );
          won.push(doc);
        }
        return won;
      });
    } catch (err: any) {
      logger.warn(
        "[Petpooja Retry Worker] claim transaction failed, skipping tick:",
        err?.message || err
      );
      return { retriedCount, failedCount };
    }
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
          logger.warn(
            `[Petpooja Retry Worker] Order ${chunk[j].id} threw, continuing batch:`,
            res.reason?.message || res.reason
          );
        }
      }
    }
  }

  // Quarantine: unknown legacy outcomes become manual reconciliation. No POST,
  // and NO "enter manually" notification (the POS may already hold the KOT).
  for (const doc of quarantineDocs) {
    const quarantined = await quarantineUnknownOutcome(doc);
    if (quarantined) {
      failedCount++;
      await captureErrorSnapshot({
        source: "petpooja",
        severity: "high",
        message:
          `KOT sync outcome UNKNOWN for legacy order ${doc.id} — quarantined in ` +
          `${RECONCILIATION_REQUIRED}; verify in Petpooja, do NOT resend or re-enter blind`,
        orderId: doc.id,
      }).catch(() => undefined);
    }
  }

  // Dead-letter ONLY provably-unsent rows, inside a fresh transaction so a
  // concurrent acceptance/reconciliation can never be overwritten and no
  // "enter manually" FCM is sent for a possibly-sent order.
  for (const doc of deadLetterDocs) {
    const outcome = await deadLetterProvablyUnsent(doc);
    if (!outcome.deadLettered) continue;

    failedCount++;
    // Neutral copy only. This runs after an awaited snapshot write, so by now
    // a new direct attempt may exist; never claim the order was "never sent"
    // nor instruct manual re-entry. The advisory asks the branch to verify.
    await captureErrorSnapshot({
      source: "petpooja",
      severity: "high",
      message:
        `KOT relay retries exhausted for order ${doc.id} — POS relay requires review; ` +
        `verify the POS/order attempt before any re-entry`,
      orderId: doc.id,
    }).catch(() => undefined);

    // Fence the notification against work that landed during the snapshot
    // await: skip if the order was accepted, a newer attempt exists, the
    // status moved, or a fresh unresolved intent is present.
    const obsolete = await isDeadLetterNotificationObsolete(doc.id, outcome.attemptId);
    if (obsolete) {
      logger.warn(
        `[Petpooja Retry Worker] Skipped stale dead-letter notification for order ${doc.id} — state moved during snapshot capture`
      );
      continue;
    }

    if (typeof outcome.branchId === "string" && outcome.branchId) {
      try {
        await dispatchFCM({
          topic: `branch_${outcome.branchId}_orders`,
          title: "POS relay requires review",
          body: `Order #${doc.id.substring(0, 6)} — POS relay retries are exhausted. Verify the order/attempt in Petpooja before any re-entry.`,
          data: { type: "kot_sync_failed", orderId: doc.id },
        });
      } catch (fcmErr: any) {
        logger.warn(
          "[Petpooja Retry Worker] KOT-failed branch alert failed:",
          fcmErr?.message || fcmErr
        );
      }
    }
  }

  return { retriedCount, failedCount };
}

/**
 * Freshly re-checks a pending_retry row and parks it for manual reconciliation
 * when the prior attempt cannot be proven pre-send. Refuses to touch accepted,
 * already-parked, or freshly-changed rows. No POST, no "enter manually" FCM.
 */
async function quarantineUnknownOutcome(doc: any): Promise<boolean> {
  if (!db || typeof (db as any).runTransaction !== "function") return false;
  try {
    return await (db as any).runTransaction(async (tx: any) => {
      const fresh = await tx.get(doc.ref);
      const data = (fresh.exists ? fresh.data() : undefined) as any;
      if (!data || data.petpoojaStatus !== "pending_retry") return false;
      if (data.petpoojaOrderId || data.petpoojaAcceptedNoId) return false;
      if (isPetpoojaPushBlocked(data)) return false;
      if (isProvablyUnsentPetpoojaRetry(data)) return false;
      tx.set(
        doc.ref,
        {
          petpoojaStatus: RECONCILIATION_REQUIRED,
          petpoojaSyncStatus: RECONCILIATION_REQUIRED,
          petpoojaAmbiguousSend: true,
          petpoojaAmbiguousAt: admin.firestore.FieldValue.serverTimestamp(),
          petpoojaUnresolvedIntent: true,
          petpoojaSendIntentState: SEND_INTENT_AMBIGUOUS,
          petpoojaLegacyOutcomeUnknown: true,
          lastPetpoojaError:
            "Legacy pending_retry has no provable pre-send evidence — quarantined; verify in Petpooja before any resend",
          petpoojaClaimedAt: null,
          kotSyncFailed: true,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      return true;
    });
  } catch (err: any) {
    logger.warn(
      `[Petpooja Retry Worker] quarantine failed for order ${doc.id}:`,
      err?.message || err
    );
    return false;
  }
}

/**
 * Dead-letters ONLY a row that is still pending_retry, still positively
 * provably pre-send, and still not accepted/parked at commit time.
 */
async function deadLetterProvablyUnsent(
  doc: any
): Promise<{ deadLettered: boolean; branchId?: string; attemptId?: string }> {
  if (!db || typeof (db as any).runTransaction !== "function") {
    return { deadLettered: false };
  }
  try {
    return await (db as any).runTransaction(async (tx: any) => {
      const fresh = await tx.get(doc.ref);
      const data = (fresh.exists ? fresh.data() : undefined) as any;
      if (!data || data.petpoojaStatus !== "pending_retry") {
        return { deadLettered: false };
      }
      if (data.petpoojaOrderId || data.petpoojaAcceptedNoId) {
        return { deadLettered: false };
      }
      if (isPetpoojaPushBlocked(data)) return { deadLettered: false };
      if (!isProvablyUnsentPetpoojaRetry(data)) return { deadLettered: false };
      if (Number(data.petpoojaRetryCount || 0) <= 3) {
        return { deadLettered: false };
      }

      tx.set(
        doc.ref,
        {
          petpoojaStatus: "failed",
          petpoojaSyncStatus: "failed",
          kotSyncFailed: true,
          petpoojaUnresolvedIntent: false,
          petpoojaSendIntentState: SEND_INTENT_PROVABLY_UNSENT,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      return {
        deadLettered: true,
        branchId: typeof data.branchId === "string" ? data.branchId : undefined,
        attemptId:
          typeof data.petpoojaAttemptId === "string" ? data.petpoojaAttemptId : undefined,
      };
    });
  } catch (err: any) {
    logger.warn(
      `[Petpooja Retry Worker] dead-letter failed for order ${doc.id}:`,
      err?.message || err
    );
    return { deadLettered: false };
  }
}

/**
 * Re-reads the order immediately before any dead-letter notification. Returns
 * true when work landed during the awaited snapshot write (acceptance, a newer
 * attempt, a fresh unresolved intent, or a moved status) — the advisory must
 * not be sent. Unreadable state fails closed (no notification).
 */
async function isDeadLetterNotificationObsolete(
  orderId: string,
  attemptIdAtDeadLetter?: string
): Promise<boolean> {
  try {
    const snap = await db.collection("orders").doc(orderId).get();
    const data = snap.exists ? ((snap.data() as any) ?? undefined) : undefined;
    if (!data) return true;
    if (data.petpoojaOrderId || data.petpoojaAcceptedNoId) return true;
    if (data.petpoojaUnresolvedIntent === true) return true;
    if (data.petpoojaStatus !== "failed") return true;
    if (
      attemptIdAtDeadLetter &&
      typeof data.petpoojaAttemptId === "string" &&
      data.petpoojaAttemptId !== attemptIdAtDeadLetter
    ) {
      return true;
    }
    return false;
  } catch {
    return true;
  }
}

