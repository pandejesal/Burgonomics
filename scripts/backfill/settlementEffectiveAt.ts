/**
 * ONE-OFF, REVIEWED, STAGING-ONLY backfill for the canonical settlement key.
 *
 * Never run against production. The only entry point is the CLI at the bottom;
 * importing this module is side-effect free (no Firestore client, no writes).
 *
 * Rules (mirrors the live writers exactly):
 *  - online (paymentChannel === "razorpay"): the numeric key is stamped ONLY
 *    from a provider-confirmed capture instant (payment.captured_at or
 *    payment.capturedAtMs). No capture -> no key, state "unknown",
 *    unresolved true (rationpay.service.ts verify/recovery and
 *    webhookHandler.ts payment.captured write exactly this).
 *  - cash and every other non-online row: settlementEffectiveAtMs = placedAt
 *    (the doc's createdAt), state "confirmed", unresolved false, exactly as
 *    createCashOrder.ts:557-560 writes it. Legacy cash is NEVER unresolved.
 *  - cancelled razorpay rows are EXCLUDED: on an update that changes only
 *    settlement fields, onOrderStatusChangedNotificationTrigger reaches the
 *    refund reconcile BEFORE its status-delta gate, and
 *    ensureCancelledPaidRefundObligation can create a refund review row (and
 *    alert claim). A backfill must never trigger a refund or a provider call.
 *
 *   STAGING_BACKFILL_CONFIRM=yes BACKFIRE_PROJECT=burgonomics-7faa8 \
 *     BACKFILL_RECEIPT_PATH=./receipt.json \
 *     npx ts-node scripts/backfill/settlementEffectiveAt.ts
 *
 * Rollback: set BACKFILL_ROLLBACK=receipt.json with the same confirm/project.
 */
import * as admin from "firebase-admin";
import * as fs from "fs";

export const SETTLEMENT_FIELDS = [
  "settlementEffectiveAtMs",
  "settlementCaptureState",
  "settlementCaptureUnresolved",
] as const;

type Patch = Record<string, unknown>;

function ms(source: any): number | undefined {
  if (typeof source === "number" && Number.isFinite(source) && source > 0) return Math.round(source);
  if (source && typeof source.toMillis === "function") {
    const v = Number(source.toMillis());
    return Number.isFinite(v) && v > 0 ? Math.round(v) : undefined;
  }
  if (typeof source === "string") {
    const v = Date.parse(source);
    return Number.isFinite(v) && v > 0 ? v : undefined;
  }
  return undefined;
}

/** Provider-confirmed capture time ONLY: seconds -> ms, or already ms. */
/**
 * A Firestore-only backfill has NO signed payment.captured event. Razorpay docs
 * /my/webhooks/payments.mdx contain no `captured_at` field at all, so no
 * stored document can prove a capture instant. Returning undefined keeps the
 * online row unresolved (never a guessed month).
 */
export function providerCapturedAtMs(_order: any): number | undefined {
  return undefined;
}

export function planSettlementPatch(order: any): { skip?: string; patch: Patch } {
  if (typeof order?.settlementEffectiveAtMs === "number") {
    return { skip: "already_backfilled", patch: {} };
  }
  const status = String(
    typeof order?.status === "object" ? order?.status?.code : order?.status
  ).toUpperCase();
  const online = order?.paymentChannel === "razorpay";
  if (online && status === "CANCELLED") {
    return { skip: "cancelled_razorpay_refund_reconcile", patch: {} };
  }
  let patch: Patch;
  if (online) {
    const captured = providerCapturedAtMs(order);
    patch = captured
      ? {
          settlementEffectiveAtMs: captured,
          settlementCaptureState: "confirmed",
          settlementCaptureUnresolved: false,
        }
      : { settlementCaptureState: "unknown", settlementCaptureUnresolved: true };
  } else {
    // createCashOrder.ts:557-560 — placedAt is the doc's server-placed time.
    const placed = ms(order?.createdAt) ?? ms(order?.placedAt);
    patch = placed
      ? {
          settlementEffectiveAtMs: placed,
          settlementCaptureState: "confirmed",
          settlementCaptureUnresolved: false,
        }
      : { settlementCaptureState: "unknown", settlementCaptureUnresolved: true };
  }
  const unchanged = SETTLEMENT_FIELDS.every((f) => !(f in patch) || order?.[f] === patch[f]);
  return unchanged ? { skip: "already_current", patch: {} } : { patch };
}

function snapshot(order: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of SETTLEMENT_FIELDS) out[f] = order?.[f] === undefined ? null : order[f];
  return out;
}

export interface BackfillReceiptEntry {
  id: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

export interface BackfillResult {
  scanned: number;
  written: number;
  unresolved: number;
  excluded: string[];
  receipt: BackfillReceiptEntry[];
}

export async function runBackfill(db: any, receiptPath?: string): Promise<BackfillResult> {
  const result: BackfillResult = { scanned: 0, written: 0, unresolved: 0, excluded: [], receipt: [] };
  let cursor: any = null;
  for (;;) {
    let q: any = db.collection("orders").orderBy(admin.firestore.FieldPath.documentId()).limit(400);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    const docs = snap?.docs ?? [];
    if (!docs.length) break;
    for (const doc of docs) {
      result.scanned += 1;
      const beforeSnap = doc.ref ? await doc.ref.get() : null;
      const current = (beforeSnap && beforeSnap.exists ? beforeSnap.data?.() : doc.data?.()) || {};
      const plan = planSettlementPatch(current);
      if (plan.skip) {
        if (plan.skip === "cancelled_razorpay_refund_reconcile") result.excluded.push(doc.path || `orders/${doc.id}`);
        continue;
      }
      const before = snapshot(current);
      await doc.ref.set(plan.patch, { merge: true });
      const afterDoc = await doc.ref.get();
      result.receipt.push({ id: doc.id, before, after: snapshot(afterDoc.data?.()) });
      result.written += 1;
      if (plan.patch.settlementCaptureUnresolved === true) result.unresolved += 1;
    }
    cursor = docs[docs.length - 1];
  }
  if (receiptPath) fs.writeFileSync(receiptPath, JSON.stringify(result, null, 2));
  return result;
}

/** Removes ONLY the settlement fields this backfill wrote, on those documents. */
export async function rollbackBackfill(db: any, receipt: BackfillReceiptEntry[]): Promise<number> {
  const del = admin.firestore.FieldValue.delete();
  let reverted = 0;
  for (const entry of receipt) {
    const patch: Patch = {};
    for (const f of SETTLEMENT_FIELDS) patch[f] = del;
    await db.collection("orders").doc(entry.id).set(patch, { merge: true });
    reverted += 1;
  }
  return reverted;
}

function assertStaging(): void {
  const confirm = process.env.STAGING_BACKFILL_CONFIRM === "yes";
  const project = String(process.env.BACKFIRE_PROJECT || "");
  if (!confirm || project !== "burgonomics-7faa8") {
    throw new Error("Refusing: set STAGING_BACKFILL_CONFIRM=yes and BACKFIRE_PROJECT=burgonomics-7faa8");
  }
}

async function cli(): Promise<void> {
  assertStaging();
  const rollback = process.env.BACKFILL_ROLLBACK;
  const db = admin.firestore();
  if (rollback) {
    const receipt = JSON.parse(fs.readFileSync(rollback, "utf8"));
    console.log(JSON.stringify({ reverted: await rollbackBackfill(db, receipt.receipt ?? receipt) }));
    return;
  }
  const result = await runBackfill(db, process.env.BACKFILL_RECEIPT_PATH);
  console.log(JSON.stringify({
    scanned: result.scanned,
    written: result.written,
    unresolved: result.unresolved,
    excluded: result.excluded,
    receipt: result.receipt,
  }));
}

if (require.main === module) {
  void cli().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
