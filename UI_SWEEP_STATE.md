# UI Sweep State — ban list + iteration log

## Ban list
- B1 (iter1): core /support zustand getSnapshot infinite loop (React error #185, minified text leaked to users). FIXED in support.tsx — never re-fix; any future /support crash is a NEW flaw only with a different stack signature.
- B2 (iter1): partner /admin/login permanent "Verifying Credentials..." disabled button (store initial isLoading:true never cleared on login route). FIXED in adminAuthStore.ts — never re-fix.
- B3 (iter1): white Capacitor-logo splash (11 partner Android drawables) + all-white 2732 iOS template glyphs (6 PNGs both apps). REPLACED with #0E4825 + mascot brand masters — never re-do; future splash work only for NEW asset/config drift.

## Iteration log

### Iteration 1 (attempt 2) — 2026-09-07 — focus: splash kill + harness + baselines (both apps)
- Screens shot (390x844, system Chrome, vite preview): core / /menu /stores /offers /support /cart /checkout /payment /auth/login /about /privacy (5192); partner /login /admin/login (5191). Authed routes out of scope (no session) — skipped per protocol. All PNGs under .swarm/ui-shots/1/ (gitignored).
- FIXED:
  - F1 core burgonomics-foundation-core/src/routes/support.tsx:79 — `useOrdersStore(selectAllOrders)` built a fresh array per snapshot (ordersStore.ts:94-95) so getSnapshot never stabilized → "Maximum update depth exceeded" (#185), whole /support down with raw minified error text. Before: crash page + 1 console error. After: renders (SLA banner + ticket accordion), 0 errors. Fix: stable `ids` subscription + getState derive in useMemo. Verified: npx tsc --noEmit clean; support.test.tsx 5/5; refix screenshot eyes-on.
  - F2 partner burgonomics-partner/src/admin/store/adminAuthStore.ts:20 — initial `isLoading:true` never cleared on /admin/login (AdminPortalLayout skips bootstrap there) → submit button disabled on "Verifying Credentials..." forever. Before: stuck spinner. After: enabled "Authenticate Credentials". Fix: initial false (login/logout/bootstrap set true on real work). Verified: npm run typecheck clean; refix screenshot eyes-on; no test asserts initial true.
  - F3 splash kill — 17 assets overwritten, sizes/modes preserved, Contents.json + all config untouched: 11 partner Android drawable*/splash.png + 3 partner iOS + 3 core iOS Splash PNGs → #0E4825 bg + official mascot (sourced from public/burgonomics-logo.png 977x1024 after rejecting a blurry 16x upscale from the 320px drawable; verified via 1000px center-crop eyes-on). Rollback: git checkout the asset paths.
- DISMISSED (not fixed, not banned): D1 /menu "AWAITING SYNC" + /menu//offers networkidle timeouts — no backend in preview, not a code flaw, revisit live; D2 consent banner overlapping every shot — fresh-profile harness artifact (never accepted); D3 / hero clipping/truncations — cosmetic, below bar; D4 /offers "LA PINO'Z INSPIRED BOGO" competitor copy — real, queued iter2; D5 refix /support ticket heading low-contrast — queued iter2; D6 partner /login "prefilled" creds — placeholders; D7 pristine OTP input red border — minor, queued; D8 banner over privacy text — same as D2.
- GATES: partner typecheck clean + build clean (22.5s→9.0s rebuild); core tsc clean + build clean + support.test.tsx 5/5. Full suites SKIPPED per swarm no-full-suite rule (only touched-file tests run).
- A11Y: no new barriers (logic-only edits + asset swap); star radios labeled, FAQ accordions aria-expanded, 44px targets kept; D5 contrast noted for iter2.
- PUSH SHAs: partner a6e4e2a (feat/partner-device-smoke, 15 files), core e60df6f (main, 4 files). Root: this file only.
- DEVIATIONS: (a) harness at .swarm/ui-harness/capture.mjs not scripts/ (root repo UNTOUCHED + gitignore rule wins); (b) both coder delegations returned no-diff settlements, self-applied identical specs with own-eyes diff + gates; (c) Task tool has no model parameter — model pinning requested in prompts but not mechanically enforceable; (d) full test suites skipped (swarm rule overrides protocol step 11).

## Ban list additions (iter2)
- B4 (iter2): customer-facing fake "Sync Telemetry / Webhook Status" panel (hardcoded mockWebhookLogs timestamps). REMOVED from PetpoojaSyncPlaceholder — never re-add fake telemetry to prod paths; future sync-status UI only with live data.
- B5 (iter2): header bell unconditional unread dot. FIXED in LaPinozHeader (gated on unreadCount) — never re-hardcode; future bell work only for NEW indicator logic.

### Iteration 2 — 2026-09-07 — focus: core / + /menu (foundation-core main only)
- Screens shot (390x844, system Chrome via reused harness, vite preview 5192): / (200, 0 console errors), /menu (networkidle timeout — no backend in preview, same D1 artifact as iter1; PNG still written).
- Hypotheses formed per screen (/, /menu): hero-clip class (dismissed — D3), chip/card ellipsis (dismissed — accessible names + normal scroll patterns), banner-occlusion "This"/"POS" ghosts (dismissed — D2 harness artifact), fake telemetry (FIXED), phantom bell dot (FIXED).
- FIXED:
  - F4 src/shared/components/feedback/PetpoojaSyncPlaceholder.tsx — deleted `mockWebhookLogs` (fake 10:42:0x timestamps) + entire "View Sync Telemetry / Webhook Status" collapsible; removed now-unused `useState`/`AnimatePresence`/`Terminal`/`ChevronRight`. Before: expanding panel showed fabricated webhook log as live status on /menu + /home empty states. After: honest waiting copy only. Verified: dist grep zero hits for "Sync Telemetry"/"mockWebhookLogs"; refix screenshot no regressions.
  - F5 src/features/home/components/LaPinozHeader.tsx — bell unread dot now conditional on `useNotificationsStore(s => s.unreadCount) > 0` (matches profile.notifications/profile.index contract); aria-label announces "Notifications, N unread" when present. Before: phantom dot on every load. After: clean bell at zero (refix root.png eyes-on) + dist grep confirms "Notifications, " in home chunk.
- DISMISSED: /menu networkidle timeout (D1, backend-absent); consent-banner overlap + occluded "This"/"POS" text (D2 artifact); hero/chip/card truncations (D3 class, accessible names present); BURG50 badge hardcode (Banner model has no badge field — presentational default, needs model change, below bar).
- Queued iter1 items untouched (out of my / + /menu scope): offers "LA PINO'Z" copy, support ticket-heading contrast, OTP pristine-error border.
- GATES: npx tsc --noEmit clean (exit 0); no touched-file tests exist (no *.test references either component — nothing to run); npm run build clean (6.44s, post-fix). Full suite SKIPPED per swarm no-full-suite rule.
- A11Y: no new barriers — removed content was decorative; bell dot decorative + label announces count; pre-existing 32px bell target noted, untouched (out of scope).
- Step 9 splash kill: SKIP (iteration 1 only).
- PUSH SHAs: core 7c0e61d, root 45c0c38 (scoped commits only; pre-existing dirty files untouched).
- DEVIATIONS: (a) both coder delegations returned CODER_SETTLEMENT_RECOVERY_UNCERTAIN no-write settlements — self-applied identical specs with own-eyes diff + gates (same as iter1 deviation b); (b) Task tool has no model parameter — pinning requested in prompts only; (c) full suite skipped (swarm rule).

## Ban list additions (iter3)
- B6 (iter3): cart chip toggles silently dropped at checkout (cart-local `selectedChips`/`customNote` state never reached order creation, which reads checkout.orderNotes). FIXED in cart.tsx (mergeChipIntoNotes mirrors chips into persisted notes, free text preserved) — never re-plumb; future notes work only for NEW channels.
- B7 (iter3): fabricated 10:00 price-lock countdown + eternal "locked" claim at 00:00 (null-lock branch set 600s; banners rendered whenever non-null). FIXED in cart.tsx + checkout.tsx (null lock => null => banner hidden; 0 => honest expired copy) — never re-fabricate lock UI; future lock work only for NEW timer logic.

### Iteration 3 (attempt 2) — 2026-09-07 — focus: core /cart + /checkout (foundation-core main only)
- Screens shot (390x844, system Chrome via reused harness, vite preview 5192, post-fix dist): /cart + /checkout both HTTP 200, ZERO console errors (refix console-errors.json). Baselines .swarm/ui-shots/3/cart.png + checkout.png (attempt-1 pre-fix) kept; refix cart-refix.png + checkout-refix.png alongside. Refix PNGs byte-identical in size to baselines — expected: fresh-profile empty carts never render the lock banner, so this confirms no regression; F6/F7 verified by own-eyes diff + dist grep + gates.
- State restated at start: iter 3, /cart + /checkout, B1–B5 intact (no re-fix touched them).
- Fix #1 VERIFIED present in tree (attempt-1 uncommitted work, git diff eyes-on): cart.tsx mergeChipIntoNotes() + toggleChip mirrors into useCheckoutStore.orderNotes + selectedChips seeded from persisted notes. Untouched by attempt 2.
- FIXED:
  - F6 (Fix #1, attempt-1 spec, now committed): cart.tsx — chip toggles persisted to checkout notes via "|" parts, user free text preserved, StrictMode-idempotent; onCheckout reads getState. Before: chips selected in cart silently lost at order creation. After: chips survive cart→checkout→order.
  - F7 (Fix #2, derived attempt-2 from code — baselines show empty states so no price UI visible; flaw proven by file:line): cart.tsx:107-109 + checkout.tsx:128-130 fabricated `setRemainingLockSeconds(600)` when `priceLockExpiresAt` is null (empty/cleared cart, fresh profile, null persisted value), and banners (cart.tsx:299, checkout.tsx:405, `!== null` gate) rendered "Prices locked for this order 10:00" / "Checkout Price Locked 10:00" with no lock behind them — same fake-telemetry class as B4, on money paths. At real expiry the clamp-to-0 kept claiming "locked" at 00:00. Fix (display-only; pricing/gateway truth untouched — CartRepository.validateCart still revalidates expired locks pre-charge): null lock => `setRemainingLockSeconds(null)` => banner hidden; remaining===0 => honest "Price lock expired — latest prices apply at checkout" (cart) / "Price Lock Expired — Rechecked At Checkout" (checkout). Verified: dist grep hits "Price lock expired" in bundle; tsc clean; cart+checkout tests 11/11.
- DISMISSED: bill-breakdown `?? 15`/`?? 35` packing/delivery fallbacks while totals null — transient loading skeleton values, replaced on recompute, below bar; checkout loyalty-clamp + geofence NaN guard + offline PAY gate already hardened in code (comments at checkout.tsx:105-124,190-233) — not flaws.
- GATES: npx tsc --noEmit clean (exit 0); npx vitest run cart.test.tsx + checkout.test.tsx 11/11 pass; npm run build clean (6.49s). Full suite SKIPPED per swarm no-full-suite rule.
- A11Y: no new barriers — text-node-only conditionals, same classes/contrast; no CTA geometry touched (PAY/offline button, 44px redeem toggle intact); totals region unchanged.
- Step 9 splash kill: SKIP (iteration 1 only).
- PUSH SHAs: core 6380669, root e6ea6fc (scoped commits only; pre-existing dirty files untouched).
- DEVIATIONS: (a) coder delegation returned CODER_SETTLEMENT_RECOVERY_UNCERTAIN no-write — self-applied identical spec with own-eyes diff + gates (iters 1–2 precedent); (b) Task tool has no model parameter — pinning requested in prompt only; (c) full suite skipped (swarm rule); (d) refix screenshots confirm no-regression only (empty-cart states can't render the banner; no seed path in harness).

## Ban list additions (iter4)
- B8 (iter4): /support section headings forced `text-white` on the light page background (near-invisible "Your Active & Past Tickets", "Direct Contact Channels", "Frequently Asked Questions"). FIXED in support.tsx (dropped text-white, theme-aware default) — never re-force light text on light surfaces; future heading work only for NEW sections.
- B9 (iter4): competitor brand name "La Pino'z Inspired BOGO" in prod offers UI. FIXED in BOGOBanner.tsx ("Signature BOGO") — never name competitor brands in customer-facing copy; future banner work only for NEW promo logic.

### Iteration 4 — 2026-09-07 — focus: core /payment + /support + /offers + /stores (foundation-core main only)
- Screens shot (390x844, system Chrome via reused harness, vite preview 5192, post-fix dist): /payment + /support + /stores HTTP 200, ZERO console errors; /offers networkidle timeout (D1 backend-absent artifact — repository load never settles in preview; PNG still rendered full UI). Baselines .swarm/ui-shots/4/ (refix capture overwrote support/offers PNGs + console-errors.json; payment/stores entries from first capture: 200/0 errors).
- State restated at start: iter 4, payment/support/offers/stores, B1–B7 intact (no re-fix touched them).
- Hypotheses per screen: payment dead/dishonest CTAs (dismissed — PaymentMethodList already semantic motion.button + role=radio + disabled + focus ring; Loop 23 div-onClick claim does not reproduce, already hardened); support contrast/crash (B1 holds — 0 errors, no crash; F8 fixed); offers copy honesty (F9 fixed); stores dead buttons/empty states (dismissed — search, Nearby, map, list all render, 0 errors).
- FIXED:
  - F8 support.tsx:143,155,196 — three `Text variant="titleMedium" className="text-white font-bold"` headings invisible on light page bg (own-eyes: ghost "Your Active & Past Tickets (1)"). Fix: dropped `text-white` (theme-aware default, matches offers.tsx coupon-heading pattern). Dark surfaces untouched (SLA banner, ChannelRow, FaqAccordion). Verified: refix screenshot dark readable heading, 0 errors, no regressions.
  - F9 BOGOBanner.tsx:41 — "La Pino'z Inspired BOGO" competitor chip (queued D4, own-eyes verified). Fix: "Signature BOGO" text-node only. Verified: refix screenshot badge, coupon code/logic untouched.
- DISMISSED: /payment guest redirect to login (auth guard correct; authed money path out of scope without session, iter1 precedent); /offers goto timeout + transient ERR_CONNECTION_RESET (D1 class); consent-banner overlap (D2 artifact); stores "mock Bandra coordinates" fallback toast (dev-mode GPS fallback, not rendered in shot); hardcoded red-800/700 GPS-offline text (below bar); still queued: OTP pristine-error border, BURG50 badge.
- GATES: npx tsc --noEmit clean (exit 0); support.test.tsx 5/5; no offers-component tests exist (nothing to run for BOGOBanner — iter2 precedent); npm run build clean (8.22s post-fix). Full suite SKIPPED per swarm no-full-suite rule.
- A11Y: contrast IMPROVED (dark-on-light headings); BOGO text-only change, copy/Apply buttons intact; no CTA geometry touched.
- Step 9 splash kill: SKIP (iteration 1 only).
- PUSH SHAs: core 6c59b84 (support.tsx only — pure 3-line diff). BOGOBanner.tsx host file is UNTRACKED (other stream's in-progress offers feature); F9 applied in working tree, NOT committed — left for owning stream, not swept. Root: this file (pending).
- DEVIATIONS: (a) both coder delegations returned CODER_SETTLEMENT_RECOVERY_UNCERTAIN no-write — self-applied identical specs with own-eyes diff + gates (iters 1–3 precedent); (b) Task tool has no model parameter — pinning requested in prompts only; (c) full suite skipped (swarm rule); (d) F9 uncommitted (untracked host file — sweeping it would claim another stream's work).

### Iteration 5 (attempt 2) — 2026-09-07 — focus: core /auth/login + /about + /privacy (foundation-core main only)
- State restated at start: iter 5, auth/about/privacy, B1–B9 intact (no re-fix touched them).
- Baselines REUSED from attempt 1 (no recapture needed — tree unchanged since its build): .swarm/ui-shots/5/auth_login.png + about.png + privacy.png, all HTTP 200, ZERO console errors (console-errors.json). dist/mobile fresh (attempt-1 build; no src changes since).
- Analysis finished with in-browser computed-style probe (sandbox-safe: probe written via Write to .swarm/ui-harness/probe-border.mjs beside capture.mjs for node_modules resolution, CWD=.swarm/ui-harness, no heredocs; deleted after run):
  - QUEUED "OTP pristine red border" — DISMISSED as non-flaw with proof. Probe of /auth/login pristine field: wrapper class `border-divider focus-within:border-primary` (no error state), computed wrap border rgb(14,72,37) = primary green from :focus-within (autoFocus working), aria-invalid null, helper neutral "0/10 digits". The red-orange rectangle = global `:focus-visible` ring `outline: 2px solid var(--color-ring)` (styles.css:240-243, --ring #C2410C = rgb(194,65,12), probe-measured on the focused input) — an intentional Loop-13 a11y feature, gated to `(hover:hover) and (pointer:fine)` so real touch devices never render it. PhoneLoginForm.tsx:31 gates inlineError on `touched`, TextField.tsx:18-23 defaults to `border-divider` — no validation-error leak. Removing it would regress keyboard a11y; fail-closed on auth. NOT banned (not a fix), recorded here so iter6 never re-litigates.
  - /about + /privacy own-eyes: no new flaws. "Follow us" social chips are honest non-interactive spans with "launching alongside our next store" caption (about.tsx:68-80) — not dead buttons. Legal internal links (/terms, /privacy) real routes. Privacy [Name]/[Building/Street]/masked-ID placeholders = dismissed placeholder class (iter1 precedent) + legal copy needs owner data — fabricating a grievance-officer name would be worse; queued for owner, not fixed. Distressed display-font texture on headings is brand style, consistent across screens. Consent-banner overlap = D2 harness artifact.
- FIXED: none (zero new fixable flaws → FIX #1/#2 both SKIP with reasons above; Step 9 splash SKIP iter1-only; no re-screenshots — nothing changed).
- GATES: npx tsc --noEmit clean (exit 0). No touched files → no touched-file tests to run (nothing to run). No rebuild (dist fresh, zero edits). Full suite SKIPPED per swarm no-full-suite rule.
- A11Y: no changes; verified intact — phone input labeled (label + aria-label) with helper counter, server errors role=alert, 56px targets, focus ring present; about/privacy semantic headings + real links.
- PUSH SHAs: no code commit (no-op — zero edits; scope files verified untouched). Root: this file (pending).
- DEVIATIONS: (a) no coder delegations sent (nothing to fix — analysis-only iteration); (b) full suite skipped (swarm rule).

## Ban list additions (iter6)
- B10 (iter6): partner /admin/login hardcoded brand hex (`bg-[#0E4825]`, `text-[#0E4825]`, `focus:border-[#0E4825]`, `text-[#FF6600]`, `hover:text-[#0E4825]`) bypassing theme tokens (dark-mode incorrect). FIXED in AdminLoginPage.tsx (`bg-primary`/`text-primary`/`focus:border-primary`/`text-accent dark:text-accent-light`/`hover:text-primary`) — never re-hardcode brand colors; future brand work only for NEW surfaces.
- B11 (iter6): partner /admin/login unassociated `<label>`s (no htmlFor/id) + error box without role=alert (screen-reader users got placeholder-only inputs, silent errors). FIXED in AdminLoginPage.tsx (htmlFor admin-email/admin-password + role=alert) — never ship unlabeled auth inputs; future label work only for NEW fields.

### Iteration 6 (attempt 2) — 2026-09-07 — focus: partner /login + /admin/login (burgonomics-partner feat/partner-device-smoke only)
- State restated at start: iter 6, /login + /admin/login, B1–B9 intact (no re-fix touched them).
- Attempt-1 context: stalled ~60+ min post-build, killed; left AdminLoginPage token fix uncommitted (adopted as-is) + zero screenshots + no STATE entry. 5191/5192 listeners from attempt 1 still up — reused 5191 (serves dist, HTTP 200), never stacked; did not start any server.
- Screens shot (390x844, system Chrome via reused harness): /login + /admin/login both HTTP 200, ZERO console errors (.swarm/ui-shots/6/login.png + admin_login.png; refix capture overwrote admin PNG after attribute-only FIX #2 — iter4 precedent).
- FIXED:
  - F10 (FIX #1, attempt-1 spec adopted): AdminLoginPage.tsx — hardcoded hex → theme tokens. Tokens verified resolving in index.css @theme (--color-primary #0E4825, --color-accent #C2410C, --color-accent-light). Refix eyes-on: brand green tile/heading, orange gateway caption, enabled "Authenticate Credentials" button (B2 holds).
  - F11 (FIX #2, own-eyes derived): AdminLoginPage.tsx labels gained htmlFor + input ids (admin-email/admin-password); error box gained role=alert. Before: placeholder-only announcement, silent error div. After: associated labels, announced errors. Attribute-only, zero visual change (refix 200/0 errors).
- DISMISSED: B2-class stall (button enabled, isSubmitting starts false — B2 holds); /login "prefilled" creds = placeholders (value starts '', iter1-D6 class); Quick Staff PIN tab = intentional fail-closed (roster EMPTY by design, AuthContext.tsx:26-32, honest invalid-PIN error — touching it would violate fail-closed; NOT a flaw); focus:ring-[#0E4825] leftovers resolve to identical #0E4825 = primary (no visual bug); no password-visibility toggle on admin page (feature request, fail-closed on auth — not added); tab/keypad target sizes (keypad 48px pass; tabs borderline, geometry untouched per iter2 precedent); /login error boxes without role (noted, outside scoped file — left alone).
- GATES: npm run typecheck clean; no touched-file tests exist (no *.test references AdminLoginPage — nothing to run); npm run build clean (41.13s post-fix). Full suite SKIPPED per swarm no-full-suite rule.
- A11Y: labels associated + errors announced on admin login (IMPROVED); /login already htmlFor-bound with aria-pressed toggle; no CTA geometry touched.
- Step 9 splash kill: SKIP (iteration 1 only).
- PUSH SHAs: partner fa06c5c (AdminLoginPage.tsx only, scoped; all other dirty files untouched). Root: this file (pending).
- DEVIATIONS: (a) no subagent delegation for FIX #2 — self-applied 3-attribute spec with own-eyes diff + gates (iters 1–4 precedent; avoided long-hang risk after attempt-1 stall); (b) full suite skipped (swarm rule).

### Iteration 7 — 2026-09-07 — focus: shared components at source (BOTH apps — core main + partner feat/partner-device-smoke)
- State restated at start: iter 7, shared-source scope, B1–B11 intact (no re-fix touched them).
- Harness REUSED (.swarm/ui-harness/capture.mjs, CWD=.swarm/ui-harness). No rebuild (core dist/mobile fresh — no core src changes since 6c59b84 build; partner dist fresh — iter6 fa06c5c build, no src changes since). Servers reused, never stacked (5192 core + 5191 partner, both HTTP 200).
- Screens shot (390x844, system Chrome): core / (200, 0 console errors) + partner /login (200, 0 console errors) → .swarm/ui-shots/7/root.png + login.png + console-errors.json (merged — harness overwrites per-run, both runs logged 200/0 on stdout).
- Analysis own-eyes, B1–B11 discarded:
  - B10-pattern grep (hardcoded [#0E4825]/[#FF6600]): 100+ hits per app BUT all app-local (tracking cards, support forms, store maps, KDS/ticket widgets, LoginPage tiles) — out of scope for shared-source iteration, dismissed (queued for future app-local token pass; tokens themselves resolve correctly in both index.css/styles.css).
  - B11-pattern (unlabeled shared inputs): partner LoginPage.tsx:157,174 labels ARE htmlFor-bound (operator-email/operator-password) — B11 holds, no flaw. TicketDetailPage bare labels wrap their inputs (implicit association) — not a flaw.
  - Core / own-eyes: hero "THE HOUSE OF DAMN GOOD BURGERS" tight two-line stack + BURG50 badge (still queued, needs Banner model change) + chip truncation — all app-local core home/banner scope (D3 class / pre-existing queue), dismissed for iter7.
  - Partner /login own-eyes: clean — labeled inputs, password toggle, honest RBAC caption, enabled CTA. No flaws.
  - No cross-repo shared lib exists (each app owns src/shared/* + own tokens); no flaw found in shared-source files → FIX #1/#2 both SKIP, Step 9 SKIP (iter1-only), no re-screenshots (nothing changed).
- FIXED: none (zero new shared-source flaws).
- GATES: core npx tsc --noEmit clean (exit 0); partner npm run typecheck clean (exit 0). No touched files → no touched-file tests, no rebuild. Full suite SKIPPED per swarm no-full-suite rule.
- A11Y: no changes; verified intact — partner /login labels associated, core / landmarks unchanged.
- PUSH SHAs: no code commit (no-op — zero edits). Root: this file (pending). Heads unchanged: partner fa06c5c, core 6c59b84.
- DEVIATIONS: (a) no coder delegations sent (nothing to fix — analysis-only iteration, iter5 precedent); Task tool has no model parameter — pinning N/A with no delegations; (b) full suite skipped (swarm rule); (c) console-errors.json hand-merged (harness single-baseUrl per run overwrites).

### Iteration 8 — 2026-09-07 — focus: TABLET re-sweep 768x1024 of top fixed screens (BOTH apps — core main + partner feat/partner-device-smoke)
- State restated at start: iter 8, tablet viewport, core /support /cart /checkout /offers + partner /admin/login /login, B1–B11 intact (no re-fix touched them).
- Harness EXTENDED via sibling .swarm/ui-harness/capture-tablet.mjs (768x1024; mobile capture.mjs untouched). No rebuild (core dist fresh — no src changes since 6c59b84 build; partner dist fresh — iter6 fa06c5c build). Servers reused, never stacked (5192 core + 5191 partner, both HTTP 200).
- Screens shot (768x1024, system Chrome): core /support (200, 0 errors) + /cart (200, 0) + /checkout (200, 0) + /offers (networkidle timeout = D1 backend-absent artifact, PNG still rendered full UI) → .swarm/ui-shots/8/core/; partner /admin/login (200, 0) + /login (200, 0) → .swarm/ui-shots/8/partner/.
- Analysis own-eyes, B1–B11 discarded: B1 holds (/support renders ticket accordion, 0 errors); B8 holds (section headings dark readable at width); B6/B7 hold (empty cart/checkout, no fabricated lock banner); B9 holds ("Signature BOGO", no competitor copy); B2 holds (enabled "Authenticate Credentials"); B10 holds (brand green tile/orange caption = tokens); B11 holds (labels visible above inputs). No tablet-only layout breaks, no clipped CTAs.
- A11Y probe at width (sandbox-safe probes beside harness, deleted after run): primary CTAs cart Explore Menu 44px + checkout Browse menu 48px + admin Authenticate 52px PASS; sub-44px hits (support RAISE 36px, offers Apply 28px, login Sign-in 42px/tabs 38px, consent X 24px, inline Privacy/Terms links ~16px) proven IDENTICAL at mobile 390x844 baseline (36/28/42/38) → same-flaw class, not tablet-specific → dismissed per standing rules (app-local nits stay queued); inline text links carry WCAG inline exception. Partner labeledInputs 2/2 both login routes.
- FIXED: none (zero new tablet-specific flaws → FIX #1/#2 both SKIP; Step 9 SKIP iter1-only; no re-screenshots — nothing changed).
- GATES: core npx tsc --noEmit clean (exit 0); partner npm run typecheck clean (exit 0). No touched files → no touched-file tests, no rebuild. Full suite SKIPPED per swarm no-full-suite rule.
- PUSH SHAs: no app commits (no-op — zero src edits). Heads unchanged: partner fa06c5c, core 6c59b84. Root: 0d36326 (this file only).
- DEVIATIONS: (a) no coder delegations sent (nothing to fix — analysis-only iteration, iter5/7 precedent); Task tool has no model parameter — pinning N/A with no delegations; (b) full suite skipped (swarm rule); (c) tablet capture via sibling file (protocol-allowed) rather than editing shared harness; (d) no servers started (reused prior-iter listeners) → none killed.
- Zero-flaw streak: 2 (non-consecutive — no early stop).

### Iteration 9 — 2026-09-08 — focus: FULL re-sweep verify ALL screens BOTH apps at mobile 390x844 (core main + partner feat/partner-device-smoke)
- State restated at start: iter 9 verify-only, 13 routes, B1–B11 intact (no re-fix touched them). Regression hypotheses per fixed screen: /support crash return (B1) / ghost headings (B8); admin-login stall (B2) / hex drift (B10) / delabeled inputs (B11); menu telemetry return (B4); home bell dot return (B5); cart chip loss (B6) / fake lock banner (B7); offers competitor copy return (B9); splash revert (B3).
- Harness REUSED (.swarm/ui-harness/capture.mjs, CWD=.swarm/ui-harness). No rebuild (core dist/mobile fresh — no src changes since 6c59b84; partner dist fresh — no src changes since fa06c5c; scoped fix files verified clean except BOGOBanner.tsx still untracked other-stream file with F9 intact). Servers reused, never stacked (5192 core + 5191 partner, both HTTP 200); started none → killed none.
- Screens shot (390x844, system Chrome): core / /menu /stores /offers /support /cart /checkout /payment /auth/login /about /privacy → .swarm/ui-shots/9/core/ (11 PNGs); partner /login /admin/login → .swarm/ui-shots/9/partner/ (2 PNGs). Console errors: 11 routes HTTP 200 / 0 errors; /menu + /offers networkidle timeout = D1 backend-absent artifact (PNGs still rendered full UI, iter1/2/4 precedent); partner both 200/0.
- Analysis own-eyes, per-B verdict (ALL HOLD): B1 holds (/support renders ticket accordion, 0 errors); B2 holds (enabled "Authenticate Credentials"); B3 holds (splash PNG present 25KB mascot master, untouched since iter1 — route shots out of scope for splash, Step 9 SKIP); B4 holds (/menu honest waiting copy, no telemetry panel); B5 holds (clean bell at zero); B6 holds by code (cart.tsx committed, empty-cart state can't render chips — iter3 precedent); B7 holds (empty cart/checkout, no lock banner); B8 holds (dark readable ticket headings); B9 holds ("Signature BOGO" in shot + tree grep, untracked host file untouched); B10 holds (green tile/orange gateway caption); B11 holds (labels visible above inputs both partner routes).
- DISMISSED (verify-only, queued never in scope): D1 timeouts; D2 consent-banner overlap on all core shots (fresh-profile harness artifact); BURG50 badge (still present, needs Banner model change); app-local token hardcodes; sub-44px targets; /payment guest redirect to login (auth guard correct, iter4 precedent); auth focus-visible orange ring (intentional Loop-13 a11y, iter5 precedent).
- FIXED: none (zero B-regressions → FIX #1/#2 both SKIP; Step 9 SKIP iter1-only; no re-screenshots — nothing changed).
- GATES: core npx tsc --noEmit clean (exit 0); partner npm run typecheck clean (exit 0). No touched files → no touched-file tests, no rebuild. Full suite SKIPPED per swarm no-full-suite rule.
- A11Y: no changes; verified intact — admin labels associated, headings readable, focus ring present; no CTA geometry touched.
- PUSH SHAs: no app commits (no-op — zero src edits). Heads unchanged: partner fa06c5c, core 6c59b84. Root: this file only (pending).
- DEVIATIONS: (a) no coder delegations sent (nothing to fix — analysis-only iteration, iter5/7/8 precedent); Task tool has no model parameter — pinning N/A with no delegations; (b) full suite skipped (swarm rule); (c) core+partner shots in separate subdirs (both console-errors.json preserved, no hand-merge needed); (d) no servers started → none killed.

### Iteration 10 (FINAL close-out) — 2026-09-08 — focus: verify state integrity + final regression spot-check + HANDOFF
- State integrity: 9 iteration sections present covering iters 1–9 (headers: 1-attempt2, 2, 3-attempt2, 4, 5-attempt2, 6-attempt2, 7, 8, 9). FINDING (log-only, repaired by this entry, no app impact): prompt's "10 entries (1,2,3,3-attempt2-note,4,5,6,7,8,9)" counts iter3 baseline + attempt-2 note as two logical entries; physically the file holds 9 headers with attempt-2 context merged into single headers for iters 3/5/6 — coverage is complete, no iteration missing. Bans B1–B11 all recorded verbatim (B1–B3 base + B4/B5 iter2 + B6/B7 iter3 + B8/B9 iter4 + B10/B11 iter6). SHAs consistent: partner fa06c5c, core 6c59b84, root pre-push 1cc0cfa.
- Spot-check (no rebuild): core HEAD 6c59b84 MATCHES log; partner HEAD fa06c5c MATCHES log; root HEAD 1cc0cfa MATCHES log. F9 "Signature BOGO" present in tree (burgonomics-foundation-core/src/features/offers/components/BOGOBanner.tsx:41), zero competitor-copy hits. Sweep-scoped git status CLEAN (UI_SWEEP_STATE.md + iter10 prompt + harness + shots show no sweep-owned uncommitted files); other streams' dirty files listed but untouched per protocol (core + partner worktrees carry unrelated deletions/modifications — not mine, never touched).
- Screens: SKIPPED capture with reason — both dists FRESH (core dist/mobile/index.html Sep 7 19:57 newer than HEAD 6c59b84 with zero fix-files newer than dist; partner dist/index.html Sep 7 22:57, AdminLoginPage.tsx not newer than dist, HEAD fa06c5c). Per protocol "serve ONLY if dists stale" → no servers started, no screenshots to .swarm/ui-shots/10/ (dir not created — nothing to attest beyond iter9's 13-route full verify 11/11 holds). Highest-risk screens (core /checkout money path, partner /admin/login auth path) covered by iter9 200/0-error shots + this iter's code-grep gates.
- FIXED: none (close-out only; no critical regression — no app won't-render, no money-path dishonesty → no fixes per scope).
- GATES: core npx tsc --noEmit clean (exit 0); partner npm run typecheck clean (exit 0). No touched files → no touched-file tests, no rebuild. Full suite SKIPPED per swarm no-full-suite rule.
- A11Y: no changes; prior attestations stand.
- PUSH SHAs: no app commits (no-op — zero src edits). Heads unchanged: partner fa06c5c, core 6c59b84. Root: this file only (pending).
- DEVIATIONS: (a) no coder delegations sent (nothing to fix — close-out only); Task tool has no model parameter — pinning N/A with no delegations; (b) full suite skipped (swarm rule); (c) no servers started → none killed; (d) .swarm/ui-shots/10/ intentionally absent (fresh-dist skip per protocol).

## Ban list additions (iter11)
- B12 (iter11): prod build without Firebase env whitescreened EVERY route (task-1.4 fail-fast throw at module scope, before React renders). FIXED with dependency-free ConfigErrorScreen + boot.tsx (mobile-entry dynamic import catches boot throw; fail-fast semantics untouched — still refuses to boot, now visibly, zero console errors). Never reintroduce static-entry boot that can whitescreen; the error screen must stay backend-import-free.
- B13 (iter11): partner Logo SVG wordmark (~154 units wide) overflowed its circle, spilling invisible white-on-white at small sizes (admin login). FIXED with textLength="120" lengthAdjust="spacingAndGlyphs" — never ship SVG text wider than its container; future logo work only for NEW marks.

### Iteration 11 — 2026-09-23 — focus: post-upgrade re-sweep, ALL screens BOTH apps at mobile 390x844 + tablet spot-check
- State restated at start: iter 11 (new campaign chapter — prior 1–10 closed Sep 8), all public routes, B1–B11 intact (verified holding where screens allow).
- Harness REUSED (.swarm/ui-harness/capture.mjs + capture-tablet.mjs, CWD=.swarm/ui-harness). Rebuilt BOTH apps (dists stale after Sep upgrades + bug-hunt fixes): core `npm run build` + `build:mobile` clean, partner `npm run build` clean. Started 3 SPA servers (5173 core prod dist/mobile, 5174 partner dist, 5175 core dev-build scratch) — kill commands blocked by shell safety filter, servers left running (static only, noted).
- FINDING F11a (critical, NEW): core prod dist without VITE_FIREBASE_* rendered BLANK WHITE on all 11 routes (HTTP 200, 1 pageerror each: task-1.4 fail-fast throw). Own-eyes verified (root.png white). Not a backend-absent artifact — the throw precedes all rendering. FIXED (F11): ConfigErrorScreen.tsx (zero imports from app graph) + boot.tsx (old mobile-entry body) + mobile-entry.tsx (dynamic import + catch render). Refix eyes-on: branded error screen with collapsible technical details, 0 console errors. Gates: tsc clean.
- Screens shot round 2 with SWEEP-DUMMY Firebase keys in gitignored .env (local-only, deleted after; restored .env verified 1-line; prod dist/mobile rebuilt after restore so shipped bundles never contain dummies): 11/11 core routes HTTP 200, ZERO console errors (.swarm/ui-shots/11/sweep2/); partner /login + /admin/login 200/0; tablet /checkout + /payment 200/0.
- Analysis own-eyes per screen: / → store-selection redirect correct (no chosen store); /menu same guard correct; /stores search + Nearby + honest location prompt + skeleton loaders; /offers "Signature BOGO" (B9 holds) + coupon box; /support dark readable headings, honest on-device copy, mascot, no crash (B1/B8 hold); /cart + /checkout honest empty states; /payment guest→login redirect correct; /auth/login focus ring = intentional Loop-13 a11y (iter5 precedent); /about + /privacy real copy, masked-ID placeholders = owner-data queue (iter5 precedent); partner /login placeholders confirmed empty values in code (D6 holds); partner /admin/login B2/B10/B11 hold.
- FINDING F12 (NEW, verified): partner Logo wordmark overflow (see B13). FIXED, partner rebuilt, refix eyes-on: full "BURGONOMICS" legible in circle on /admin/login. Core BrandMascot unaffected (different asset, support-shot mascot clean).
- DISMISSED: consent-banner overlap (D2 harness artifact, all shots); /menu+/offers networkidle timeouts absent this round (dummy keys boot the app; backend-absent states render honest placeholders); distressed display-font texture (brand style, iter5 precedent); chunk-size + dynamic-import build warnings (pre-existing).
- NOTE for task-1.4 owner: `import.meta.env.PROD === true` is TRUE in EVERY `vite build` (Vite sets NODE_ENV=production for builds regardless of --mode; bundle evidence: MODE:"development" with PROD:!0) — the dev warn+placeholder branch is dead code in all builds. Spec-compliant as-is (prod throws), but the dev fallback only ever runs under `vite dev`. No change made (not my scope).
- GATES: core tsc clean (exit 0) post-fix; partner typecheck clean; core mobile build clean; partner build clean. Touched-file tests: payments-flow 2/2, guest-gate 1/1, order-status 7/7 (core); KDSPage 7/7, DeliveryQueue 8/8 (partner). Full suites SKIPPED per swarm rule.
- A11Y: error screen has role=alert + headed structure; logo fix visual-only (aria-label intact); no CTA geometry touched.
- PUSH SHAs: no commits (user asked for fixes only, no commit instruction — all changes uncommitted in worktrees alongside other streams' work).
- Cleanup: .env restored (verified), prod dist/mobile rebuilt post-restore, peek/print/probe helper scripts deleted. Leftover on disk (gitignored, untracked): dist/sweep + dist/sweep2 scratch builds (recursive delete blocked by shell filter), 3 SPA servers running. Shots under .swarm/ui-shots/11/ (gitignored).

### Iteration 12 — 2026-09-23 — focus: targeted re-verify after API-routing fixes (no full re-sweep)
- Reason: iter 11 (same day) already shot all 13 routes with eyes-on analysis; only code-level (non-visual) changes landed since, except SystemApiTab content + RiderAssignmentModal rewrite + Porter fare copy — all behind authenticated routes the harness cannot reach without a session (iter1 precedent: authed routes out of scope).
- Rebuilt BOTH apps (dists stale): partner `npm run build` clean, core `npm run build:mobile` clean. Re-shot partner /login + /admin/login (200/0 errors): B13 wordmark fix HOLDS (legible in-circle wordmark both routes), B2/B10/B11 hold. No other visual deltas vs iter 11.
- Changed-but-unshootable screens verified by gate instead: SystemApiTab real-inventory rewrite (tsc clean), RiderAssignmentModal explicit-rider rewrite + PorterDispatchCard honest-fare copy (tsc clean + DeliveryQueue/OrderDetail tests pass), customer ticket-create rewiring (tsc clean + support tests pass), KDS/OTP/dispatch hook changes (tsc clean + KDS/Delivery tests pass).
- FIXED: none (no new visual flaws; B12/B13 hold).
- GATES: partner typecheck + build clean; core tsc + mobile build clean. Full suites SKIPPED per swarm rule.
- PUSH SHAs: no commits (fixes-only instruction).

### Iteration 13 - 2026-10-07 - focus: fresh dual audits + P0 sweep both apps, review rounds 1-4, batch commits begin
- New audits written (gitignored): .swarm/ui-audit-core.md (26 findings: P0=5, P1=11, P2=10) + .swarm/ui-audit-partner.md (27: P0=5, P1=15, P2=7). Total 53 findings queued; P0 core + partner P0-1 addressed this iteration.
- COORDINATION: sibling session ses_eec3caca (store-submission: keystores, bundle-ID rename, secrets, store listing, integration flags) confirmed domain split - orchestrator owns ALL UI files. Sibling Phase 1 in flight (keystores generated, com.glassdoorsstudio -> com.burgonomics rename running) so its native/config edits share the app worktrees; sweep commits stage ONLY sweep files.
- FIXED core P0 batch (4 review rounds: coder r1 -> reviewer REVISION_NEEDED -> orchestrator revisions r2 (coder backend overloaded) -> reviewer REVISION_NEEDED -> coder r3 -> reviewer 4 issues -> coder r4 interrupted, orchestrator finished -> reviewer 1 blocker -> h-full fix):
  - P0-1/2/4 + P1-1 address cluster: AddressFormModal map port with pinPlaced honesty (lat/lng only from drag / granted GPS / edit-with-coords); addressService clean() strips undefined on create AND deleteField maps cleared fields on update; sanitizePhone in validate/validatePatch ("" + E.164 pass - was BLOCKER rejecting every AddressForm save); autoLocatedRef once-per-open auto-locate (later GPS fixes never yank a confirmed pin or overwrite typed fields); geocodeTokenRef stale reverse-geocode guard (checked before any setState, bumped on reset); Locate Me re-centers from request() coords on every press; role=img wrapper h-full w-full (reviewer-caught 0px map regression); zoomControl off; >=44px targets.
  - P0-3 WhatsApp consent: whatsappOptIn persisted to order doc; customer update rules clause hasOnly([whatsappOptIn,updatedAt]) + is bool in BOTH root and core firestore.rules; tests 27/28 added; order-confirmation legacy docs default OFF (=== true, never assert consent).
  - P0-5: showTabs=false on /profile/edit; EditProfileForm sticky bar pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))].
- FIXED partner P0-1: useNavigation derives roles from routePolicy.rolesForRoute()/canAccessRoute; PARTNER_CONSOLE_ROLES + customer-route deny; NotificationBell hidden when /notifications denied; tests/nav-policy-parity.test.ts (3 tests).
- VERIFY CAUGHT STALE PREVIEW: vite preview on 5192 served yesterday's dist (first screenshot round showed a since-removed zoom control). Rebuilt, re-captured, then DOM-probed /addresses/create with Playwright: map 352x254, zero .leaflet-control-zoom/.leaflet-bar, attribution only, fresh chunk served, 0 console errors. Same-path PNG re-read returned a replayed cached image (known harness desync) - DOM probe treated as source of truth.
- GATES: core tsc exit 0; npm run build exit 0 (38.8s); tests 13/13 (checkout, route-imports) + earlier 21/21 (guest-gate, order-status); partner typecheck + build + 208 tests PASS (incl. 3 nav-parity) from its batch. Full suites skipped per swarm rule. Screenshots .swarm/ui-harness/shots-mapfix*/ (gitignored).
- COMMITS: policy CHANGED this iteration by user decision - commit each verified batch on branch ui-sweep per repo (root + core + partner), default branches untouched. Stage ONLY sweep files: excludes pre-existing dirt (netlify deletions, menu images, plan files), sibling Phase 1 native edits, and partner firestore.rules home-merchandising block (not sweep work).

---

## Iteration 14 — Core P1 round complete (all 4 tasks approved + committed)

**Commits on `ui-sweep` (burgonomics-foundation-core):**
- `b8660db` T1 / P1-2 tracking honesty (approved round 1; 16/16 track tests)
- `8b9de6e` T2 / P1-3 fabricated store measurements (1 revision round: AddressSelector doc-radius display, StoreCard ETA span, FulfillmentSheet pickup ETA; 37/37 + honesty tests)
- `5bafd3d` T3 / P1-4+P1-9+P1-11 profile & consent (2 revision rounds: me() read-boundary sanitizeProfileDoc + verifyOtp guard; 49/49)
- `ee54de0` T4 / P1-5/6/7/8/10 copy, legal, errors (APPROVED round 1 + 4 reviewer leftovers applied: sign-in subtitle, empty-outlet copy, vendor strings in offers meta + cart chip; 26/26, build 0)

**Process notes:** backend failed 5 dispatches total (ENOTFOUND + restart aborts + geo-block) — orchestrator fallback used for T2 remainder, T3 fixes, T4 remainder; reviewers ran with full rigor every time and caught 5 blockers across T2/T3 that the fallback work had missed (all fixed + confirmed). New helper `core/errors/userMessages.ts` (toUserMessage) is the standard raw-error funnel going forward.

**New findings filed (from T4 reviewer):** P1-13 (raw Firebase text in auth/support/offers toasts beyond audited six), P1-14 (broad `*.error.message` UI surface backlog). P1-12 (menu prep-time fabrication) filed in iter13. All queued for a follow-up round after P2.

**Working-tree caveat:** whole-file commits on shared files (home/menu/stores/offers) carry some other-lane hunks already documented at references/verification/8.1.md — same policy as batch 1.

---

## Iteration 15 — Core P2 round complete (10/10 findings, 4 batches, all approved)

**Commits on `ui-sweep` (burgonomics-foundation-core):**
- `4b27fdf` P2-T1 / P2-3+P2-9: home dead FulfillmentSheet instance removed; terms fee copy matches pricingEngine (flat fee as shown at checkout); de-branded comments (offers/BottomTabBar/OTPInputGrid/track "Domino's"); LaPinozHeader → BrandHeader rename (bell gate B5 byte-identical). Reviewer APPROVED 0 blockers.
- `dc458dd` P2-T2 / P2-4+P2-5: deleted unreachable FranchiseModal (zero importers both repos; partner franchise lead flow untouched) + VisualOrderTracker (fake 14-min ETA/7419 PIN/demo badge) + barrel line. Reviewer APPROVED 0 issues.
- `4a71b81` P2-T3 / P2-1+P2-2: search Voice/Scan coming-soon stubs deleted; About social pills lost link-implying icon + schedule-promise caption. Reviewer APPROVED 0 issues.
- `d77a507` P2-T4 / P2-7+P2-8+P2-10: profile "coming soon" → present-fact; rating toast device-local thanks; CreateTicketForm slaMinutes + "SLA Guarantee"/auto-escalation claims removed (Option A). Reviewer APPROVED 0 blockers.

**P2-6** = verify-only (P1-8 already DEV-gated the Bandra GPS toast; re-check `rg "mock Bandra|GPS failed" dist` → 0 after builds — confirmed during T2 review).

**Info notes queued (non-blocking):** support.tsx:118 stale JSX comment "SLA Guarantee"; profileService.ts:86 unreachable "Coming soon" (requestPhoneChange, no UI caller); root docs reference old LaPinozHeader filename (_config/design_system.md:43, references/ui_ux_spec.md:130 — handover doc OWNER_INFO_NEEDED.md:90 quotes old about caption).

**Process:** 1 ENOTFOUND + 2 lost-result dispatches this round — retries succeeded; one session misbehaved as coder during a reviewer dispatch, was re-dispatched as strict read-only reviewer (verdict obtained).

**Core audit status: P1 (10) + P2 (10) = 20 findings closed; 3 reviewer-discovered findings queued (P1-12/13/14).** Next: partner app P0 2–5, then partner P1/P2.

---

## Iteration 16 — Partner P0 round complete (5/5 findings, 4 batches, all approved)

**Commits on `ui-sweep` (burgonomics-partner):**
- `41e6f54` P0-5 / Batch 1: Core Cluster Health — standby stub returns status only (empty-{} truthiness root cause), 15s constant-poll dropped, key-count `hasLiveTelemetry` exported, uptime/RAM/disk fallbacks (382410s/184MB/1GB/4.2GB/15GB) gone, STANDBY card reachable, new SystemHealth.test.ts. Reviewer APPROVED 0 issues.
- `161cc86` P0-4 / Batch 2: KPI trends now computed from a real shifted window (one extra useAnalyticsSummary; either side missing → no chip), New Customers gets NO trend (rolling metric — shifted window would fabricate baseline), 8 literal sparklines removed (revenue/orders fed from real series), `10s ago` → formatFreshness(dataUpdatedAt) with chip omitted while fetching; marketing StatCard trends removed (P1-18 trend-half folded). Reviewer REVISION_NEEDED (comment contained its own banned grep literal) → reword → APPROVED.
- `4e330a3` P0-2 / Batch 3: Petpooja white-screen — 3 layers: layout swaps Outlet for honest standby card (children-first so delivery-queue keeps rendering — reviewer blocker round 1), all 23 mount-time gateway accesses deferred (2 extra hits found), RouteErrorBoundary keyed to pathname inside <Router>. Reviewer REVISION_NEEDED → fixes → APPROVED.
- `8a16e06` P0-3 / Batch 4: store creation — buildNewStore persists only user input; ~17 render sites honest (Never/Not connected/em dashes/empty states); 2 extra fabrication writers fixed (toggle stamps, staff email); isOpen false (reviewer blocker — fresh outlets could appear open-for-orders via admin_stores fallback); +9 tests. Reviewer REVISION_NEEDED → fix → APPROVED.

**New findings queued (from P0-4/P0-3 reviews):** P2-25 addendum (PetpoojaDashboardPage `trend={{value:0}}` ×4, AdminOrdersPage:486 threshold-as-trend); finding-17 addendum (dev queue sim buttons, gate `import.meta.env.DEV &&`); **#28** Purge CDN Cache fake success toast (P1); **#29** ungated success toasts in AdminStoresPage (P2).

**Info:** reviewer judged honest-as-measured: zero counters/trend arrays on fresh stores (AOV → "Not enough orders yet"); spec-sanctioned defaults (hours/delivery params/console settings) accepted as WYSIWYG-adjacent. An unclaimed 2-line `useAdminAuthStore → useAdmin` swap inside AdminStoresPage noted (sibling-pattern, gates green, does NOT fix finding 12).

**Partner status: P0 5/5 done. Next: P1 (findings 6-20, 15), then P2 (21-27, 7) + #28/#29.**

---

## Iteration 17 — Partner P1 round complete (15/15 findings, 8 batches, all approved)

**Commits on `ui-sweep` (burgonomics-partner), ascending-risk order:**
- `48f0ec1` T1 / F7: integration chips bound to session evidence — Porter chip from successful dispatchQuotes (Reachable ✓ (this session) / Unknown — not checked), header chip drops "Live", MenuPage chip via useSyncHealth stub + manual-sync outcome, caption "POS link not verified" unless verified. Reviewer APPROVED 0 issues.
- `e420766` B6 / F14+15+16: header badge requires a real branch id (select-an-outlet chip when absent; cross-tenant default id that drove real sync writes gone), Settings resolves outlet from own branchIds (no branches[0]/raw id), chat offers + Open room buttons for OWN branches only (surrogate table deleted, threadLabel guards title-less docs). APPROVED 0 issues.
- `5762220` T2 / F6+10: Store Operating badge NO OUTLET on mount, prep-time slider wired to real updateBranchSettings write (Save/Unsaved/revert-on-failure), status toggle reverts on error; dashboard no-op poll deleted → 60s window tick, refresh awaits invalidateQueries (alert retired), Last Updated from dataUpdatedAt (refreshing…/—), Export CSV real RFC-4180 CSV from loaded summary. APPROVED 0 issues.
- `0c75882` T4 / F11: Security tab — fabricated sessions table + SQL snapshots card deleted (zero backend), banner "Local Console Controls — No Server Backend", local-flag copy (no 503 promise), 4 alerts → honest local-only warnings. File 391→103 lines. APPROVED 0 issues.
- `566ee79` B7 / F18+19: AI SEGMENT banner deleted (unsourced cohort claims, no segmentation backend); Save Campaign Draft = synchronous honest local save via marketingStorage (burg_mkt_push_logs, 50-cap), stale broadcast banner guarded, endpoint leak removed from dialog, comment scrubs. Reviewer REVISION_NEEDED (new key missing from sign-out wipe list → cross-user leak) → added to clearAppCaches (untracked other-lane file staged whole per policy) → APPROVED.
- `6d0c7d6` T3 / F8+9: ticket escalate/resolve now hit real POST /tickets/escalate + /tickets/resolveNote inside try/catch/finally (spinner + alert banner; snapshot claim conditional on returned id; refund/goodwill byte-identical); diagnostics drawer fail-closed behind developer/brand_owner (stack traces/Copy Payload hidden from branch+support), invented version → Unknown, Cloud Function/dev_error_snapshots jargon rewritten to server truth. APPROVED 0 issues (coder session was restart-aborted — work landed complete, orchestrator ran gates, reviewer verified).
- `6ab478e` B8 / F17+20: QueueMonitor.tsx deleted (proven unreachable ever — git grep at HEAD), useQueueMutations gone, useQueueStats loses 15s constant poll; AdminRoutes gains analytics→analytics-hub redirect + `*`→/admin catch-all (empty-pane dead); KpiSection AOV card navigateTo fixed (approved 1-line carve-out). P2-24's QueueMonitor sub-target DISCHARGED. APPROVED 0 issues.
- `312298f` T5 / F12+13 (HIGH): storeDirectoryAccess pure helper replaces dead RoleType comparisons (real roles; empty role fail-closes; no str_001/Developer fallbacks), branch_owner zero-store backstop, 5 early-returns toast (settings-save was silent), dev panel `import.meta.env.DEV && isDeveloper` (prod unchanged), Retry/Replay fake buttons deleted — **finding-17 addendum DISCHARGED**. INTENDED tightening: regional_manager = view+sync (was unrestricted). F13: SECURE DOWNLOAD + fake MD5-over-id deleted, COMPLIANCE RECORD — METADATA ONLY copy, expiry chip bound to real status. +4 tests (16 in file). APPROVED 0 issues (RBAC matrix + reachability audited).

**SME process:** 2 serial calls (findings 6-13 → S125; 14-20 → S126), collated into 8 disjoint-file batches; orchestrator carve-outs: B8 sole owner of useDashboardData/AdminRoutes/KpiSection-1line. Both halves zero BLOCKED-for-sibling.

**New findings queued during P1:** #30 (P2, dead accessToken fetch pattern in SystemQueueTab/Logs/FeatureFlags tabs), #31 (P2, fabricated admin emails/IPs in AdminDeveloperPage), finding-17 addendum (DISCHARGED by T5), P2-24 QueueMonitor sub-target (DISCHARGED by B8), P2-23 (shrunk by T2 alert removal + T4 — remaining RaiseTicketModal + security-tab sites… verify against audit when P2 batches), P2-25 addendum (PetpoojaDashboardPage trend={{value:0}} ×4, AdminOrdersPage:486 threshold-as-trend).

**Suite baseline moved:** 47/234 → 48/241 (B7 pushLogs +3, T5 storeDirectoryAccess +4).

**Partner status: P0 5/5, P1 15/15 done. Next: P2 (findings 21-27, 7) + #28/#29/#30/#31, then core queue (P1-12/13/14 + info notes), screenshot QA, APK.**

---

## Iteration 18 - 2026-10-16 sweep (core P1-12/13/14 + V1-a/V1-b, partner P2-H*, round-2 honesty)

Full live board: `audit-results/polish-2026-10-14/sprint-2026-10-16/SPRINT_STATUS.md`.

**Core (`burgonomics-foundation-core`), commits on `ui-sweep` (scoped, no push):**
- `0c48597` V1-a: payment-failure copy no longer promises a refund or asserts "no money charged"; both claims made conditional; tests pin the removals across all branches.
- `1cece8e` P1-13: raw Firebase/auth/offer/support error text mapped to safe copy via `userMessages.ts` (namespaced `auth/*` table + fail-closed string recovery with an authored-copy allow-list + anchored cooldown regex); 5 route/component surfaces + a login-screen integration test pinning both the toast and the inline banner.
- `096ad8d` P1-14: broad `*.error.message` UI surfaces mapped (curated-code allow-lists; closed 5 extra raw catch leaks) across cart / orders / profile / promo.
- P1-12 (menu prep-time `|| 15` fabrication) + V1-b (address-form discard-confirm) are FIXED but land in files carrying the user's pre-existing Oct-wave hunks → left uncommitted by policy (see board).
- Gates (frozen tree): tsc 0 / build 0 / vitest **640 passed | 55 skipped | 0 failed** (81 files; baseline 80/605).

**Partner (`burgonomics-partner`), commits on `ui-sweep` (scoped, no push):**
- `e6b0244` P2-C · `22fd090` P2-H3b · `9fcba59` P2-H2 · `f940cba` P2-D · `ed06c55` P2-H4 — admin shell clearance/touch targets, fabricated audit fixtures removed, honest Petpooja status/metrics/feed provenance, confirmed-snapshot rollback + gated save toasts, DEV-only simulated log stream + honest system standbys.
- Round 2: `c971c25` severity-aware menu feedback + honest POS-sync claims; `59ddb23` await clipboard writes before reporting success; `57b9b85` branch count matches its filter + log-console a11y + truthful labels.
- Gates: 63 files/404 → 65/419 → **66 files / 422 tests passed**; tsc 0, build 0.

**SME process:** deepseek-v4.1-flash tiers were unfunded this window ("Insufficient account funds" / "Go requires a credential") → coder/reviewer lanes ran on gpt-6.1-sol; agy/Opus quota exhausted until ~20:00 local. Multiple environment restarts killed shells/subagents; all gates re-run on a frozen tree, long gates launched detached with a DONE marker.

**Round-2 follow-ups (documented on the board):** core authStore structured-code preservation (Med), profile.addresses device-local honesty (Med), PaymentRepository preflight raw-text passthrough (Low), C1/C5 mixed-file per-hunk staging; info: dormant GlobalAlerts, mapProductDoc honesty test.

**Owner-pending:** Petpooja credential rotation + sandbox `save_order` blocker/email (`.opencode/BLOCKED.md`), git-convention registration, `antigravity_bridge.py` CLI-arg patch.

---

## Iteration 19 - 2026-10-16 wave 1 (deep two-app re-audit + 5 reviewed fix commits)

Full live board: `audit-results/polish-2026-10-14/sprint-2026-10-16/SPRINT_STATUS.md`.

Trigger: "Use all agents to improve the codebase, review everything and use subagents, deepseek v4.1 flash free." Every lane in this wave ran on **`opencode/deepseek-v4.1-flash-free`** (the correct id; the earlier paid/gated deepseek mis-route is closed).

**Audits (4 read-only lanes)**: ~8 High / ~26 Med / ~24 Low across both apps - artifacts `audit-core-routes.md`, `audit-core-features.md`, `audit-partner-admin.md`, `audit-partner-app.md`. Highest-value classes: fabricated derived data (order ETA, dietary labels, health/diagnostics, KYC/settlement, reconciliation), false success claims (4 add-to-cart toasts, unconditional kitchen-POS sentence), cross-account data leak (favorites under one global key), and one real contrast bug (FAQ `text-white` on a white surface).

**Fix lanes (5 coders + 5 independent reviewers, all APPROVED)**, each with a bite-proof (same tests red against pre-fix source) and `tsc --noEmit` 0:
- Core `b8bace7` real store ETAs retained + kitchen-POS sentence gated on actual `petpoojaStatus` + offers read failure no longer `ok([])`.
- Core `708717b` favorites uid-scoped + cleared on auth change, honest guest copy, all four dietary surfaces branch on the real veg flag.
- Core `9a5dfb7` readable FAQ text on tokens, honest product-page cart toast, order refresh clears its prior error.
- Partner `9429dc8` case-insensitive cancelled/refunded revenue exclusion, real discrepancy read (unavailable, never "balanced"), canonical reconciliation roles.
- Partner `ecaa45e` royalty badges from real linkage, role-gated honest diagnostics modal, analytics error panel with retry.

**Gates (frozen tree, detached):** core tsc 0 / build 0 / vitest **88 files, 696 passed | 55 skipped | 0 failed**; partner tsc 0 / build 0 / vitest **69 files, 464 passed**.

**Held back by the no-foreign-hunks rule** (fixed + gated, uncommitted, owner shares the file with in-flight Oct-wave work): core `ordersService.ts` (ETA derivation), `menu.index.tsx`, `search.tsx`, `tests/order-eta-honesty.test.ts`, `src/routes/core-routes.polish.test.tsx`; partner `AdminRefundsPage.tsx` + `tests/admin-financial-evidence.test.tsx`. Commit-integrity was checked first: every committed test resolves only to committed sources.

**Wave-1 backlog (next pass):** core CR-M3 checkout stale totals + CR-M5 raw gateway text (both in MIXED files), core medium/low set (dead `SORTS`/`setSort`, unlabeled search input, colour-only tabs, 40px refresh target, undefined `neutral-850` token); partner admin mediums (`Utilities.tsx` dialog semantics, duplicate-payment classification, reconciliation page coherence), partner app mediums (heatmap fabrication, inert audio tester, hardcoded franchise capital, fail-open regional scope, KOT print claims, margin badge) and lows (`|| 7` km, `|| 'Surat Adajan'`).

---

## Iteration 20 - 2026-10-17 wave 2 (the remaining Medium/Low backlog, both repos)

Full live board: `audit-results/polish-2026-10-14/sprint-2026-10-16/SPRINT_STATUS.md`. Every lane again on **`opencode/deepseek-v4.1-flash-free`**.

**Wave 1 hold-backs resolved first (owner decision: split).** The 4 mixed files were committed as an "owner WIP" commit plus the wave-1 fix on top: core `5d7db8b` + `eb9b792` (ETA derivation, honest menu/search cart toasts, 2 held tests), partner `5bccbc5` + `7c73674` (refund failure shows the recorded gateway status, not an invented diagnosis). The split used per-hunk reverse-apply with byte-identical restore, so the gated tree was never altered.

**Wave 2 (8 coder lanes + 4 reviewers + 3 fix lanes).** Core: honest support-surface load/error/retry states, dead `SORTS` removed, accessible search label + real tab state + 44px refresh target, existing hover token, legible FAQ legend/stars; checkout and payment stop paying/reading against a bill they could not compute and stop showing a fabricated `INR 0.00` (raw gateway text now mapped through the curated mapper); invoice/gST claim, payment mode, store address, address state/contact/phone and store capabilities no longer fabricated (unknown store capability = deny-by-default, per owner); modifier options/loyalty switch/carousel/tip targets/best-seller quantity made keyboard- and touch-correct. Partner: missing status is "Unknown", duplicate evidence-gated, undated orders excluded from intervals, store filters from the real directory, awaited clipboard writes, offer drafts not "Active", no claimed CRM, reconciled search/loading/empty/error, exact capture-reason mapping, awaited health refresh, `Promise.allSettled` per-store status; the shared confirmation now awaits `onConfirm` and closes only on success, tables got `aria-sort`/accessible names/page clamping; the peak-hour heatmap no longer invents a peak/SLA/staffing plan, franchise capital shows recorded bands, regional-manager scope fails closed, the margin verdict requires margin data, branch/geography values are no longer invented, the audio tester no longer claims a tone/FCM push it did not send, KOT preview no longer claims Petpooja printed, and settings/order toggles/replies surface real failures.

**Gates (frozen tree, detached):** core tsc 0 / build 0 / vitest **96 files, 731 passed | 55 skipped | 0 failed**; partner tsc 0 / build 0 / vitest **78 files, 518 passed**.

**Commits:** core `854371e` (owner WIP for the 3 mixed files) -> `7003231` (routes/payments) -> `06b8b60` (features/a11y); partner `42ccd07` (admin) -> `3a5438a` (app). Local `ui-sweep` only, no pushes, no foreign hunks staged.

**Left open (documented, not defects we introduced):** the reviewer nits listed in `SPRINT_STATUS.md` - notably `useBranches.ts` still persists `|| 7` km / `|| 5.0` % on create, `AdminOffersPage` rows still say "Active", the M10 async-confirm contract is not repo-wide, and a few lint/contrast nits.

**Owner-pending (unchanged):** Petpooja credential rotation + sandbox `save_order` (`.opencode/BLOCKED.md`), git-convention registration, `antigravity_bridge.py` CLI-arg patch, agy/Opus quota.

