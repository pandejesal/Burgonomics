import * as admin from "firebase-admin";
import { db } from "../../core/firebase";
import {
  applyCancelSideEffects,
  type CancelSideEffectsResult,
} from "../orders/cancelSideEffects";

/**
 * P3 — POS-originated cancellations must still run the SHARED cancel side
 * effects (coupon release, courier cleanup, coin restore) exactly once, without
 * calling the vendor's "Update Order Status" back.
 *
 * A trusted callback writes `status: cancelled` in its own transaction. The
 * durable obligation persisted WITH that transition means an interrupt after
 * commit cannot lose the cleanup. r2 hardening:
 *   - the worker reclaims EXPIRED `processing` leases, not just `pending` rows;
 *   - every result write is fenced to the claim token, so a takeover's newer
 *     state is never clobbered by a late stale result;
 *   - an explicit coupon/courier/coin failure is RETRIED, never marked done;
 *   - the drain runs even while the outbound POS bridge is disabled (these
 *     obligations do not call the vendor at all).
 */
export const POS_CANCEL_SIDE_EFFECT_COLLECTION = "petpoojaCancelSideEffectObligations";

/** How long a claimed obligation blocks another drainer (mirrors the POS cancel lease). */
export const POS_SIDE_EFFECT_CLAIM_TTL_MS = 10 * 60 * 1000;

const OBLIGATION_SCAN_LIMIT = 100;

function obligationId(orderId: string): string {
  return `pcs_${orderId}`;
}

function numberField(raw: any): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (raw && typeof raw.toMillis === "function") {
    const ms = Number(raw.toMillis());
    return Number.isFinite(ms) ? ms : 0;
  }
  return 0;
}

function newClaimToken(nowMs: number): string {
  return `${nowMs}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Write the obligation INSIDE the caller's status transaction. Deterministic id
 * + a no-reset merge makes a replay of the same callback idempotent; the claim
 * below re-checks fresh state before running anything.
 */
export async function enqueuePosCancelSideEffectsTx(
  tx: any,
  orderId: string,
  branchId: string | null
): Promise<void> {
  const ref = db.collection(POS_CANCEL_SIDE_EFFECT_COLLECTION).doc(obligationId(orderId));
  const snap = await tx.get(ref);
  if (snap?.exists && snap.data()?.status === "done") return; // never re-open a finished cleanup
  tx.set(
    ref,
    {
      orderId,
      branchId: branchId || null,
      type: "pos_originated_cancel",
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

/** Non-transactional enqueue for datastores without `runTransaction`. */
export async function enqueuePosCancelSideEffects(
  orderId: string,
  branchId: string | null
): Promise<void> {
  const ref = db.collection(POS_CANCEL_SIDE_EFFECT_COLLECTION).doc(obligationId(orderId));
  const snap = await ref.get();
  if (snap?.exists && snap.data()?.status === "done") return;
  await ref.set(
    {
      orderId,
      branchId: branchId || null,
      type: "pos_originated_cancel",
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

export type PosSideEffectDrain = "ran" | "skipped" | "retry" | "failed";

/**
 * Explicit failures that must NOT be recorded as a completed cleanup. A `noop`
 * is fine (there was nothing to release); only a real failure keeps the
 * obligation retryable.
 */
export function posSideEffectFailures(result: CancelSideEffectsResult): string[] {
  const failures: string[] = [];
  if (result.couponReleased === "failed") failures.push("coupon_release");
  // r3: the courier records its OWN durable pending/dead-letter intent and the
  // dispatch worker owns its retries. Re-running it from this obligation would
  // recreate manual alerts and reset the provider retry budget.
  if (result.providerCancelSkipped === "helper_fault") failures.push("helper_fault");
  if (result.coinsRestored === "failed") failures.push("coin_restore");
  if (result.posCancel === "helper_fault") failures.push("pos_side_effect");
  return failures;
}

/**
 * Fence a result write to the claim token. A competing drainer that took over a
 * stale lease has a different token; its state must survive a late result.
 */
async function recordObligationResult(
  orderId: string,
  token: string,
  failures: string[],
  fault?: any,
  couponSucceeded?: boolean,
  courierSucceeded?: boolean
): Promise<boolean> {
  const ref = db.collection(POS_CANCEL_SIDE_EFFECT_COLLECTION).doc(obligationId(orderId));
  if (!db || typeof (db as any).runTransaction !== "function") return false;
  try {
    return await (db as any).runTransaction(async (tx: any) => {
      const snap = await tx.get(ref);
      const data = snap?.exists ? snap.data() : undefined;
      if (!data) return false;
      if (data.status !== "processing") return false;
      if (data.claimToken !== token) return false;
      const done = failures.length === 0 && !fault;
      const common = {
        claimToken: null,
        claimedAt: null,
        // r2: remember a successful coupon release so a retry of a different
        // failed obligation (e.g. courier) does not double-count the slot.
        ...(couponSucceeded ? { completedCoupon: true } : {}),
        ...(courierSucceeded ? { completedCourier: true } : {}),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      tx.set(
        ref,
        done
          ? {
              ...common,
              status: "done",
              processedAt: admin.firestore.FieldValue.serverTimestamp(),
            }
          : {
              ...common,
              status: "pending",
              lastError: [...failures, fault ? String(fault?.message || fault).slice(0, 200) : ""]
                .filter(Boolean)
                .join("; ")
                .slice(0, 300),
            },
        { merge: true }
      );
      return true;
    });
  } catch {
    return false;
  }
}

/**
 * Claim and drain ONE obligation. Live leases defer; expired leases are
 * reclaimed. The token is generated before the claim and checked on the result.
 */
export async function processPosCancelSideEffectObligation(
  orderId: string
): Promise<PosSideEffectDrain> {
  const ref = db.collection(POS_CANCEL_SIDE_EFFECT_COLLECTION).doc(obligationId(orderId));
  if (!db || typeof (db as any).runTransaction !== "function") return "skipped";

  const nowMs = Date.now();
  const token = newClaimToken(nowMs);
  // r3: only the COMMITTED transaction attempt may authorise a cleanup. A
  // side-effect call keyed to a claim from a discarded retry would double-run
  // work whose lease another instance now owns. `runTransaction` returns the
  // callback value of the attempt that actually committed.
  type Claim = { token: string; skipCoupon: boolean; skipCourier: boolean };
  let claim: Claim | null = null;
  try {
    claim = await (db as any).runTransaction(async (tx: any): Promise<Claim | null> => {
      const snap = await tx.get(ref);
      const data = snap?.exists ? snap.data() : undefined;
      if (!data) return null;
      if (data.status === "done") return null;
      const skipCoupon = data.completedCoupon === true;
      const skipCourier = data.completedCourier === true;
      if (data.status === "processing") {
        const claimedAt = numberField(data.claimedAt);
        if (claimedAt > 0 && nowMs - claimedAt < POS_SIDE_EFFECT_CLAIM_TTL_MS) return null;
      }
      tx.set(
        ref,
        {
          status: "processing",
          claimedAt: nowMs,
          claimToken: token,
          attempts: Number(data.attempts || 0) + 1,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      return { token, skipCoupon, skipCourier };
    });
  } catch {
    return "skipped";
  }
  if (!claim) return "skipped";

  try {
    const result = await applyCancelSideEffects({
      orderId,
      requestedBy: "petpooja",
      reason: "order_cancelled",
      skipPosCancel: true,
      skipCoupon: claim.skipCoupon,
      skipCourier: claim.skipCourier,
    });
    const failures = posSideEffectFailures(result);
    const couponSucceeded = result.couponReleased === "released" || result.couponReleased === "noop";
    // Any courier attempt (pending/dead-letter included) has a durable intent
    // owned by the dispatch worker: never re-invoke it from this obligation.
    const courierSucceeded = result.providerCancelAttempted || result.courierCleanup === "attempted";
    const recorded = await recordObligationResult(
      orderId, token, failures, undefined, couponSucceeded, courierSucceeded
    );
    if (!recorded) return "skipped";
    return failures.length > 0 ? "retry" : "ran";
  } catch (err: any) {
    // applyCancelSideEffects contracts never to throw; defense in depth keeps
    // a surprise fault retryable and fenced, never silently done.
    await recordObligationResult(orderId, token, [], err);
    return "failed";
  }
}

/**
 * Drain every open obligation: `pending` AND expired/finished `processing`
 * leases. Reuses the existing 5-minute Petpooja tick — no new scheduler.
 */
export async function processPendingPosCancelSideEffects(): Promise<{
  ran: number;
  failed: number;
}> {
  let ran = 0;
  let failed = 0;
  const seen = new Set<string>();
  const docs: any[] = [];
  for (const lane of ["pending", "processing"] as const) {
    try {
      const snap = await db
        .collection(POS_CANCEL_SIDE_EFFECT_COLLECTION)
        .where("status", "==", lane)
        .limit(OBLIGATION_SCAN_LIMIT)
        .get();
      for (const doc of (snap?.docs || []) as any[]) docs.push(doc);
    } catch {
      // A lane scan failure must not stop the other lane.
    }
  }
  for (const doc of docs) {
    const orderId = String((doc.data() || {}).orderId || doc.id?.replace(/^pcs_/, "") || "");
    if (!orderId || seen.has(orderId)) continue;
    seen.add(orderId);
    const outcome = await processPosCancelSideEffectObligation(orderId);
    if (outcome === "ran") ran++;
    if (outcome === "failed") failed++;
  }
  return { ran, failed };
}
