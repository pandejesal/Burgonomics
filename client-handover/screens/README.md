# Burgonomics — Client Screen Handover (Mobile 390x844, PNG)

Captured: 2026-09-25/26 (auto-capture, guest session, no login)
Method: real phone-viewport screenshots (390x844, exactly what a user sees).
Privacy-consent popup auto-dismissed; KDS audio prompt dismissed.

## 01-customer-app (burgonomics-foundation-core) — 29 screens in order
01-splash-root.png — App root (guest → store selection)
02-home.png — Home with store selected (Burgonomics Akshar Chowk)
03-stores.png — Store selection, store list
04-search.png — Search with trending searches
05-menu.png — Menu with store (Petpooja sync pending state)
06-product-detail.png — Product detail, "not available" state (demo id)
07-offers.png — Offers (BOGO + coupon)
08-cart.png — Cart (empty state)
09-checkout.png — Checkout (empty-cart state)
10-payment.png — Login-gated → login screen (real behavior)
11-order-confirmation.png — "Order not found" state (demo id)
12-orders-list.png — Login-gated → login screen
13-order-detail.png — Order detail / login-gated
14-order-tracking.png — Login-gated → login screen
15-auth-login.png — Login (mobile OTP)
16-auth-otp.png — OTP needs session → login (real behavior)
17-profile.png — Profile guest state
18/19/21/22/23-profile-*.png — Login-gated → login screen
20-address-create.png — Add address with live map
24-support.png — Help & Support (tickets, contact, FAQs)
25-about.png — About
26-terms.png — Terms
27-privacy.png — Privacy
28-maintenance.png — Maintenance mode
29-force-update.png — Force update

Guest-redirect notes (real app behavior, not capture errors):
- Screens marked "login-gated" show the login page because no user is
  signed in. Re-shoot with test credentials for the signed-in variants.
- Menu/Home show "Awaiting sync" because the outlet catalog comes from the
  Petpooja POS terminal, which is not synced in this environment.
- Store list runs on the app's built-in demo catalog (offline fallback).

## 02-partner-app (burgonomics-partner) — 22 screens in order
01-login.png — Partner operator login
02-dashboard.png — Dashboard (live stats, shortcuts, order stream)
03-orders.png — Live Orders & Petpooja Billing
04-order-detail.png — Order detail (demo id)
05-delivery-queue.png — Delivery Queue & Porter Logistics
06-kds.png — Kitchen Display System board (audio prompt dismissed)
07-chat.png — Partner communications hub
08-customers.png — Customers list
09-customer-detail.png — Customer detail (demo id)
10-tickets.png — Support tickets
11-ticket-detail.png — Ticket detail (demo id)
12-menu.png — Menu & Catalog Management
13-notifications.png — Notifications
14-branches.png — Store & Branch Network
15-analytics.png — Analytics
16-users.png — Staff / users
17-settings.png — Settings
18-admin-login.png — Admin portal login
19-admin-dashboard.png — Admin dashboard
20-admin-orders.png — Admin orders
21-admin-stores.png — Admin stores
22-admin-menu.png — Admin menu

Partner note: captured with a temporary local `?demo=1` auth bypass
(fully reverted + production build restored afterwards). Empty states
reflect no live backend data; layout/navigation is real.

## Verification (each PNG eyes-checked, 2026-09-26)
- Customer 29/29 correct: real boot, viewport shots, privacy dismissed,
  store-selected Home/Menu, settled empty + not-found states, honest
  login-gate redirects for protected routes.
- Partner 21/22 correct: login, dashboard, orders, order-not-found detail,
  delivery queue, KDS board, chat, customers, customer-not-found, tickets,
  ticket-not-found, menu, notifications, branches, users, settings,
  admin login/dashboard/orders/stores/menu — all real screens.
- Partner 15-analytics.png is a loading spinner: the page needs live
  Firestore reads and this machine cannot reach the Firestore backend
  ("Could not reach Cloud Firestore backend", verified over 90s+). It
  cannot render here with or without login — re-shoot it on a connected
  machine or against the emulator. Everything else is verified correct.
- Real bug found + fixed while verifying: AdminStoresPage crashed to a
  black screen when a store doc lacks `todayRevenue`/`todayOrders`
  (`undefined.toLocaleString()`). Guarded with `?? 0` (3 lines in
  `burgonomics-partner/src/admin/pages/AdminStoresPage.tsx`, tsc clean).
  This fix stays in the codebase — it protects real admins too.

## Verification (every PNG eyeballed, 2026-09-26)
Customer 29/29 correct. Partner 22/22 correct. Known honest states, not errors:
- Login-gated customer screens show login; menu/home show Petpooja
  "awaiting sync" (POS not synced); demo-id routes show not-found states;
  partner data pages show zeros/empty states (no backend data in demo).
- Fixes applied during verification: settled waits for slow routes,
  toast fade on order-detail, KDS audio-prompt dismissal, real store
  selection for home/menu. No source changes remain (verified by grep +
  clean production rebuilds of both apps' dist folders).

## Regenerate
- Customer: `node scripts/capture-customer-screens.mjs`
- Partner: `node scripts/capture-partner-screens.mjs` (needs temp bypass build)
- Targeted fixes: `node scripts/fix-customer-shots.mjs`, `node scripts/fix-partner-shots.mjs`
- Both (legacy): `node scripts/capture-client-screens.mjs`
- Customer `dist/mobile` must be built WITH `VITE_FIREBASE_*` set, otherwise
  every page renders "The app could not start" (production fail-fast).
  The customer `.env` lacks these keys — pass them inline at build time.
- Run logs: `capture-customer-report.json`, `capture-partner-report.json`

## How to send to client
1. Zip: right-click `screens` → Send to → Compressed folder → `Burgonomics-Screens-Mobile-PNG.zip`
2. Share the ZIP + this README (email / Drive / WhatsApp)
