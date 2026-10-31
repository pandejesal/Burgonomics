# Backend and security — release blockers and proof gaps

Status: source reconnaissance, not a penetration-test result or security clearance. No code/rules were changed, tests executed, private collections read or provider calls made by this task. Revalidate these leads against current source before designing fixes.

## Confirmed source-level concerns

### B01 — client-writable refund accounting

- Root `firestore.rules:272-284`: branch-owner order updates use a denylist, not an allowlist. `refundLedger`, `refundedTotalPaise`, `refundOverCapturedPaise` and `refundNeedsReview` are absent from that denylist. The brand-owner arm at line 272 is unmasked.
- `functions/src/modules/payments/razorpay.service.ts:1888-1935`: the refund claim reads `refundedTotalPaise` and sums `refundLedger`. A ledger entry matching the requested amount returns a `processed`/`reused` response before a new gateway refund.
- Parent directly read both boundaries. This is a financial-integrity concern: an authorised branch actor can plant accounting data that a later refund action trusts, potentially suppressing a real refund while reporting replay success. It is not a demonstrated unauthenticated exploit or evidence that money was created.
- Required outcome: financial receipts/accounting remain server-owned, with explicit permitted client mutations and regressions for staff/brand/customer roles. Validate existing app queries/workflows rather than broadening access to get a green UI.

### B02 — client-amount fallback in POS/COD payloads

- `functions/src/modules/petpooja/orderPush.ts:226-231,305,351`: `grandTotal` falls back from `pricing.grandTotal` to `order.totalAmount` / `order.total`; COD `collect_cash` uses it. The `||` chain can also discard an intentional zero.
- Reviewer traced order-create rules that do not prohibit every legacy total field, and a courier adapter fallback. Parent directly confirmed the POS builder, **not** every COD/manual route's reachability.
- Whether every COD/manual lane receives trusted pricing before that builder remains unverified. Treat it as a release-blocking trust-boundary question, not proof every cash order is exploitable.
- Required outcome: canonical server pricing for every enabled mode/tender; no invented or client-authoritative fallback amounts, taxes, currency or item mappings. Preserve explicitly legitimate zero values.

### B03 — security rules differ across repositories

- Root and Partner `firestore.rules` have matching hashes; the customer copy differs. Hashes are in the evidence file.
- Parent read `burgonomics-foundation-core/tests/rules/firestore.rules.test.ts:24-29`: it loads the working-directory `firestore.rules`. Thus customer-directory execution tests the customer copy, not automatically the root deployment copy.
- The runner **exists** at `burgonomics-foundation-core/scripts/test-rules.mjs`. Earlier reconnaissance incorrectly reported it missing; that claim was retracted.
- Required outcome: explicitly prove which rules bytes are tested and deployed, synchronise or remove mirrors through an approved ownership change, and exercise the authoritative copy in the emulator.
- Test-runner caveat from direct read: `process.exit(result.status ?? 0)` can report zero when a child has no numeric status. Rules tests also skip locally when the emulator is unavailable, while `CI=true` fails that condition. A zero exit without real test execution is not acceptance.

## Reviewer findings needing further verification

These are source leads, not all independently verified exploits:

| Lead | Evidence / question |
|---|---|
| Petpooja credential-less status intake | `functions/src/core/middleware.ts:374-388` reportedly admits a status-shaped callback and marks it unauthenticated. Trace `item86ingSync.ts` end-to-end and prove unauthenticated data cannot forge POS identity, sync success or order state. |
| Shadowfax callback authentication | `functions/src/modules/dispatch/dispatch.webhooks.ts:148` reportedly compares a static secret header. Validate the approved vendor contract, binding, rotation and replay controls; do not invent a supported HMAC protocol or endorse static auth without evidence. |
| Legacy menu writes | Root rules around `menu/{branchId}/items` and `categories` permit broad branch-owner mutations. Trace real consumers and protect identity/financial fields without breaking valid stock updates. |
| Claim assignment | Audit actual claim-setting/revocation routes and role/branch membership authorisation. No complete escalation-surface review was done. |
| Public operational documents | `admin_stores` / `app_settings` have public-read paths. No documents were fetched; a PII/secret leak is unproven. Inspect permitted schemas/writers first; obtain scope before any private-data review. |
| App Check | Reviewer found monitor-mode defaults. Verify actual deployed configuration and app enrollment before planning enforcement; do not flip a production flag based on source defaults. |
| Outlet tax mappings | Worker found fallback CGST/SGST IDs in `orderPush.ts:41-44`. Verify approved per-outlet tax IDs/rates and GST liability rather than carrying guessed values into live KOTs. |

## Operational invariants already approved

- Petpooja remains the POS. Preserve actual restID/item/variation/add-on/tax bindings and fail visibly on missing configuration.
- Payment capture, price authority, refund authority, POS acceptance and physical KOT output are distinct facts. Keep customer status honest about each.
- Pending POS after payment: durable retry/reconciliation, staff alert at 2 minutes, escalation at 5 minutes. Do not conflate those thresholds with vendor retry intervals.
- Ambiguous transport acceptance needs reconciliation; do not blindly retry a possibly accepted POS order or rider booking. Never claim KOT printing merely because HTTP returned 200.
- No automatic refund based solely on the new pending-POS threshold. Refund/cancel actions need the agreed business policy and authorised server path.
- Production missing credentials/configuration must fail closed. Test fixtures stay hermetic and development-only; do not “fix” failures by enabling mock success.
- Auth, ownership and branch checks apply to every sensitive path; CORS, App Check and client UI visibility are not substitutes for authorisation.

## Verification the future plan must own

- Regression-first tests at actual rule/consumer boundaries, including direct client attempts to mutate refund fields and client-total injection for online/COD/manual modes.
- Payment webhook-first/verify-first concurrency, duplicate capture, partial/full refund, amount/currency binding and missing credentials.
- POS mapping failure, 86 branch isolation, duplicate trigger, acceptance followed by persistence failure, ambiguous timeout, bounded retry and operator reconciliation.
- Real emulator RBAC/schema tests against the root deployment rules bytes; do not weaken skips or assertions.
- Staff KDS arrival/alerts and end-to-end operator-observed KOT/instruction output, with separately approved sandbox/live action scopes.
- Relevant package typecheck, full unit tests and build, with command, exit, counts/skips, source/artifact fingerprints and remaining blockers recorded.

Load `api-security`, `api-testing`, applicable Firebase skills and Burgonomics provider contracts/testing for owned implementation. For rules authoring, use `firestore-rules-author` only if actually available; otherwise follow `firestore-rules-creation` directly. Do not describe generated rules as guaranteed secure. No rule change is authorised merely by this list.
