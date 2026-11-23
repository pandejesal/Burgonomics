/**
 * ONE-OFF, REVIEWED, STAGING-ONLY backfill for the canonical settlement key.
 *
 * Production has never run; staging test statements predate the ledger. This
 * copies a single numeric `settlementEffectiveAtMs` from the best available
 * provider/server timestamp onto every orders doc that lacks it, so the
 * settlement query can use ONE indexed field. Rows whose capture is unknown
 * get `settlementCaptureState: "unknown"` and remain un-payable in statements.
 *
 *   STAGING_BACKFILL_CONFIRM=yes BACKFIRE_PROJECT=burgonomics-7faa8 \
 *     npx ts-node scripts/backfill/settlementEffectiveAt.ts
 */
import * as admin from "firebase-admin";

const confirm = process.env.STAGING_BACKFILL_CONFIRM === "yes";
const project = String(process.env.BACKFIRE_PROJECT || "");
if (!confirm || project !== "burgonomics-7faa8") {
  throw new Error("Refusing: set STAGING_BACKFILL_CONFIRM=yes and BACKFIRE_PROJECT=burgonomics-7faa8");
}

admin.initializeApp({ projectId: project });
const db = admin.firestore();

function numeric(source: any): number | undefined {
  if (typeof source === "number" && Number.isFinite(source) && source > 0) return Math.round(source);
  if (source && typeof source.toMillis === "function") return Number(source.toMillis());
  if (typeof source === "string") {
    const ms = Date.parse(source);
    if (Number.isFinite(ms)) return ms;
  }
  return undefined;
}

async function main(): Promise<void> {
  let scanned = 0;
  let written = 0;
  let unresolved = 0;
  let cursor: any = null;
  for (;;) {
    let q: any = db.collection("orders").orderBy(admin.firestore.FieldPath.documentId()).limit(400);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) break;
    for (const doc of snap.docs) {
      scanned += 1;
      const d: any = doc.data();
      if (typeof d?.settlementEffectiveAtMs === "number") continue;
      // Provider-confirmed capture first; never the bank credit date.
      const captured = numeric(d?.payment?.capturedAtMs) ?? numeric(d?.payment?.captured_at);
      const fallback = numeric(d?.payment?.gatewayCreatedAtMs) ?? numeric(d?.createdAt) ?? numeric(d?.placedAt);
      const at = captured ?? fallback;
      const patch: Record<string, unknown> = at
        ? { settlementEffectiveAtMs: at, settlementCaptureState: captured ? "confirmed" : "unknown", settlementCaptureUnresolved: !captured }
        : { settlementCaptureState: "unknown", settlementCaptureUnresolved: true };
      if (!at) unresolved += 1;
      await doc.ref.set(patch, { merge: true });
      written += 1;
    }
    cursor = snap.docs[snap.docs.length - 1];
  }
  console.log(JSON.stringify({ scanned, written, unresolved }));
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
