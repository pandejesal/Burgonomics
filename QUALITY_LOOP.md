# Quality Loop — 10 × 3 parallel find-and-fix sweeps

> Each loop: 3 parallel finder lanes (functions / partner / core) return top
> findings with file:line + evidence → architect verifies → fixes → gates.
> Status: `pending` | `running` | `done`. Lanes are READ-ONLY; fixes by architect.

- [ ] Loop 1: Swallowed errors & silent failures (unhandled rejections, missing toasts, empty catches)
- [ ] Loop 2: Firestore rules vs actual queries (denied reads/writes, missing indexes, offline behavior) [RUNNING → done below]

### Loop 2 — rules vs queries (done)
- Fixed: KDS topic orphan (`branch_<id>` → `branch_<id>_orders`); Android channel creation in customer app; useMenu re-read from dead collection; deleted dead legacy orderService; cancelOrder persists to Firestore; webhook rest_id reverse-lookup (skip-loudly when unlinked); store-id default branchIds removed; combos stamped restId+petpoojaItemId; branch guards on menu mutations; seed CRM dev-gated; sessions listener error UI; 4 new composite indexes (routeTransfer, petpooja retry, coin_transactions, notifications); `petpoojaStoreId` added to branch-update guard; customer self-cancel rule (pre-terminal, status-only); delivery gateway log writes removed (rules-denied noise) + server-side sync audit trail; tracking onError forwarding.
- Dismissed with reason: S5 fcmTokens (allowed by exclusion — not in deny list); C3 restId composite (single-field where needs none); C4 userId query (works; customerId index kept for partner); P1 simulate fallback (explicit dev action, button gated); P3 denial unreachable (activate UI dead + rule now covers field).
- Queued (needs product call): admin orders migration, device_tokens ownership, orders-create field mask.
- Gates: functions 121 · partner 130 · core 205+18 skipped — all green.
- [ ] Loop 3: Money paths re-verify (totals, caps, rounding, refunds, loyalty) [RUNNING → done below]

### Loop 3 — money paths (done)
- Critical: live online payments were unbuildable (client sent no items/branch/loyalty → server 500). Client now sends items + storeId + coupon + loyalty + idempotency key; server resolves branch via stores.partnerBranchId, reuses open gateway orders on retry (no double charge), rejects zero totals.
- Critical: loyalty display 50% vs server 20% (user overpaid + lost points). All client caps + copy + tests now 20%.
- Guards: coupon percent clamped (0,100]; no-repeat transfer on re-verify; order.paid entity shape handled (+ no undefined writes).
- Deferred (bigger): usage-count coupons, Route onboarding checks, admin refund/loyalty server transactions, analytics estimate labels.
- Gates: functions 125 · core 205+18 skipped · builds green; root + core pushed.
- [ ] Loop 4: Notification pipeline end-to-end (topics, channels, tokens, triggers) [RUNNING → done below]

### Loop 4 — notifications (done)
- Fixed: customer PLACED confirm on order create (was kitchen-only); urgent-born tickets alert (new trigger); subscribe route allowlisted + ownership-checked; FCM sound "new_order" (was 404 name); partner subscribes _tickets topics + fresh user on refresh; foreground ticket View action; refresh-login token linking; logout drops token from user fan-out (explicit uid).
- Dismissed: server-side fcmTokens writer (client covers), token-refresh listener (Capacitor re-fires registration), inbox poll fallback (feature, not fix).
- Gates: functions 125 · partner 130 · core tsc clean.
- [ ] Loop 5: Menu pipeline (sync, 86-ing both directions, images, categories) [RUNNING → done below]

### Loop 5 — menu pipeline (done)
- Fixed: branch-scoped product doc IDs (second synced branch no longer steals the first's docs); stock webhook attributes branchId/restId (orphans staged, never merged); stock-push ack accepts all Petpooja forms; retry worker dead-letters exhausted orders; re-enable clears stale 86 metadata; POS pushes skipped (loudly) without petpoojaItemId; combos warn when restId missing; unscoped menu reads return [] instead of cross-store leak; "Other" label; category toggle index.
- Dismissed: categories persistence (derived by design), isVeg default (pure-veg brand), image SAMPLE fallback (exact-match only), home mock rails + trending (separate feature), KDS 86 badges (feature).
- Gates: functions 125 · partner 130 · core 205+18 skipped · all builds green.
- [ ] Loop 6: Auth/session/RBAC (claims, guards, login flows, OTP) [RUNNING → done below]

### Loop 6 — auth/session/RBAC (done)
- Fixed CRITICAL: partner hardcoded PIN roster (1234/5678/9999=owner) deleted — roster empty, PINs fail closed; demo hints + operator-email directory removed from login; lock screen gains sign-out escape.
- Fixed: partner unknown-role fail-open to developer → fail-closed deny; route policy enforced in ProtectedRoute (default-deny, single source routePolicy.ts); branch_staff locked out of picker + all hooks clamp to assigned branches (branchScope.ts); scoped-no-branch reads return empty; customers scoped for staff; single auth listener + force-refresh on bootstrap.
- Fixed: server guest-migration now requires anonymous source proof; welcome bonus atomic via deterministic create() + E.164; delivery OTP route staff-only + branch-scoped; porter/dispatch services enforce order.branchId ∈ caller branches; claims sync admins/ registry (demotion deletes); onUserDeleted wired (v1 trigger) with PII strip.
- Fixed: customer order IDOR (ownership check); bootstrap requires live Firebase uid match; httpClient auth interceptors implemented + wired; OTP resend store-throttled; QuickAuthSheet uses canonical validators, 6-digit gate, no code autofill.
- Dismissed: optionalAuth no-revocation (documented guest exception), categories persistence n/a, admin-portal separate session (queued).
- Gates: functions 131 · partner 138 · core 207+18 skipped · all builds green. Committed locally; pushes blocked on 403 (credential rotation pending user).
- [ ] Loop 7: Performance (N+1 queries, bundle weight, re-renders, pagination) [RUNNING → done below]

### Loop 7 — performance (done)
- Fixed functions: Razorpay webhook idempotency claim-before-work (closes double-KOT on retry, stale-claim takeover); ticket reminder batch+allSettled; KOT retry worker chunked(4) + single-scan dead-letter; route-transfer branch prefetch + chunked attempts; pricing branch+coupon reads concurrent.
- Fixed partner: useOrders limit(100) + server-side dateRange (was accepted-then-ignored); dashboard 3-fetch Promise.all; CustomerDetailPage drops full-collection useOrders for scoped customer.orders; chat threads/messages bounded (30/50, order preserved); tickets dual-fetch concurrent + Set dedup.
- Fixed core: menu restId cache + 30s products cache (one scan per open, invalidated by live listener); live listener merges buckets (no pagination clobber); order history one-fetch-per-session cache; menu pager windowed to active±1; tab bar motion→CSS (shell chunk); home rails lazy+async images, first banner eager.
- Dismissed: aggregate-query counts (needs schema alignment, follow-up); chat "load older" pagination (follow-up); React.lazy sheet splits + manualChunks (follow-up); per-card motion springs (visual, follow-up).
- Gates: functions 131 · partner 138 · core 207+18 skipped · all builds green. Committed locally; pushes still blocked on 403.
- [ ] Loop 8: UX dead-ends (dead buttons, empty states, broken routes/links) [RUNNING → done below]

### Loop 8 — UX dead-ends (done)
- Fixed functions: unmatched captured payments parked in unmatched_payments (was acked-ok + dropped); resolveTicket refund throws loudly when no payment exists (was resolved+success with no money moved); KOT dead-letter sets kotSyncFailed + branch FCM (kitchen still sees order via Firestore); RIDER_CANCELLED flips canonical status + needsRebook + branch alert (customer push via status trigger); porter quotes flag isEstimate when GPS defaulted.
- Fixed partner: Grill Coins now server-side (POST /customers/adjustCoins, branch-scoped, ledger row) — both pages call the mutation, fake local toasts gone; OrdersPage print opens real KOT preview, Porter row books a real rider; /delivery → /delivery-queue; test print renders a real slip to the print dialog; partial refunds strictly validated (digits, 1..100000, inline error, disabled execute).
- Fixed core: paid-but-no-order panel no longer lies about "no money charged" and hides Retry — shows payment id + support CTA deep-linking a prefilled PAYMENT_ISSUE ticket; invoice tile wired to working GST generator; share builds a real track URL with clipboard fallback; search empty state gains Clear action; ratings persist on-device with honest copy.
- Dismissed: per-card motion springs (visual), chat load-older pagination (follow-up), aggregate-count billing (follow-up).
- Gates: functions 136 · partner 138 · core 207+18 skipped · all builds green. Committed locally; pushes still blocked on 403.
- [ ] Loop 9: Test quality (mock-assertions, skipped tests, untested critical paths) [RUNNING → done below]

### Loop 9 — test quality (done)
- Fixed functions: webhook replay test drives the REAL handler (replay→already_processed, stale-claim takeover, orphan parking); tickets.service.test rewritten to real resolveTicket (refund executes, refusals throw, no silent resolve); forged-signature test with mock mode off; escalator test imports the real tier clocks (also fixed: numeric/ISO clocks now escalate) + real topic router; FCM test pins real on-device channels (killed divergent kot_alarm fiction); coins moved into a tx + truly-concurrent bonus test.
- Fixed partner: auth-rbac/login tests import the REAL routePolicy/branchScope (deleted local clones + test-to-test import); new fail-closed suite pins resolveUserProfile deny (customer/typo/missing); thermal test uses the real formatter; PIN test imports real helpers; refund guard extracted to tested util; API gateway test proves endpoint/body/error mapping.
- Fixed core: bootstrap trust gate tested via injected probe (found+fixed: dynamic firebase imports bypass mock interception — static import now); resend-open + ownership helper + trackUrl util tested; payments fictions rewritten to real pricer/HMAC/cancelOrder; FailurePanel logic extracted + branched tests; rules suite wired to CI (fail-hard on skip) + local emulator run: 18/18 PASS.
- Dismissed: component-render tests (no DOM harness in repo — pure helpers extracted instead); aggregate-count billing (prior follow-up).
- Gates: functions 143 · partner 145 · core 218+18 skipped (rules 18/18 green under emulator) · all builds green. Committed locally; pushes still blocked on 403.
- [ ] Loop 10: Docs/config drift (env examples vs code, runbook accuracy, stale .md) [RUNNING → done below]
- [ ] Loop 11: Firestore indexes vs queries (missing composites, unused indexes) [RUNNING → done below]

### Loop 11 — indexes vs queries (done)
- Fixed: admin portal live/history (collectionGroup orders) had ZERO matching composites — added 4 COLLECTION_GROUP indexes (store.id/orderStatus/placedAt × asc/desc).
- Removed dead weight: support_tickets(status,branchReminderSent,createdAt) + orders(petpoojaStatus,petpoojaRetryCount) composites (no producers anywhere); deleted orphan core firestore.indexes.json (unreferenced, divergent).
- Kept (verified producers): tickets ×2, products(branchId,categoryId), orders branchId+createdAt ×2, support_tickets ×3, routeTransfer, coin, notifications, customerId, dev_error.
- Dismissed: userId-vs-customerId and restId-vs-branchId standardizations (no failing query today; renames are migrations, not fixes).
- Gates: rules 18/18 green. Committed locally; pushes still blocked on 403.
- [ ] Loop 12: Logging/observability hygiene (PII leaks, noise, snapshot gaps) [RUNNING → done below]

### Loop 12 — logging/observability (done)
- Fixed functions: PII boundary at captureErrorSnapshot (customer/payment ids masked, forbidden context keys dropped, pay_ ids scrubbed from messages, alerts use masked copy); idempotency-lookup failures + branch/coupon pricing fallbacks snapshot LOUD with pricingDegraded flag; KOT/customer/urgent dispatch failures snapshotted; raw UIDs removed from cleanup/prune/claims logs.
- Fixed partner: QueueMonitor/SystemQueueTab alert()→toast+status (incl. non-OK HTTP); FCM token material out of logs; porter quote errors redacted; useOrder + admin live-stream failures staff-visible; KDS resume documents autoplay policy.
- Fixed core: Firebase errors log codes not phones; profile/device-link floats caught via logger; getOrder denials logged; watchPosition sampled 1/min + UI state; payment/root/tracking floats caught.
- Dismissed: wholesale logger migration of older console.* (low-noise paths; new code uses logger).
- Gates: functions 143 · partner 145 · core 218+18 skipped · all builds green. Committed locally; pushes still blocked on 403.
- [ ] Loop 13: Accessibility (labels, roles, touch targets) [RUNNING → done below]

### Loop 13 — accessibility (done)
- Fixed functions: generic fallback push copy (no raw status jargon on lock screens); ticket subjects out of push bodies (PII paste risk, branch-first ≤80 chars); INVALID_AMOUNT speaks human + 400; porter errors actionable without ids; confirm-failure snapshot carries branch/customer/next-action.
- Fixed partner: KDS checklist rows are real checkbox buttons; cancel modal has dialog semantics + ESC + focus + X label (also fixed its fail-open RBAC: nonexistent roles + missing role no longer pass); order-row actions labeled + 44px; login labels associated + toggle announces state.
- Fixed core: sheet close labeled + 44px; phone/OTP/notes labels associated; checkout errors assertive live regions; dish alt text; ADD/Redeem/stepper at 44px with group + live qty.
- Dismissed: full screen-reader pass with devices (needs hardware + users).
- Gates: functions 143 · partner 145 · core 218+18 skipped · all builds green. Committed locally; pushes still blocked on 403.
- [ ] Loop 14: Offline/empty/error resilience [RUNNING → done below]

### Loop 14 — resilience (done)
- Fixed functions: catalog-total-outage fail-closed 503; idempotency-lookup failure fail-closed 503 (same-key retry reuses); verifyPayment ghost-order 404 + tx-claimed transfers with stale takeover + busy-poll reuse; KOT + route workers claim-leased (shared `transferring` flag); porter poll dead-letters to needs_review + branch alert after 12 fails/2h.
- Fixed partner: walk-in orders keep the form on write failure (no fake success); KDS bumps record recall only on success + buttons lock in flight; orders/menu streams surface error panels with Retry; KDS polls every 15s with refresh button + age stamp.
- Fixed core: checkout PAY gated offline (button + handler); cart syncPending flag + banner; menu live failures keep cached data flagged stale with Retry; category empties navigate onward; MenuItemCard/BestsellerCarousel use SafeImage.
- Dismissed: full offline queue-and-replay (needs backend outbox; cart persists locally).
- Gates: functions 143 · partner 145 · core 218+18 skipped · all builds green. Committed locally; pushes still blocked on 403.
- [ ] Loop 15: Type safety in money/auth paths [RUNNING → done below]

### Loop 15 — type safety (done)
- Fixed functions: order items zod-validated (finite price, qty 1–99) + engine-level rejection; payment-intent reuse requires sane numeric totals; transfer amounts integer-narrowed (string paise can no longer POST); OTP attempts integer-coerced + hash string-checked.
- Fixed partner: ticket docs normalized at read (tier union, timeline array); auth role unwrapping unified + claim arrays narrowed (string branchIds wrapped); coin modal capped 1–5000 client-side; counter phones normalized (no '+91 ' placeholder); status round-trip pinned by contract test.
- Fixed core: cart migrate scrubs tampered lines; paymentsService rejects NaN; bootstrap shape-guards persisted user; loyalty balance finite-clamped; geofence rejects NaN coords; mockJwt requires numeric sub/iat/exp.
- Dismissed: wholesale tx-callback retyping (claim logic already race-safe; types follow).
- Gates: functions 144 · partner 151 · core 221+18 skipped · all builds green. Committed locally; pushes still blocked on 403.
- [ ] Loop 16: Secrets/transport safety (keys, http, webviews) [RUNNING → done below]

### Loop 16 — secrets/transport (done)
- Fixed functions: Porter webhook fail-closed on missing signature; CORS localhost gated to non-prod, netlify wildcard removed; Petpooja body credentials narrowed to app_key (access_token no longer accepted inbound).
- Fixed partner: print-window XSS escaped + noopener; campaign deep-link/image allowlists with inline errors; tracking/tel links validated; WebView debugging pinned off.
- Fixed core: deep-link scheme+path allowlist; push deeplinks sanitized (no location.href fallback), orderId charset-checked; manifest documents in-app enforcement; embedded Razorpay test key removed (explicit simulation); httpClient refuses cleartext bases.
- Dismissed: mock-by-default + committed mock fallbacks (prod boot now refuses all three — Loop 10 guard); Petpooja HMAC-only (their protocol echoes app_key; header-first kept); admin-portal session fallbacks (separate session, queued).
- Gates: functions 144 · partner 151 · core 221+18 skipped · all builds green. Committed locally; pushes still blocked on 403.
- [ ] Loop 17: Notification copy/topics consistency [RUNNING → done below]

### Loop 17 — notifications (done)
- Fixed functions: ticket triggers repointed to support_tickets (dead pushes now fire); branch fan-out uses subscribable _tickets topics; invented tickets_alerts channel replaced; role-gated regional/superadmin/escalated subscriptions; webhook KOT dupe removed; payment-failed/refund/ticket-resolved customer pushes added.
- Fixed partner: launch modal copy honest (no fake FCM claim); push init split (listeners once, reconcile every user change); stale topics unsubscribed (new endpoint); permission actually prompted; foreground/tray navigation typed (no full-reload to wrong pages).
- Fixed core: web onMessage singleton (no double toast/push); inbox dedupe by id + 50-cap.
- Dismissed: netlify topic-only fan-out (legacy, undeployed); badge plugin (not installed); token-cache clearing on logout (re-link lifecycle already correct).
- Gates: functions 144 · partner 151 · core 221+18 skipped · all builds green. Committed locally; pushes still blocked on 403.
- [ ] Loop 18: Dead code elimination (verified-unreferenced only) [RUNNING → done below]

### Loop 18 — dead code (done)
- Deleted functions: authenticateRequest (superseded), onDocumentCreated import, auth.service.ts barrel-orphan, webhookListener.ts (dead file + divergent normalize) with barrel line.
- Deleted partner: formatters.ts, lib/utils.ts cn(), utils/api.ts, useDashboardStats hook, AdminPetpoojaPage (all zero refs in src+tests).
- Deleted core: useGsapReveal, useFeedback, use-mobile, deviceInfo, error-capture (all zero refs).
- Held (needs product/design call, NOT deleted): reminderCron/escalationScheduler duality, verifyPetpoojaSignature, useFirestore toolkit, DeliveryOtpModal/AddFutureStoreModal, shadowed ProductCard/OfferCard/dateUtils, gsap dep (lockfile regen needed).
- Gates: functions 144 · partner 151 · core 221+18 skipped · all builds green. Committed locally; pushes still blocked on 403.
- [ ] Loop 19: Capacitor/native parity [RUNNING → done below]

### Loop 19 — native parity (done)
- Fixed functions: POST /notifications/registerToken (server-owned push identity); multicast chunked at 500; unsubscribe + registerToken under App Check; GET /config/app version floor (permissive until ops seeds minimums).
- Fixed partner: Android back-button → router-back/minimize; native splash+statusbar driven at runtime (auto-hide off); deviceInfo uses canonical Capacitor API; camera/photo plist strings removed (no code); package 1.0.0 synced with native builds; iOS background modes for KDS alerts.
- Fixed core: WKAppBoundDomains cover Razorpay/Google/Firebase (was blocking pay+captcha); dead CAMERA perm + camera/photo strings removed; HTTPS App Links filter added (assetlinks/applinks already published); debug WebView pinned off; splash manual-hide.
- Dismissed: SW compat pin (10.8.0 background channel stable; modular rewrite untestable here); Petpooja HMAC-only (their protocol); token-cache clearing (re-link lifecycle correct).
- Gates: functions 144 · partner 151 · core 221+18 skipped · all builds green. Committed locally; pushes still blocked on 403.
- [ ] Loop 20: Final verification + release summary [RUNNING → done below]

### Loop 20 — final verification (done)
- Full matrix green on 2026-09-06: functions build + 144 tests; partner typecheck + 151 tests + build; core tsc + 221 tests (+18 skipped) + build; Firestore rules 18/18 under local emulator.
- No stray work left behind: every loop file verified committed in its repo (scoped commits only; other streams' dirty files untouched).
- Release state: 20/20 loops complete. All commits LOCAL — pushes to origin blocked on 403 (stored credential rejected on all 3 repos). Unpushed: root master +N, partner feat/partner-device-smoke +N, core main +N.
- Known follow-ups (product calls, not defects): per-item vs flat packing preview, server whole-₹ rounding display, chat load-older pagination, aggregate-count billing, reminderCron/escalationScheduler duality, shadowed shared cards, gsap dep removal (needs lockfile regen), Play Integrity/App Attest enrollment + APP_CHECK_ENFORCEMENT flip, app_config/native minimums seeding, full screen-reader device pass.

### Loop 10 — docs/config drift (done)
- Fixed rules fork (CRITICAL): 3 divergent copies → root canonical + byte-identical mirrors; consolidation EXPOSED a real regression (root messages rule let any staffer read any branch's chats) — fixed to participant/brand gating, proven 18/18 under emulator.
- Fixed runbook: dotenv (not functions:config) mechanism, OTP_HMAC_SECRET row, jq field assertion; assertProductionKeys now refuses mock Porter/Petpooja in prod too.
- Fixed functions README: real route table (23 routes), dotenv flow, burgonomics-7faa8.
- Fixed partner: fake pg_dump/S3 backup relabeled demo (seeds zeroed), maintenance PIN has no default (refuses unset), .env.example split client/server + documents FUNCTIONS_API_URL, README routes/endpoints/commands corrected.
- Fixed core: .env.example regenerated from env.ts (split Firebase vars, VITE_PUSH_* canonical, all readers covered); cart fallback aligned to engine schedule (499/₹40, discount-aware GST); pricing authority documented; mock-transport headers rewritten; addresses subcollection corrected.
- Dismissed: per-item vs flat packing + server whole-₹ rounding (server authoritative at charge; previews converge — product call to unify further).
- Gates: functions 143 · partner 145 · core 218+18 rules green · all builds green. Committed locally; pushes still blocked on 403.

## Log

### Loop 1 — swallowed errors & silent failures (done)
- functions lane (5): F1 dead client class with fake-success fallback → DELETED class, kept API types. F2 catalog-fallback silence → error snapshot added, fallback kept deliberately (availability). F3 /porter/quote unvalidated → porterQuoteSchema + wired. F4 webhook unknown-order silence → loud warns. F5 scheduler batch abort → per-order catch + failedCount.
- partner lane (5): P1 simulate catch → downgraded (explicit dev action) + simulate BUTTON dev-gated. P2 seed CRM → dev-gated. P3 → stale, already gated. P4 → onError toasts on all 4 order mutations. P5 → catch added.
- core lane (5): C1 ok(null) logging → kept (fire-and-forget background sync, already logged). C2 paid-but-no-order celebration → gated on created.success with support copy. C3 → toast added. C4 → catch ends skeleton. C5 → import errors forwarded to onError.
- Gates: functions 121 · partner 130 · core targeted 15 — all green.
