# Auth race/epoch repair - delivery-launch-ui-20261028

Date: 2026-10-29. Worktree: `.swarm-worktrees/delivery-launch-ui-20261028`.
Scope: OTP request/verify ownership, challenge-generation fencing, cancelled-confirm
session discard, slot-integrity OTP grid.
No live SMS, live Firebase, user account, credentials, phone or browser control was used.
Synthetic fixtures only (`uid_synthetic_a`, `uid_synthetic_b`, `+91 98250 12345`).

## Correction to the previous revision of this file

The earlier report stated that a cancelled `confirm()` could not leave a usable
Firebase session, and treated the gap as a product decision. Both were wrong.
`confirmationResult.confirm(code)` mutates Firebase auth state before it returns,
so cancelling after that point left a live session that `authStore.refresh()` and
any other `firebaseAuth.currentUser` consumer could still reach. It was a
must-fix defect. It is now fixed and covered by tests.

## Files changed

| File | sha256 | lines |
|---|---|---|
| `src/features/auth/state/authStore.ts` | `DB1279769669EE4BA61368EBB0FCA5F8A3F3DE31C47E61230187C6E599FD19B0` | 479 |
| `src/features/auth/services/authService.ts` | `1B56E8E8DE4CAB798F7B78D393750952919BD0729B73B64D43A57A3A40A3AC4C` | 289 |
| `src/features/auth/repositories/AuthRepository.ts` | `A8490EC179C741CD359ED4A5DC1530B34DF97044B89E4D40065610C606094BF0` | 45 |
| `src/features/auth/components/OTPInputGrid.tsx` | `DDBD48D0CE69A4A0407DA08E49D87F8F22F21BC45FD3BDB0F01364120FEDF347` | 208 |
| `tests/auth.races.test.ts` (new) | `3824012832436005EA1C60E9756E4519F397A19EE353AD785CEA6F8D7CFCF405` | 385 |
| `src/features/auth/components/OTPInputGrid.races.test.tsx` (new) | `A31BD83EEF801A866E81369E71099B3351D3D59FF4A4BDBBA83ABBA3B767136B` | 88 |

`git status` in this scope shows exactly these four modified auth sources and the
two new test files. All other dirty paths in the worktree (home, menu, cart,
checkout, theme, orders, `public/images/brand/`) were already present and were
not touched.

## Transport changes (`authService`)

- `challengeGeneration` counter. `cancelChallenge()` increments it and clears
  `confirmationResult`.
- `requestOtp` clears the old challenge and captures its generation BEFORE the
  first await. A `signInWithPhoneNumber` completion that resolves after the
  generation moved on returns `AUTH_OTP_SUPERSEDED` and never installs itself as
  the current challenge.
- `verifyOtp` serializes confirms (`verifyInFlight`, `VERIFY_IN_PROGRESS`) so two
  owned verifies for the same uid cannot race. It captures the challenge
  generation plus the exact `userCredential.user` uid and `refreshToken` in
  memory only (never logged, never persisted separately).
- On cancellation after `confirm()`, `discardConfirmedSession` signs out ONLY
  that session: `currentUser.uid` must equal the captured uid AND
  `currentUser.refreshToken` must equal the captured refresh token. A null
  `currentUser`, a different uid, or a newer refresh token is a no-op.
- `logout` still cancels the challenge (and therefore bumps the generation).

## Store changes (`authStore`)

- `challengeEpoch` fence plus `identityEpoch` for bootstrap/adoption.
- `verifyOtp` re-checks the epoch BEFORE persisting, and AGAIN after
  `persistSession` resolves (logout/changePhone can land during the storage
  await). On the late path it releases only tokens it wrote
  (`releasePersistedTokensIfOwned` compares the stored access token first), so a
  newer user's tokens are never cleared.
- Fenced verifies call `discardConfirmedSession` unless a newer operation has
  already claimed that uid in the store.
- `bootstrap` shares one in-flight run, captures `identityEpoch`, and re-checks
  after each await before hydrating or setting. A logout during the probe wins;
  the pass still sets `isBootstrapped` so guards do not hang.
- `changePhone` / `logout` bump both epochs and release the send owner so an
  abandoned request cannot block the next one.
- The repository seam is now test-runtime gated (`VITEST` / `MODE` / `NODE_ENV`),
  not `DEV`, so a suite that forces production flags cannot inject a fake
  repository.

## Focused verification (run separately)

```
RED (first revision, before this repair) =>
npx --no-install vitest run tests/auth.races.test.ts \
  src/features/auth/components/OTPInputGrid.races.test.tsx --maxWorkers=1
Test Files 2 failed (2) | Tests 14 failed | 1 passed (15) | exit 1

GREEN =>
npx --no-install vitest run tests/auth.login.test.ts tests/auth.login.test.tsx \
  tests/auth.bootstrap.test.ts tests/auth-error-copy.integration.test.tsx \
  tests/order-service-auth-isolation.test.ts tests/auth.races.test.ts \
  src/features/auth/components/OTPInputGrid.races.test.tsx --maxWorkers=1
Test Files 7 passed (7) | Tests 58 passed (58) | VITEST_EXIT=0 | no stderr, no unhandled

npx --no-install tsc --noEmit
TSC_EXIT=0 | TSC_OUTPUT_LINES=0
```

New cases added for this repair (all passing):

- delayed `requestOtp` cancelled, then a new request for another number proceeds
  and the stale completion cannot replace the challenge
- logout landing during the storage write: no adoption, tokens released
- bootstrap still probing when logout lands: stays `guest`, `isBootstrapped` true
- late confirm after logout, then `bootstrap()`: exact session discarded, guest
- newer verify already claimed the identity: no discard
- different signed-in user: only the cancelled uid's ref is discarded, that user
  is not logged out

## Defects the gates caught during implementation (fixed before freeze)

- `AuthRepository` singleton export dropped during a rebuild (every auth call
  threw).
- Test seam cached the singleton at module init; an import cycle left it
  undefined. Now resolved per call.
- A stray method comma in the repository class produced a parse error.
- Two test-side expectation errors (probe timing; paste slot index).

## Not run / not claimed

- `npm run build` - not run here; the parent serializes full builds.
- No auth emulator, Playwright/browser run, native device, or live provider.
- Full UI suite intentionally not repeated (parent owns that gate).
- No account-deletion flow, no new auth provider, no visual/restyle work.

## Remaining limits

- The exact-session discard is unit-verified against the repository seam only;
  the Firebase branch (`currentUser` uid + refreshToken comparison, `signOut`)
  needs the auth emulator to be exercised end to end.
- Transport generation semantics (stale `signInWithPhoneNumber` completion) are
  likewise emulator-only: the unit tests prove the store contract, not the SDK
  callback ordering.

---

## Second review pass - five defects found after the first repair

The first repair was incomplete. The reviewer's five findings were real; all are
now fixed, with tests that fail on the old code.

| # | Defect | Fix | Test |
|---|---|---|---|
| 1 | Persistence failure cleared local storage but left the Firebase session from `confirm()` alive | `verifyOtp`'s persist catch now calls `discardFencedSession(res.data.sessionRef)` before returning | `auth.races` "reports a persistence failure..." asserts `discardConfirmedSession` called with the exact ref |
| 2 | `discardConfirmedSession` used `if (ref.refreshToken && differs) return` - a missing token fell through and signed out a **newer session for the same uid** | Guard now refuses when the captured token is falsy, then requires uid **and** refresh-token equality | `tests/auth.service.discard.test.ts` (real service, SDK mocked): uid mismatch, newer token, empty token, no session |
| 3 | `verifyInFlight` was a bare promise, so an abandoned verify blocked every later code | Ownership is `{ epoch, promise }`; only the current epoch blocks; `changePhone` / `logout` release it; transport keeps its generation guard | `auth.races` "lets a new code verify while an abandoned verify is still hung" |
| 4 | `releasePersistedTokensIfOwned` treated a `null` read as ownership, and read/delete were not atomic across awaits | Strict equality (`stored !== accessToken` returns, including null) and all persist/clear/release run through one `withSessionStorageLock` queue | `auth.races` "never clears tokens it does not own while releasing a fenced attempt" |
| 5 | `emit` used `next.filter(isDigit).join("")`, collapsing holes; a remount shifted every later digit | Emits positional text with a space placeholder per hole, trailing-trimmed; `toSlots` already maps non-digits to empty; completion still requires six real digits | `OTPInputGrid.races` "restores a middle hole in place when remounted from a controlled value" |

Serializing storage means `logout()`'s clear queues behind an in-flight write.
That is the intended ordering (the alternative is the TOCTOU this fixes), and the
logout-during-persist test now starts logout, releases the write, then awaits both.

### Real-service coverage, not just store mocks

`tests/auth.service.discard.test.ts` imports the **real** `authService` and mocks
only the Firebase SDK boundary (`firebase/auth` + the auth instance). It covers:

- signs out only when uid **and** refresh token match the captured session
- refuses a different uid with the same token
- refuses a newer token for the same uid
- refuses an empty/missing captured token (the uid-only escalation path)
- no-op when no Firebase session exists
- a request whose `signInWithPhoneNumber` resolves after cancel returns
  `AUTH_OTP_SUPERSEDED` and installs no confirmable challenge
- a confirm cancelled mid-flight returns `AUTH_VERIFY_CANCELLED` and signs out
  exactly that session
- the same cancel does **not** sign out when a different user owns the session
- a second concurrent confirm is refused with `VERIFY_IN_PROGRESS`

### Final gate after this pass

```
npx --no-install vitest run tests/auth.login.test.ts tests/auth.login.test.tsx \
  tests/auth.bootstrap.test.ts tests/auth-error-copy.integration.test.tsx \
  tests/order-service-auth-isolation.test.ts tests/auth.races.test.ts \
  tests/auth.service.discard.test.ts \
  src/features/auth/components/OTPInputGrid.races.test.tsx --maxWorkers=1
=> Test Files 8 passed (8) | Tests 70 passed (70) | VITEST_EXIT=0 | no unhandled

npx --no-install tsc --noEmit
=> TSC_EXIT=0 | 0 diagnostic lines
```

Hashes at freeze: authStore `24ED6E8BEA1E12CB`, authService `C6116C202B749D83`,
AuthRepository `A8490EC179C741CD`, OTPInputGrid (unchanged this pass),
auth.races `DB68F0D35CDFE996`, auth.service.discard `E63DDC8E84D58B9B`.

### Known limitation left explicit

`OTPInputGrid` now emits a positional value such as `"12 456"` for a hole. The
OTP screen enables its Verify button on `code.length === 6`, so a holed value can
enable a button whose submit is then rejected by `validateOtp`. Cosmetic, not a
security path, and `auth.otp.tsx` was outside this slice's ownership.
