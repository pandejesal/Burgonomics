import { db } from "./firebase";

/**
 * Whole-run scheduler overlap guard. Cloud Scheduler fires on wall-clock
 * cadence with no mutual exclusion — a slow tick overlapping the next one
 * used to double-process the same queue (double KOT pushes, double transfer
 * POSTs, double reminders) before per-doc leases existed, and per-doc
 * leases still don't stop two full scans from racing.
 *
 * Lease doc `scheduler_locks/{name}` with a NUMERIC local-clock timestamp
 * (never a serverTimestamp sentinel — unreadable on fast re-read, causes
 * instant false takeover). A live lease skips the tick ({ran:false});
 * a stale lease (>ttlMs, crashed run) is taken over. Lock is NOT released
 * at the end — the TTL expiry is the release (a crashed run must not leave
 * a permanent lock, and an early release would re-admit overlap).
 *
 * Check and claim run in ONE transaction: the old read-then-write pair let two
 * overlapping ticks both read an unclaimed lease before either wrote, so both
 * ran. The lock fails OPEN if it cannot be read or written — a stuck lock must
 * never silently kill reminders/syncs forever; per-doc leases still protect the
 * money paths inside the run.
 */
export async function withSchedulerLock<T>(
  name: string,
  ttlMs: number,
  fn: () => Promise<T>
): Promise<{ ran: boolean; result?: T }> {
  const ref = db.collection("scheduler_locks").doc(name);
  // CAS acquire (stress sweep 2026-10-24, M1): the old read-then-set let two
  // Cloud Run instances both observe an absent lock inside the same instant
  // and both run the tick. The freshness check and the lease write now
  // commit ATOMICALLY: the loser observes the winner's stamp and skips.
  // NUMERIC local-clock stamps stay (serverTimestamp sentinels are unreadable
  // on fast re-read and cause instant false takeovers); the lease remains the
  // release (a crashed run must not leave a permanent lock).
  const nowMs = Date.now();
  let acquired = false;
  try {
    if (db && typeof (db as any).runTransaction === "function") {
      await (db as any).runTransaction(async (tx: any) => {
        const snap = await tx.get(ref);
        const data = (snap.exists ? snap.data() : undefined) as any;
        const claimedAt =
          typeof data?.claimedAtMs === "number" && Number.isFinite(data.claimedAtMs)
            ? data.claimedAtMs
            : 0;
        if (claimedAt > 0 && nowMs - claimedAt < ttlMs) {
          acquired = false;
          return;
        }
        // Absent or stale (crashed run) — claim atomically inside the same
        // transaction that proved staleness.
        tx.set(
          ref,
          { claimedAtMs: nowMs, lockedAt: new Date().toISOString() },
          { merge: true }
        );
        acquired = true;
      });
    } else {
      // Datastore shim without transactions: best effort, same semantics.
      const snap = await ref.get();
      const data = (snap.exists ? snap.data() : undefined) as any;
      const claimedAt =
        typeof data?.claimedAtMs === "number" && Number.isFinite(data.claimedAtMs)
          ? data.claimedAtMs
          : 0;
      if (!(claimedAt > 0 && nowMs - claimedAt < ttlMs)) {
        await ref.set(
          { claimedAtMs: nowMs, lockedAt: new Date().toISOString() },
          { merge: true }
        );
        acquired = true;
      }
    }
  } catch {
    // Lease/transaction unavailable — fail OPEN for schedulers (same policy
    // as before: a stuck lock must never silently kill reminders/syncs
    // forever); per-doc leases remain the backstop for the money paths.
    acquired = true;
  }
  if (!acquired) {
    return { ran: false };
  }

  const result = await fn();
  return { ran: true, result };
}
