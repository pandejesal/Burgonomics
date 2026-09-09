# Order Backfill (ops tooling — NOT deployed)

One-off backfill for pre-bridge `orders` docs missing the query-compatible
mirrors (`customerId` / `createdAt` / `updatedAt` / `branchId`).

These sources live here (not `functions/src/`) so they are **excluded from
the Cloud Functions deploy bundle** (B6-S1 deploy-path hygiene). Only fills
missing fields, never overwrites; dry-run by default.

`tsconfig.json` pins the project TypeScript 5.x toolchain and maps
`firebase-admin` to `functions/node_modules` (bare-specifier resolution
walks up from this dir, so the mapping + `NODE_PATH` below are required).

## Run

From repo root via npm (Windows/cmd):

```bash
npm --prefix functions run backfill:orders
```

Apply writes:

```bash
npm --prefix functions run backfill:orders -- --apply
```

POSIX shells (`set` is cmd-only) — same steps manually from repo root:

```bash
cd functions && ./node_modules/.bin/tsc -p ../scripts/backfill/tsconfig.json && NODE_PATH=node_modules node ../scripts/backfill/dist/backfillOrders.js [--apply]
```

Then delete `scripts/backfill/dist/`.

Auth: `GOOGLE_APPLICATION_CREDENTIALS=/path/to/serviceAccount.json` or
`gcloud auth application-default login`. Optional: `FIREBASE_PROJECT_ID`
(default `burgonomics-7faa8`).
