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
 */
export async function withSchedulerLock<T>(
  name: string,
  ttlMs: number,
  fn: () => Promise<T>
): Promise<{ ran: boolean; result?: T }> {
  const ref = db.collection("scheduler_locks").doc(name);
  try {
    const snap = await ref.get();
    const data = (snap.exists ? snap.data() : undefined) as any;
    const claimedAt =
      typeof data?.claimedAtMs === "number" && Number.isFinite(data.claimedAtMs)
        ? data.claimedAtMs
        : 0;
    if (claimedAt > 0 && Date.now() - claimedAt < ttlMs) {
      return { ran: false };
    }
  } catch {
    // Lease unreadable — fail OPEN for schedulers (a stuck lock must never
    // silently kill reminders/syncs forever); per-doc leases still protect
    // the money paths inside the run.
  }
  try {
    await ref.set(
      { claimedAtMs: Date.now(), lockedAt: new Date().toISOString() },
      { merge: true }
    );
  } catch {
    // Lock write failed — proceed; per-doc leases remain the backstop.
  }
  const result = await fn();
  return { ran: true, result };
}
