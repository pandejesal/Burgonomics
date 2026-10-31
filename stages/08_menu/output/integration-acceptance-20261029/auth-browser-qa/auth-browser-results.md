# Auth browser QA — Delivery + Partner (TEST MODE, emulators only)

Status: **PARTNER AUTH VERIFIED under emulator; DELIVERY AUTH NOT VERIFIED (blank app root).**
Mode label: TEST-MODE VERIFIED (Partner only). Not live, not production, no real SMS/Firebase/vendor.

Project: `demo-burgonomics-auth-qa` (loopback only). Auth `127.0.0.1:48692`, Firestore `127.0.0.1:48691`.
Delivery QA server `127.0.0.1:48178`, Partner `127.0.0.1:48179`. No app source file was edited.

## Commands
```
cd C:\Users\DELL\Desktop\Burgonomics\stages\08_menu\output\integration-acceptance-20261029\auth-browser-qa
node run-auth-browser.mjs                     # r1: 9 PASS / 1 FAIL
$env:DELIVERY_ONLY="1"; node run-auth-browser.mjs   # r2: 5 PASS / 1 FAIL (delivery diagnostics only)
```
- `run-output-r1.json` — 9 PASS / 1 FAIL, 0 external requests, finished 10:57:52Z (reconstructed copy; full step list preserved).
- `run-output-r2.json` — Delivery-only rerun with console/pageerror capture.
- `run-output.json` — last run (r2).
- `emulator-tail.log` — only written on fatal before the app is served (stale from an early failed start).

## Partner — PASS (real UI, real Firebase SDK, emulator backend)
- `partner: wrong-password-blocked` — generic `Invalid email or password, or your account lacks operator access.`, still on `/login`.
- `partner: valid-operator-allowed` — synthetic `qa.admin@example.test` (admins doc `branch_owner`) reached `http://127.0.0.1:48179/dashboard`.
- `partner: unknown-role-locked` — admins doc role `superadmin` denied on `resolveUserProfile`, signed out, generic error (log: `[auth] Denying login: unrecognized operator role "superadmin"`).
- `partner: login screen renders` — `http://127.0.0.1:48179/login`.

These exercise the real `src/stores/authStore.ts` path (`signInWithEmailAndPassword` → admins → users → claims), not a mock token.

## Delivery — FAIL, unclassified (not a locator issue)
r1 timed out on `getByText('Welcome to Burgonomics')`. r2 captured:
- URL settles on `/auth/login`; no navigation error.
- React mounts (`#app` has a React root, devtools message present) but `document.getElementById('app').innerHTML === ''` and `document.body.innerText === ''`.
- No `pageerror`, no failed requests, 0 external requests.
- QA overlay removes the shipped CSP meta in the served page because `connect-src` forbids plain-HTTP loopback; blank persists with CSP removed.

So the earlier suspicion (text is `Welcome to BURGONOMICS`, `APP.name = "BURGONOMICS"` in `src/core/constants/app.ts:2`) is **not** the cause: the body is empty, not mis-cased. The app boots `src/mobile-entry.tsx` → `src/boot.tsx` → `RouterProvider`, and the router renders nothing under this Vite dev QA environment. Root cause not established; not claimed as a production defect. Needs app-side debugging (owner: parent) before any Delivery auth claim.

Not run because blocked: phone OTP request, emulator code fetch, wrong code, correct code, session reload, logout, Settings appearance Light→Dark→reload→System, duplicate Continue/code count, resend cooldown, account deletion (no such UI asserted), native path.

## Harness notes (QA-only, no app edits)
- `qa-emulator-overlay.mjs`: `enforce:'pre'` transform injects `connectAuthEmulator`/`connectFirestoreEmulator` immediately after the exact `db` init line and asserts exactly one match (Delivery `src/core/config/firebase.ts`, Partner `src/config/firebase.ts`). Also sets `auth.settings.appVerificationDisabledForTesting = true` and removes the CSP meta **in the served QA page only**.
- `run-auth-browser.mjs`: starts CLI emulators with Android Studio JBR, seeds two synthetic identities, serves both apps with isolated `cacheDir`, launches Chromium from the local Playwright MCP deps, blocks all non-loopback requests, service workers blocked, writes JSON + JPEG crops (synthetic UI only, no tokens).
- Vite warning `configLoader: 'native'` (`__dirname` in Delivery config) is noise; app served.

## Cleanup
- Owned Auth/Firestore emulator and both Vite servers were terminated; ports 48691/48692/48178/48179 are free.
- Orphan Firestore listener PID 19148 (from the interrupted run) was killed explicitly; no java process remains.
- Unknown `node` PIDs started by other sessions were left untouched.

## Known holes
- Delivery auth acceptance (phone OTP) unverified.
- Partner unknown-role test used an emulator-admin doc; it does not prove server-rule enforcement in production.
- Partner `uses email/password` only; no phone path for Partner.
- No screenshots of Delivery beyond the blank failure frame.
