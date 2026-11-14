import { db } from "../../core/firebase";
import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import { syncPetpoojaMenu } from "./menuSyncWebhook";
import {
  pushOrderToPetpooja,
  wasPushDeferredBusy,
  isCancelledOrTerminal,
  terminalOrderRetirementPatch,
  hasRecordedPosAcceptance,
  classifyPushClaim,
  unresolvedPriorSendParkPatch,
  PETPOOJA_PUSH_CLAIM_TTL_MS,
} from "./orderPush";
import { isPetpoojaEnabled } from "./client";
import { dispatchFCM } from "../notifications/fcm.service";
import {
  PETPOOJA_MAX_RETRY_ATTEMPTS,
  isPetpoojaRetryDue,
  petpoojaRetryScheduledAtMs,
} from "./retryBackoff";

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
  // DISABLED BRIDGE: PETPOOJA_ENABLED=false must cost nothing — no branch scan,
  // no per-branch fan-out, no Menu API pull. Reported as zero synced branches
  // (never as a healthy sweep), and no run is recorded.
  if (!isPetpoojaEnabled()) {
    logger.info(
      "[Petpooja Menu Scheduler] PETPOOJA_ENABLED=false — bridge disabled, skipping the menu sweep"
    );
    return { syncedBranches: 0 };
  }

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
  // Unlinked outlets are CONFIGURATION, not a sync failure: collect them and
  // report ONE warning for the run instead of an error per branch per hour.
  const unlinkedBranches: string[] = [];

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
      } else if ((res.reason as any)?.unlinkedOutlet === true) {
        unlinkedBranches.push(doc.id);
      } else {
        logger.error(`[Petpooja Menu Scheduler] Failed for branch ${doc.id}:`, res.reason);
      }
    }
  }

  if (unlinkedBranches.length > 0) {
    logger.warn(
      `[Petpooja Menu Scheduler] ${unlinkedBranches.length} active branch(es) have no linked Petpooja outlet — skipped this run: ${unlinkedBranches.join(
        ", "
      )}`
    );
  }

  return { syncedBranches };
}

/**
 * Worker to retry failed Petpooja KOT order pushes with exponential backoff.
 *
 * The 5-minute schedule is only the POLL cadence: an order is re-POSTed only
 * once its persisted `petpoojaNextRetryAtMs` has arrived, so successive
 * attempts are 5m / 10m / 20m / 40m apart (see `retryBackoff.ts`). Rows that
 * are not due yet are skipped before any claim transaction, so they hold no
 * lease and cost no provider call.
 */
export async function retryPendingPetpoojaOrdersWorker(): Promise<{
  retriedCount: number;
  failedCount: number;
}> {
  let retriedCount = 0;
  let failedCount = 0;
  const CLAIM_TTL_MS = 10 * 60 * 1000;

  // DISABLED BRIDGE: PETPOOJA_ENABLED=false must not touch the queue at all.
  // Returning before the crash scan / pending_retry scan is what guarantees no
  // scan, no claim lease, no retry-count burn and no dead-letter alert — and it
  // is why queued orders are still retried unchanged once the flag goes back to
  // enabled. They are deliberately NOT relabelled: `pending_retry` is the lane
  // both this worker and the pending-alert lane already understand.
  if (!isPetpoojaEnabled()) {
    logger.info(
      "[Petpooja Retry Worker] PETPOOJA_ENABLED=false — bridge disabled, skipping the retry tick"
    );
    return { retriedCount, failedCount };
  }

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
        // Astra F2 (round 7): NO TRANSACTION CAPABILITY MEANS NO QUARANTINE.
        //
        // This branch used to read the row and then write a `reconciliation_required`
        // park with a PLAIN `set`. Nothing made that write conditional on the state
        // it had read still being current, so a sender's late ACK committing in
        // between was written over: the park's merge kept the acceptance ID fields
        // but replaced the acceptance STATE (`synced`/`accepted_unconfirmed`) and
        // cleared the claims, telling operators an already-recorded send was
        // unresolved.
        //
        // A missing `runTransaction` cannot justify a read-then-write quarantine.
        // Fail closed instead: no read, no write, no alert, no provider POST, and
        // no `failedCount` increment (that counter is driven by `parkResult`, which
        // stays "skipped"). The row is left for the transactional lane or an
        // operator — the same fail-closed rule the dead-letter pass already uses
        // when it has no atomic recheck.
        logger.warn(
          `[Petpooja Retry Worker] no transaction support — cannot atomically quarantine stale processing order ${procDoc.id}; leaving it untouched`
        );
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

  // 2. Scan pending_retry orders.
  //
  // BACKOFF: an order carries `petpoojaNextRetryAtMs` (see retryBackoff.ts) and
  // is only attempted once that time has arrived. The 5-minute schedule below
  // is the POLL cadence, not the retry cadence.
  //
  // The not-yet-due rows must not consume the window: an oldest-first
  // limit(100) would fill up with rows waiting out their backoff during an
  // outage (they are the OLDEST by definition) and a due order behind them was
  // never even read. So the scan PAGES oldest-first, in memory, and stops only
  // when it has a full set of workable candidates or has exhausted a bounded
  // number of pages. Each tick makes progress: a due row is either pushed
  // (leaves the lane) or rescheduled into the future, so the next tick's first
  // page has moved on. Legacy rows (no timestamp) are due immediately and are
  // the oldest rows by construction — they are always inside the first pages.
  //
  // Requires the (petpoojaStatus, createdAt) composite in
  // firestore.indexes.json.
  const SCAN_PAGE_SIZE = 100;
  /**
   * Due rows claimed (and pushed) per tick — the old `limit(100)` cap, so a
   * tick can never fan out more provider POSTs than before. The scan may read
   * further pages to FIND them; it pushes no more than this.
   */
  const PETPOOJA_SCAN_CLAIM_LIMIT = 100;
  /** Bounded pagination: at most 5 pages (500 rows) of reads per tick. */
  const MAX_SCAN_PAGES = 5;
  /**
   * Dead-lettering costs a transaction + a branch alert per row, so it is
   * capped at what the old single-window scan could produce (100). Rows over
   * the cap stay in the retry lane and are drained by the next tick — each
   * one that IS processed leaves the lane, so progress is guaranteed.
   */
  const DEAD_LETTER_BATCH_LIMIT = 100;

  const retryableDocs: any[] = [];
  const exhaustedDocs: any[] = [];
  /** Astra F3: pending_retry rows whose order is already terminal. */
  const terminalRetireDocs: any[] = [];

  try {
    let cursor: any = null;
    for (let page = 0; page < MAX_SCAN_PAGES; page++) {
      let query: any = db
        .collection("orders")
        .where("petpoojaStatus", "==", "pending_retry")
        .orderBy("createdAt", "asc")
        .limit(SCAN_PAGE_SIZE);
      if (cursor && typeof query.startAfter === "function") {
        query = query.startAfter(cursor);
      }
      const snap = await query.get();
      const docs = snap.docs || [];
      if (docs.length === 0) break;

      const now = Date.now();
      for (const doc of docs) {
        const data = doc.data() || {};
        // Astra F3: a terminal row must be retired regardless of its retry
        // budget or schedule — a closed order is never sent and never
        // dead-lettered, so it is collected BEFORE the due/budget filters.
        // A recorded acceptance is left alone. A prior SEND claim is NOT skipped
        // here: its outcome may be unknown, so it must reach the atomic F2
        // quarantine rather than being silently drained or stranded.
        if (isCancelledOrTerminal(data)) {
          if (!hasRecordedPosAcceptance(data)) {
            if (terminalRetireDocs.length < DEAD_LETTER_BATCH_LIMIT) {
              terminalRetireDocs.push(doc);
            }
          }
          continue;
        }
        const retryCount = Number(data.petpoojaRetryCount || 0);
        if (retryCount > PETPOOJA_MAX_RETRY_ATTEMPTS) {
          // Spent budget: dead-lettered regardless of its timestamp — that
          // pass never POSTs, it only flips the row and alerts the branch.
          if (exhaustedDocs.length < DEAD_LETTER_BATCH_LIMIT) {
            exhaustedDocs.push(doc);
          }
          continue;
        }
        // Not due yet: skipped here, BEFORE any claim, so it holds no lease
        // and costs no provider call.
        if (!isPetpoojaRetryDue(data, now)) continue;
        if (retryableDocs.length < PETPOOJA_SCAN_CLAIM_LIMIT) {
          retryableDocs.push(doc);
        }
      }

      // Enough due work for this tick, or this was the last page.
      if (retryableDocs.length >= PETPOOJA_SCAN_CLAIM_LIMIT) break;
      if (docs.length < SCAN_PAGE_SIZE) break;
      cursor = docs[docs.length - 1];
      if (!cursor || typeof cursor !== "object") break;
    }
  } catch (scanErr: any) {
    logger.warn(
      "[Petpooja Retry Worker] pending_retry scan failed, skipping tick:",
      scanErr?.message || scanErr
    );
    return { retriedCount, failedCount };
  }

  // Skip empty ticks: nothing pending → no claim transaction, no writes.
  if (retryableDocs.length === 0 && exhaustedDocs.length === 0 && terminalRetireDocs.length === 0) {
    return { retriedCount, failedCount };
  }

  // Claim-then-work: overlapping 5-min scheduler instances used to push the
  // same KOT twice (no lease, just a shared pending_retry flag). Claims flip
  // to `processing` inside one transaction; stale claims (>10 min, crashed
  // worker) are take-over-able. pushOrderToPetpooja releases the claim by
  // writing synced/pending_retry itself.
  const pendingDocs = retryableDocs;
  const claimedDocs: any[] = [];
  /** Astra F3 retirements committed in the claim transaction (no POST). */
  const retiredDocs: any[] = [];
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

          // Astra F3: a cancellation can land between the scan and this fresh
          // read. Recorded acceptance wins. Otherwise a prior SEND claim decides:
          // a live lease means a sender owns it (leave it completely alone), an
          // expired/unreadable one means the POS may hold the ticket, so it is
          // quarantined here — atomically — instead of being skipped and left
          // stranded in pending_retry forever.
          if (isCancelledOrTerminal(data)) {
            if (hasRecordedPosAcceptance(data)) continue;
            const decision = classifyPushClaim(data, now, PETPOOJA_PUSH_CLAIM_TTL_MS);
            if (decision === "busy") continue;
            if (decision === "unresolved") {
              tx.set(doc.ref, unresolvedPriorSendParkPatch(), { merge: true });
              continue;
            }
            tx.set(doc.ref, terminalOrderRetirementPatch(), { merge: true });
            retiredDocs.push(doc);
            continue;
          }
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

  // Astra F3: retire pending_retry rows whose order is already terminal. They
  // were excluded from the claim/push path at scan time; this commits the
  // retirement behind a FRESH transactional re-check (a racer may have accepted
  // the KOT meanwhile), and it never pages the branch — a closed order owes no
  // manual KOT entry.
  if (terminalRetireDocs.length > 0) {
    for (const doc of terminalRetireDocs) {
      if (db && typeof (db as any).runTransaction === "function") {
        try {
          const outcome = await (db as any).runTransaction(async (tx: any) => {
            const fresh = await tx.get(doc.ref);
            const freshData = (fresh.exists ? fresh.data() : undefined) as any;
            if (!freshData || freshData.petpoojaStatus !== "pending_retry") return "skipped";
            // Recorded acceptance outranks retirement: preserve it exactly.
            if (hasRecordedPosAcceptance(freshData)) return "skipped";
            if (!isCancelledOrTerminal(freshData)) return "skipped";
            const decision = classifyPushClaim(
              freshData,
              Date.now(),
              PETPOOJA_PUSH_CLAIM_TTL_MS
            );
            // A live lease belongs to a sender: leave the row untouched.
            if (decision === "busy") return "skipped";
            // An unknown prior send may already be at the POS: quarantine
            // atomically rather than asserting nothing was ever sent.
            if (decision === "unresolved") {
              tx.set(doc.ref, unresolvedPriorSendParkPatch(), { merge: true });
              return "quarantined";
            }
            tx.set(doc.ref, terminalOrderRetirementPatch(), { merge: true });
            return "retired";
          });
          if (outcome === "retired") retiredDocs.push(doc);
        } catch (retireErr: any) {
          logger.warn(
            `[Petpooja Retry Worker] terminal retirement failed for order ${doc.id}:`,
            retireErr?.message || retireErr
          );
        }
      }
      // No transaction support: refuse to write without an atomic recheck.
      // The row simply stays pending_retry; it is never POSTed below.
    }
    if (retiredDocs.length > 0) {
      logger.info(
        `[Petpooja Retry Worker] retired ${retiredDocs.length} terminal order(s) as not_applicable without a POST`
      );
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
                      // A thrown attempt is still a spent attempt: schedule
                      // the next one on the same backoff curve, or the row
                      // would be reclaimed on the very next 5-minute tick
                      // while the POS is still failing.
                      petpoojaNextRetryAtMs: petpoojaRetryScheduledAtMs(
                        Number(data.petpoojaRetryCount) || 0
                      ),
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

  // Dead-letter: an order whose `petpoojaRetryCount` exceeded
  // PETPOOJA_MAX_RETRY_ATTEMPTS would otherwise sit as pending_retry forever,
  // invisible. Flip it to failed with an audit snapshot. Folded into the same
  // scan above — no second collection pass.
  if (exhaustedDocs.length > 0) {
    try {
      const { captureErrorSnapshot } = await import("../../core/errors");
      for (const doc of exhaustedDocs) {
        // K2 stress sweep: re-read INSIDE a transaction before the dead-letter
        // write. The scan snapshot is minutes old — a direct push or an
        // in-flight worker may have synced this order meanwhile, and a plain
        // `failed` merge over `synced` (plus its "enter manually" branch
        // alert) would mint a duplicate kitchen ticket.
        let deadLetterOutcome: "wrote" | "skipped" | "retired" | "quarantined" = "skipped";
        if (db && typeof (db as any).runTransaction === "function") {
          try {
            deadLetterOutcome = await (db as any).runTransaction(async (tx: any) => {
              const fresh = await tx.get(doc.ref);
              const freshData = (fresh.exists ? fresh.data() : undefined) as any;
              // Recorded acceptance is a fact about the POS: preserve it exactly.
              if (hasRecordedPosAcceptance(freshData)) {
                return "skipped" as const;
              }
              // Astra F2/F3: a prior SEND claim decides what may be written.
              // Live lease — a sender owns this attempt, so no mutation, no
              // count, no alert. Expired/unreadable — the POS may already hold
              // the ticket, so quarantine atomically; never claim it failed and
              // never ask a human to type a KOT that might already be printed.
              const decision = classifyPushClaim(freshData, Date.now(), PETPOOJA_PUSH_CLAIM_TTL_MS);
              if (decision === "busy") return "skipped" as const;
              if (decision === "unresolved") {
                tx.set(doc.ref, unresolvedPriorSendParkPatch(), { merge: true });
                return "quarantined" as const;
              }
              // Astra F3: the order closed between the scan and this recheck.
              // Retire it — never dead-letter, never page the branch, because a
              // closed order owes no manual KOT entry.
              if (isCancelledOrTerminal(freshData)) {
                tx.set(doc.ref, terminalOrderRetirementPatch(), { merge: true });
                return "retired" as const;
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
          // No transaction-capable db: FAIL CLOSED with NO mutation. A plain
          // `failed` merge could overwrite an acceptance or an unknown send
          // claim that only an atomic recheck can see, and a wrong "enter
          // manually" alert is worse than none. The row stays pending_retry for
          // the transactional lane / an operator; a static warning is recorded.
          logger.warn(
            `[Petpooja Retry Worker] no transaction support — refusing to dead-letter order ${doc.id} without an atomic recheck`
          );
          continue;
        }
        // A retired terminal row and a skipped-accepted row owe no alert.
        if (deadLetterOutcome !== "wrote") continue;
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
              title: "KOT sync failed - enter manually",
              body: `Order #${doc.id.substring(0, 6)} is confirmed but POS sync failed after retries. Enter the KOT in Petpooja by hand.`,
              data: { type: "kot_sync_failed", orderId: doc.id },
              purpose: "operational",
              actor: { trusted: true },
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

