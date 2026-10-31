# Existing session: close the R17 rules tenant/trust-field protection packet

Queue task: `rules-tenant-trust-protection`. Owner: original root07
`ses_ea5c88140ffeqstoAT9sWrRWFE` (DeepSeek V4.1 Flash Free). No replacement writer.
Read `AUTONOMOUS_WINDOW.md`. Deadline 2026-10-22T03:05:59Z. Main is coordinator only.
(This is a FOLLOW-UP packet for your session; the FCM packet must be finished or
explicitly parked first — do not interleave two writers' changes in one repo.)

## What already exists (verified by Main today, read-only)

The R17 hardening is ALREADY applied and byte-identical in all three mirrors:

- ROOT `firestore.rules` — SHA256 `113FA5EA407F2792DC40E5DB2E4302FC3B2ECD0C21E6A203C64C3AE58BBADCFC`
- CUSTOMER `burgonomics-foundation-core/firestore.rules` — same hash
- PARTNER `burgonomics-partner/firestore.rules` — same hash

The change extends the protected-key list on `users/{userId}` create and update from
`['role','isStaff','isBrandAdmin','isSuperAdmin','grillCoins','loyaltyPoints']` to also
include `branchIds`, `cityIds`, `active`, `isDeleted`, `deletedAt`, so a self-signed-up
customer cannot mint tenant/trust fields for themselves.

New customer emulator tests exist in `burgonomics-foundation-core/tests/rules/firestore.rules.test.ts`
(+99 lines): a clean self-profile create still succeeds (positive control) and self
attempts to birth `role`/`branchIds`/`cityIds`/... fail (negative controls).

Also uncommitted in ROOT: `.merge_file_ZPdkGb` — a stray 38 KB merge leftover whose
content is a copy of the rules file. It is untracked noise, not product code.

## Exact sole-writer scope

1. ROOT `firestore.rules`
2. CUSTOMER `burgonomics-foundation-core/firestore.rules`
3. PARTNER `burgonomics-partner/firestore.rules`
4. CUSTOMER `burgonomics-foundation-core/tests/rules/firestore.rules.test.ts`
5. ROOT `.merge_file_ZPdkGb` — delete it (it is a duplicate stray artefact, not user work; say so in your report)
6. Evidence `closeout-20261022/lane-07-rules.md`

OUT of scope: every other file. In particular the CUSTOMER repo currently has an active
payments owner (lane08) and a pending menu/a11y packet — do not touch payment, menu,
address, shared or app files, and do not run a second CUSTOMER heavy gate while lane08
holds that slot.

## Required outcome

- Prove the hardening with the real emulator suite, not by inspection: self create of
  a clean profile succeeds; self create/update that tries to set `role`, `branchIds`,
  `cityIds`, `active`, `isDeleted`, `deletedAt` is denied; a BRAND OWNER path that
  legitimately writes tenant fields must still work if the rules intend to allow it —
  if the hardening accidentally blocks a legitimate operator write, FIX THE RULES, do
  not weaken the test.
- Keep the three mirrors byte-identical after your change and prove it with a hash
  comparison (root is the canonical copy; the other two are mirrors).
- Never weaken an existing rule to make a test pass, and never widen client write
  access. The protected-field list is a security boundary.
- Confirm the rules suite command actually exists and runs here
  (`node scripts/test-rules.mjs` in the customer repo, per the rules header comment)
  and report real pass/fail counts. If the emulator cannot start on this Windows host,
  report that honestly as a BLOCKED gate with the exact error, and still run every
  check that does not need the emulator.

## Reviews, gates, commit

Freeze the final bytes with immutable copies + Git blobs + SHA256 for all four files.
ONE fresh read-only actual DeepSeek Free reviewer child, THEN a DIFFERENT fresh
read-only actual GLM Free verifier child; verify actual serving models via the local
session API; reviewers write nothing and spawn no children. Apply findings, refreeze.
On 429/transport stop and report.

Commit per repo, only the listed paths (three separate repo commits, not one), plus the
stray-file deletion in the root commit. Never push/deploy. Never stage `.merge_file_*`,
secrets, or foreign paths.

Report `QUEUE_TASK: rules-tenant-trust-protection` with the three commits (or BLOCKED),
hashes, emulator test counts, review IDs + actual models, and the mirror-identity
proof. End with the exact unquoted final line `SUPERVISOR_STATE: COMPLETE` only when
the packet is really closed.
