# A08 — Financial Safety Review (read-only, current state)

Scope: independent financial-safety audit of the paid-order path. No code edits, no tests run, no provider calls, no suites, no devices. All findings verified by direct source read on 2026-10-14. Prior green claims (R24/R27/R28/R29, loop reports) are NOT accepted as proof; only current source counts. No policy changes made here.

---

## Status update — 2026-10-19 (re-verified against current source; the findings below are kept verbatim as the trail)

> Everything under "Blocking case B1…B9" is the ORIGINAL 2026-10-14 read and is left untouched. Re-reading the current tree, every blocking case has since been closed except B4, which is open **by design**. Each line below cites the code that now proves it, so nobody re-opens a solved case the way a stale doc invites.
>
> - **B1 — CLOSED (lane C01).** The signature codes are gone from the uncaptured set: `paymentsService.ts:372-384` says so in its own comment and `UNCAPTURED_PAYMENT_ERROR_CODES` no longer contains them. Call sites follow: `useRazorpayPayment.ts:122,171`, `payment.tsx:462`, `checkout.tsx:575` — all route an HMAC-mismatch to sync-pending, never to a failed state that invites a re-pay.
> - **B2 — CLOSED.** `markPaymentFailed` now refuses a paid/terminal order with `ORDER_ALREADY_PAID` (`ordersService.ts:1189,1290,1301`; intent documented at `:1175`), and the cache-poisoning half is addressed at `PaymentRepository.ts:280`.
> - **B3 — CLOSED AS ALREADY-DONE, no code added.** Both gaps were already handled in the code as it stands: amount binding at `ordersService.ts:756-773`, and `paidAt` derived from the server-owned `verifiedAt` (server-only) at `:848-852`.
> - **B4 — OPEN BY DESIGN.** The `[pending]→[accepted]` versus server `CONFIRMED`/`completed` drift is a product/server naming decision, not a rename to be done quietly. Only a loud-failure guard was added (`db97311`), exactly as this case proposes.
> - **B5 — CLOSED (server half + client half).** The customer-visible reconciliation marker is now written server-side (`reconciliation.ts` `markOrderReconciliation`, merge-only and fail-open) and retired on confirm (`6f808da`), and the client renders it: `paymentRecovery.ts:173`, `orders.$orderId.index.tsx:222-235`, typed at `orders/models/index.ts:154`, pinned by `orders.$orderId.index.test.tsx:169`. No `firestore.rules` change was needed — a customer already reads their own order.
> - **B6 — CLOSED.** The webhook confirm now mints the hash it used to omit (`webhookHandler.ts:467,528`); the gap was fixed in `425e5aa` and the mint is pinned to the order.paid-only confirm by `4f6462a`.
> - **B7 — CLOSED.** The verify path now detects a foreign capture: `recordedPaymentId` is read (`razorpay.service.ts:874`), compared (`:943-963`), and parked as `ORDER_MISMATCH` (`:1379`) instead of being absorbed by the `alreadyCompleted` reuse path (`:1471-1533`).
> - **B8 — CLOSED.** The webhook no longer confirms blind on a doc with no stored total: it falls back to the server-written intent amount and parks when the amount stays unknown (`webhookHandler.ts:256-322`).
> - **B9 — CLOSED (lane C01).** The post-gateway recovery surface now carries the payment id and a support CTA in the waiting state, not just the failed state: `payment.tsx:534,539,857-889`, `checkout.tsx:806`, and the panel itself (`PaymentRecoveryPanel.tsx`, tests at `PaymentRecoveryPanel.test.tsx:82`, `useRazorpayPayment.test.tsx:162`).
>
> **Still open, and they are decisions rather than defects:** P1 (guest paid orders), **P2 (the plaintext-OTP delivery channel — the one that actually blocks an app-closed handover)**, P3 (marker shape/support prefill — largely delivered by the B5 work), P4 (retry-after-capture policy), P5 (legacy-doc amount source — the B8 fix implements the "intent fallback" option).
>
> **Findings raised this session that are NOT in the B-list** (recorded here so they are not lost; each was posted to the bus with file:line evidence):
> 1. **Unpaid online orders reach the kitchen.** The customer app creates the order as `PLACED` + `payment.pending` BEFORE the gateway opens, the partner maps `PLACED→pending`, and neither the KDS filter, the KDS card, nor the server `bumpOrderStatus` consults payment at all. Staff can therefore accept and cook an order nobody paid for, with no on-screen signal. Proposed a visibility fix first (payment chip + reuse of the B5 marker), enforcement second — the second is a workflow decision.
> 2. **Customer copy during the unpaid window.** The order screen's payment line falls through to the raw enum for anything outside paid/CASH_PENDING/PAY_AT_STORE, so it reads "Pay Online · pending"; and the tracking timeline titles the `PLACED` state "Order confirmed" (`orderStatusEngine.ts:79,98,108`) while nothing is paid. The server's own label for the same code is the honest one: "Order placed" (`orderStatus.ts:45`).
> 3. **Two contradictory refund policies inside `autoRefund`.** A different-amount refund is refused as `ALREADY_REFUNDED` once `refundStatus==="refunded"` (`razorpay.service.ts:1728`), and that status is stamped after a PARTIAL refund too (`:1868`) — which makes the cumulative partial cap (`:1753-1774`) unreachable in production and makes the refusal message ("Order is already fully refunded") factually wrong for a partial. Latent companion: the gateway idempotency key is `refund_{orderId}_{amount}` (`:1831`), which the spec (RZ3) says must distinguish the two callers; two distinct refunds of equal amount collide and the second silently returns the first. Both must be fixed together if partials are enabled.
> 4. **The zero-mock guard on the webhook was unproven.** Now pinned, including the property that a refused delivery writes no idempotency claim (`1178d68`).
> 5. **The test suite is not type-checked at all.** `functions/tsconfig.json` includes only `src` (and excludes `src/**/*.test.ts`), so the mandated gate never sees the tests, and vitest strips types without checking them. A throwaway config found 32 latent errors across 14 files; my additions contributed zero. Recommendation: adopt a test typecheck only after a coordinated cleanup — it spans several lanes, so it cannot be one lane's change.
> 6. **The E2E fixture was built on invented fields** (products keyed by `branchId` instead of `restId`, missing `royaltyPercentage`/`packagingFee`) and is now corrected (`b4961f4`). Two consequences were silent failures (empty menu, 503 pricing), and one was a safety issue: cloning products without rewriting `restId` would leak test items into a real outlet's live menu.

## Sources inspected

- `burgonomics-foundation-core/src/features/payments/services/paymentsService.ts:365-393` (UNCAPTURED whitelist + `isUncapturedPaymentError`)
- `burgonomics-foundation-core/src/routes/payment.tsx:340-458,748-789,823-880` (verify branching, waiting vs FailurePanel, support CTA)
- `burgonomics-foundation-core/src/routes/checkout.tsx:246-260,500-520,593-594` (reconciliationPending re-pay block)
- `burgonomics-foundation-core/src/features/payment/hooks/useRazorpayPayment.ts:90-183` (same branching as payment.tsx)
- `burgonomics-foundation-core/src/features/payments/repositories/PaymentRepository.ts:266-295` (create-failure `markPaymentFailed`, gateway-order binding)
- `burgonomics-foundation-core/src/features/orders/services/ordersService.ts:531-799` (`finalizePaidOrder`), `:1104-1153` (`markPaymentFailed`), `:47-60` (resolveStatus)
- `functions/src/modules/payments/razorpay.service.ts:617-922` (`verifyPayment`), `:952-1130` (`executeRouteSplit`), `:1157-1272` (`assertLivePaymentMatchesOrder`), `:1279-1451` (`finishVerifiedPayment`)
- `functions/src/modules/payments/webhookHandler.ts:154-507` (captured/order.paid confirm, suppression, no-OTP path), `:508-591` (payment.failed guard)
- `functions/src/modules/payments/routeTransfers.ts:1-60` (reconcile-before-POST)
- `functions/src/modules/porter/porter.service.ts:1243-1353` (`verifyDeliveryOtp`)
- `functions/src/index.ts:321-363` (verify route status passthrough incl. 401/202)
- `firestore.rules:188-276` (orders read/create/update lanes), `:510-568` (server-only ledgers)
- `references/razorpay_payments.md` (RZ1–RZ4 design), `references/order_flow.md` (status vocabulary)

R27/R28/R29 referenced in `functions/tests/payment-confirmation-concurrency.test.ts` and `payment-confirmation-webhook-concurrency.test.ts` (pre-split terminal guard, audit-id clock, exact audit accounting) were read as test comments only, not as proof. This review re-verifies each claim against current `razorpay.service.ts` + `webhookHandler.ts` source below.

---

## Blocking case B1 — `INVALID_SIGNATURE` whitelisted as "proven uncaptured"

- Current: `UNCAPTURED_PAYMENT_ERROR_CODES` (`paymentsService.ts:372-389`) contains `"INVALID_SIGNATURE"` (plus `"VERIFICATION_FAILED"`, `"SIGNATURE_MISMATCH"`).
- Both call sites (`payment.tsx:375`, `useRazorpayPayment.ts:115`) treat a whitelisted code as proven-no-money and call `orderRepository.markPaymentFailed(internalOrderId)` + show failed/retry UI.
- Server truth: `INVALID_SIGNATURE` (`razorpay.service.ts:666-678`, 401) proves only HMAC mismatch. It says nothing about capture state. A genuinely captured payment whose client callback was tampered, truncated, or replayed with the wrong signature answers 401 — the money has moved but the client marks the order failed and invites re-pay (double-charge path).
- Safe fix (proposal only): remove `"INVALID_SIGNATURE"`, `"SIGNATURE_MISMATCH"`, `"VERIFICATION_FAILED"` from the uncaptured set. Route them to the existing `PAYMENT_SYNC_PENDING` reconciliation branch (no `markPaymentFailed`, no re-pay invite, payment-id + support CTA, server reconcile via `payment_discrepancies`/`unmatched_payments`). Only codes backed by a live gateway fetch proving non-capture (`PAYMENT_NOT_CAPTURED` → `awaiting_capture` park) may drive `markPaymentFailed`.
- Regression fixture (proposal): hermetic client test — mocked `verify` rejects `{code:"INVALID_SIGNATURE"}` with a captured gateway payment stubbed server-side; assert `markPaymentFailed` NOT called, `setReconciliation(true,"PAYMENT_SYNC_PENDING",…)` called, no cart clear, no confirmation navigation.

## Blocking case B2 — `markPaymentFailed` has no paid guard and poisons cache on a rules-denied write

- Current (`ordersService.ts:1104-1153`): loads from memory/`getOrder` cache only (no fresh `getDoc`), never checks `paymentStatus==="completed"` / nested completed / terminal status, builds `{payment.status:"failed"}` and `setDoc(...,{merge:true})`.
- `firestore.rules:240-273`: customer update lanes allow ONLY `{status,completedAt,updatedAt}` (cancel) or `{whatsappOptIn,updatedAt}`. A `{payment,updatedAt}` write matches neither lane → denied for customers. So the server write fails with `WRITE_FAILED`, yet the catch arm (`:1134`) still does `orders.set(id, updated)` — the local cache flips to failed while the server still says pending (or completed). Combined with B1, a captured order can render locally as failed.
- Safe fix (proposal only): add a server-truth paid guard — fresh `getDoc` first; if top-level or nested marker is `completed`/`awaiting_capture`, or status is terminal/CONFIRMED-later, refuse (`ORDER_ALREADY_PAID`/`ORDER_TERMINAL`, no write, no cache mutation). On persist denial, do NOT mutate cache; surface honest sync-pending. Consider removing the client `payment`-key write lane entirely (server owns it; `payment.failed` webhook already flips failed state server-side at `webhookHandler.ts:568-575` with paid/foreign guards).
- Regression fixture (proposal): mocked paid server doc + denied/failed `setDoc`; assert `markPaymentFailed` returns refusal, `orders` cache untouched, zero writes attempted after the guard read.

## Blocking case B3 — `finalizePaidOrder` is read-only (good) but does not revalidate amount and never delivers OTP

- Verified good: fresh `getDoc` only (`ordersService.ts:557-582`), no `setDoc`/`updateDoc`, owner binding `:599-615`, terminal gate `:629-642`, shape-coherence + client-`"paid"`-literal flag `:648-696`, tx binding `:702-724`, canonical shape gate `:729-744`, server-values-only hydrate `:750-798`. Matches R24 report §§1–2 as currently implemented.
- Gaps:
  1. No amount revalidation: neither `pricing.grandTotal` nor `payment.capturedAmountPaise` is compared to anything. A server-confirmed doc for a different total finalizes identically. Backend binds amount at confirm time, but the client finalizer is amount-blind.
  2. `paidAt` derives from `paymentBlock.paidAt ?? verifiedAt` (`:792`) — `paidAt` is a client-writable display field on legacy docs; only `verifiedAt` (serverTimestamp) is server-owned. Prefer `verifiedAt`, fall back to nothing rather than a client timestamp.
  3. Returns no `deliveryOtp`: OTP is minted server-side in `finishVerifiedPayment` (`razorpay.service.ts:1337-1370`) and returned only on the verify response (`:888`). A webhook-confirmed order finalized later has no OTP path (see B6). Customer has no defined OTP read channel from Firestore (hash only, brand-masked; rules deny nothing here but no reader exists).
- Safe fix (proposal only): bind `pricing.grandTotal` (whole-paise) against `payment.capturedAmountPaise` when both present; mismatch → `SERVER_DOC_SHAPE_INVALID` + sync-pending (never finalize). Derive `paidAt` from `verifiedAt` only. Define the OTP read channel explicitly (product decision P2 below) — do not leak the hash to the client.
- Regression fixture (proposal): paid doc with `capturedAmountPaise` ≠ `pricing` total → `SERVER_DOC_SHAPE_INVALID`, cache empty; paid doc with client `paidAt` only → `paidAt` undefined, still ok.

## Blocking case B4 — real server docs-status contract has drifted from `references/order_flow.md`

- Real server writes: `status:{code:"CONFIRMED",label:"Order confirmed",kind:"upcoming",terminal:false}` + `paymentStatus:"completed"` + dotted `"payment.status":"completed"` (verify: `razorpay.service.ts:1341-1355`; webhook: `webhookHandler.ts:348-367`).
- Spec vocabulary (`order_flow.md:10-28,50-52`) says `[pending] → [accepted]` + `verifyPayment … advancing status to accepted`. No `CONFIRMED`/`completed` literal appears in the spec. Client `resolveStatus` knows `CONFIRMED` (good) but track-screen mapping also accepts legacy `ORDER_PLACED` (`orders.$orderId.track.tsx:110,287`). Partner/KDS expectations of `accepted` are unreconciled in the files inspected.
- Do NOT "fix" by renaming a status string (policy change, out of scope). Record as contract drift requiring a product/server decision: either the spec adopts `CONFIRMED/completed` or the server adopts `accepted` — with a migration for live docs. Regression fixture (proposal): contract test asserting the exact server literal shape (`CONFIRMED` + both `completed` markers) so any rename fails loudly.

## Blocking case B5 — backend terminal-before-split verified, but customer-visible reconciliation is brand-only

- Verified in current source: `verifyPayment` reads terminal transactionally BEFORE `executeRouteSplit` (`razorpay.service.ts:788-826`, parks `ump_term_*`, throws 409 `ORDER_TERMINAL`). Webhook suppresses later-state/foreign captures inside the confirm transaction and only splits when `confirmWritten` (`webhookHandler.ts:370-431,489-505`). `payment.failed` never flips paid/foreign orders (`:549-567`). This matches the R27-third-pass/R29-ordering intent as currently coded — stated here from source, not from prior green claims.
- Residual gap: every suppressed/parked outcome (`ump_*`, `payment_discrepancies`, `needs_reconciliation`, `awaiting_capture`) is brand-only readable (`firestore.rules:510-568`; `unmatched_payments` brand-only). The affected customer sees at best the client `PAYMENT_SYNC_PENDING` path — which only exists if the app was open. Webhook-only payers (app closed after gateway charge) get no push on suppression (push only on `payment.failed` non-paid path and refund), and their order stays non-confirmed with no self-serve recovery. Support must reconcile manually.
- Safe fix (proposal only): server-owned customer-visible reconciliation flag on the order doc itself (e.g. merge-only `reconciliation:{state, paymentId, updatedAt}` written by the same paths that park `ump_*`), covered by a rules lane letting the owner READ (not write) it; client renders it with payment-id + support CTA. Never expose `unmatched_payments`/discrepancy docs to customers.
- Regression fixture (proposal): terminal-order capture + foreign-capture webhook fixtures asserting: no split POST, no KOT push, exactly one `ump_*` park, order doc carries the customer-readable reconcile marker, status unregressed.

## Blocking case B6 — webhook-only delivery orders confirm with NO OTP (authoritative-channel gap)

- `finishVerifiedPayment` (verify path) mints `crypto.randomInt(1000,10000)` OTP + HMAC hash atomically (`razorpay.service.ts:1336-1370`) with exactly-once backfill (`:1377-1394`).
- Webhook path (`webhookHandler.ts:348-393`) writes the same CONFIRMED markers but never mints `deliveryOtpHash`. The webhook is the authoritative channel for app-closed payers (RZ2), so exactly those delivery orders — the ones most needing handover proof — end up CONFIRMED with no OTP. `verifyDeliveryOtp` then throws "No delivery OTP found" (`porter.service.ts:1266-1268`); staff cannot complete handover; takeaway/dine-in are unaffected (no OTP needed). The `finishVerifiedPayment` backfill never runs for webhook confirms (different code path).
- Safe fix (proposal only): mint the OTP hash in the same webhook confirm transaction (server `crypto.randomInt` + `computeHmacSha256`, only when `eligibleForOtp` and no hash present, never overwrite), and define single-delivery of the plaintext OTP (product decision P2). Until then, webhook-confirmed delivery orders are non-deliverable by the OTP flow.
- Regression fixture (proposal): webhook `payment.captured` on a delivery order with no prior hash → assert exactly one hash written in the confirm transaction, plaintext never persisted/logged; second delivery (order.paid replay) asserts hash unchanged (no overwrite).

## Blocking case B7 — second distinct capture for one order is silently absorbed (verify path)

- Webhook guards foreign captures (`recordedPaymentId !== razorpayPaymentId` → suppress + park, `webhookHandler.ts:376-393,489-505`).
- `finishVerifiedPayment` (`razorpay.service.ts:1313-1403`) checks `alreadyCompleted` (either `completed` marker or `CONFIRMED`) but never compares the recorded `payment.razorpayPaymentId` against the incoming `razorpayPaymentId`. A second, different captured payment for the same order returns `{success:true, confirmedOrderId}` (the "race-loser reuses winner" path) with no discrepancy park. Money from payer B is absorbed into payer A's order. `executeRouteSplit` won't double-payout (transferred dedupe, `:961-968` + reconcile-before-POST), but the overpayment is invisible.
- Safe fix (proposal only): mirror the webhook foreign-payment check in the verify transaction: mismatched recorded vs incoming payment id → park `payment_discrepancies` (`ORDER_MISMATCH`-style, 409), return non-success, no confirm overwrite, no OTP/coin/KOT effects.
- Regression fixture (proposal): CONFIRMED order with recorded `pay_A`, verify with captured `pay_B` (order binding + amount valid) → 409 refusal + discrepancy park + no audit/OTP/coin side effects.

## Blocking case B8 — amount/auth binding asymmetry between channels

- Verify binds via live fetch: gateway `order_id` match + paise equality + INR + `captured` status (`assertLivePaymentMatchesOrder`, `:1222-1269`), expected total = stored `pricing/totals` else server intent amount (`:760-779`). No auto-capture (`:1252-1268` parks `awaiting_capture`).
- Webhook binds WITHOUT a gateway fetch: stored `pricing/totals` vs `paymentEntity.amount` (`webhookHandler.ts:247-327`); when `storedPaise` is null (legacy doc, no totals/pricing) the amount check is skipped and CONFIRM proceeds. No intent-amount fallback. Stale deliveries (>15 min) are rejected (`:72-78`), unsigned/missing-event-id rejected (`:34-66`) — good.
- Auth: verify ownership gate is correctly fail-closed (`:895-921`; HTTP passes uid-or-null, never undefined, `index.ts:345-348`). Guest finalize is intentionally impossible (`finalizePaidOrder` → `MISSING_AUTH` for guests): a guest-captured order (server supports guest intents) confirms server-side but the guest client can never finalize → permanent sync-pending. This is the documented 2026-09-23 product decision, flagged here as a live edge, not a violation.
- Safe fixes (proposal only): webhook falls back to the server intent amount when the order doc carries no total (else park `confirm_amount_unknown` instead of confirming blind); verify keeps intent-missing ghost refusal (already 404). Reconcile guest-capture vs guest-finalize policy (product decision P1).
- Regression fixtures (proposal): webhook capture on a no-pricing/no-totals order with valid intent → uses intent amount; without intent → parked, not confirmed. Guest captured order → assert client finalize returns `MISSING_AUTH` + sync-pending (documented) and server order is CONFIRMED (divergence pinned until P1 decided).

## Blocking case B9 — sync-pending customers see a spinner, not the payment-id + support CTA

- Verified good: `PAYMENT_SYNC_PENDING` never clears the cart, never navigates to confirmation, persists `paymentReconciliation` + store flag, and `checkout.tsx:250-259,593-594` blocks re-pay while pending.
- Gap: `PAYMENT_SYNC_PENDING` sets `status:"waiting"` (`payment.tsx:403,430`; `useRazorpayPayment.ts:141,171`), but the payment-id + "Contact support" `FailurePanel` renders ONLY for `failed/cancelled` (`payment.tsx:741`). The waiting branch (`:771-789`) is a generic spinner ("Complete the checkout inside the Razorpay secure pop-up") with no payment id, no support deep-link, no "do not pay again" copy — the exact content the failure panel was built to show. A sync-pending customer who paid sees spinner copy telling them to complete checkout.
- Separately, the catch-all `catch` (`payment.tsx:452-457`) sets `status:"failed"` + `POST_PAYMENT_ERROR` retryable:true → invites "Retry checkout" after money was taken. And `PaymentRepository.createPaymentOrder` failure arm (`PaymentRepository.ts:273-275`) calls `markPaymentFailed` when no gateway order opened — without proving non-capture (gateway could have minted then errored on intent store; the 503-retry-same-key path exists precisely because the gateway order may exist).
- Safe fixes (proposal only): render the payment-id + support CTA + do-not-pay-again copy in the waiting/sync-pending state (not only failed); make the catch-all fail closed to sync-pending (retryable:false, no re-pay CTA); gate the create-failure `markPaymentFailed` on proven-no-gateway-order (else sync-pending).
- Regression fixtures (proposal): verify-unknown (`PAYMENT_STATUS_UNKNOWN`/503) and post-verify finalize-failure fixtures assert waiting-state content includes payment id + `/support?topic=payment` link and no enabled re-pay; create-failure-with-possible-gateway-order fixture asserts no `markPaymentFailed` call.

---

## What requires a product/sandbox decision (no code changed)

- **P1 — Guest paid orders.** Server confirms guest captures; client finalize refuses guests. Decide: supported (then define guest finalize binding) or blocked at checkout (then enforce pre-gateway, with messaging). Sandbox: guest capture → finalize matrix.
- **P2 — OTP delivery channel.** Plaintext OTP currently returns only on the verify response. Webhook-only customers have no channel. Decide: in-app order screen read (owner-only server endpoint), SMS, or staff-readback — with 24–48h expiry and attempt/lockout policy (see `_archive` pentest notes on `deliveryOtpExpiresAt`). Sandbox: webhook-only delivery order → OTP display → `verifyDeliveryOtp` → DELIVERED.
- **P3 — Customer-visible reconciliation.** `unmatched_payments`/`payment_discrepancies` are brand-only by design. Decide the owner-readable reconcile marker shape + support-ticket prefill (`PAYMENT_ISSUE` with payment id) and whether `payment.failed` push copy covers suppressed captures. Sandbox: suppressed/foreign/terminal capture → customer screen shows marker + CTA.
- **P4 — Retry-after-capture policy.** Any `failed`-state Retry CTA after a gateway charge risks double-spend. Decide: Retry allowed only for proven-uncaptured codes (narrower than today's whitelist), everything else sync-pending. Sandbox: each whitelist code × gateway capture state matrix.
- **P5 — Amount source of truth for legacy docs.** Webhook blind-confirm when no stored total. Decide: backfill pricing at intent (already done for new orders) + intent-fallback confirm, or park-and-review for legacy. Sandbox: legacy no-totals order capture.

## Explicit non-findings (verified, not assumed)

- Pre-split terminal guard EXISTS in current source on both channels (B5). R29 audit-id/exact-accounting claims were not re-proven (test-only) and are not relied on.
- `firestore.rules` customer lanes do NOT permit `payment`/`paymentStatus` writes (customer update mask `:245-273`), and create lanes deny server-owned keys (`:96-103`) with pending-only `paymentStatus` birth (`:214-238`). Staff `payment` writes remain permitted within `ownsBranch` minus the denylist — branch-staff paid-flip risk noted in `references/firebase_security.md` F-PAY stands as written and is out of this lane's scope.
- `/payments/verifyPayment` route passes 202/401/404/409/502/503 through (`index.ts:357`) with `Retry-After` on 202 — no collapse of `INVALID_SIGNATURE`→400 or `TRANSFER_IN_PROGRESS`→400 in current source.

## Proposed regression fixture list (hermetic, no live calls)

1. `INVALID_SIGNATURE` → no `markPaymentFailed`, sync-pending + support CTA (B1).
2. Paid-doc `markPaymentFailed` → refusal, zero writes, cache untouched (B2).
3. Amount-mismatched paid doc finalize → `SERVER_DOC_SHAPE_INVALID` (B3).
4. Terminal/foreign capture on both channels → no split/KOT, one park, customer marker, status unregressed (B5).
5. Webhook delivery confirm → exactly-once OTP hash, replay preserves hash (B6).
6. Second distinct payment for CONFIRMED order → 409 + discrepancy park (B7).
7. Webhook no-totals order → intent-amount bind or park, never blind confirm (B8).
8. Unknown/post-verify failures → waiting state shows payment id + support CTA, re-pay blocked (B9).
