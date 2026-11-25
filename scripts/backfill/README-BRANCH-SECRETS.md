# Branch secrets migration (SEC-11) — ops tooling, NOT deployed

One-off migration that moves a branch's POS/payment identifiers off
`branches/{branchId}` into the brand-only `branch_secrets/{branchId}`, because
`branches` stays readable to every operator role (`isStaff()`).

Moved: `petpooja`, `petpoojaStoreId`, `restIDs`.
**Dropped, never copied:** `razorpayAccountId` — Razorpay Route per-order
transfers are retired (`attemptRouteTransfer` is a stub and `functions/src` has
no reader), so keeping the value would only preserve a cross-tenant disclosure
risk.

Like the other backfills in this folder, the source lives here (not
`functions/src/`) so it is excluded from the Cloud Functions deploy bundle.
The module is side-effect free on import; the CLI is the only entry point.

**Do not run APPLY against production. Staging (`burgonomics-7faa8`) only.**

## PLAN (read-only — safe first step, writes nothing)

```bash
cd functions
./node_modules/.bin/tsc -p ../scripts/backfill/tsconfig.json
STAGING_BACKFILL_CONFIRM=yes BACKFIRE_PROJECT=burgonomics-7faa8 BACKFILL_MODE=plan \
  NODE_PATH=node_modules node ../scripts/backfill/dist/branchSecretsMigration.js
```

Prints `{mode:"plan", scanned, planned, skipped, entries[], writes:0}`. Review
`entries` — one object per branch that still carries a secret field.

Windows (cmd, the same three env vars):

```bat
cd functions
node_modules\.bin\tsc -p ..\scripts\backfill\tsconfig.json
set STAGING_BACKFILL_CONFIRM=yes
set BACKFIRE_PROJECT=burgonomics-7faa8
set BACKFILL_MODE=plan
set NODE_PATH=node_modules
node ..\scripts\backfill\dist\branchSecretsMigration.js
```

## APPLY (writes; refuses without a receipt path)

```bash
STAGING_BACKFILL_CONFIRM=yes BACKFIRE_PROJECT=burgonomics-7faa8 \
  BACKFILL_MODE=apply BACKFILL_RECEIPT_PATH=./branch-secrets-receipt.json \
  NODE_PATH=node_modules node ../scripts/backfill/dist/branchSecretsMigration.js
```

Per branch it: writes `branch_secrets/{id}` with the moved values (merge), then
deletes the moved keys **and** `razorpayAccountId` from the branch document. It
keeps a receipt with the **removed values** per branch, so a rollback is exact.

Re-running is safe: once the fields are gone the branch plans as `skip`.

## ROLLBACK (restores the moved values into their canonical home)

```bash
STAGING_BACKFILL_CONFIRM=yes BACKFIRE_PROJECT=burgonomics-7faa8 \
  BACKFILL_MODE=rollback BACKFILL_ROLLBACK=./branch-secrets-receipt.json \
  NODE_PATH=node_modules node ../scripts/backfill/dist/branchSecretsMigration.js
```

Rollback writes the receipt's moved values back into `branch_secrets/{id}`
(merge) — **not** onto `branches/{id}`. That is deliberate: the safety-net
trigger `onBranchWrittenSecretsMirror` runs on every `branches` write, mirrors
those keys into `branch_secrets` and strips them from the branch again, so a
branch-document rollback is silently undone one trigger hop later while still
exposing the identifiers to every `isStaff()` reader in between. Restoring the
canonical document is trigger-safe and idempotent (verified in
`functions/tests/backfill.branchSecretsMigration.test.ts`, "ROLLBACK mode").

`razorpayAccountId` is never restored: it is retired (`DROPPED_FIELDS`, no
reader in `functions/src`).

Then delete `scripts/backfill/dist/` and the receipt (it holds removed values).

Auth: `GOOGLE_APPLICATION_CREDENTIALS=/path/to/serviceAccount.json` or
`gcloud auth application-default login`.

Guards (in code, not just here): `STAGING_BACKFILL_CONFIRM=yes` **and**
`BACKFIRE_PROJECT=burgonomics-7faa8` are both required for every mode, `apply`
additionally needs `BACKFILL_RECEIPT_PATH`, and `rollback` needs
`BACKFILL_ROLLBACK`. Nothing runs against another project.
