# Lane 01 — customer address server-truth debt (closed)

- Queue task: `customer-address-server-truth`
- Owner: original root01 `ses_ea5c8a548ffex6hMqeB90XmuF0`, actual
  `opencode/deepseek-v4.1-flash-free`
- Customer base: `98c8dc4` (payments hook commit)
- Local commit: `ea1bc3f14990f2a484c0480043d786f3e632c4c7`
  (`fix(addresses): seed server addresses on login and confirm default promotion [lane:customer]`)
- Commit contains exactly 5 paths; 37 pre-existing foreign dirty/untracked
  entries remain untouched. No push, deploy, stash, reset, or broad staging.

## Four debts

1. **Server addresses were device-local — CLOSED.**
   `AddressRepository.hydrate()` reads `addressService.list()` for the signed-in
   uid and merges the result into the store. A failed read returns the typed
   failure and writes nothing; the uid is captured before the read and checked
   before the write; rows mutated (or with a mutation in flight) after the read
   began keep the live local copy (monotonic revision); ids deleted in that
   window are tombstoned; unsynced local-only rows are preserved; the server's
   recorded default wins unless a local default was mutated in the same window.
   `profile.addresses.tsx` calls it on mount and shows a loading status instead
   of "No saved addresses" while the first read runs, plus a persistent
   `role="alert"` failure instead of a false empty state.
2. **Delete-default promoted without a server mirror — CLOSED.**
   `remove()` computes the row the store will promote, deletes locally, clears
   the store's unconfirmed auto-promotion, then mirrors with
   `addressService.setDefault` and only then marks it default. A failed mirror
   keeps the committed delete, leaves NO row flagged default, and returns
   `DEFAULT_PROMOTION_FAILED` ("Address deleted, but we couldn't set a new
   default…", not retryable). A session change during the mirror returns
   `AUTH_CHANGED` and leaves B untouched.
3. **`/addresses/create` failure UX — already correct, coverage added.**
   `AddressForm` already set a `role="alert"` error, error toast, retained
   fields, and never called `onSaved` (so the route never navigates) on failure.
   No product code changed; one test added to the existing polish suite.
4. **Untracked a11y test — ADOPTED.**
   13/13 green against the committed component before adoption; committed in
   `ea1bc3f` (554 lines).

## Frozen bytes (reviewed, then committed — blob equality verified)

| path | git blob | SHA256 |
|---|---|---|
| `src/features/addresses/repositories/AddressRepository.ts` | `6c195480c59a2e8b26389f3888e90fa7fa2945fa` | `c0bc7f55a3663967217f4a38e106fe01c7a822a4a9de464bcb196bd65834468e` |
| `src/routes/profile.addresses.tsx` | `50ec7cedbea7354319739ff4e96361993786930a` | `17c566b2bae8e232443cfc9e6721c1fefa40e2b0204102b07f7ca6b95ef23a6d` |
| `tests/address-persistence-failures.test.ts` | `edb191be7caa402618aa4613a73bbf59a357b2e4` | `04f0fa9e13a72ae3c053240c2320931638ff6359734039cb6fee4957e7d3a4f4` |
| `src/features/addresses/components/AddressForm.polish.test.tsx` | `a6ddc73a186148f904aa43337fa877cb0b946515` | `ef9223cd5d6da36b4087c7d854d141d83b461283b7fba515386bbd3b7eaa2bb1` |
| `src/features/profile/components/AddressFormModal.a11y.test.tsx` | `ee4a87d6fde7e40e58cf185a7264012cb9a13ad6` | `75d97da9b5d7e9213950a0b813351ac6ef11084b31bdd5476f0ed65b0d4062aa` |

Immutable copies + `manifest.tsv`:
`C:\Users\DELL\AppData\Local\Temp\opencode\lane01-addr-debt\frozen\`.

## RED → GREEN

- Baseline at `98c8dc4` (committed bytes): 32/32 in
  `tests/address-persistence-failures.test.ts`.
- RED over `98c8dc4`: 10 new tests failed — 7 seed (`hydrate is not a function`
  and no server merge/default truth) and 3 promotion (no mirror, no failure
  code, no mid-mirror guard). Log: `red-new-tests.log`.
- The create-failure UX test is GREEN over committed bytes by design (debt 3 was
  already correct; it adds missing coverage, not new behaviour).
- GREEN candidate: 3 focused files / 56 tests — `green-first.log`.
- a11y alone: 13/13 — `a11y-test.log`.
- Full dirty-tree regression run (foreign work present): 104 files / 818 tests
  pass — `dirty-full-tests.log`.

## Independent review

- Reviewer: `ses_e993a7074ffe2rkfvYY2nemzRZ`, actual serving model verified from
  `session_message` assistant rows: **12/12 `opencode/glm-5.3-flash-free`,
  0 mismatches** (`reviewer-model-proof.txt`). Author is DeepSeek, so GLM is the
  independent model required by POLICY; read-only, no children.
- Verdict: **APPROVE_WITH_NOTES**, no BLOCKER/MAJOR; all four debts judged
  genuinely closed. Full text: `review-verdict.md`.
- Minors were not changed after review so the committed bytes stay identical to
  the reviewed bytes; they are recorded as limits below.

## Isolated heavy gate (customer, mine first; lane 03 released)

Detached worktree at `98c8dc4` + only the five reviewed paths; `node_modules`
junction; no foreign dirty file present. Blobs in the worktree matched the
manifest before running.

| command | exit | result |
|---|---|---|
| `npx --no-install tsc --noEmit` | 0 | no output (`gate-tsc.log`) |
| `npm test -- --maxWorkers=2` | 0 | 94 files / 721 tests passed (`gate-tests.log`) |
| `npm run build` | 0 | vite build, 7.51s (`gate-build.log`) |

`GATE START` and `GATE END` posted on `fresh-run-2-coordination`; lane 03 may
proceed. Worktree removed after the gate; no push/deploy.

## Remaining honest limits

- Hydration is wired to the saved-addresses screen mount. A customer who goes
  straight to checkout on a brand-new device still sees only the local store
  until that screen mounts (root-level seed needs an auth-observer hook outside
  this packet's scope).
- A brand-new first address is still auto-defaulted by the store without a
  server mirror (pre-existing behaviour, not the delete-default path).
- If the server collection records no default, an unmutated pre-existing local
  default flag is cleared by the seed (data rows survive; the UI intentionally
  does not invent a server default).
- Tombstones are module-lifetime and not pruned; `mutatedAt` grows with mutated
  ids. The header comment "kept until the next seed" is imprecise; no functional
  impact for generated `addr_*` ids.
- The route's `hydrate?.()` optional call exists so isolated host/test doubles
  that omit the method do not crash mount; the production class always exposes
  it. The loading/error branch is proven at the repository level and by review,
  not by a route-render test (route test file was outside this packet's scope).
- A route that stays mounted across an account switch re-scopes the store via
  `addressStore` but does not re-run `hydrate`; ProtectedRoute remounts in the
  normal flow.
