import { onDocumentWritten } from "firebase-functions/v2/firestore";
import * as admin from "firebase-admin";
import { db } from "../../core/firebase";
import { captureErrorSnapshot } from "../../core/errors";
import { staffCloseOverrideInForce } from "./storeStatus";

/**
 * Directory-write guard for the staff close (audit A5 finding 1).
 *
 * The Partner brand-directory save (`adminStoresService.stageStoreWrite`) FULL
 * REPLACES `admin_stores/{id}` with `toPublicStoreDoc(store)`. That projection
 * carries only the public keys, mirrors `isOpen` from the page's cached row and
 * DROPS `storeStatusOverride` / `storeStatusSource` / `storeStatusReason` /
 * `storeTurnOnAt`. Firestore rules brand the arm with
 * `hasOnly(adminStorePublicKeys())`, so the client cannot include the marker
 * keys to preserve them even if it wanted to.
 *
 * Consequence before this guard: a brand admin editing an unrelated field (a
 * phone number) erased a staff close, and a directory row loaded BEFORE the
 * close restored `isOpen:true` immediately. The next Petpooja "open" then saw
 * no override and reopened a kitchen staff had shut.
 *
 * This trigger restores the staff close from the BEFORE snapshot whenever a
 * write drops it. It cannot fight a staff reopen: a reopen clears the marker in
 * the before-state, so `staffCloseOverrideInForce(before)` is false and nothing
 * is written. It also cannot loop: its own merge write keeps the marker set,
 * so the re-fired invocation finds the close already in force.
 */

/** Marks a write this guard made, so a restore is traceable in the audit trail. */
export const STAFF_CLOSE_GUARD_MARKER = "directory_status_guard";

const REGION = "asia-south1";

function asObject(value: any): Record<string, any> | null {
  return value && typeof value === "object" ? (value as Record<string, any>) : null;
}

/**
 * Pure decision: what (if anything) must this write patch to keep the staff
 * close?
 *
 * Returns `null` when the write needs no repair.
 *
 * How a legit write is told apart from a directory save:
 *   - `setStaffStoreStatus` (the ONLY writer allowed to resolve the marker)
 *     always writes `storeStatusOverride` EXPLICITLY — `true` on a close,
 *     `false` on a reopen. A reopen therefore arrives with an explicit
 *     `false` and is left alone, which is what keeps rule C intact.
 *   - `toPublicStoreDoc` cannot write that key at all (it is not a public key,
 *     and `firestore.rules` brands the arm with `hasOnly(adminStorePublicKeys())`).
 *     So a directory save always arrives with the key ABSENT.
 *
 * An absent marker on a previously staff-closed document is the defect; it is
 * restored verbatim. A contradictory `override: true` with `isOpen: true` is
 * also restored (defence in depth; no legit path produces it).
 *
 * Scope is deliberately narrow: the guard restores the CLOSE (the gate flag +
 * the override block a later POS "open" is refused on). It is not a
 * general-purpose doc reconciler, so a write that keeps both intact is left
 * completely alone.
 */
export function guardDirectoryStatusWrite(
  before: Record<string, any> | null | undefined,
  after: Record<string, any> | null | undefined
): Record<string, any> | null {
  const prev = asObject(before);
  const next = asObject(after);
  // A create (no before) has nothing to protect; a delete (no after) has no
  // document left to write.
  if (!prev || !next) return null;

  const wasStaffClosed = staffCloseOverrideInForce(prev, null);
  if (!wasStaffClosed) return null;

  // An EXPLICIT resolution of the marker can only come from the staff route; a
  // reopen must win. A staff CLOSE that already left the gate shut needs no
  // repair either — and that is what makes the guard's own restore idempotent.
  const hasMarkerDecision = Object.prototype.hasOwnProperty.call(next, "storeStatusOverride");
  if (hasMarkerDecision && next.storeStatusOverride === false) return null;
  if (next.storeStatusOverride === true && next.isOpen === false) return null;

  return {
    // The close IS `isOpen: false`. Re-assert it rather than copying the old
    // value: a legacy doc with `storeStatusOverride: true` but `isOpen: true`
    // is already serviced as closed by `isStorefrontOpen`, and writing the
    // literal gate flag keeps the stored document honest as well.
    isOpen: false,
    storeStatusOverride: true,
    storeStatusSource:
      typeof prev.storeStatusSource === "string" ? prev.storeStatusSource : "manual",
    storeStatusReason:
      typeof prev.storeStatusReason === "string" ? prev.storeStatusReason : null,
    storeTurnOnAt: prev.storeTurnOnAt ?? null,
    directoryStatusGuard: STAFF_CLOSE_GUARD_MARKER,
    storeStatusUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

/**
 * Trigger: restores a staff close a directory save dropped.
 *
 * A repair failure is snapshotted, never thrown: a rejected Firestore trigger
 * retries the WHOLE write, and the directory save itself already committed.
 */
export const onAdminStoreDirectoryStatusGuard = onDocumentWritten(
  {
    region: REGION,
    document: "admin_stores/{storeId}",
  },
  async (event) => {
    const storeId = String(event.params?.storeId || "");
    const change = event.data;
    if (!change || !storeId) return;

    // `exists` is the SDK's own discriminator; a snapshot that simply omits it
    // (unit doubles, older emulator shapes) is treated as present, because the
    // data getter is the authority on what was written.
    const before = change.before && change.before.exists !== false
      ? change.before.data() || {}
      : null;
    const after = change.after && change.after.exists !== false
      ? change.after.data() || {}
      : null;

    const patch = guardDirectoryStatusWrite(before, after);
    if (!patch) return;

    try {
      await db
        .collection("admin_stores")
        .doc(storeId)
        .set(patch, { merge: true });
      console.warn(
        `[Store Status] directory save for ${storeId} dropped the staff close — restored (isOpen: ${patch.isOpen})`
      );
    } catch (err: any) {
      console.error(
        `[Store Status] directory status guard FAILED for ${storeId}:`,
        err?.message || err
      );
      await captureErrorSnapshot({
        source: "petpooja",
        severity: "high",
        message: `A directory save dropped the staff close for store ${storeId} and the restore write failed — the outlet may reopen while staff closed it. Reopen/close it again from the Partner app.`,
        errorStack: err?.stack,
      }).catch(() => undefined);
    }
  }
);
