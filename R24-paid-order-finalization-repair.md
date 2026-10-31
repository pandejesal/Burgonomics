# R24 — Paid-Order Finalization Repair (read-only server truth)

## Executive Summary

After backend payment verify confirms that the pending `orders/{id}` document exists, the
post-payment finalization path re-ran `createFromCurrentContext` → `ordersService.createOrder`
→ a **full `setDoc` over the SAME confirmed id**. On an existing document that is an UPDATE, and
`firestore.rules` only lets a customer touch `status/completedAt/updatedAt` (cancel) or
`whatsappOptIn/updatedAt` — so the write is **denied on a captured payment** (surfacing as
`PERSIST_FAILED` → `PAYMENT_SYNC_PENDING` even though the customer paid). If the document did
NOT exist at that moment, the same call would pass the customer **create** lane and mint a
client-built order carrying client-written payment fields — a paid order whose
`payment`/`status`/`totals` never came from the server, and (in either shape) a client payload
positioned to clobber server-owned state written by `finishVerifiedPayment`.

This repair adds a **NEW, strictly read-only finalization method** on both owned surfaces:

- `ordersService.finalizePaidOrder(...)` — server-truth read + validation, zero writes
- `orderRepository.finalizePaidOrder(...)` — delegates, then hydrates the UI store **only**
  from that server-truth result

`createFromCurrentContext` is untouched, so pre-gateway pending-order creation and the COD /
Pay-at-Counter / free-order contexts keep their exact semantics. No backend, payment-transport,
call-site, `firestore.rules`, or pricing edits were made (those lanes are owned elsewhere).

## Root Cause (evidence)

1. **The violating path** — `src/features/orders/repositories/OrderRepository.ts`
   `createFromCurrentContext(opts)` builds a full `CreateOrderInput` (client cart totals,
   client-computed `payment.paidAt = new Date()`, client `status: PLACED`) and passes
   `opts.confirmedOrderId` through to `ordersService.createOrder`, which does
   `setDoc(doc(db, "orders", id), { ...order, ... })` with **no merge** and no existence check
   (`ordersService.ts` createOrder body). Three bad outcomes:
   - **Doc exists (normal case)** → full overwrite = UPDATE. `firestore.rules` update lanes
     (lines ~240-273) reject any customer change affecting `payment`, `paymentStatus`,
     `totals`, … → denied write → `PERSIST_FAILED` for an order whose money is already taken.
   - **Doc missing** → CREATE with nested client-written paid fields → a client-minted "paid"
     order (rules test `#33 ORDERS-CREATE-PLANTED-PAID-DENY` exists precisely to stop born-paid
     docs, but the client display literal `"paid"` is not what the server writes).
   - **Either shape** → the client payload carries client totals/status over a document the
     server may have already confirmed (`paymentStatus: "completed"`, `status: CONFIRMED`).
2. **What server truth looks like** — `functions/src/modules/payments/razorpay.service.ts`
   `finishVerifiedPayment` writes `paymentStatus: "completed"`, `payment.status: "completed"`,
   `payment.razorpayPaymentId`, `payment.razorpayOrderId`, `payment.verifiedAt`,
   `status: {code:"CONFIRMED",...}` (webhook path writes the same paid markers). Only the
   server writes the literal `"completed"` — the client's `PaymentDisplayStatus` enum has no
   such value, so `"completed"` is a trustworthy marker while a nested `"paid"` is not.
3. **Why a read, not a write, is the fix** — `firestore.rules` already allows the owner to
   READ their own order (read lane, lines ~189-193). Finalization never needs a customer write;
   persisting server-confirmed state is the server's job (verify/webhook), and the customer app
   only needs the canonical order in its cache/UI.

## Edits Made

### 1. `burgonomics-foundation-core/src/features/orders/services/ordersService.ts` — NEW
`finalizePaidOrder(input: { confirmedOrderId: string; expectedTransactionId?: string })`

Pure read + validation + cache hydrate. In order:

| # | Gate | Failure code (retryable) |
|---|------|--------------------------|
| 1 | Non-blank `confirmedOrderId` (never mint a fallback id) | `MISSING_CONTEXT` (no) |
| 2 | Authenticated session at entry (guest checkout unsupported) | `MISSING_AUTH` (no) |
| 3 | `syncCacheScope(startedUser)` — drop any other account's caches first (R03) | — |
| 4 | **Fresh `getDoc(orders/{id})`** — not the session cache (`getOrder` serves memory first), not `void refreshOrder` (swallows failures). Read error → | `SERVER_READ_FAILED` (yes) |
| 4b | Doc absent | `NOT_FOUND` (no) |
| 5 | **Scope/async guard**: uid re-checked after the await; on change, re-anchor and discard | `AUTH_CHANGED` (yes) |
| 6 | **Owner binding**: every identity field present on the doc (`customerId`/`userId`) must equal the pinned uid — the same binding `firestore.rules` enforces. None present → shape flag; foreign uid → | `SERVER_DOC_SHAPE_INVALID` / `NOT_OWNER` (no) |
| 7 | **Status shape + terminal gate**: readable status code; terminal / `CANCELLED` / `REFUNDED` / `FAILED` → | `ORDER_TERMINAL` (no) |
| 8 | **Payment shape coherence**: `paymentStatus`/`payment` must be well-typed; a **disagreement** between top-level and nested paid markers → flag, never pick the flattering one | `SERVER_DOC_SHAPE_INVALID` (no) |
| 9 | **Server-paid marker**: `"completed"` (top-level `paymentStatus` or nested `payment.status`). A nested/client `"paid"` literal → flag; genuinely pending/failed → | `SERVER_DOC_SHAPE_INVALID` / `PAYMENT_NOT_CONFIRMED` (yes) |
| 10 | **Expected transaction binding** (when supplied): server's own `payment.razorpayPaymentId` (fallback `payment.transactionId`) must exist (else flag — never fall back to the client's payment id) and match | `SERVER_DOC_SHAPE_INVALID` / `TRANSACTION_MISMATCH` (no) |
| 11 | **Canonical render shape**: fulfillment ∈ {delivery,takeaway,dinein}, store/items/totals/placedAt present | `SERVER_DOC_SHAPE_INVALID` (no) |
| 12 | Hydrate: id = **doc-ref id**, `status` = client catalog resolve, `payment.status = "paid"` *derived from the proven server marker*, `transactionId`/`paidAt` = **server values only** (no `new Date()` minting), `userId` stripped (parity with `getOrder`/`listOrders`), then `orders.set` + `seedProgression` — no awaits between the scope re-check and the cache commit | `ok(canonical)` |

**No branch of this method calls `setDoc`/`updateDoc`/`createOrder` or mints an order id.**

### 2. `burgonomics-foundation-core/src/features/orders/repositories/OrderRepository.ts` — NEW
`finalizePaidOrder(opts: { confirmedOrderId?: string; transactionId?: string }): Promise<ApiResult<Order>>`

Thin and honest: delegates to `ordersService.finalizePaidOrder` (blank id passes through as
`MISSING_CONTEXT`), then `useOrdersStore.upsert(...)` + `setActiveOrderId(...)` **only when
`res.success && res.data`**. Failures never touch the UI store → no false order, no new id.

### 3. `burgonomics-foundation-core/tests/paid-order-finalization.test.ts` — NEW (21 tests)

Hermetic (all Firebase surfaces mocked, no network; `jsdom` docblock because the repository
import graph reaches leaflet, which needs `window` at module scope).

- **A. server-confirmed paid order finalizes with zero writes (2)** — canonical id/status/paid
  payment + server `transactionId`/`paidAt`; `mockSetDoc`/`mockUpdateDoc` **never called**;
  cache hydration served without a second fetch.
- **B. honest failures (12)** — pending-unpaid rejects (`PAYMENT_NOT_CONFIRMED`, cache stays
  empty on a denied raw read); client-written `"paid"` literal flagged; disagreeing markers
  flagged; other-owner `NOT_OWNER`; mid-read uid switch `AUTH_CHANGED` (new session's cache
  empty); read failure `SERVER_READ_FAILED` (no data, no write, cache empty); missing doc
  `NOT_FOUND`; terminal `CANCELLED`/`DELIVERED` → `ORDER_TERMINAL`; tx mismatch
  `TRANSACTION_MISMATCH`; paid-but-no-server-tx-id flagged instead of bound to the client's id;
  guest `MISSING_AUTH` (no read); blank id `MISSING_CONTEXT` (no read).
- **C. cache can never prove payment (2)** — a stale client-"paid" cache entry + failed server
  read → `SERVER_READ_FAILED` (never `ok`, no extra write); a stale unpaid cache entry is
  replaced by a fresh server read that says paid.
- **D. repository UI-store hydration (5)** — success hydrates `useOrdersStore` (byId +
  activeOrderId, zero writes); pending/read-failure/other-owner failures leave the store
  empty; blank id reads nothing.

## Regression ↔ charter mapping

| Charter requirement | Test |
|---|---|
| mocked existing server-paid order finalizes **without writes** | A1, A2, D1 (`setDoc`/`updateDoc` never called) |
| pending/unpaid rejects | B1 (`PAYMENT_NOT_CONFIRMED`), D2 |
| other-owner / UID-switch reject | B5 (`NOT_OWNER`), B6 (`AUTH_CHANGED`), D4 |
| server read failure → no false order / no new id | B7, D3 (store/cache empty, no data, no write) |
| no stale `getOrder` cache / silent `void refresh` as paid proof | C1, C2 (implementation reads via direct `getDoc` only) |
| source rules permission constraints honored | rules suite `55/55` pass, **zero** `firestore.rules` edits |
| preserve initial pending creation + COD context semantics | `createFromCurrentContext` untouched; no call-site edits |
| R03 cache isolation preserved | `syncCacheScope` at entry + post-read uid re-check; B6 |

## Verification

- `npx tsc --noEmit` → **clean** (the AGENTS.md gate's first step; full `npm run build`
  intentionally skipped per charter "no full builds").
- Targeted tests (new + existing payments/orders only, no assertion relaxed):
  `17 files / 135 tests — all pass`, i.e. the 21 new tests plus
  `order-service-auth-isolation`, `orders-guest-gate`, `orders-ownership-share`, `order-status`,
  `tracking-reorder`, `payments-contract`, `payments/payments-flow`, `payment-failure`,
  `payment-response-wire`, routes `payment`/`checkout`/`orders*`/`order-confirmation`,
  `OrderHistoryCard`.
- `npm run test:rules` (local Firestore emulator) → **55/55 pass**, including
  `#6 CUSTOMER-READ-OWN`, `#7 CUSTOMER-CROSS-READ-DENY`, `#28 CUSTOMER-ORDER-FIELD-DENY`,
  `#33 CUSTOMER-CREATE-PLANTED-PAID-DENY` — the permission constraints this repair relies on
  are unchanged and honored (read-only finalization needs only the existing owner-read lane).
- `npx eslint` on the three touched files → all errors inside R24-authored code fixed.
- No live financial/order calls, no phone interaction, no full build.

## New API contract (for the R01 call-site lane — call sites NOT edited here)

```ts
orderRepository.finalizePaidOrder({
  confirmedOrderId?: string;   // verify.data.confirmedOrderId / paymentStore.internalOrderId
  transactionId?: string;      // gateway paymentId (razorpay `pay_...`) — optional binding
}): Promise<ApiResult<Order>>  // server-truth canonical order; NEVER a write
```

Post-verify call sites that still run the violating `createFromCurrentContext` path and should
switch to `finalizePaidOrder` (R01 owns these files):
- `src/routes/payment.tsx` (~line 391, after `verify.data`)
- `src/routes/checkout.tsx` (~line 491, after `verify.data`)
- `src/features/payment/hooks/useRazorpayPayment.ts` (~line 132, after verify)

Call sites that must **stay** on `createFromCurrentContext` (semantics preserved by R24):
- `src/features/payments/repositories/PaymentRepository.ts` (~214) — pre-gateway pending doc
- `src/routes/payment.tsx` (~230) — COD / Pay at Counter
- `src/routes/checkout.tsx` (~352) — COD; (~398) — free order (₹0, no gateway; R01 decision)

On failure the caller's existing `PAYMENT_SYNC_PENDING` reconciliation branch (support CTA,
no cart clear, "do not pay again") is the correct sink for every non-success code.

## Flags — fixture gaps & inconsistent-shape policy (flag, don't trust)

1. **`REPAIR_CHARTER.md` not found** anywhere in the repo, `.swarm`, or the inter-harness
   prompt queues — the task brief itself was used as the operative charter.
2. **worker10 `PAY03` handoff not found** (repo, `.swarm/*`, `04-Prompt-Queues/Ecosystem/*`) —
   PAY03 context was reconstructed from the current source (`createFromCurrentContext`,
   `paymentsService.verify`, `firestore.rules`). If PAY03 exists elsewhere, its findings should
   be reconciled against this report.
3. **No pre-existing test imported `OrderRepository`** — the new file is the first repository-
   level suite; it needs the `jsdom` docblock (leaflet import chain) and a `vi.mock` of the
   firebase config with a *live* `currentUser` getter so uid switches mid-flight are testable.
4. **Server doc shape policy**: a paid marker disagreement (top-level `paymentStatus` vs nested
   `payment.status`), a nested client `"paid"` literal, a paid doc with no server payment id, or
   a structurally broken doc all return `SERVER_DOC_SHAPE_INVALID` rather than trusting
   client-paid fields. Legacy docs finalized by the old path (client `"paid"`, no server
   `paymentStatus`) will honestly fail finalization and surface as sync-pending for
   server-side reconciliation — this is intentional.
5. **Pre-existing lint debt left untouched**: 5 `eslint` errors remain in
   `ordersService.ts` regions R24 did not author/edit — lines 165, 313, 802
   (`no-useless-assignment` on `let all`), 913, 1184. Baseline debt, out of R24 scope.
6. **Concurrent lanes**: the working tree carries uncommitted changes from other lanes
   (payments call sites, `functions/*`, `firestore.rules`, root-repo files). R24 touched only
   its two owned source files + the new test file + this report; nothing else was modified.

## Out of scope (per charter)

Backend / payment transport / call-site edits (R01), pricing refactor, `firestore.rules`
changes, phone/live financial calls, full build.
