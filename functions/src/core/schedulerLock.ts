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

  const leaseIsLive = (data: any): boolean => {
    const claimedAt =
      typeof data?.claimedAtMs === "number" && Number.isFinite(data.claimedAtMs)
        ? data.claimedAtMs
        : 0;
    return claimedAt > 0 && Date.now() - claimedAt < ttlMs;
  };

  let shouldRun = true;
  try {
    if (db && typeof (db as any).runTransaction === "function") {
      const acquired = await (db as any).runTransaction(async (tx: any) => {
        const snap = await tx.get(ref);
        const data = (snap.exists ? snap.data() : undefined) as any;
        if (leaseIsLive(data)) return false;
        const now = Date.now();
        tx.set(
          ref,
          { claimedAtMs: now, lockedAt: new Date(now).toISOString() },
          { merge: true }
        );
        return true;
      });
      if (acquired === false) shouldRun = false;
    } else {
      // Datastore shim without transactions: best effort, same semantics.
      const snap = await ref.get();
      const data = (snap.exists ? snap.data() : undefined) as any;
      if (leaseIsLive(data)) {
        shouldRun = false;
      } else {
        const now = Date.now();
        await ref.set(
          { claimedAtMs: now, lockedAt: new Date(now).toISOString() },
          { merge: true }
        );
      }
    }
  } catch {
    // Lease unreadable or unwritable — fail OPEN (see the header comment).
    shouldRun = true;
  }

  if (!shouldRun) return { ran: false };

  const result = await fn();
  return { ran: true, result };
}
