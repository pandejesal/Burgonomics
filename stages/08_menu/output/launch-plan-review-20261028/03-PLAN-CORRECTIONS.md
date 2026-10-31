# Accepted planning corrections — no application source changes

The complete work packages remain in [Delivery](../launch-plan-20261028/03-DELIVERY-DESIGN.md), [backend/security](../launch-plan-20261028/05-BACKEND-SECURITY.md), [schedule](../launch-plan-20261028/08-SCHEDULE.md) and [acceptance](../launch-plan-20261028/09-ACCEPTANCE-MATRIX.md). This review edits those **planning documents only** and records why. The original requirements handoff is unchanged.

## Delivery scope and sequencing

| Finding | Source independently checked by parent | Correction accepted |
|---|---|---|
| Mixed chip writer was omitted from kitchen-note migration | `cart.tsx:50–70,95–105,213–223`; store `:84–85,157–158` | Retire/migrate existing chips with explicit user review; preserve literal text and delivery preferences; one kitchen entry remains |
| Proposed 300 limit conflicts with current storage | `checkoutStore.ts:84,157` truncates at 240 UTF-16 code units | Current 240 ceiling recorded; no widening without contract review; verify stricter server/POS character/byte limits, Unicode-safe visible handling |
| Home history fetch persists below JSX | `homeStore.ts:47–62`, `HomeRepository.ts:21–22`, `homeService.ts:98–118` | Add exact state/repository/model ownership and loader-chain acceptance; preserve shared reorder APIs used elsewhere |
| Four-way shortcuts can resolve ambiguously | `menu.index.tsx:52–75,143–148` selects a first token match | D3 hands a deterministic outlet-scoped resolver/approved alias interface to D2 before shortcut acceptance; missing/ambiguous mapping is explicit |
| Duplicate Home category entrance | Home's pills and grid; shared `CategoryPills.tsx` inspected | Remove the Home import/render in D2; do not delete a shared component without caller evidence |

The distinct 160-code-unit `deliveryInstructions` field exists and downstream references were located, but a reachable editor was not established in the scoped search. The plan does not invent an existing fulfillment editor or silently move legacy delivery requests. Any actual transport/payment/UI change needs verified caller ownership and later implementation approval.

## Backend trust and acceptance

| Finding | Source independently checked by parent | Correction accepted |
|---|---|---|
| Create-time financial authority missing from the focused evidence | `firestore.rules:96–103,246–284` | Explicit create/update/dotted/nested accounting/capture/legacy-money cases and legitimate operation preservation |
| Amount-only refund identity appears twice | `razorpay.service.ts:1928–1935,2071` | Durable request identity must bind both ledger and outbound fingerprint; verify provider behaviour and legacy receipts |
| Lease-timestamp overstatement needs a precondition | `razorpay.service.ts:1973–1980` plus create forbidden `refundStatus` | Future/invalid claim-time tests during actual `refunding`; no claim a timestamp alone at birth establishes an indefinite block |
| Zero pricing and unused helper are not authority | POS boolean-OR fallbacks; `pricing.engine.ts:459–510` | Authoritative ₹0/conflicting legacy values and no-trusted-cart cases; helper existence is not a wired route or permission to retrofit every legacy order blindly |
| Catch can retry after uncertain external work | `orderPush.ts:650–811`, including ACK persistence and race guard | Durable ambiguity with no automatic scheduler retransmit until reconciled; retain accepted-no-ID and racing-winner protections |
| HMAC exists; default handler trust is the new seam | `middleware.ts:332–388`, `item86ingSync.ts:806–810` | Preserve presented-signature verification; default-deny absent/malformed auth context and prevent unsigned canonical authority |

A fake replay receipt, widened local cap, unresolved status callback or refund lease is not proof that money was created or an unauthenticated gateway refund occurred. No exploit/runtime test was executed. Externally safe idempotency/status lookup still needs the actual vendor contract.

## Dependency, provenance and calendar wording

- **B1 starts its own read-only mutation inventory** under its approved scope, jointly checked with B2/P3 owners; it does not wait for those downstream implementations.
- Day-2 source implementation explicitly requires **B and C**, a complete relevant A1 set or explicitly bounded per-screen/package approval, and approved baselines. A nod to the initial v0 is not general implementation permission.
- Q1 retains **24–40 hands-on hours**, begins per lane when prerequisites pass and runs across Days 5–7 or beyond. A lane with unfinished evidence on 3 November is not ready. Parallel execution requires real qualified people/devices, not model names.
- Main dirty-checkout/G-group provenance is explicit. Any selected alternative candidate must re-establish source leads at gate C.
- Before B1, retain both root and app-mirror rule hashes marked reconciliation pending; neither an unreviewed mirror nor a skipped emulator satisfies G03.

The correction-only GLM recheck confirmed the five original issues resolved and raised two LOW follow-ups. The parent made the ASCII graph explicitly show the early D3 resolver → D2 dependency with no D2 prerequisite for D3's continuous menu, and explicitly serialised D2→D4 handover for the overlapping Home route/service/model files. These final two edits are parent-verified and separately fingerprinted, not claimed to have another independent review.

## What did not change

No app/backend/rules/environment/native/dependency file was edited. No test, build, deploy, store/account/credential change or merchant action occurred. Requirements D01–D30, all four releases, Petpooja retention, Borzo/Shadowfax current scope, Reelo deferral and 2m/5m honest reconciliation remain intact. Original targets and unapproved fallback proposals are unchanged. Human/model owners, acceptance commands, recovery and per-lane external blockers remain in the complete plan; newly clarified scope must be re-estimated with real owners before C, not represented as a fixed-price/time guarantee.
