# HANDOFF_LOOP_120 — started 2026-09-11
## Progress (check each completed loop)
- [x] 1 (2026-09-11 — workers-down, home-mock queued, tsc green)
- [x] 2 (2026-09-11 — rules dead-block fix, 22/22 gates)
- [x] 3 (2026-09-11 — partner store honesty, 154 green)
- [x] 4 (2026-09-11 — FCM topic authz, 240 green)
- [x] 5 (2026-09-11 — refund fake-success fix, 155 green)
- [x] 6 (2026-09-11 — store directory honesty, 158 green)
- [x] 7 (2026-09-11 — disposition endpoint, 243 + 159 green)
- [x] 8 (2026-09-11 — settings fake-success fix, 162 green)
- [x] 9 (2026-09-11 — CRM attribution honesty, 165 green)
- [x] 10 (2026-09-11 — demo prod-gate, 223 green)
- [x] 11 (2026-09-11 — store read bounds, 225 green)
- [x] 12 (2026-09-11 — OTP bypass closed, 24/24 + 165 green)
- [ ] 13-120
## Carryover (queued product calls, newest last)
- Core home-mock backend (Loop 1) + checkout wiring for partner_settings
  (Loop 8) + live customer directory to replace CRM seeds (Loop 9: loyalty/
  block/campaign/coupon actions all local; server adjustCoins exists).
## Baseline divergence (noted Loop 1 Step 0)
- root `master`: in sync with origin/master
- core `main`: ahead 29, behind 7 vs origin/main — DIVERGED, LOCAL commits only, never force-push
- partner `feat/partner-device-smoke`: ahead 36, behind 6 vs origin — DIVERGED, LOCAL commits only
## Records (newest last)
### Loop 1 — 2026-09-11 06:15 UTC — fixed 0 / workers-down, direct exploration only
- Workers: E1+E2 opencode sessions failed 5x with opencode-zen `UnknownError`
  server errors (same pinned model, serialized + 170s backoff; tries 5/20).
  Phase 2/3 skipped — no exploration output to plan from. Will keep retrying.
- Direct exploration (read-only): functions routes hardened (fail-closed env,
  webhook secret verify, caller passthrough on tickets); no unbounded
  `.collection().get()` in functions/src; core input-placeholder hits benign.
- Queued (product call): core home screen serves MOCK data unconditionally —
  `homeService.ts` (MOCK_BANNERS/OFFERS/etc.) <- `HomeRepository.ts` <-
  `homeStore.ts:62`. No live path, no DEV gate. Fix needs backend /v1/home
  endpoint or DEV-gate/honest-label decision. Not in HANDOFF_100 (new).
- Dismissed: `/porter/webhook` route-level no-auth — service verifies
  x-porter-signature with fail-closed secret (porter.service.ts:527); by design.
- Gates: functions `npx tsc --noEmit` GREEN (exit 0). Full suites deferred.
- Commits: handoff only (root master in sync; core/partner diverged, untouched).
### Loop 2 — 2026-09-11 06:25 UTC — fixed 1 (rules dead block) / workers still down
- Workers: E1 retry-5 + trivial smoke prompt both failed, same opencode-zen
  `UnknownError` (auth creds present, github.com reachable). Endpoint-wide
  outage, not prompt-specific. Tries 6/20. Direct implementation fallback.
- Fixed: `petpooja_webhook_logs` rules block sat at top level OUTSIDE
  `match /databases/{database}/documents` (root firestore.rules:256) — dead
  rule, admin reads default-denied. Live callers broken: core
  httpGateway.ts:563,589 (get/subscribeWebhookLogs), partner
  httpGateway.ts:525,552. Re-indented inside documents block in root + both
  mirrors (all 3 byte-identical). Fix bar: silent admin-path failure.
- Tests added (core suite 20->22): 21 brand-owner read ALLOWED, 22 anon read
  DENIED (+ wh_rules_01 seed). Test 21 fails pre-fix (default deny).
- Gates: core rules 22/22 green (emulator) + tsc clean + unit 221/221 (38
  files) + build clean. Functions untouched (tsc+234 green from Loop 1/2).
- Commits: root 189f229 PUSHED (rules fix); handoff pushed. Core d9d6990
  LOCAL + partner 5422d25 LOCAL (both diverged — push after sync, never force).
  NOTE: core/partner commits show whole-file line-ending stat churn vs their
  HEADs; content verified byte-identical to root fix.
### Loop 3 — 2026-09-11 06:40 UTC — fixed 1 (partner store honesty) / workers down
- Workers: smoke probe failed again, same opencode-zen UnknownError. Tries 7/20.
- Fixed (partner, meets bar — mock data reachable in prod): `getStores`
  served INITIAL_RICH_STORES fixtures silently when admin_stores empty/unreadable
  (dashboardService.ts:616), rendered as live in StoreOverview with hash-fabricated
  "Today's Sales" figures, POS LINK / Cache HIT badges, no demo label anywhere.
  Fix: `StoreResponse.isDemoFallback` flag (types/index.ts) set on fallback rows;
  UNBOUNDED `getDocs(collection(admin_stores))` bounded with limit(100);
  StoreOverview "Demo store" badge + "Demo metrics" caption under card figures.
- Dismissed: simulateOrder sample names/items (useOrders.ts:436+) — DEV-gated
  with loud throw, unreachable in prod. Petpooja gateway factory mock default —
  explicit env-flagged pattern (VITE_PETPOOJA_ENABLED), product posture, QUEUE-adjacent.
- Gates: partner typecheck clean + 31 files/154 tests green (30/151 + 3 new
  store-overview-honesty) + build clean.
- Commits: partner LOCAL (diverged, push after sync). NOTE pre-existing
  `M src/types/index.ts` in partner tree left untouched (not mine).
### Loop 4 — 2026-09-11 06:55 UTC — fixed 1 (FCM topic authz) / workers down
- Workers: smoke probe failed again, same opencode-zen UnknownError. Tries 8/20.
- Fixed (functions, meets bar — authz bypass): /notifications/subscribe let ANY
  authed caller (incl. customers) attach ANY branch's orders/tickets topics to
  their own token — filter checked topic shape, never caller role. Branch pushes
  carry order numbers/totals/flow (KOT alerts, templates.ts:105,276). Fix:
  pure filterSubscribableTopics() (topics.ts, barrel-exported) — branch topics
  staff-only, other topics keep existing checks; both subscribe + unsubscribe
  routes use it. Plus unsubscribe gained subscribe's token-ownership 403
  (previously anyone could detach anyone's token from kitchen alerts).
- Gates: functions tsc clean + 24 files/240 tests green (23/234 + 6 new
  fcm.topics) + build clean.
- Commits: root PUSHED (fix + tests). Handoff pushed below.
### Loop 5 — 2026-09-11 07:00 UTC — fixed 1 (refund fake-success) / workers down
- Workers: smoke probe failed again, same opencode-zen UnknownError. Tries 9/20.
- Fixed (partner, meets bar — fake money movement): AdminRefundsPage approve /
  retry mutated LOCAL paymentStorage seeds + toast.success while Razorpay +
  Firestore stayed untouched (live list comes from Firestore listener, so the
  row never even changed). Approve + retry now POST /payments/refund via new
  partnerFunctionsApi.releaseRefund (staff-only, server-idempotent); failures
  toast loud with dialog kept open; isReleasing blocks double-submit. Reject
  has NO server endpoint → honest fail-closed loud toast, nothing recorded.
  QUEUED: disposition endpoint (carryover).
- Gates: partner typecheck clean + 31 files/155 tests green (+1 gateway test)
  + build clean.
- Commits: partner bc77d03 LOCAL (diverged, push after sync).
### Loop 6 — 2026-09-11 07:35 UTC — fixed 1 (store directory honesty) / workers blocked on auth
- Workers: pinned model still unusable — fresh probe failed with
  opencode-zen UnknownError (err_c74f150e); Hermes pool shows both Zen creds
  rate-limited 429, and the CLI-reported error is key rejection at
  https://opencode.ai/zen/v1. Tries 10/20. Blocked until key is refreshed
  (user action: hermes auth add opencode-zen). Direct implementation fallback.
- Fixed (partner, meets bar — fabricated prod data + fake success):
  AdminStoresPage create persisted "+91 98765 00000" as store/staff phone when
  left blank (3 spots, live admin_stores collection); edit-settings Save
  toasted success without persisting; create toast claimed a Petpooja mapping
  that never happens. Fix: exported normalizeIndianMobile validator (rejects
  blank/placeholder/all-same-digit), create blocked loud without a valid
  phone, saveStores returns real persist outcome, both save paths report
  truthfully, toast copy corrected.
- Queued: AdminSettingsPage Save persists nothing (carryover).
- Gates: partner typecheck clean + 32 files/158 tests green (+3 validator
  tests; one caught the placeholder passing digit-check, validator tightened)
  + build clean.
- Commits: partner 7904a1e LOCAL (diverged, push after sync).
### Loop 7 — 2026-09-11 08:05 UTC — fixed 1 (disposition endpoint, closes Loop 5 carryover) / workers down
- Workers: smoke probe failed again, same opencode-zen UnknownError
  (err_7cdb5969). Key not refreshed (same 2 pooled creds). Tries 11/20.
- Fixed (functions + partner): built POST /refunds/dispose — staff-only +
  AppCheck + zod schema (reason required); disposeRefundRequest 404s missing
  requests and 409s non-PENDING rows, records REJECTED + disposition
  (reason/decider/timestamp) via Admin SDK. Partner reject dialog now calls it
  via partnerFunctionsApi.disposeRefund (loud error, dialog stays open).
  Approval still flows only through autoRefund by construction.
- Lesson: firebase-admin vitest mocks need BOTH `default` and top-level named
  exports for `import * as admin` (named-only access throws at collect).
- Gates: functions tsc + 243 tests (240 + 3 new) + build clean. Partner
  typecheck + 159 tests (158 + 1 new) + build clean.
- Commits: root PUSHED (endpoint + tests); partner 2e7edda LOCAL (diverged).
### Loop 8 — 2026-09-11 08:20 UTC — fixed 1 (settings fake-success) / workers down
- Workers: foreground smoke probe HUNG 120s (no fast error this time).
  Tries 12/20. Endpoint still unusable.
- Fixed (partner, meets bar — fake success + false copy): AdminSettingsPage
  Save showed "committed to Cloud SQL successfully!" while persisting nothing
  (local useState + 1200ms timer); subtitle claimed instant checkout effect;
  helpdesk default was a fake "+91 11 99999 88888". Fix: real persist to
  app_settings/partner_settings (setDoc merge, brand-only per rules, loud
  errors) + load on mount + mergePartnerSettings sanitizer + blank-phone
  rejection + truthful subtitle/success copy. Checkout wiring stays QUEUED
  (neither app reads app_settings live yet).
- Gates: partner typecheck clean + 162 tests (159 + 3 new) + build clean.
- Commits: partner 17a1d8e LOCAL (diverged, push after sync).
### Loop 9 — 2026-09-11 08:35 UTC — fixed 1 (CRM attribution honesty) / workers down
- Workers: background probe failed again, same opencode-zen UnknownError
  (err_d487ac0d). Tries 13/20.
- Compliance sweep (all dismissed with evidence): Android permissions map to
  real features, no cleartext/debuggable flags, targetSdk 36 both apps,
  location + push use proper OS permission flows, iOS PrivacyInfo manifests
  present with required-reason APIs + tracking false.
- Fixed (partner, meets bar — false audit attribution + mock presented as
  live): CRM loyalty/block/campaign/coupon/note actions stamped hardcoded
  "Super Admin (Jesal Pande)" for ANY operator (9 live call sites across
  directory + profile pages). Fix: actorLabelFor(admin.fullName, role) helper
  + "Local directory" badge on the CRM page + "cryptographically signing"
  toast corrected. No live customers source exists in partner (verified) —
  full server wiring QUEUED (carryover).
- Gates: partner typecheck clean + 165 tests (162 + 3 new) + build clean.
- Commits: partner b466452 LOCAL (diverged, push after sync).
### Loop 10 — 2026-09-11 08:50 UTC — fixed 1 (demo prod-gate) / workers down
- Workers: background probe failed again, same opencode-zen UnknownError
  (err_06699bee). Tries 14/20.
- Dismissed with evidence: schedulers all bounded (20/25/40/100, paginated
  menu sync) with claim-then-work overlap guards; compliance items from the
  Loop 9 sweep hold.
- Fixed (core, meets bar — mock/sabotage paths reachable in prod):
  demoStore simulation flags (simulationMode, errorSims, petpoojaSimulate)
  persist in localStorage shared with prod builds on-device, and readers
  (ordersService, razorpayAdapter, mockGateway, routes) applied them
  ungated — a QA-toggled device would serve mocks + simulated payment/order
  failures in prod. Fix: setters refuse + persist merge strips flags on
  prod rehydrate + shouldSimulate/isSimulationMode hard-off in prod.
- Test lesson: vi.stubEnv cannot reach Vite-baked import.meta.env — mock the
  env module with importOriginal instead.
- Gates: core tsc clean + 223 tests (221 + 2 new) + build clean.
- Commits: core 2060b3b LOCAL (diverged, push after sync).
### Loop 11 — 2026-09-11 09:05 UTC — fixed 1 (store read bounds) / workers down
- Workers: background probe failed again, same opencode-zen UnknownError
  (err_a8a1e994). Tries 15/20.
- Dismissed with evidence: PII logging absent (all 3 codebases); Porter card
  already confirm-guarded; GST 5% consistent across server/core/UI; deep-link
  allowlist + sanitizer verified live; OTP 3-attempt lockout; core menu reads
  live Firestore; mock KOT push failures leave honest Pending status for the
  server retry worker.
- Fixed (core, checklist — unbounded queries): storesService pulled whole
  `stores` + `admin_stores` collections unbounded. Now limit(100) both, with
  bounds tests (empty-backend fallback stays DEV-gated).
- Test lesson: client-SDK firebase mocks need importOriginal merge (named
  exports like getFirestore), and vi.mock matches the resolved module — use
  the relative specifier, not the @ alias.
- Gates: core tsc clean + 225 tests (223 + 2 new) + build clean.
- Commits: core 7e1c929 LOCAL (diverged, push after sync).
### Loop 12 — 2026-09-11 09:30 UTC — fixed 1 (OTP bypass closed end-to-end) / workers down
- Workers: background probe failed again, same opencode-zen UnknownError.
  Tries 16/20 (counting this loop's background probe).
- Fixed (meets bar — auth/proof bypass): any branch staffer could flip delivery
  orders straight to DELIVERED via the stepper/direct write, bypassing the
  OTP+lockout handover proof; the functional DeliveryOtpModal was never
  mounted (dead code). Fix: OrderDetailPage routes delivery handover through
  the OTP modal (server verifies + flips); takeaway/dine-in keep stepper;
  rules add directDeliveredBypass() deny on staff delivery-DELIVERED writes
  (brand owners exempt); mirrors re-synced byte-identical.
- Gates: core rules 24/24 green (22 + tests 23 deny / 24 allow) + tsc clean.
  Partner typecheck + 165 tests + build clean.
- Commits: root 1a41e00 PUSHED (rules); core c014963 LOCAL; partner 5e6d0ea
  LOCAL (both diverged, push after sync).
