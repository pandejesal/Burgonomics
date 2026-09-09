import type { Firestore } from "firebase-admin/firestore";
import * as admin from "firebase-admin";

/**
 * Backfill for pre-bridge `orders` docs that lack the query-compatible
 * mirrors (customerId / createdAt / branchId) added to new writes.
 *
 * Safety rules (never violated):
 *  - Only fills fields that are missing (undefined, null, or "").
 *  - Never overwrites an existing value, even a "wrong-looking" one.
 *  - Dry-run by default; writes only with explicit opt-in.
 *  - Bounded pagination (default 50 pages x 400 docs).
 *
 * branchId fills ONLY from the embedded store snapshot's partnerBranchId
 * (set by ops when outlets are linked). Unlinked stores keep branchId
 * missing — the Partner alias-query path still finds them under All Outlets.
 */

export interface BackfillPlan {
  updates: Record<string, unknown>;
  filled: string[];
}

function isMissing(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

export function planOrderBackfill(data: Record<string, any>): BackfillPlan | null {
  const updates: Record<string, unknown> = {};
  const filled: string[] = [];

  if (isMissing(data.customerId) && !isMissing(data.userId)) {
    updates.customerId = data.userId;
    filled.push("customerId");
  }

  if (isMissing(data.createdAt) && !isMissing(data.placedAt)) {
    updates.createdAt = data.placedAt;
    filled.push("createdAt");
  }

  if (isMissing(data.updatedAt)) {
    const fallback = !isMissing(data.createdAt)
      ? data.createdAt
      : !isMissing(data.placedAt)
        ? data.placedAt
        : undefined;
    if (fallback !== undefined) {
      updates.updatedAt = fallback;
      filled.push("updatedAt");
    }
  }

  const linkedBranch = (data.store as any)?.partnerBranchId;
  if (isMissing(data.branchId) && !isMissing(linkedBranch)) {
    updates.branchId = linkedBranch;
    filled.push("branchId");
  }

  if (filled.length === 0) return null;
  return { updates, filled };
}

export interface BackfillSummary {
  scanned: number;
  updated: number;
  skipped: number;
  dryRun: boolean;
  errors: string[];
}

export async function runOrderBackfill(
  db: Firestore,
  opts: { dryRun?: boolean; pageSize?: number; maxPages?: number } = {}
): Promise<BackfillSummary> {
  const dryRun = opts.dryRun !== false;
  const pageSize = Math.min(Math.max(opts.pageSize ?? 400, 1), 500);
  const maxPages = opts.maxPages ?? 50;

  const summary: BackfillSummary = { scanned: 0, updated: 0, skipped: 0, dryRun, errors: [] };
  let startAfter: FirebaseFirestore.DocumentSnapshot | undefined;

  for (let page = 0; page < maxPages; page++) {
    let q: FirebaseFirestore.Query = db
      .collection("orders")
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(pageSize);
    if (startAfter) q = q.startAfter(startAfter);

    let snap: FirebaseFirestore.QuerySnapshot;
    try {
      snap = await q.get();
    } catch (err: any) {
      summary.errors.push(`page ${page + 1} read failed: ${err?.message || err}`.slice(0, 300));
      break;
    }
    if (snap.empty) break;

    const batch = db.batch();
    let pageWrites = 0;
    snap.forEach((docSnap) => {
      summary.scanned += 1;
      try {
        const plan = planOrderBackfill((docSnap.data() as Record<string, any>) || {});
        if (!plan) {
          summary.skipped += 1;
          return;
        }
        if (!dryRun) {
          batch.set(docSnap.ref, plan.updates, { merge: true });
          pageWrites += 1;
        }
        summary.updated += 1;
      } catch (err: any) {
        summary.errors.push(`${docSnap.id}: ${err?.message || err}`.slice(0, 300));
      }
    });

    if (!dryRun && pageWrites > 0) {
      try {
        await batch.commit();
      } catch (err: any) {
        summary.errors.push(`page ${page + 1} commit failed: ${err?.message || err}`.slice(0, 300));
      }
    }

    const docs = snap.docs;
    if (docs.length < pageSize) break;
    startAfter = docs[docs.length - 1];
  }

  return summary;
}
