# Lane 07 — FCM fan-out list bypass (users/{uid}.fcmTokens)

Truth label: **LOCAL CODE VERIFIED** (rules engine/emulator on the exact bundle).
No deployment, no live project, no PII read/write.

## Defect

`firestore.rules` → `match /users/{userId}` allowed any signed-in user to write
`users/{theirUid}.fcmTokens` (create and update both omitted the field from the
denylist). Dispatch reads exactly that array
(`functions/src/modules/notifications/fcmClient.ts`), so a client could attach an
arbitrary/foreign FCM token to its own push fan-out.

That makes the server ownership gates decorative:
- `functions/src/core/deviceTokenRegister.ts` (commit 962c649) refuses a foreign
  or ownerless `device_tokens/{token}` binding with HTTP 409.
- `functions/src/modules/notifications/unregisterToken.ts` refuses non-owner
  deletes and never purges other accounts' lists on an unproven token.

A client-side append re-creates the same foreign-token adoption through the SDK,
where the 409 never runs.

Legit client writers (grep of both app sources):
- `authService.ts` profile create → id/phone/createdAt only.
- `profileService.ts` profile update → `ProfileInput` (no token field).
- `notificationsService.ts` logout fallback → `fcmTokens: arrayRemove(token)` +
  `updatedAt` on the caller's own doc (REMOVAL only).
- Partner app: no `fcmTokens` writer at all.

## Repro (pre-fix, captured)

Full 18-test file against the committed rules → **10 failed | 58 passed (68)**.
Every deny assertion fails because the write SUCCEEDS:
tests 1 (append), 2 (replace), 3 (create plant), 9 (brand attach), 11 (non-list),
13 (merge-create plant), 14 (duplicate inflation), 16 (merge over existing),
17 (re-add after shrink), 18 (re-add after deleteField).
Log: `red-state-full-suite.log` (the earlier 10-test file run, 3 failed | 7 passed,
is in `pre-fix-repro.log`).

## Fix (minimal, no weakening)

`fcmTokensRemovalOnly()` helper + one create conjunct + update conjuncts:

- new list must be a **list**, a **subset** of the stored list, and **no longer**
  than it (the size bound blocks duplicate inflation, which `hasOnly` ignores);
- field absent → `get('fcmTokens', [])` default, so legacy profiles and
  `deleteField()` behave (0 ≤ 0);
- brand/operator authority is bounded by the same invariant: attaching a token is
  server-only for every client role, while `role`/`branchIds`/`cityIds`/`active`
  stay brand-writable;
- create forbids seeding `fcmTokens`; the first link is server-stamped by
  `POST /notifications/registerToken`.

`scripts/test-rules.mjs` adds `--fileParallelism=false`: `tests/rules` now holds two
files and both call `clearFirestore()` on the same projectId, so parallel files wipe
each other's seeds.

## Tests (18, positive + negative)

Deny: self append, self replace, create plant, cross-user write, brand attach,
non-list value, shrink+`role` smuggling, `setDoc(merge)` create plant, duplicate
inflation, `setDoc(merge)` over an existing doc, re-add after shrink.

Allow: `arrayRemove` own token (+`updatedAt`), stale remove no-op, any subset,
ordinary profile update, brand tenant-field write, legacy doc without the field,
removal persists, `deleteField` (then re-add denied).

## Gate (isolated exact bundle)

- Worktree: `git worktree add --detach %LOCALAPPDATA%\Temp\opencode\lane07-gate 29fd0e6`
  (customer HEAD), `node_modules` junction, no install, **no stash**.
- Overlaid only: `firestore.rules`, `tests/rules/users-fcm-tokens.rules.test.ts`,
  `scripts/test-rules.mjs`.
- The rules blob is synthesized as **HEAD + the lane-07 hunk only**; the unclaimed
  foreign R17 hunks in the working copies (`branchIds`/`cityIds`/`active`/`isDeleted`/
  `deletedAt` + tests 50-54) are excluded from the committed blob. Gate-side
  `git diff` = 1 hunk, +36/−2, zero foreign lines.
- Committed blob: `44f4b476368b17eee0ea7991406fc7b764ed3926` (identical in all three
  repos — root canonical, customer mirror, partner mirror).
- Command: `npm run test:rules` (cwd = worktree) → **Test Files 2 passed, Tests 68
  passed, exit 0** (50 pre-existing HEAD tests + 18 new). Log: `gate-bundle.log`.
- Worktree removed after the gate; logs preserved here.

## Reviews

- DeepSeek V4.1 Flash Free (child `ses_ea52aa616ffeMEbQ1MpQUKyQLn`, read-only):
  round 1 **APPROVE_WITH_CHANGES** — 2 MAJOR (brand branch bypass; CI rules job still
  parallel) + 4 MINOR (test 9 enshrined the bypass; `hasOnly` multiplicity; absent-field
  eval error; tautological test 10) — all applied except the CI hunk, which is outside
  lane 07 ownership and was posted as an exact proposal. Round 2 re-check after the
  delta: **APPROVE**.
- GLM 5.3 Flash Free (child `ses_ea4a2eb31ffeAR0Q5a74fDxZSt`, separate verifier):
  **VERIFIED_WITH_NOTES** — no remaining add-path, no over-block, byte-identity and
  rule-language semantics confirmed. Notes applied: precise comment wording (the code
  permits equal-size repeats, not only shrinkage); three added pins (merge over an
  existing doc, re-add after shrink, `deleteField`); full-suite red-state captured.
  Remaining note (CI `--fileParallelism=false`) is outside lane 07 ownership.

## Commits (local only, never pushed)

| Repo | SHA | Paths |
|---|---|---|
| root | `6e4bfdd` | `firestore.rules` |
| customer | `355ba9f` | `firestore.rules`, `tests/rules/users-fcm-tokens.rules.test.ts`, `scripts/test-rules.mjs` |
| partner | `d7b8d69` | `firestore.rules` |

Unclaimed foreign R17 edits remain in the working copies of all three rules files and
were neither staged nor committed (`git status` still shows `M firestore.rules`).

## Outside lane 07 (proposal, not applied)

`burgonomics-foundation-core/.github/workflows/ci.yml` (clean file, not owned by lane
07):
- rules job: add `--fileParallelism=false` to the vitest invocation;
- web job: `npx vitest run` also collects `tests/rules/**` (no emulator, `CI=true`
  hard-fails) — add `--exclude 'tests/rules/**'`.
