
# POS dispatch verification - 2026-10-29

Appended POS scope in the same owned harness. Local real-Firestore-emulator + native-TLS recorder against the exact current worktree source. **Not vendor acceptance.**

## Verdict

- Runner: `node run-tests.cjs --snapshot pos-current-01 --scope pos --mode final --expected pos-current-01.expected.json --run pos-final-04`
- Exit: **0**; `scopedChecksPassed: true`; `sourceAcceptance: false`; `cleanupComplete: true`
- Cases: **13/13 PASS** (3 infrastructure + 10 POS). No source failure reproduced.

## Source actually executed

| File | Bytes | SHA256 |
|---|---|---|
| `functions/src/modules/petpooja/orderPush.ts` | 80775 | `fdcc6167a03cb36a0018950fad66a0d71e1e2f83fdb643ca7721e2bfc9fa573f` |
| `functions/src/modules/petpooja/petpooja.scheduler.ts` | 16512 | `07fdc211faadba1879a7366029dcd980f5bccd5ebda043e9c2f8c777d6878eac` |

- Worktree HEAD `31e82c3c415757064e3b33010ade4d2b0d8ebd6f` (dirty staged + unstaged)
- Snapshot `pos-current-01`; manifest SHA256 `c53266063a210db578a15f289054572f61479d82fb3835bbd0f86df2a6132d69`
- Harness SHA256: snapshot `b2b2d7fc1b7c6f58068ab48525cc88f3ce008ae399500222c695c6ebbbf2a599`, infrastructure `78286d41f623320477ed940ede6a2082b820fb9fcc29ef1e239a653fbb8aa723`, run-tests `19e3c52c35f707b6f4eccef8cc1803758ad517e22ff23431f780b9941539d19a`

## Cases

| Case | Status | ms |
|---|---|---|
| infrastructure/native-fetch-loopback-recorder-and-network-refusal | PASS | 407 |
| infrastructure/real-sdk-concurrent-transactions-and-read-before-write-control | PASS | 11007 |
| infrastructure/real-grpc-commit-fault-after-durable-state-and-restore | PASS | 239 |
| POS/direct-legacy-pending-retry-timeout-without-claim-must-not-send | PASS | 139 |
| POS/ACK-all-later-Commit-RPCs-fail-restore-plus11min-no-resend | PASS | 565 |
| POS/documented-400-refusal-resolves-intent-without-automatic-replay | PASS | 1138 |
| POS/multiple-scheduler-documents-real-SDK-reads-before-writes | PASS | 604 |
| POS/429-no-resend-no-redirect-follow | PASS | 376 |
| POS/malformed-200-no-resend-no-redirect-follow | PASS | 328 |
| POS/307-no-resend-no-redirect-follow | PASS | 313 |
| POS/wire-payload-strict-money-contract | PASS | 220 |
| POS/concurrent-direct-pushes-one-wire-and-no-resent-kot | PASS | 3039 |
| POS/branch-tax-provenance-mismatch-refused-pre-wire | PASS | 383 |

## Strict payload proven on the wire

For a synthetic order with `payment.method='RAZORPAY'` (no flat `paymentMethod`), item unit price 100, quantity 1, 5% GST, branch tax rows `QA-CGST`/`QA-SGST` @2.5 with matching provenance:

- `Order.details.total = 105.00` (grand total includes GST, not double-taxed)
- `tax = tax_total = 5.00`; `payment_type = ONLINE`; `collect_cash = 0.00`
- `OrderItem.details[0].price = 100.00`, `final_price = 100.00` (UNIT figure), `quantity = 1`, `tax_inclusive = false`
- `item_tax = [{id: QA-CGST, 2.50}, {id: QA-SGST, 2.50}]`; `Tax.details` carries the same outlet ids and amounts
- `Restaurant.details.restID = QA-NOT-A-MERCHANT`
- Exactly one `/pos/save` wire request.

## Other confirmed properties

- Legacy `pending_retry` without positive pre-send evidence is refused with 0 wire.
- ACK then all later Commit RPCs denied: durable intent observed before ACK; order stays unresolved; +11min direct recall sends 0 additional requests.
- Documented 400/SO_105 resolves the intent as rejected; no automatic replay.
- Two scheduler documents commit and each receives exactly one POST.
- 429, malformed 200 and 307 park reconciliation; recall + scheduler send no second wire; redirect target receives 0.
- Concurrent direct pushes: exactly one KOT wire; both callers report success (one sends, the loser dedupes); post-ACK retry sends no wire.
- Branch tax provenance mismatch is refused pre-wire with `PETPOOJA_TAXES_OUTLET_MISMATCH`-class error.

## Fixture changes (synthetic only; no backend source edited)

1. POS candidate root repointed to `backend-email-contract-20261029`; closure captured 14 files including the auxiliary author test.
2. Branch fixture now carries non-empty `petpoojaTaxes` plus `petpoojaTaxesRestId` provenance.
3. Order fixture now uses `payment.method='RAZORPAY'` and `pricing.foodSubtotal=100 / gst=5 / grandTotal=105 / loyaltyDiscount=0`.
4. Dedupe test asserts one wire and that a loser dedupes as success; the earlier "exactly one may return true" assumption was wrong, not a guard.
5. Post-ACK retry asserts no new wire, not a `false` return (the app treats "already pushed" as idempotent success).

## Limitations

- Local TLS recorder only: no Petpooja credentials, real POS outlet, actual KOT registration/printer, or vendor callback.
- The synthetic outlet id and tax rows are not production values; no outlet mapping is claimed.
- Emulator admin SDK bypasses Security Rules; Auth/Functions routing/email delivery are outside this harness.
- No `tsc`, full Vitest, build, deploy, indexes, billing or production rules.
- `--expected` was generated from the same captured manifest (capture integrity, not owner-supplied fingerprints).
- Old 7/7 POS evidence did not validate the newer strict payload; this run adds wire-level money/tax assertions but remains local.

## Cleanup

- `run.cleanupComplete: true`; emulator, proxy, recorders and SDK clients shut down.
- Independent `cleanup-verification-pos.json` records the post-run listener/process check.