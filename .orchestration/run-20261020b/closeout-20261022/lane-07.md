# Lane 07 — token-unregister close-out (token-unregister-closeout)

Truth label: **LOCAL CODE VERIFIED** (focused unit suites, one isolated full
functions gate, local commit only). No network, no live Firebase, no provider
writes, no secrets or real token/user identifiers.

Base: root `086b60d5afe492391d222873f259e6ddc7d760ad` (Porter retirement; out of
scope) on top of review-start base `5e1777cb…`. Frozen candidate dir:
`C:\Users\DELL\AppData\Local\Temp\opencode\lane07-unreg-freeze\` (+ `manifest.json`).

## Frozen bytes (immutable copies)

| Path | SHA-256 | Git blob |
|---|---|---|
| `functions/src/modules/notifications/unregisterToken.ts` | `4442D51A49FB7649549E52127C37CA522B24946166492D80D2B4A4EA38093EE2` | `25dcc369448fd360d35182461fc70928f7e433a3` |
| `functions/tests/notifications.token-ownership.test.ts` (new) | `8F24D2C2F89753024090A73F3DB4DE6CF50A17221FBDD121C152D3B4D7EB9A3A` | `56ce2ec86bc1b1d22ce504720c52ba183657799b` |
| `functions/tests/unregisterToken.test.ts` | `FAB83B45849F2B47395257714E353065F45BF65ECE9385C0D270A8DA5646CA57` | `6e9e97363ebadd5ecd1bc6b48c67c4031c07e995` |

## RED

- **RED-1 — original suite vs the delivered source** (`unreg-red.log`):
  **2 failed / 12 passed (14)**, both `TypeError: db.runTransaction is not a
  function` at `unregisterToken.ts:66`. The fake also lacked `docs`/`size`
  (returned `forEach` only) and its `arrayRemove` returned `[item]` instead of
  removing — latent fixture gaps behind the first. **All fixture gaps; no part
  of these two failures is a source defect** (the source legitimately needs a
  transaction to make the ownership compare atomic with the delete).
- **RED-2 — genuine source gap** (`unreg-rebind-red.log`): ownership test 13,
  the post-commit hook rebinds the token to a second account between the delete
  commit and the holders scrub; the pre-fix scrub stripped the new owner's fresh
  membership — **1 failed / 12 passed (13)**,
  `expected ['tkn_attackerowntoken…'] to include 'tkn_realregistrationtoken…'`.
  Defect of the delivered rewrite, not of the committed base (the base had no
  ownership gate at all).

## GREEN

- Focused, final bytes (`unreg-green3.log`): `npx vitest run
  tests/unregisterToken.test.ts tests/notifications.token-ownership.test.ts`
  → **15 passed (15)** (2 adapted originals + 13 ownership).
- **Isolated full gate** on an exact worktree at `086b60d` + the three frozen
  files only (`unreg-gate-final.log`, run after the final comment fix):
  `npm run typecheck` exit 0 · `npm test -- --maxWorkers=2` → 76 files passed /
  1 skipped (77), **912 passed / 2 skipped (914)**, exit 0 · `npm run build`
  exit 0. An earlier identical-byte-except-one-comment run also passed
  (`unreg-gate.log`, same counts); the final run is the one quoted.

## Fixture adaptation (original suite)

`tests/unregisterToken.test.ts` models the real client faithfully: transaction
writes buffered and applied **at commit**, full `docs`/`size`/`forEach` snapshot
surface, `arrayRemove` that actually removes, `update()` on a missing doc throws
`NOT_FOUND` (code 5). Assertions pin exact remaining tokens
(`users/u1 -> ["tok_9"]`, `users/u2 -> []`), the unrelated holder (`users/u3`)
byte-identical and never updated, and `removedFromUsers === 2`. Unknown-token
path pins no delete / no update / count 0. The ownership gate's negative half is
pinned by ownership tests 2/3/7.

## Source correction (narrow)

The holders scrub is now a **second transaction** whose first read is
`device_tokens/{token}`:
- token doc exists again -> rebind won; skip the scrub wholesale (warn),
  `removedFromUsers: 0`; the skip protects the new owner's fresh membership and
  stale lists survive until that owner's later **refreshed**-path registration
  prunes them (a fresh claim never scans — verified at
  `core/deviceTokenRegister.ts:154`);
- concurrent holder mutation -> transaction retry instead of a stale write;
- post-delete scrub failure -> warn + constant body (logout never 500s).

Honest limits (in code comments): the delete and the scrub are **two commits**;
nothing is claimed about writes outside those transactions.

## Reviews (one at a time, read-only, exact frozen bytes)

- **DeepSeek** `ses_e9f07d88bffeoOunDDx2cJJEIu`, persisted session model
  `{"id":"deepseek-v4.1-flash-free","providerID":"opencode"}`. Round 1
  **APPROVE_WITH_CHANGES** (two comment misclaims + cap-test comment); after
  those fixes, a focused final reconfirm returned **APPROVE_WITH_CHANGES** with
  one last comment-only correction (the same prune overstatement in test 13's
  justification). That was applied and the bytes re-frozen; the source blob was
  already approved as-is and stayed byte-identical. Main's independent API
  serving proof: 32/32 actual DS assistant records, 0 mismatches
  (`closeout-20261022/lane-07-serving-proof.json`).
- **GLM** `ses_e9f02f99effeNM51y21kZSmPym`, persisted session model
  `{"id":"glm-5.3-flash-free","providerID":"opencode"}`. **VERIFIED** on the
  pre-comment bytes, then a focused final reconfirm **VERIFIED** on the final
  blobs `25dcc369/56ce2ec/6e9e9736` — delta isolated to the one comment,
  corrected rationale verified against `deviceTokenRegister.ts`, 15/15 passing.
  Main's serving proof: 13/13 actual GLM records, 0 mismatches.

## Commit (local only, never pushed)

Root `4b6e4f6` on `086b60d`, exactly three paths, committed blobs identical to
the frozen manifest (`git rev-parse HEAD:<path>` verified). Real index reset to
HEAD afterwards; 90 unrelated dirty paths (other lanes/Main) remain untouched
and unstaged. No push, deploy, provider or live-data action.

## Remaining limits

- Gate and reviews are local/actual-model only; nothing deployed or run against
  a live project.
- The scrub transaction's retry behaviour on genuine contention is asserted by
  Firestore semantics and modelled only via the fake's happy path; the
  rebind-skip is proven by test 13 against the pre-fix code.
