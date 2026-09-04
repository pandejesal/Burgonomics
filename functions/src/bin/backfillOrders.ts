/**
 * One-off backfill runner for pre-bridge `orders` docs.
 *
 *   Dry run (default, writes nothing):
 *     npm run backfill:orders
 *
 *   Apply:
 *     npm run backfill:orders -- --apply
 *
 * Auth (either):
 *   - GOOGLE_APPLICATION_CREDENTIALS=/path/to/serviceAccount.json, or
 *   - gcloud auth application-default login (ADC)
 * Optional: FIREBASE_PROJECT_ID (default burgonomics-7faa8)
 *
 * Safety: only fills missing customerId/createdAt/updatedAt/branchId,
 * paginated (400/page, 50 pages default; --max-pages N to raise).
 */
import * as admin from "firebase-admin";
import { runOrderBackfill } from "../modules/maintenance/orderBackfill";

function parseArgs(argv: string[]) {
  const args = { apply: false, maxPages: 50 };
  for (const a of argv) {
    if (a === "--apply") args.apply = true;
    const m = a.match(/^--max-pages=(\d+)$/);
    if (m) args.maxPages = Math.max(1, parseInt(m[1], 10));
  }
  return args;
}

async function main() {
  const { apply, maxPages } = parseArgs(process.argv.slice(2));

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    admin.initializeApp({
      credential: admin.credential.cert(process.env.GOOGLE_APPLICATION_CREDENTIALS),
      projectId: process.env.FIREBASE_PROJECT_ID || "burgonomics-7faa8",
    });
  } else {
    admin.initializeApp({
      projectId: process.env.FIREBASE_PROJECT_ID || "burgonomics-7faa8",
    });
  }

  const db = admin.firestore();
  console.log(
    `[backfill] mode=${apply ? "APPLY (writing)" : "DRY-RUN (no writes)"} project=${process.env.FIREBASE_PROJECT_ID || "burgonomics-7faa8"}`
  );

  const summary = await runOrderBackfill(db, { dryRun: !apply, maxPages });
  console.log(
    `[backfill] scanned=${summary.scanned} would_update=${summary.updated} skipped=${summary.skipped} errors=${summary.errors.length}`
  );
  for (const e of summary.errors.slice(0, 20)) console.error(`[backfill] error: ${e}`);
  if (!apply && summary.updated > 0) {
    console.log("[backfill] re-run with --apply to write these updates.");
  }
  process.exit(summary.errors.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[backfill] fatal:", err?.message || err);
  process.exit(1);
});
