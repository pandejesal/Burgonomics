/**
 * ONE-OFF, REVIEWED, STAGING-ONLY migration for SEC-11 (A3 finding 1).
 *
 * `branches/*` is readable by every operator role, so the POS/payment
 * identifiers it used to carry are being moved to `branch_secrets/{branchId}`
 * (brand-only rules). This script performs that move for documents that already
 * exist. It is NOT run by this change: the release lane plans, reviews, then
 * applies it.
 *
 *   PLAN  (read-only, the default):
 *     STAGING_BACKFILL_CONFIRM=yes BACKFIRE_PROJECT=burgonomics-7faa8 \
 *       BACKFILL_MODE=plan npx ts-node scripts/backfill/branchSecretsMigration.ts
 *
 *   APPLY (writes; refuses without an explicit receipt path):
 *     STAGING_BACKFILL_CONFIRM=yes BACKFIRE_PROJECT=burgonomics-7faa8 \
 *       BACKFILL_MODE=apply BACKFILL_RECEIPT_PATH=./branch-secrets-receipt.json \
 *       npx ts-node scripts/backfill/branchSecretsMigration.ts
 *
 *   ROLLBACK (restores the branch fields this run removed):
 *     ... BACKFILL_MODE=rollback BACKFILL_ROLLBACK=./branch-secrets-receipt.json
 *
 * The rules on every write:
 *  - copy `petpooja`, `petpoojaStoreId`, `restIDs` into `branch_secrets`;
 *  - DELETE those three keys from the branch document;
 *  - DELETE `razorpayAccountId` from the branch document and do NOT copy it:
 *    Razorpay Route per-order transfers are retired (`attemptRouteTransfer` is a
 *    stub and `src/` has no reader), so the value is dead weight and a
 *    cross-tenant disclosure risk.
 *  - never touch a branch that carries none of these keys.
 */
import * as admin from "firebase-admin";
import * as fs from "fs";

export const MIGRATED_FIELDS = ["petpooja", "petpoojaStoreId", "restIDs"] as const;
export const DROPPED_FIELDS = ["razorpayAccountId"] as const;

export interface BranchMigrationPlan {
  branchId: string;
  /** "move" writes, "skip" has nothing to do. */
  action: "move" | "skip";
  /** Payload written to `branch_secrets/{branchId}` (never the dropped keys). */
  secret: Record<string, unknown>;
  /** Branch fields the plan removes. */
  removedFields: string[];
  /** Branch fields present but deliberately NOT carried over. */
  droppedFields: string[];
}

export interface BranchMigrationReceiptEntry {
  branchId: string;
  /** Exactly the branch fields removed, with their VALUES, for rollback. */
  removed: Record<string, unknown>;
  /** The secret document as written (its "before" is always absent). */
  secret: Record<string, unknown>;
}

export interface BranchMigrationResult {
  mode: "plan" | "apply";
  scanned: number;
  planned: number;
  written: number;
  skipped: number;
  entries: BranchMigrationPlan[];
  receipt: BranchMigrationReceiptEntry[];
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

/** Pure: decides what a single branch document needs. No I/O. */
export function planBranchMigration(branchId: string, data: any): BranchMigrationPlan {
  const secret: Record<string, unknown> = {};
  const removed: string[] = [];
  const dropped: string[] = [];

  if (!data || typeof data !== "object") {
    return { branchId, action: "skip", secret, removedFields: removed, droppedFields: dropped };
  }

  for (const field of MIGRATED_FIELDS) {
    if (field in data) {
      if (isPresent(data[field])) secret[field] = data[field];
      removed.push(field);
    }
  }
  for (const field of DROPPED_FIELDS) {
    if (field in data) {
      dropped.push(field);
      removed.push(field);
    }
  }

  // Nothing to move and nothing to drop: leave the document alone. A branch
  // that already has `petpoojaStoreId` only inside branch_secrets lands here.
  const hasMovedValues = Object.keys(secret).length > 0;
  const hasAnythingToRemove = removed.length > 0;
  if (!hasMovedValues && !hasAnythingToRemove) {
    return { branchId, action: "skip", secret, removedFields: [], droppedFields: [] };
  }

  return {
    branchId,
    action: "move",
    secret: Object.keys(secret).length > 0 ? { ...secret, branchId } : {},
    removedFields: removed,
    droppedFields: dropped,
  };
}

/** Reads every branch and returns the plans. NEVER writes in this function. */
export async function planBranchSecretsMigration(db: any, pageSize = 300): Promise<BranchMigrationResult> {
  const result: BranchMigrationResult = {
    mode: "plan",
    scanned: 0,
    planned: 0,
    written: 0,
    skipped: 0,
    entries: [],
    receipt: [],
  };
  let cursor: any = null;
  for (;;) {
    let query: any = db.collection("branches").orderBy(admin.firestore.FieldPath.documentId()).limit(pageSize);
    if (cursor) query = query.startAfter(cursor);
    const snap = await query.get();
    const docs = snap?.docs ?? [];
    if (docs.length === 0) break;
    for (const doc of docs) {
      result.scanned += 1;
      const plan = planBranchMigration(doc.id, doc.data?.() ?? {});
      if (plan.action === "skip") {
        result.skipped += 1;
        continue;
      }
      result.planned += 1;
      result.entries.push(plan);
    }
    if (docs.length < pageSize) break;
    cursor = docs[docs.length - 1];
  }
  return result;
}

/** Applies the plans. Keeps a per-document receipt with the REMOVED VALUES. */
export async function applyBranchSecretsMigration(
  db: any,
  plans: BranchMigrationPlan[],
  receiptPath?: string
): Promise<BranchMigrationResult> {
  const result: BranchMigrationResult = {
    mode: "apply",
    scanned: plans.length,
    planned: plans.length,
    written: 0,
    skipped: 0,
    entries: plans,
    receipt: [],
  };
  const del = admin.firestore.FieldValue.delete();

  for (const plan of plans) {
    const branchRef = db.collection("branches").doc(plan.branchId);
    const before = await branchRef.get();
    if (!before?.exists) {
      result.skipped += 1;
      continue;
    }
    const current = before.data() ?? {};
    const removed: Record<string, unknown> = {};
    const stripPatch: Record<string, unknown> = {};
    for (const field of plan.removedFields) {
      if (field in current) {
        removed[field] = current[field];
        stripPatch[field] = del;
      }
    }
    if (Object.keys(removed).length === 0) {
      result.skipped += 1;
      continue;
    }

    if (Object.keys(plan.secret).length > 0) {
      await db.collection("branch_secrets").doc(plan.branchId).set(
        {
          ...plan.secret,
          migratedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
    await branchRef.update(stripPatch);
    result.receipt.push({ branchId: plan.branchId, removed, secret: plan.secret });
    result.written += 1;
  }

  if (receiptPath) {
    fs.writeFileSync(
      receiptPath,
      JSON.stringify(
        {
          createdAt: new Date().toISOString(),
          project: String(process.env.BACKFIRE_PROJECT || ""),
          migratedFields: MIGRATED_FIELDS,
          droppedFields: DROPPED_FIELDS,
          written: result.written,
          receipt: result.receipt,
        },
        null,
        2
      )
    );
  }
  return result;
}

/**
 * Puts back exactly the branch fields this run removed, from its own receipt.
 * The secret document is left in place: it is the canonical home now, and
 * deleting it during a rollback would break live KOT sends.
 */
export async function rollbackBranchSecretsMigration(
  db: any,
  receipt: { receipt?: BranchMigrationReceiptEntry[] } | BranchMigrationReceiptEntry[]
): Promise<number> {
  const entries = Array.isArray(receipt) ? receipt : receipt.receipt ?? [];
  let reverted = 0;
  for (const entry of entries) {
    const restore: Record<string, unknown> = { ...entry.removed };
    if (Object.keys(restore).length === 0) continue;
    await db.collection("branches").doc(entry.branchId).set(restore, { merge: true });
    reverted += 1;
  }
  return reverted;
}

function assertStaging(): void {
  const confirm = process.env.STAGING_BACKFILL_CONFIRM === "yes";
  const project = String(process.env.BACKFIRE_PROJECT || "");
  if (!confirm || project !== "burgonomics-7faa8") {
    throw new Error(
      "Refusing: set STAGING_BACKFILL_CONFIRM=yes and BACKFIRE_PROJECT=burgonomics-7faa8 (staging only)"
    );
  }
}

function mode(): "plan" | "apply" | "rollback" {
  const raw = String(process.env.BACKFILL_MODE || "plan").toLowerCase();
  if (raw === "plan" || raw === "apply" || raw === "rollback") return raw;
  throw new Error(`Refusing: unknown BACKFILL_MODE ${raw} (plan | apply | rollback)`);
}

async function cli(): Promise<void> {
  assertStaging();
  const selected = mode();
  const db = admin.firestore();

  if (selected === "rollback") {
    const path = process.env.BACKFILL_ROLLBACK;
    if (!path) throw new Error("Refusing: rollback needs BACKFILL_ROLLBACK=<receipt.json>");
    const receipt = JSON.parse(fs.readFileSync(path, "utf8"));
    console.log(JSON.stringify({ reverted: await rollbackBranchSecretsMigration(db, receipt) }));
    return;
  }

  const planned = await planBranchSecretsMigration(db);
  if (selected === "plan") {
    console.log(
      JSON.stringify({
        mode: "plan",
        scanned: planned.scanned,
        planned: planned.planned,
        skipped: planned.skipped,
        entries: planned.entries,
        writes: 0,
      })
    );
    return;
  }

  const receiptPath = process.env.BACKFILL_RECEIPT_PATH;
  if (!receiptPath) throw new Error("Refusing: apply needs BACKFILL_RECEIPT_PATH=<receipt.json>");
  const applied = await applyBranchSecretsMigration(db, planned.entries, receiptPath);
  console.log(
    JSON.stringify({
      mode: "apply",
      scanned: applied.scanned,
      written: applied.written,
      skipped: applied.skipped,
      receiptPath,
    })
  );
}

if (require.main === module) {
  void cli().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
