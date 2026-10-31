# Firebase Rules Acceptance Results â€” backend-email-contract-20261029
Run date: 2026-10-29. Runner: GLM reviewer subagent, isolated rules harness only.
Live-run: REAL locally cached Firestore emulator (jar `C:\Users\DELL\.cache\firebase\emulators\cloud-firestore-emulator-v1.22.0.jar`,
JAVA = Android Studio JBR, node v24.18.0), loopback 127.0.0.1:8166, synthetic project `demo-firebase-qa-20261029`
(money gate/probe) and `burgonomics-test-rules` (byte-copied 4 existing rules files). NO live Firebase,
NO credentials, NO FCM, NO SMS, NO storage creation, NO production write, NO deployed-rules fetch.

## 1) Authoritative rules identity & drift (SHA256)
| Copy | SHA256 before | SHA256 after | Change author |
|---|---|---|---|
| ROOT `firestore.rules` (deploy source of root firebase.json) | 113FA5EAâ€¦DCFC | 113FA5EAâ€¦DCFC | untouched (verified) |
| `burgonomics-foundation-core\firestore.rules` (app mirror / emulator target of core_test-rules.mjs) | BF491F4Câ€¦600282 | BF491F4Câ€¦600282 | untouched (preserved) |
| `burgonomics-partner\firestore.rules` | 113FA5EAâ€¦DCFC | 113FA5EAâ€¦DCFC | untouched (preserved) |
| WORKTREE candidate `.swarm-worktrees\backend-email-contract-20261029\firestore.rules` | BF491F4Câ€¦600282 (pre-promote) â†’ 113FA5EAâ€¦DCFC (exact root policy promoted) â†’ 8A29193Câ€¦ (mask applied, BOM) â†’ **99C37419BBCF5C015E673FA7D4DFD585E063980A1ED3AC8874ABD833B1F2C6A0 (final, BOM-free)** | owned file (git `M firestore.rules`) |

Root must-not-edit: verified untouched post-run (hash identical to pre-run).
Diff confirm rootâ†’worktree before promotion: `Compare-Object` = 4 lines = exactly the 2 users/{uid}
mask line pairs; worktree lines are root lines minus the tail keys `branchIds, cityIds, active,
isDeleted, deletedAt` (structural checker PASS). No other deltas.

## 2) Repair applied (single bounded change, 1 file)
`orders.update` brand arm, worktree candidate file line ~272 (was `allow update: if isBrandOwner() || (`).
Replaced with an unmasked-arm deny â€” SAME server-owned field list the branch arm already carries:
totals, pricingSnapshot, pricing, customerId, userId, branchId, paymentStatus, payment,
refundStatus, refundId, refundAmount, routeTransferStatus, deliveryOtpHash, deliveryOtp,
deliveryOtpAttempts, deliveryOtpLockedUntil. The branch arm, customer cancel/whatsapp arms,
create block, and every other collection block are byte-identical to root policy.
Root rules, core mirror, partner mirror: NOT touched. No other copy mirrors created anywhere.

## 3) Reproduction & repair verification (money-ownership harness)
Harness: `stages/08_menu/output/integration-acceptance-20261029/firebase-qa/rules-money-ownership.emulator.test.mjs`
(probe|gate). 88 rows: 82 server-owned-field DENY rows across roles [anon, customer (own),
branch-staff-own (admin doc role branch_owner branchId branch_01), branch-staff-missing-claims
(token role only, no branchIds, no admins doc â†’ fail-closed), foreign-branch-staff, brand-owner
(admin doc role), developer], plus 6 legit ALLOW control rows (staff status flow, customer
cancel, customer whatsapp opt-in, partner POS walk-in cash create, customer clean create,
customer own-order read) and banned-plant-create deny rows.

- STAGE 0 â€” rules = ROOT policy (pre-fix), real emulator:
  - probe `logs/probe-stage0-root.json` exit 0: **22 deny-rows SUCCEEDED for brand-owner and
    developer** across paymentStatus/payment/totals/pricingSnapshot/pricing/refundStatus/
    refundId/refundAmount/routeTransferStatus/deliveryOtpHash/deliveryOtpAttempts â€” reproduction
    CONFIRMED on the emulator. All 6 legit rows allowed; zero spurious denies.
  - gate `logs/gate-stage0-root.json` exit **1**: GATE FAIL with exactly those 22 violations â†’
    "regressions fail before mask" recorded.
- STAGE 1 â€” rules = MASKED CANDIDATE:
  - probe `logs/probe-stage1-candidate.json` exit 0: deny-violations **0** (all 82 denies hold,
    incl. brand/developer â€” formerly 22 allowed), allow-violations 0.
  - gate r2 `logs/gate-stage1-r2.json` exit **0** (GATE PASS, 88 rows)
  - gate r3 `logs/gate-stage1-r3.json` exit **0** (GATE PASS, 88 rows)
  - gate r4 `logs/gate-stage1-r4.json` exit **0** (GATE PASS, 88 rows)
  - ONE transient (gate r1): allow-row `legit-customer-create` returned permission-denied once
    mid-run (setVisible log adjacent: known v1.22.0 rules-engine eval-error on token-role lookups
    for users without an admins doc, "Property role is undefined" â€” pre-existing on root too); did
    NOT reproduce in 3 reruns (r2â€“r4) and probe. Mask deny behavior was 100% stable across every
    run. Recorded honestly; recommend a retry-loop or per-case isolation when promoting this
    harness to a permanent suite.

## 4) Existing 4-file rules suite vs correct candidate (byte-copied, unmodified)
Runner: owned `temp-rules-suite\vitest.config.ts` CWD trick (`readFileSync("firestore.rules")` resolves to
the harness-copied rules bytes; only my config adds testTimeout=180s, hookTimeout=180s).
- vs MASKED CANDIDATE (`existing4-candidate.cmd`): **Test Files 4 passed (4), Tests 113 passed (113), skipped 0 / failed 0 / todo 0** (duration 103.96s).
- vs ROOT policy baseline (`existing4-root.cmd`): **4 files / 113 tests passed, 0 skipped/failed/todo** (61.29s).
Files: branch-announcements.rules.test.ts, firestore.rules.test.ts, ticket-resolution-lease.rules.test.ts,
users-fcm-tokens.rules.test.ts (MD5-copied verbatim; per-inventory lengths preserved 11964/33883/29419/12453 B).

## 5) Role matrix summary (rules-lane; verified on emulator)
| role (context basis) | server-owned field writes | legit ops | notes |
|---|---|---|---|
| anon (unauth) | deny (root & candidate) | create denied | reads denied |
| customer (own uid, no claims) | deny both | own-read ok, cancel ok, whatsapp ok, clean-create ok | banned-plant create denied (refundStatus) |
| branch-staff-own (admin doc branch_owner+branchId) | deny both | status flow ok, walkin-cash create ok | banned-plant create denied (petpoojaOrderId) |
| branch-staff-missing-claims (token role, no branchIds/admins doc) | deny (fail-closed) | all denied | verified both stages |
| foreign-branch-staff (branch_01 credentials on branch_02 doc) | deny (both read+write) | none | verified both stages |
| brand-owner (admin doc) | **root: ALLOW x11, candidate: DENY x11** | innocuous/legit update allowed (non-money fields) | the repaired lane |
| developer (admin doc) | **root: ALLOW x11, candidate: DENY x11** | see brand-owner | the repaired lane |

## 6) API 401/403 lane â€” SEPARATE from rules permission-denied (STATIC references only)
No functions emulator was started (functions API is parent-serialized lane; this harness makes NO
claims tests for it). Static read of functions sources confirms role gates are enforced in HTTP API
space separate from Firestore rules: `functions/src/index.ts:393-396,480,704-707,961-983,1060`
(signature 401, refused-route 403/404/409, stack custom status passthrough) and
`functions/src/index.ts:1178-1187` (`403 Forbidden: topic is outside your role scope` / `branch`). Those
lanes must be exercised by the parent's serialized functions suite â€” not claimed here.

## 7) Storage â€” BLOCKED (as instructed)
No `storage.rules` existed anywhere pre-run and none was created. Root `firebase.json` has no `storage`
deploy config and no storage emulator entry (functions/firestore/auth/ui only). New storage policy is
unknown to the parent at this time â†’ recorded BLOCKED; zero storage touch in this run.

## 8) Commands (verbatim, all zero-production-side-effect)
- Emulator (per stage, OWNED supervisor `firebase-qa\run-stage.ps1 -CmdFile <stage.cmd> -StageLabel <lbl>`):
  starts cached jar `--host=127.0.0.1 --port=8166 --project_id=demo-firebase-qa-20261029`, waits TCP READY,
  runs stage via `cmd /c` with console log `logs\stage-<lbl>-console.log`, always Stops-Process the java PID.
- Stage files created (all inside owned firebase-qa dir): gate-stage0.cmd, gate-stage1.cmd,
  gate-stage1-r2.cmd, gate-stage1-r3.cmd, existing4-candidate.cmd, existing4-root.cmd.
- Core runner NOT invoked bare (`scripts/test-rules.mjs` avoided deliberately: it loads the STALE
  `burgonomics-foundation-core\firestore.rules` copy and swallows a missing emulator).
- No `npx` fetches (all deps cached), no `firebase deploy`, no live project access, no SMS.

## 9) Cleanup
- All 11 java emulator instances confirmed dead; port 8166 free; no stray PIDs.
- Emulator data dirs `%LOCALAPPDATA%\Temp\opencode\firebase-qa-emu-*` deleted (8 dirs).
- Harness `node_modules` junction removed (link only; target core node_modules untouched).
- Kept for audit inside firebase-qa: rules-money-ownership.emulator.test.mjs, temp-rules-suite\ (4
  byte-copied test files + vitest.config.ts, no firestore.rules copy left), logs\ (probe/gate JSONs,
  console logs, emulator stdout/stderr logs, hashes-promote.json, final-hash-audit.json), stage cmd files.

## 10) Source-vs-deployed caveat (binding limitation)
Acceptance was performed on SOURCE files only â€” the production-deployed ruleset was never fetched
(per constraints; no live cloud call). If the deployed cloud ruleset currently drifts from SOURCE FIRESTORE.RULES,
these results bind the SOURCE, not the deployed state. Root policy source is the deployment model per
`firebase.json` (firestore.rules config) and matches `burgonomics-partner\firestore.rules`;
`burgonomics-foundation-core\firestore.rules` is a STALE copy (missing users/{uid} branchIds/cityIds/
active/isDeleted/deletedAt) and NEEDS a mirror re-sync by whoever owns the core lane.

## 11) Artifacts (hashes verified at time of write)
- Candidate (worktree): `99C37419BBCF5C015E673FA7D4DFD585E063980A1ED3AC8874ABD833B1F2C6A0`
- Root policy: `113FA5EA407F2792DC40E5DB2E4302FC3B2ECD0C21E6A203C64C3AE58BBADCFC`
- Core mirror (stale, unchanged): `BF491F4CC46C8D1E1A9678A20456755155D56F7A6BD9E7CCEF3E2EDAAB600282`
- Root firebase.json: `1C50FAA3150545ADDAC016A93EE6515DA663AFF05B18B5E9144891A473C7871E`
