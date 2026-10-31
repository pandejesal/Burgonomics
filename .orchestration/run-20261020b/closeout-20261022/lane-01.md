# Lane 01 — customer address packet closeout

Task: `customer-address-closeout` · session `ses_ea5c8a548ffex6hMqeB90XmuF0` (original root)
Contract: run-20261020b `CONTRACT.md` + `closeout-20261022/AUTONOMOUS_WINDOW.md`
Label: **LOCAL CODE VERIFIED** (isolated exact-bundle gate at the stated base). No deploy, no
push, no E2E/device/provider claim.

## Commit

- Repo: `burgonomics-foundation-core`, branch `ui-sweep`
- Base HEAD: `2f47cef1dd9d9b7696898c3c502051df22b7dc2f`
- Commit (local only, never pushed): **`6e25a0cb6a3ae5883e860ea89fa758c17342664b`**
  `fix(addresses): honest failure closure, session isolation and accessible save errors [lane:customer]`
- Scope: exactly 9 paths, 2222 insertions / 138 deletions. No foreign path staged; `git diff --cached`
  was empty before and after; real index carries nothing else.

Provenance: the address patch existed as prior-team uncommitted work. It was adopted after
investigation (not reimplemented) and completed with the delta below; its useful behavior is preserved.

## Defects found in the adopted patch (reproduced first)

1. **Remote save failure was toast-only.** `AddressFormModal` renders an inline `role="alert"` for
   validation errors, but a failed remote save only toasted: nothing stayed visible for a
   screen-reader user, while the sheet remained open on the same values.
2. **No synchronous re-entry guard.** `setSubmitting(true)` is async, so two native submits before the
   disabled state re-renders fire two remote writes → duplicate saved addresses.
3. **Session-change failure was retryable and generic.** `AUTH_CHANGED` (the remote write for account A
   already committed) was `retryable: true` and was not in `userMessages` `CODE_MESSAGES`, so the modal
   showed the generic copy and left Save enabled — a retry under account B would duplicate the row.
4. **Session check preceded the failure check.** A genuine write failure coinciding with a session
   change was re-labelled `AUTH_CHANGED`.
5. **List screen failures were toast-only.** Delete / set-default failures had no persistent,
   accessible error and no route-level failure test.

## Delta applied (all inside the 9 paths)

- `AddressRepository`: `if (!res.success) return res;` before the post-await session check in all four
  mutations; `AUTH_CHANGED` is now `retryable: false` with copy "Your session changed before we could
  confirm that. Reopen this address after signing in."; header documents why retrying duplicates.
- `AddressFormModal`: synchronous `saveInFlightRef` re-entry guard set as the first `try` statement and
  released in `finally`; inline `role="alert"` copy on failure/catch; `saveBlocked` terminal state for
  `AUTH_CHANGED` (Save disabled, "Reopen to retry", early return ahead of clearing the alert, reset on
  reopen).
- `profile.addresses`: single `actionError` inline `role="alert"` for delete/set-default failures,
  cleared on success, named handlers.
- Tests: failure-path coverage added (inline alert + retained values + no success toast + no close;
  double-submit coalescing; guard release after failure; terminal AUTH_CHANGED incl. programmatic
  submit bypass; list-screen delete/set-default failures through the real buttons).

## RED → GREEN evidence

- **RED (pristine base + ONLY the final test files):** `2f47cef` snapshot with the 4 final test files
  and no source patch → **34 failed / 13 passed (47)**. Every failure is an address behavior the patch
  is supposed to fix (signed-out closure, swallowed write failures, missing-doc defaults, repository
  local-state safety, account switch, ProtectedRoute gating, modal behavior).
- **RED (adopted patch WITHOUT the lane delta):** modal file → **2 failed / 11 passed (13)**; the two
  failures are exactly the new inline-alert and double-submit tests.
- **GREEN (final bytes, working tree):** 4 focused files **53/53 passed**; `npx tsc --noEmit` exit 0.

## Reviews (actual serving models verified from the runtime DB, not pins)

| Role | Child session | Parent | Assistant msgs served | Verdict |
|---|---|---|---|---|
| DeepSeek V4.1 Flash Free | `ses_e9efb6f73ffeX7EjqhU8MqK50m` | my root | 31/31 `opencode/deepseek-v4.1-flash-free` | APPROVE (all 7 findings dispositioned; delta re-checked) |
| GLM 5.3 Flash Free | `ses_e9eefadd3fferIQBDmrE9QSWfS` | my root | 10/10 `opencode/glm-5.3-flash-free` | CONFIRMED_WITH_NOTES (53/53 re-run) |

DS findings applied: AUTH_CHANGED terminal + curated copy, list-screen inline alerts + tests, guard
placement, failure-before-session ordering, guard-release test, and (new LOW) the terminal alert is no
longer cleared by a programmatic submit.

## Isolated exact-bundle gate

Method: detached worktree `.../Temp/opencode/lane01-addr-closeout/gate-2f47cef` at base `2f47cef`,
`node_modules` junction, overlay of ONLY the 9 reviewed paths (snapshot `git status` = those 9: 5 M,
4 new). No stash; shared tree untouched; foreign dirty/untracked files excluded by construction.

| Command | Exit | Evidence |
|---|---|---|
| `npx --no-install tsc --noEmit` | 0 | no diagnostics |
| `npm test -- --maxWorkers=2` | 0 | **87 files / 591 tests passed, 0 failed** |
| `npm run build` | 0 | Vite `✓ built in 10.96s` |

Committed blobs re-checked against the frozen manifest after the commit: **9/9 match**
(`git ls-tree HEAD` blob == frozen blob for every path).

## Frozen manifest (blob · SHA256 · path)

| Git blob | SHA256 | Path |
|---|---|---|
| `030a7dad69da96e5c72717bdd58addbae3bb6a87` | `C611A8C6BFD7E9A5D4C7662CA55DAFEECF620E8FC4B10D72115FFA88D8D8802F` | `src/features/addresses/repositories/AddressRepository.ts` |
| `247ce802f32aca9dbe5c0f30b135d3a9202275cb` | `16D4AD532B5C8CA0F5631CD198D6745964AD9B3DAA19EF4B97FDDC376B973E5C` | `src/features/addresses/services/addressService.ts` |
| `5b47ca0377384256a94c4216c75c42c82927529b` | `1D0017588D673BA419EA71D605DDA2F41DA919475680E66BFB417D89663B8F25` | `src/features/profile/components/AddressFormModal.tsx` |
| `59f1972b31ec15136ccca4cbbc4884ec054cca73` | `DBFF480B9D8901F81D0C1C9DE2C935FDAD7E50D9655F50CBCCAF79C035369E36` | `src/routes/addresses.create.tsx` |
| `ceca1d36643219abcf730853a1b39719e40288cc` | `F9822313218AC28A7858AA52C4F901521EF4171D8101030C93987893F3206F2B` | `src/routes/profile.addresses.tsx` |
| `d70823a0dfc441500263dc162c81692b8df24601` | `50EBB680FE06BE182BE8391A3026053230A2531360DCBEB5BAF5D9D1FAA3FBBB` | `src/features/profile/components/AddressFormModal.test.tsx` |
| `6a8ced9afa5aecf62b04629632a4746d73e75902` | `A32D64736C73D08E1D3841EC4D07EC17A34A42C087C3CE7FA16B00097148188A` | `src/routes/addresses.create.test.tsx` |
| `ddd7fa457c60eb5598e5042b011ed7c77aeae5dd` | `370B167A6D1563746F87DC8305607F50AFC48D2D2EB972EABAA02C15F78DA629` | `src/routes/profile.addresses.test.tsx` |
| `6f63274a95057c70f435ec96e19428740b0b42e5` | `BC1AA41F3130DB9EF222C07FB75EDA6533367A3C34BBDF27FCC3F3CDB9293A72` | `tests/address-persistence-failures.test.ts` |

## Honest limits (documented, not violations of the required outcomes)

- `AddressRepository.list()` still serves the locally persisted store; `addressService.list()` (the
  Firestore read) has no call site yet, so server addresses are not seeded back after login. A
  missing read-back is not a false success and no mutation becomes local-only, but saved addresses
  are device-local until a seed path is added. Header documents this.
- Deleting the default address promotes a new local default without mirroring it to the server
  (success-path consistency divergence, pre-existing, unchanged).
- The full-page `/addresses/create` route delegates its failure UX to `AddressForm` (a path outside
  this packet); that path's failure handling was read and is correct (`setError` + error toast, no
  `onSaved`, no navigation) but is not covered by tests inside this packet.
- `AddressFormModal.a11y.test.tsx` exists untracked and is OUTSIDE the nine paths; it was not staged
  or committed.

## Foreign work

All other working-tree changes (menu, payments, rules, workflows, native, other tests) were left
untouched: no stash, no reset, no checkout, no blanket staging. At commit time only the nine paths
were staged; 45+ foreign modified/untracked entries remain in the tree.

## Gate artifacts

`.../Temp/opencode/lane01-addr-closeout/`: `manifest.txt`, `source.diff`, `red-tests.log`,
`red-modal-unfixed.log`, `green-4.log`, `gate-tests.log`, `gate-build.log`.
