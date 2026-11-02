/**
 * Petpooja KOT retry backoff — the single source of truth for WHEN a failed
 * paid order may reach the POS again, and for HOW MANY attempts it gets before
 * ops is told to enter the KOT by hand.
 *
 * The 5-minute worker used to retry EVERY `pending_retry` order on EVERY tick
 * (no next-eligible time existed at all) and dead-lettered at a bare `3`, so a
 * 30-minute Petpooja outage burned the whole budget in ~20 minutes and dropped
 * paid orders that never reached the kitchen.
 *
 * Both WRITERS (`orderPush` when a push fails, the scheduler when it has to
 * release a claim) and both READERS (the worker's due filter and its
 * dead-letter filter) import these constants, so the schedule and the attempt
 * limit can no longer drift apart — the old code hard-coded `3` twice.
 *
 * The persisted field is `petpoojaNextRetryAtMs` (epoch ms, on the order doc).
 * It is written in the same merge as `petpoojaStatus: "pending_retry"` and is
 * only read while an order is in the retry lane. `null`/absent means "no
 * schedule" — due immediately — which is also how every pre-backoff (legacy)
 * row is treated, so deploying this never strands an existing backlog.
 */

/**
 * Delay AFTER each successive failure, indexed by the attempt number that just
 * failed (1-based): 5m, 10m, 20m, 40m.
 */
export const PETPOOJA_RETRY_BACKOFF_MS: readonly number[] = [
  5 * 60 * 1000, // attempt 1 failed → wait 5 min
  10 * 60 * 1000, // attempt 2 failed → wait 10 min
  20 * 60 * 1000, // attempt 3 failed → wait 20 min
  40 * 60 * 1000, // attempt 4 failed → wait 40 min
];

/**
 * Highest `petpoojaRetryCount` that is still retryable; anything above it is
 * dead-lettered (`failed` + `kotSyncFailed`, branch alerted to enter the KOT
 * manually). ONE constant for both workers' filters — the old code repeated a
 * bare `3` in two places.
 *
 * Attempt times with this limit: the initial push fails at T, then automatic
 * retries at T+5m, T+15m, T+35m and T+75m (delays of 5/10/20/40 minutes). The
 * next tick after the 4th retry fails dead-letters the order, so a paid order
 * survives a POS outage for roughly 1 hour 15 minutes to 1 hour 20 minutes
 * before ops is paged. The old flat 5-minute schedule dead-lettered the same
 * order after ~20 minutes.
 */
export const PETPOOJA_MAX_RETRY_ATTEMPTS = PETPOOJA_RETRY_BACKOFF_MS.length;

/**
 * Delay owed after `retryCount` failures. Counts beyond the schedule (an
 * operator or a later code change bumped them) reuse the last step instead of
 * producing `undefined`, and 0/NaN read as the first step.
 */
export function petpoojaRetryDelayMs(retryCount: number): number {
  const attempt = Math.max(1, Math.trunc(Number(retryCount) || 1));
  const index = Math.min(attempt, PETPOOJA_RETRY_BACKOFF_MS.length) - 1;
  return PETPOOJA_RETRY_BACKOFF_MS[index];
}

/** Wall-clock time the next attempt becomes eligible, for the given failures. */
export function petpoojaRetryScheduledAtMs(
  retryCount: number,
  now: number = Date.now()
): number {
  return now + petpoojaRetryDelayMs(retryCount);
}

/**
 * Numeric-first read of `petpoojaNextRetryAtMs` (the same trap the claim leases
 * already guard: a `serverTimestamp` sentinel has no toMillis and must not read
 * as 0 — 0 here means "legacy, due now", the opposite of a scheduled wait).
 */
export function petpoojaNextRetryAtMsOf(order: any): number {
  const raw = order?.petpoojaNextRetryAtMs;
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

/** True when this order may be attempted now (legacy rows never wait). */
export function isPetpoojaRetryDue(order: any, now: number = Date.now()): boolean {
  const scheduledAt = petpoojaNextRetryAtMsOf(order);
  return scheduledAt <= 0 || scheduledAt <= now;
}
