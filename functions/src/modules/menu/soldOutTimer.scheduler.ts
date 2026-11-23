import { db } from "../../core/firebase";
import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import { isPetpoojaEnabled } from "../petpooja/client";
import { pushItemStockToPetpooja } from "../petpooja/item86ingSync";

/**
 * SOLD-OUT TIMER — an item marked unavailable "until a time" must come back on
 * its own at that time.
 *
 * WHAT THE APP ALREADY WRITES (checked 2026-11-20). The Partner app's 86 drawer
 * (`burgonomics-partner/src/features/menu/hooks/useBranchMenu.ts:154-196`) offers
 * "2 hours" and "rest of day" and persists the deadline as
 * `products/{id}.disabledUntil` (a Timestamp) alongside `inStock:false`,
 * `isAvailable:false`, `available:false`, `eightSixDuration` and
 * `eightSixReason`. It even renders the deadline back to staff
 * (`MenuItemToggleRow.tsx:63-68`).
 *
 * WHAT NOTHING READ. `git grep disabledUntil functions/src` was EMPTY before this
 * module: no trigger, no scheduler, no read. So the promise on the drawer was
 * false — an item 86'd "for 2 hours" stayed 86'd until a human remembered to
 * toggle it back. In service that is lost sales and a stale menu, and the more
 * items staff 86 with a timer the worse it gets. This scheduler is the missing
 * reader.
 *
 * IDEMPOTENT BY CONSTRUCTION:
 *   - the scan only returns rows whose `disabledUntil` has ARRIVED, and the
 *     restore CLEARS `disabledUntil` in the same write, so a row leaves the scan
 *     the moment it is restored;
 *   - the write is a transaction that re-reads the doc and re-proves the deadline
 *     (still set, still arrived) before flipping anything. A staff member who
 *     re-86s an item between the scan and the write keeps their new state — the
 *     stale snapshot cannot un-86 it;
 *   - a second overlapping tick finds `disabledUntil: null` and writes nothing.
 *
 * WHY IT DOES NOT TOUCH A POS-ORIGINATED 86: only the app sets `disabledUntil`
 * (the Petpooja stock webhook writes `inStock` and no timer), so a row in this
 * scan is always an app-created timer. The inbound handler now also CLEARS
 * `disabledUntil` when the POS sends a stock toggle, so a POS 86 that supersedes
 * a running timer is never resurrected by this worker.
 *
 * POS PROPAGATION IS BEST-EFFORT AND REPORTED HONESTLY. The app is the source of
 * truth for the storefront; the same `pushItemStockToPetpooja` path the Partner
 * app uses is called once so the physical POS agrees. That endpoint is still
 * unproven with the vendor (2026-11-20 sandbox: the configured host answers 403,
 * so it is our route, not theirs — `petpooja-sandbox-20261120/RESULTS.md:40`),
 * so a failure is RECORDED on the product and snapshotted as `medium` instead of
 * being hidden, and it never blocks the restore.
 */

/** Rows restored per tick — bounded so one tick cannot run past its timeout. */
export const SOLD_OUT_RESTORE_BATCH = 40;

/** P2: max pages examined per tick, so a stuck row cannot starve later ones. */
export const SOLD_OUT_MAX_SCAN_PAGES = 4;

/** Concurrent restores per chunk (each may hold a POS POST). */
const RESTORE_CHUNK_SIZE = 4;

/** Read `disabledUntil` as epoch ms; 0 when absent/unreadable. */
export function soldOutUntilMsOf(product: any): number {
  const raw = product?.disabledUntil;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (raw && typeof raw.toMillis === "function") {
    const ms = Number(raw.toMillis());
    return Number.isFinite(ms) ? ms : 0;
  }
  if (raw && typeof raw === "object" && typeof raw.seconds === "number") {
    const ms = Number(raw.seconds) * 1000;
    return Number.isFinite(ms) ? ms : 0;
  }
  return 0;
}

/** True when at least one reader-visible availability flag says "sold out". */
export function isMarkedSoldOut(product: any): boolean {
  return (
    product?.inStock === false ||
    product?.isAvailable === false ||
    product?.available === false
  );
}

/**
 * True when this row is a due app timer that still needs restoring. Used both by
 * the scan filter and by the transactional re-check, so the two can never
 * disagree about what "due" means.
 */
export function isDueSoldOutTimer(product: any, nowMs: number): boolean {
  const until = soldOutUntilMsOf(product);
  return until > 0 && until <= nowMs && isMarkedSoldOut(product);
}

/**
 * P2: a product the POS has delisted (`menuSyncWebhook` writes these markers)
 * must never be brought back on sale by a timer. Its stale timer is cleared,
 * but its availability flags are left alone.
 */
export function isPosDelisted(product: any): boolean {
  return (
    product?.delistedFromPos === true ||
    product?.ghostRetired === true ||
    product?.deleted === true
  );
}

/** True when a timer deadline has arrived, regardless of availability (P2). */
function hasDueTimer(product: any, nowMs: number): boolean {
  const until = soldOutUntilMsOf(product);
  return until > 0 && until <= nowMs;
}

/**
 * P2: the value pushed to the POS is derived from the product's CURRENT
 * availability, never a hardcoded `true` (nor a stale scan snapshot). A sold-out,
 * delisted or unavailable product is never pushed as in-stock.
 */
export function availabilityForPosPush(product: any): boolean {
  return !isMarkedSoldOut(product) && !isPosDelisted(product);
}

/** Query cutoff. Tolerates a datastore shim without `Timestamp.fromMillis`. */
function cutoffValue(nowMs: number): any {
  const Timestamp: any = (admin.firestore as any)?.Timestamp;
  if (Timestamp && typeof Timestamp.fromMillis === "function") {
    return Timestamp.fromMillis(nowMs);
  }
  return new Date(nowMs);
}

/** The restore write — identical flag set the Partner app's own restore uses. */
function restorePatch(nowMs: number): Record<string, any> {
  return {
    inStock: true,
    isAvailable: true,
    available: true,
    disabledUntil: null,
    eightSixDuration: null,
    eightSixReason: null,
    autoRestoredAt: admin.firestore.FieldValue.serverTimestamp(),
    autoRestoreDueAtMs: nowMs,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

/**
 * P2: clear a timer that no longer needs restoring (item already available, or
 * delisted) WITHOUT touching the availability flags. This is what lets a stale
 * row leave the scan so the rows behind it are no longer starved.
 */
function clearStaleTimerPatch(nowMs: number, reason: "already_available" | "delisted") {
  return {
    disabledUntil: null,
    eightSixDuration: null,
    eightSixReason: null,
    autoRestoreSkippedAt: admin.firestore.FieldValue.serverTimestamp(),
    autoRestoreSkipDueAtMs: nowMs,
    autoRestoreSkipReason: reason,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

interface RestoreOutcome {
  restored: boolean;
  /** P2: a stale timer was cleared (no restore, no POS push). */
  staleCleared?: boolean;
  product?: any;
}

/**
 * Restore ONE row behind a transactional re-check. Returns `restored:false` when
 * the row moved on (a staff re-86, another tick, a deletion).
 */
async function restoreOne(doc: any, nowMs: number): Promise<RestoreOutcome> {
  const ref = doc.ref || db.collection("products").doc(doc.id);

  if (!db || typeof (db as any).runTransaction !== "function") {
    // Fail closed: without an atomic re-check a plain write could un-86 an item
    // a staff member marked unavailable seconds ago. Leave it for the next tick.
    logger.warn(
      `[SoldOutTimer] no transaction support — refusing to restore product ${doc.id} without an atomic recheck`
    );
    return { restored: false };
  }

  let outcome: RestoreOutcome = { restored: false };
  try {
    await (db as any).runTransaction(async (tx: any) => {
      // A retried transaction callback runs again from the top; reset so a
      // previous attempt's decision cannot leak into the committed outcome.
      outcome = { restored: false };
      const fresh = await tx.get(ref);
      const product = (fresh.exists ? fresh.data() : undefined) as any;
      if (!product) return;
      // Re-prove the deadline on the FRESH snapshot: the scan is minutes old and
      // a re-86 (or a manual restore) must win. If the deadline moved into the
      // future (or was cleared), the row left the scan on its own — leave it be.
      if (!hasDueTimer(product, nowMs)) return;

      if (isPosDelisted(product)) {
        // P2: a delisted SKU keeps its availability exactly as it is; only the
        // stale timer goes, so the worker cannot resurrect a retired product.
        tx.set(ref, clearStaleTimerPatch(nowMs, "delisted"), { merge: true });
        outcome = { restored: false, staleCleared: true, product };
        return;
      }
      if (!isMarkedSoldOut(product)) {
        // P2: the item is available again but its timer survived. Clear it
        // transactionally so this row stops blocking the queue; no POS push.
        tx.set(ref, clearStaleTimerPatch(nowMs, "already_available"), { merge: true });
        outcome = { restored: false, staleCleared: true, product };
        return;
      }
      // Still due, still sold out and still listed: restore it. The product we
      // hand to the POS push is the FRESH post-restore snapshot, so the outbound
      // stock value is bound to the availability we actually committed.
      // P2/r2: a monotonically increasing version fences the outbound stock
      // POST. Write the SAME numeric value we hand to the vendor call so the
      // pre-send re-check cannot disagree with what the transaction committed.
      const nextVersion = Number(product.stockVersion || 0) + 1;
      const patch = { ...restorePatch(nowMs), stockVersion: nextVersion };
      const restored = { ...product, ...patch };
      tx.set(ref, patch, { merge: true });
      outcome = { restored: true, product: restored };
    });
  } catch (err: any) {
    logger.warn(
      `[SoldOutTimer] restore transaction failed for product ${doc.id}:`,
      err?.message || err
    );
    return { restored: false };
  }
  return outcome;
}

/**
 * Push the restored availability to the physical POS, once, best-effort.
 * Recorded on the product so an operator can see WHY the POS and the app may
 * disagree — never silently swallowed, never allowed to fail the restore.
 */
async function pushRestoredStockToPos(product: any): Promise<"synced" | "skipped" | "failed"> {
  const branchId = typeof product?.branchId === "string" ? product.branchId : "";
  const petpoojaItemId = product?.petpoojaItemId;
  if (!branchId || !petpoojaItemId) return "skipped";
  if (!isPetpoojaEnabled()) return "skipped";
  // P2: never push a hardcoded "true". `product` is the fresh snapshot captured
  // inside the restore transaction, so the value reflects the availability that
  // was actually committed — a delisted or re-sold-out item is not pushed as
  // in-stock. (The caller only invokes this for a committed restore.)
  const inStock = availabilityForPosPush(product);
  const expectedVersion = Number(product?.stockVersion || 0) || null;
  const pushToken = `restore_${String(product?.id || petpoojaItemId)}_${expectedVersion}_${Date.now()}`;
  try {
    const ok = await pushItemStockToPetpooja(
      branchId,
      String(petpoojaItemId),
      inStock,
      undefined,
      expectedVersion,
      pushToken
    );
    return ok ? "synced" : "failed";
  } catch (err: any) {
    logger.warn(
      `[SoldOutTimer] POS stock push failed for product ${product?.id || "(unknown)"}:`,
      err?.message || err
    );
    return "failed";
  }
}

async function recordPosSyncOutcome(docId: string, outcome: "synced" | "skipped" | "failed") {
  try {
    await db.collection("products").doc(docId).set(
      {
        lastAutoRestorePosSync: outcome,
        lastAutoRestorePosSyncAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  } catch (err: any) {
    logger.warn(
      `[SoldOutTimer] could not record POS sync outcome for product ${docId}:`,
      err?.message || err
    );
    return;
  }
  if (outcome !== "failed") return;
  try {
    const { captureErrorSnapshot } = await import("../../core/errors");
    await captureErrorSnapshot({
      source: "petpooja",
      severity: "medium",
      message: `Auto-restored product ${docId} in the app, but the Petpooja stock push failed — the POS may still show it sold out until staff toggle it`,
    });
  } catch {
    // Best-effort telemetry; the product doc already records the outcome.
  }
}

/**
 * 5-minute worker: restore every product whose sold-out timer has arrived.
 *
 * Empty ticks return immediately (no writes, no POS calls).
 */
export async function restoreDueSoldOutItems(nowMs: number = Date.now()): Promise<{
  restoredCount: number;
  skippedCount: number;
  posSynced: number;
  posFailed: number;
}> {
  let restoredCount = 0;
  let skippedCount = 0;
  let posSynced = 0;
  let posFailed = 0;

  // P2: page past rows instead of re-reading the same first 40 due timestamps
  // every tick. A datastore shim without `startAfter` degrades to one page, but
  // the transactional stale-timer clearing below still frees the queue.
  const cutoff = cutoffValue(nowMs);
  const probe: any = db.collection("products").where("disabledUntil", "<=", cutoff);
  const canPage = typeof probe?.startAfter === "function";
  const maxPages = canPage ? SOLD_OUT_MAX_SCAN_PAGES : 1;
  let cursor: any = null;
  let anyDocs = false;

  for (let page = 0; page < maxPages; page++) {
    let query: any = db.collection("products").where("disabledUntil", "<=", cutoff);
    if (cursor && canPage) query = query.startAfter(cursor);
    let snap: any;
    try {
      snap = await query.limit(SOLD_OUT_RESTORE_BATCH).get();
    } catch (err: any) {
      logger.warn("[SoldOutTimer] scan failed, skipping tick:", err?.message || err);
      break;
    }
    const docs = (snap?.docs || []) as any[];
    if (docs.length === 0) break;
    anyDocs = true;
    cursor = docs[docs.length - 1];

    for (let i = 0; i < docs.length; i += RESTORE_CHUNK_SIZE) {
      const chunk = docs.slice(i, i + RESTORE_CHUNK_SIZE);
      const results = await Promise.allSettled(
        chunk.map(async (doc) => ({ doc, outcome: await restoreOne(doc, nowMs) }))
      );
      for (let j = 0; j < results.length; j++) {
        const res = results[j];
        if (res.status !== "fulfilled" || !res.value.outcome.restored) {
          skippedCount++;
          continue;
        }
        restoredCount++;
        const product = res.value.outcome.product;
        const sync = await pushRestoredStockToPos(product);
        if (sync === "synced") posSynced++;
        if (sync === "failed") posFailed++;
        await recordPosSyncOutcome(chunk[j].id, sync);
      }
    }
    if (docs.length < SOLD_OUT_RESTORE_BATCH) break;
  }

  if (!anyDocs) {
    return { restoredCount, skippedCount, posSynced, posFailed };
  }

  if (restoredCount > 0) {
    logger.info(
      `[SoldOutTimer] restored ${restoredCount} item(s); POS synced=${posSynced} failed=${posFailed} skipped=${skippedCount}`
    );
  }
  return { restoredCount, skippedCount, posSynced, posFailed };
}
