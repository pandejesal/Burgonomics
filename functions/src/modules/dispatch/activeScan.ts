/**
 * A8-7 (preprod audit c11) — shared cursor scan for the delivery pollers.
 *
 * WHY. Both pollers fetched a SINGLE `.limit(25)` page on the dispatch legs and
 * only THEN filtered for provider + 15-minute staleness:
 *
 *   orders.where("deliveryStatus", "in", ["dispatched","in_transit"])
 *         .limit(25).get()   // ← then .filter(provider && stale)
 *
 * In a fleet with more than 25 active deliveries, a stale order outside that
 * first page was never polled, never advanced its poll count, and never reached
 * its 12-failure / 2-hour dead-letter escalation. The same shape starved
 * `retryPendingShadowfaxCancels`: up to 25 `state: "pending"` rows with
 * staff-cancelled rows skipped AFTER the limit, so order-cancelled retries
 * queued behind them were deferred indefinitely.
 *
 * THIS walks the query with a document cursor across the whole active set and
 * applies the eligibility filter per document, so no row can hide behind 25
 * others. The per-tick PROVIDER-CALL budget stays with the caller (`budget`
 * fixes how many eligible rows are returned), so cost discipline is unchanged:
 * only the SCAN stopped being truncated.
 *
 * Firestore's implicit document-id ordering is what the cursor anchors on, so
 * the caller must not add an `orderBy` that this helper does not know about.
 */
export const ACTIVE_SCAN_PAGE = 25;
/** Safety stop so a runaway collection cannot page forever in one tick. */
export const ACTIVE_SCAN_MAX_PAGES = 40;

/**
 * Pages `buildQuery(cursor)` until the active set is exhausted or `budget`
 * eligible documents have been found.
 *
 * `buildQuery` receives the previous page's last document (or `undefined`
 * for the first page) and must return a query object with `.get()`. A read
 * failure stops the scan with whatever was already collected — a worker that
 * cannot read must not claim full coverage.
 */
export async function scanActiveDocuments(
  buildQuery: (startAfterDoc?: any) => any,
  eligible: (data: any) => boolean,
  budget: number
): Promise<any[]> {
  const found: any[] = [];
  let cursor: any;
  for (let page = 0; page < ACTIVE_SCAN_MAX_PAGES; page += 1) {
    let snap: any;
    try {
      snap = await buildQuery(cursor).get();
    } catch (err: any) {
      console.error("[Dispatch Poll] active-order page failed:", err?.message || err);
      break;
    }
    const docs = snap?.docs || [];
    if (docs.length === 0) break;
    for (const doc of docs) {
      const data = doc.data ? doc.data() : undefined;
      if (!data) continue;
      if (!eligible(data)) continue;
      found.push(doc);
      if (found.length >= budget) return found;
    }
    cursor = docs[docs.length - 1];
    if (docs.length < ACTIVE_SCAN_PAGE) break;
  }
  return found;
}

/**
 * The `lastPolledAt` / `updatedAt` guard shared by the pollers: a row that was
 * touched inside the staleness window is a healthy webhook stream and is not
 * worth a provider GET.
 */
export function staleEnough(order: any, nowMs: number, stalenessMs: number): boolean {
  const lastUpdated =
    order?.updatedAt?.toMillis ? order.updatedAt.toMillis() : Number(order?.updatedAt) || 0;
  return nowMs - lastUpdated >= stalenessMs;
}
