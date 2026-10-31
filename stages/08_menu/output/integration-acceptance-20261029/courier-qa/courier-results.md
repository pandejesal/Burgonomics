# Courier dispatch verification - 2026-10-29

Local real-Firestore-emulator + native-TLS-recorder replay of the exact current dispatch source. **Not vendor acceptance.**

## Verdict

- Runner: `node run-tests.cjs --snapshot dispatch-current-01 --scope dispatch --mode final --expected dispatch-current-01.expected.json --run dispatch-final-07`
- Exit: **0**; `scopedChecksPassed: true`; `sourceAcceptance: false`; `cleanupComplete: true`
- Cases: **21/21 PASS** (3 infrastructure + 18 dispatch)
- No business-logic failure reproduced in the final run.

## Source actually executed

| File | Bytes | SHA256 |
|---|---|---|
| `functions/src/modules/dispatch/dispatch.router.ts` | 97482 | `794f8ae61ff3cd2cae1156332721e0383f943b60700f093a17b77d4daacf4d49` |
| `functions/src/modules/dispatch/types.ts` | 8199 | `e23999e87159a34fb748d7a2c0e0e7bc837858f5266f86ea2d62f18040c9f5c3` |
| `functions/src/modules/dispatch/providers/shared.ts` | 12118 | `371d1dda0b6618f2720d94d5b55b25d91040a69104fbdc3239bec42395526601` |
| `functions/src/modules/dispatch/providers/borzo.adapter.ts` | 29535 | `472490fe64fc3cb9e0de214ff39c2fa7ce0d68515830acf201ce8941766b255c` |
| `functions/src/modules/dispatch/providers/shadowfax.adapter.ts` | 28526 | `96cf79151715eecd9d9f2d198a2c69e3dd8c6c8a53ec9a983230a26774b37fcd` |

- Worktree: `C:\Users\DELL\Desktop\Burgonomics\.swarm-worktrees\backend-email-contract-20261029`
- HEAD: `31e82c3c415757064e3b33010ade4d2b0d8ebd6f` (dirty staged + unstaged)
- Snapshot label: `dispatch-current-01`; manifest SHA256: `07b49dc931b7ae15e97b31f40edaf0d5a7e7908b33ea8ea0169c6c124913b88b`
- Frozen closure: 20 files (5 entries + imported core/config/providers/notifications closure), all hashed in `snapshots/dispatch-current-01/manifest.json`.
- Harness SHA256: snapshot `3c26771b572ccf5ba7295048cc58d96147daebd719b8a8a0cd77d2e100b6afb4`, infrastructure `78286d41f623320477ed940ede6a2082b820fb9fcc29ef1e239a653fbb8aa723`, run-tests `59f405cfd0c283bdbc4b898fd48479a80055a448acd231a055e925bd8c145a43`.

## Cases

| Case | Status | ms |
|---|---|---|
| infrastructure/native-fetch-loopback-recorder-and-network-refusal | PASS | 264 |
| infrastructure/real-sdk-concurrent-transactions-and-read-before-write-control | PASS | 10036 |
| infrastructure/real-grpc-commit-fault-after-durable-state-and-restore | PASS | 230 |
| Borzo/empty-200-never-releases-binding-or-repeats-wire | PASS | 565 |
| Borzo/non-json-200-never-releases-binding-or-repeats-wire | PASS | 355 |
| Borzo/incomplete-200-never-releases-binding-or-repeats-wire | PASS | 362 |
| Borzo/wrong-id-200-never-releases-binding-or-repeats-wire | PASS | 346 |
| Borzo/active-200-never-releases-binding-or-repeats-wire | PASS | 374 |
| dispatch/concurrent-cancels-one-real-wire-and-one-release | PASS | 3086 |
| dispatch/late-cancel-after-signed-callback-and-real-rebook-preserves-replacement | PASS | 653 |
| HTTP/helper-cross-origin-302-does-not-forward-sentinel | PASS | 8 |
| HTTP/helper-cross-origin-307-does-not-forward-sentinel | PASS | 19 |
| Shadowfax/200-ACK-keeps-live-binding-and-blocks-repeat | PASS | 297 |
| Shadowfax/204-ACK-keeps-live-binding-and-blocks-repeat | PASS | 284 |
| dispatch/held-transactional-callback-commit-serializes-and-preserves-replacement | PASS | 4003 |
| dispatch/foreign-branch-caller-refused-before-provider-wire | PASS | 44 |
| Borzo/quote-native-wire-success-honours-test-token | PASS | 11 |
| Borzo/book-native-wire-binds-and-writes-order-map | PASS | 223 |
| Borzo/book-ambiguous-2xx-without-id-never-fails-over | PASS | 178 |
| Borzo/book-connection-drop-after-send-never-books-second-provider | PASS | 194 |
| dispatch/readiness-reports-test-host-violations-but-is-inert-by-default | PASS | 3 |

## What the green cases establish (local only)

- Borzo cancel: only the documented `is_successful/order_id/status=canceled` proof releases the binding; empty, non-JSON, incomplete, wrong-id and `active` 200s stay ambiguous, keep the live binding, and block a repeat wire.
- Concurrent cancels: exactly one provider call; competitor fails closed `PROVIDER_CANCEL_IN_PROGRESS`; one released-history record.
- Late cancel ACK after a signed callback + real rebook: replacement `1250999` preserved, version 2, late call error `PROVIDER_CANCEL_BINDING_SUPERSEDED`.
- Signed callback now commits inside a real transaction (`transactionBytes: 9`); a held transactional commit serializes the same-document cancel (`cancelSettledWhileCommitHeld: false`) and the subsequent real rebook survives.
- Shadowfax 200/204 cancellation ACKs are ACK-only: live binding retained, no status lookup, repeat wire blocked.
- Shared transport: 302/307 never followed; cross-origin target received 0 requests; auth sentinel seen only by the original recorder.
- Borzo quote and book over native TLS: 1 `calculate-order` + 1 `create-order`, provider id bound, `dispatch_order_map` written, binding version 1.
- Ambiguous book (2xx without id) and connection drop after send: exactly one `create-order`; no second provider book; no binding.
- Foreign-branch caller refused `403` before any provider wire.
- Readiness reports the recorder host as non-TEST, but is inert with `DISPATCH_REQUIRE_LIVE=false` (by design).

## Fixture/harness changes (synthetic only; no backend source edited)

1. `snapshot.cjs` dispatch candidate root and dependency package repointed to `backend-email-contract-20261029`.
2. `infrastructure.cjs` recorder supports a deliberate post-record socket drop (`{destroy:true}`).
3. `waitPort` readiness deadline 25s -> 60s after three consecutive startup timeouts; the emulator was observed binding the Firestore port ~12s after first refusal. This is local startup timing, not an app behaviour.
4. The original "hold callback Commit across cancel+rebook" schedule is **not executable** with the repaired handler: the emulator serializes same-document transactions, so the cancel cannot settle while the callback commit is held. The case was replaced with a serialization probe plus rebook-preservation assertion. This is weaker than the original race and is stated as such.
5. Book-case expected binding version corrected to 1 for a first booking (the base seed has no prior `dispatchBindingVersion`).

## Limitations

- Local synthetic vendor recorder only: no Borzo test-account identity, live quote/book/cancel acceptance, rider exclusion, or callback delivery.
- `BORZO_BASE_URL` points at the local recorder, so the readiness report correctly flags a non-TEST host; no live-host refusal was exercised.
- Shadowfax contract remains unverified/404-documented and gated; its cancel path was exercised directly, not through live credentials.
- Porter remains retired; no Porter API path was replayed.
- Admin SDK bypasses Firestore Security Rules; auth token verification and Functions HTTP routing are outside this harness.
- No `tsc`, full Vitest, build, deploy, indexes, billing, or production rules were run.
- Node 24.18.0 observed; package declares Node 22.
- `--expected` was generated from the same captured manifest; it proves snapshot/capture integrity, not owner-supplied acceptance fingerprints.

## Cleanup

- `run.cleanupComplete: true`; emulator, proxy, recorders and SDK clients shut down.
- Independent `cleanup-verification.json`: first check caught one Java PID in SIGTERM teardown with no listener; 3s later zero Java processes and zero listeners on 48381-48386.