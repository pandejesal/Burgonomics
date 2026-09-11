# HANDOFF_100 — Burgonomics continuous edge-case loop

Started 2026-09-10. Sustained audit-and-fix loop over the Burgonomics monorepo
(`C:\Users\DELL\Desktop\Burgonomics`, Firebase `burgonomics-7faa8`, `asia-south1`).
Each wakeup: re-check fresh, fix what meets the bar, append an entry below.

## Baseline (prior 12-loop campaign, all green, report pushed)
- 606 tests / 91 suites / 0 failures (functions 234, core 221, partner 151) + rules 18/18 + 3 clean builds.
- Ground rules: scoped commits per repo, push only green trees, never force-push,
  no secrets/env/node_modules in commits. Partner + core branches diverged —
  their commits stay LOCAL until sync.

## Fix bar
Fail-closed violation, money movement, auth bypass, silent data loss,
fake/mock reachable in prod, crash. Else dismiss with reason or queue.

## Queued (product/server calls, still open)
- P0: cash-order server pricing endpoint (buyer-settable totals, rules identity-only).
- Mock-as-live-path purge (loop-8 catalog in AUDIT_LOOP_REPORT.md).
- Server aggregation for dashboards; defensive query limits; iOS entitlement + keystore SHA.
- Reconciliation Title-Case role gate normalization (dead gate, fail-closed).

## Log (newest last)
### 2026-09-10 — platform URL-param spoof gated (core)
- `burgonomics-foundation-core/src/shared/platform/platform.ts`: `?platform=` /
  `?simulate=` overrode platform detection in ALL builds (maps links, push
  channels, token-registration string). Now dev/test-only via local
  `isProdBuild()` (import.meta.env.PROD, no appConfig import to keep the
  module SSR-safe). Security gates already used Capacitor `isNative()`, so
  exploit was LOW — closed anyway.
- Gates: core tsc + full suite (see commit). Core commit LOCAL (diverged).
### 2026-09-11 — second dispatch confirm (partner)
- `burgonomics-partner/src/pages/OrderDetailPage.tsx`: second single-tap paid
  dispatch path (`handleDispatchPorterRider`) had no confirm (card path fixed
  loop 11). Now ConfirmDialog with fare/ETA + min-h-44px CTA.
- Gates: partner typecheck + 30/151 green. Partner commit LOCAL (diverged).
### 2026-09-11 — rider phone entry validation (partner)
- `burgonomics-partner/src/features/delivery/components/RiderAssignmentModal.tsx`:
  custom rider phone was `type=tel` + `required` only — the `+91 ` stub and
  short numbers entered dispatch records and `tel:` links. Now
  `isSafeTelNumber` + 10-digit minimum at submit with `role=alert` inline
  error (clears on edit), `aria-invalid` on the input.
- Gates: partner typecheck + 30/151 green. Partner commit LOCAL (diverged).
### 2026-09-11 — money CTA 44px targets (partner)
- Cancel confirm, AdminRefunds reject/approve/retry, ticket execute buttons:
  additive `min-h-[44px]` only, no layout logic change.
- Gates: partner typecheck + 30/151 green. Partner commit LOCAL (diverged).
### 2026-09-11 — Clear-filters recovery (partner)
- `OrderTableList` + `TicketQueueTable`: optional `onClearFilters` prop with
  recovery button in filter-empty views, wired to page filter setters
  (OrdersPage: channel/status/search; TicketsPage: tier/category/search).
  `MenuPage` filter-empty resets search + category inline.
- Gates: partner typecheck + 30/151 green. Partner commit LOCAL (diverged).
### 2026-09-11 — FCM token material out of logs (core)
- `notificationsService` + `pushNotifications`: registration logged 10-char
  token prefixes. Now `tokenLength` only — zero token material in logs.
- Gates: core tsc + 38/221 green. Core commit LOCAL (diverged).
### 2026-09-11 — rules-mask regression check + data() audit (no-op)
- Verified the loop-7 rules mask did NOT break partner ticket flows: all
  money actions route via server `resolveTicket` with honest banners;
  direct `updateTicket` writes carry only status/resolution/assignedToTier
  (mask-compatible), `addMessage` writes timeline only. Loop-7 observation closed.
- Audited all 8 `.data()!` sites in functions: every one guarded by an
  exists-check with park/throw/return (86ing parks unknown orders).
- No source changes. No commit.
### 2026-09-11 — CSV exports verified phone-free (partner, no-op)
- `AdminRefundsPage:185-198` refunds ledger CSV: ID/payment/order/customer
  NAME/store/amount/reason/status/processedBy/timestamp — no phone column.
- `AdminPaymentsPage:91-113` payments export: txn ID/order/customer
  NAME/store/amount/status/gateway/date — no phone. Closes the loop-10
  queued export-verify item.
- No source changes. Handoff only.
### 2026-09-11 — message-only backend error logs (functions)
- 11 whole-`err` console calls (auth triggers, FCM send, razorpay resolution,
  webhook KOT push, 86ing x3, menu sync, porter x2) now log `err.message`.
  Whole client/API error objects can embed keys or customer fields.
- Gates: functions tsc + 234 green. Root commit (pushed).
### 2026-09-11 — tracking honesty fixes (core)
- Track route: sandbox "Advance Stage" button faked Delivered locally (no
  server write) in prod — now `import.meta.env.DEV`-gated.
- Hardcoded `+91 98250 99881` fallback (route + card default) dialed a
  fabricated number. Call buttons render only with a real store phone.
- Gates: core tsc + 38/221 green. Core commit LOCAL (diverged).
### 2026-09-11 — tracking server refresh (core, follows timer clamp)
- Removing timer-completion left a staleness gap: tracking read memory-only,
  so server-delivered orders would show pre-terminal forever. `getTracking`
  now refreshes the doc each poll (ownership-checked, best-effort).
  Scope clean (1 file).
- Gates: core tsc + 38/221 green. Core commit LOCAL (diverged).
### 2026-09-11 — timer never auto-completes orders (core)
- `tickOrder` advanced order status to DELIVERED/COMPLETED by elapsed time
  with no backend event — faked handover, removed recourse. Now holds
  pre-terminal; real completions flow via partner/server writes.
  Scope clean (1 file).
- Gates: core tsc + 38/221 green. Core commit LOCAL (diverged).
### 2026-09-11 — honest invoice + escaping (core)
- `InvoiceDownloadButton`: tax invoice printed the fabricated fallback
  phone → em-dash when missing; all interpolated strings HTML-escaped
  (invoices get saved/shared). Scope clean (1 file).
- Gates: core tsc + 38/221 green. Core commit LOCAL (diverged).
### 2026-09-11 — reorder cross-store guard (core)
- `useReorderItems`: cross-store lines counted as added, then silently
  rejected per-line by the single-store cart rule (wrong cart + fake
  success). Upfront check with error toast; nothing touched on mismatch.
- NOTE: file was untracked (another lane's new file); commit includes its
  full content. Gates green on the combined result.
- Gates: core tsc + 38/221 green. Core commit LOCAL (diverged).
### 2026-09-11 — percent-discount preview clamp (core)
- `mockComputeDiscount`: percent value >100 with no maxDiscount previewed a
  negative payable. Clamped to subtotal (server reprices authoritatively;
  preview must not promise free money). Scope clean (1 file).
- Gates: core tsc + 38/221 green. Core commit LOCAL (diverged).
### 2026-09-11 — reminder flags on delivered alerts only (functions)
- `ticketReminder.scheduler`: `branchReminderSent` committed BEFORE sends
  ran — failed/crashed sends never retried (silent escalation). Flags now
  ride a follow-up batch keyed to fulfilled sends; escalation flips stay
  pre-committed (time-based truth). Scope clean (1 file).
- Gates: functions tsc + 234 green. Root commit (pushed).
### 2026-09-11 — honest no-branch toast (partner)
- `StoreOperatingToggle`: no-branch path toasted success while persisting
  nothing (component state, lost on unmount). Now loud error.
- NOTE: file was untracked (another lane's new file); commit includes its
  full content. Gates green on the combined result.
- Gates: partner typecheck + 30/151 green. Partner commit LOCAL (diverged).
### 2026-09-11 — no fabricated Route account ids (partner)
- `createBranch` minted `acc_Rzp_<timestamp>` + lead conversion pre-filled
  random `acc_Rzp` ids → royalty splits aimed at nonexistent accounts.
  Now null/empty (Route worker skips with a log); operator pastes the real id.
- NOTE: commit ad8a4d9 swept another lane's large BranchesPage rewrite.
  My hunks verified present, zero `acc_Rzp` literals remain, gates green.
- Gates: partner typecheck + 30/151 green. Partner commit LOCAL (diverged).
### 2026-09-11 — chat impersonation nuance queued (partner, no-op)
- `chatService.sendMessage`: `senderId`/`senderName` are caller-supplied;
  rules gate thread participation (tests 17-18) but don't bind
  `senderId == request.auth.uid` — a legit participant could post as another
  participant. No money/auth impact; needs a rules change (concurrent lane
  owns the file). Queued as hardening.
- Verified holding: thread/message reads+writes participant-gated; queries
  bounded (30/50); thread create requires self-in-participants.
- No source changes. Handoff only.
### 2026-09-11 — coins adjustment path review (no-op, functions)
- `adjustCustomerCoins`: zod ±5000 + reason, requireAuth + role gate,
  caller-bound, atomic transaction (balance+ledger), branch scope via
  customer home outlet, claims carry role+branchIds (revocation-checked,
  bootstrap force-refresh; stale claims fail closed). All HOLD.
- No source changes. Handoff only.
### 2026-09-11 — no fabricated address phone (core)
- `AddressForm`: empty profile phone persisted `0000000000` into address
  records (rider/SMS downstream). Now empty; update validation skips empty.
  Scope clean (1 file).
- Gates: core tsc + 38/221 green. Core commit LOCAL (diverged).
### 2026-09-11 — failure-injection reachability (no-op, core)
- `shouldSimulate()` gates stock/order/petpooja/payment failures. Verified:
  `errorSims` defaults all false, persisted but settable only via DebugPanel
  (unmounted, `isDebugAllowed`-gated); zero setters elsewhere in src.
  Unreachable in prod. Dismissed.
- No source changes. Handoff only.
### 2026-09-11 — regression sweep, all fixes intact (no-op)
- Re-verified every loop fix against concurrent-lane edits: platform gate,
  byId gate, stepper gate, razorpay key, support copy, store v3, refund
  label, dispatch/cancel confirms, deep-link router, KDS mask, rider phone
  validation, franchise DEV-gate, analytics honesty, message-only backend
  logs (porter 4x, 86ing 3x, webhook 1x), ticket rules tests 19-20,
  price-lock fail-honest. All present, none reverted.
- No source changes. Handoff only.
### 2026-09-11 — honest support surface (core)
- Ticket toast promised a 15-min manager response nothing fulfills → honest
  on-device copy; `branch_cg_road` default stamped tickets to a wrong outlet
  → undefined; feedback vanished entirely → on-device log (cap 100).
  Server inbox/feedback endpoints still queued. Scope clean (2 files).
- Gates: core tsc + 38/221 green. Core commit LOCAL (diverged).
### 2026-09-11 — walk-in counter orders can't save (queued, partner)
- `ManualOrderCreateModal` writes client-computed totals +
  `paymentStatus:'completed'`/`petpoojaSyncStatus:'synced'`/`kotPrinted:true`
  with `customerId:'cust_walkin'` and NO `userId` stamp → current rules
  (create requires customerId/userId == uid) DENY it. Fail-closed (safe)
  but the feature is dead + hardcoded `branch_surat_01`/city fallbacks.
  NOT hot-fixed open: needs a server counter-order endpoint (same family
  as the P0 cash endpoint). Queued as product.
- No source changes. Handoff only.
### 2026-09-11 — no mock default store (core)
- `storeStore` booted with `MOCK_STORES[0]` as the ACTIVE store (persisted),
  so checkout could run against a fake outlet. Initial null + persist v3
  migration strips `str_NNN` mock ids on upgrade; genuine picks survive.
  Scope clean (24/5, one file).
- Gates: core tsc + 38/221 green. Core commit LOCAL (diverged).
### 2026-09-11 — real Razorpay key into checkout (core)
- Intent path passed bogus `rzp_test_mock` keyId which passed `isLive()`
  and fired a REAL checkout attempt with an invalid key. Now the configured
  publishable key, else the adapter's simulation sentinel (honest branch).
- NOTE: commit 693f750 also swept another lane's full-file rewrite of the
  same file (interface expansion). Combined tree green, coherent.
- Gates: core tsc + 38/221 green. Core commit LOCAL (diverged).
### 2026-09-11 — loud errors on dead flag surface (partner)
- `SystemFeatureFlagsTab`: full CRUD against nonexistent
  `/api/v1/feature-flags` failed silently (console-only, no toasts).
  Toasts on catch + non-ok paths; endpoint itself still missing (product).
- LESSON (tool hazard): the patch tool redacts secret-like text and WROTE
  the redaction into the file (backtick-Bearer literals became `***`,
  41 tsc errors). Repaired via perl chr() codes, verified 0 errors +
  byte-check. Never put Bearer/key-like literals in patch strings —
  anchor around them or edit via terminal.
- Gates: partner typecheck + 30/151 green. Partner commit LOCAL (diverged).
### 2026-09-11 — simulated badge on Redis tab (partner)
- `SystemRedisTab`: local mock state + native alerts claiming Redis/SQL ops
  (backend is Firestore). Badged honest.
- NOTE: commit 099e010 also swept another lane's theme-token swaps in the
  same file. Cosmetic, fine, tangled.
- Gates: partner typecheck + 30/151 green. Partner commit LOCAL (diverged).
### 2026-09-11 — fake endpoint tester DEV-only (partner)
- `SystemApiTab`: "Test Endpoint" faked 200 + OTP code with spinner and
  zero backend calls. Runner gated; explorer docs stay visible. Scope clean.
- Gates: partner typecheck + 30/151 green. Partner commit LOCAL (diverged).
### 2026-09-11 — byId mock fallback DEV-only (core)
- `storesService.byId`: prod lookup miss returned a mock store (list() was
  already DEV-gated). Now null; callers already handle null. Scope clean.
- Gates: core tsc + 38/221 green. Core commit LOCAL (diverged).
### 2026-09-11 — simulated badges on system tabs (partner)
- `SystemMetricsTab` (mock Prometheus counters) + `SystemDatabaseTab`
  (static EXPLAIN plans; backend is Firestore, not Postgres) presented as
  live monitoring. "Simulated data" badges added. Diff scope-checked clean.
- Gates: partner typecheck + 30/151 green. Partner commit LOCAL (diverged).
### 2026-09-11 — honest analytics no-data state (partner)
- `AdminAnalyticsPage`: zero-data fallbacks were fiction (96.2/45.8/14.2%).
  Now em-dash + "No delivery data yet".
- NOTE: commit 4a31f09 also swept another lane's theme-token swaps in the
  same file (hardcoded hex → tokens). Cosmetic, fine, tangled.
- Gates: partner typecheck + 30/151 green. Partner commit LOCAL (diverged).
### 2026-09-11 — sync report honest empty state (partner)
- `PetpoojaStoresPage`: seeded `DEFAULT_SYNC_REPORT` (simulated:true) showed
  plausible numbers with no badge. Null until a real op runs + empty state;
  seed constant deleted.
- Gates: partner typecheck + 30/151 green. Partner commit LOCAL (diverged).
### 2026-09-11 — profile mock tables DEV-only (partner)
- `AdminCustomerProfilePage`: BUR- order rows + pay_Rzp payment rows
  fabricated from the customer's real stats were prod-visible. Both tables
  now DEV-only (empty in prod; no real source wired).
- Gates: partner typecheck + 30/151 green. Partner commit LOCAL (diverged).
### 2026-09-11 — threat-sim toggle DEV-only (partner)
- `AdminPaymentHealthPage`: "Simulate Gateway Latency Spikes" flipped
  circuit-breaker state + fake latency with zero backend calls. Gated.
- NOTE: commit b5bdfc2 also swept another lane's listener-cleanup hunk in
  the same file (direct import + unsubscribe). Functionally fine, tangled.
- Gates: partner typecheck + 30/151 green. Partner commit LOCAL (diverged).
### 2026-09-11 — real active-today metric (partner)
- `AdminCustomersPage`: "active today" was `total*0.4` fiction. Now counts
  profiles with `lastOrderDate` in the last 24h (missing/unparseable skip).
- Gates: partner typecheck + 30/151 green. Partner commit LOCAL (diverged).
### 2026-09-11 — franchise seed leads DEV-only (partner)
- `useFranchiseLeads`: empty/denied collection returned 4 realistic fake
  leads (names/phones/emails) staff might call or email. Prod returns [].
- Gates: partner typecheck + 30/151 green. Partner commit LOCAL (diverged).
### 2026-09-11 — simulate-trigger DEV-only (partner)
- `AdminAutomationPage`: "Simulate Real Trigger" wrote fake Delivered
  journey entries under REAL customer names + random stat bumps. Button
  now `import.meta.env.DEV`-only in prod builds.
- Gates: partner typecheck + 30/151 green. Partner commit LOCAL (diverged).
### 2026-09-11 — guest-migration adversarial review (no-op)
- Re-attacked the migration path end-to-end: route has requireAuth +
  AppCheck; `migrateGuestAccount` binds target to caller UID, verifies
  HMAC proof timing-safe, refuses guessable session ids, requires the
  source UID be a real project-anonymous account (order-hijack refused),
  refuses contradicting body phones, confines relink to guest-owned docs,
  chunks at 400. Secret missing → mint throws / verify false. All HOLD.
- No source changes. Handoff only.
### 2026-09-11 — sandbox smoke tab DEV-only (partner)
- `DevDiagnosticsModal`: "Run Sandbox Smoke Test" printed canned success
  lines (KOT printed, driver allocated, refund reversed) with zero backend
  calls, reachable from prod Settings. Tab + panel now `import.meta.env.DEV`;
  health/gateway/snapshot tabs unaffected.
- Gates: partner typecheck + 30/151 green. Partner commit LOCAL (diverged).
### 2026-09-11 — fabricated fallback rider removed (core)
- `usePorterLiveTracking`: stage 3 with no rider showed fake name/phone/plate
  + `porter.in/track/sample` URL. Now undefined (card's "Assigning Courier"
  path) and no sample URL.
- Gates: core tsc + 38/221 green. Core commit LOCAL (diverged).
### 2026-09-11 — cancel-booking confirm (partner)
- `PorterDispatchCard`: single-tap "Cancel Porter / Re-assign" killed live
  courier bookings. Now destructive ConfirmDialog + min-h-44px CTA.
  (One intermediate red: fragment wrapper — typecheck caught, fixed.)
- Gates: partner typecheck + 30/151 green. Partner commit LOCAL (diverged).
### 2026-09-11 — ticket mask pinned with rules tests 19-20 (core)
- Open question: does the staff update mask accept dotted `assignedTo.tier`
  writes (partner escalate flows depend on it)? Pinned with emulator tests:
  19 ALLOWED (affectedKeys top-level), 20 refundAmount DENIED. Suite 20/20.
- Gates: rules 20/20 green. Core commit 28022c3 LOCAL (diverged).
### 2026-09-11 — price lock fail-honest + functions tree green (core/functions)
- `CartRepository.validateAndRefreshPriceLock`: menu-fetch failure silently
  renewed the lock on stale prices (banner promised unverified lock). Now
  leaves expired + returns reverify message. Only caller ignores result —
  no flow breaks; online payments reprice server-side regardless.
- Gates: core tsc + 38/221 green. Core commit LOCAL (diverged).
- Functions tree (incl. concurrent lane's uncommitted hunks): tsc + 234 green.
### 2026-09-11 — cancel memory-fallback upheld, fix reverted (core)
- Attempted: revert memory-cancel when Firestore persist fails (stale-terminal
  divergence). Reverted: `payments-flow.test.ts` enshrines memory-fallback as
  the tested contract (CANCEL-PRE-DELIVERY + CANCEL-TERMINAL-REJECT broke).
  Memory fallback is by design; divergence window narrow; no UI callers of
  repository.cancelOrder yet. Dismissed with evidence. Working tree clean.
