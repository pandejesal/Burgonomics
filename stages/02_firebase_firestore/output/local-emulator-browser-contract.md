# Local Firestore Emulator — Guest Store/Catalog Browser Contract

**Status:** design only; nothing implemented, run, installed, or committed. Stage 01 plan/summary is not edited.
**Live catalog stays BLOCKED.** This lane proves a guest can select a store and read a menu through the real Firestore
SDK against a **local emulator with synthetic data**. It cannot prove production data, Razorpay/Petpooja money paths,
or a deployed claim. Every surface must say **"EMULATOR TEST — synthetic data, not live"**.

## 1. Decision
Add a **test-only browser lane** in `polish-core-20261025`: a separate Vite config (`mode=emulator`) transforms the existing `index.html` **in memory** to use `tests/emulator/emulator-entry.tsx` and widen CSP only to loopback. That entry imports a connector calling `connectFirestoreEmulator(db,"127.0.0.1",8099)` **before** `boot()`, asserts `demo-*` + loopback, then boots the unmodified app. Firestore enforces real customer rules; data is `EMULATOR ONLY`. Zero `src/**` edits; the release bundle never imports connector or fixtures. Phase 1 needs no Auth emulator; Auth is Phase 2. Mocks lose because `storesService.ts:114-115` has no mock fallback — a mock proves the shell, not SDK/rules/mapper agreement. Network interception is forbidden and hides a production-pointed SDK.

## 2. Verified inputs (read-only; file:line)
| Fact | Evidence |
|---|---|
| Stores: `stores` then `admin_stores`, `limit(100)`, drops non-finite coords | `polish-core-20261025/src/features/stores/services/storesService.ts:22-75,88-116` |
| Store fields: name,address,city,area,lat,lng,phone,imageUrl,hours,supports,eta,pickupEta,pricing,petpoojaRestId,partnerBranchId,deliveryRadiusKm | `storesService.ts:36-74`; `src/features/stores/models/Store.ts:24-92` |
| Menu: `stores/{id}.petpoojaRestId` → `products where restId ==`; categories derived, no `categories` read | `src/features/menu/services/menuService.ts:220-250,281-299` |
| Product fields: name,description,price,categoryId,categoryName,imageUrl,inStock,isVeg,tags,badges,customizations | `menuService.ts:135-218` |
| Guest reads allowed: `products`, `stores`, `admin_stores` | `polish-backend-20261025/firestore.rules:409-437,457-460,490-495` |
| Server payload restId/branchId/inStock/isVeg/petpoojaItemId; partner 86-ing syncs three flags | `functions/src/modules/petpooja/menuSyncWebhook.ts:490-508`; `polish-partner-data-20261025/src/features/menu/hooks/useBranchMenu.ts:227-251` |
| Six `VITE_FIREBASE_*` keys required; app/db/auth singletons; boot is dynamic | `src/core/config/firebase.ts:5-12,42-65`; `src/mobile-entry.tsx:24-28`; `src/boot.tsx:17-37` |
| Existing emulator config: rules only, 8080, UI off; rules suite owns 8080, skips when absent | `polish-core-20261025/firebase.json:1-15`; `tests/rules/firestore.rules.test.ts:11-16,22-56` |
| No emulator connector exists in any worktree | grep `connectFirestoreEmulator|connectAuthEmulator` → none |
| App CSP excludes `127.0.0.1:8099`; Google Fonts external; push off/no prompt | `index.html:15,18-23`; `src/core/config/env.ts:94-97`; `src/shared/platform/pushNotifications.ts:237-247` |
| Layer 3 product schema (`veg/category/available`) is stale vs live (`isVeg/categoryId/inStock`) | `references/firestore_schema.md:68-84` |
| Image resolver rejects URLs containing `placeholder`/`banner` | `src/features/menu/services/menuImageMap.ts:143-146,178-182` |

**Rules parity risk (§11):** customer and backend-worktree copies are identical (44013 bytes, SHA-256 `7610E312…A9FAE`); monorepo root `firestore.rules` differs (39236 bytes, SHA-256 `113FA5EA…DCFC`, 96 diff lines). The lane loads the customer copy, asserts equality with the backend copy, and fails on divergence. Root drift is not fixed here.

## 3. New files — customer worktree only (no new dependency)
| Path | Purpose |
|---|---|
| `tests/emulator/connect-emulators.ts` | target assertions + connect; sets `window.__EMULATOR_LANE__` |
| `tests/emulator/emulator-entry.tsx` | connector import **before** `./boot`; lane badge; `ConfigErrorScreen` on throw |
| `tests/emulator/vite.emulator.config.ts` | app root; react+tailwind; empty `envDir`; in-memory entry/CSP swap; port 5199 |
| `tests/emulator/firebase.emulator.json` | only Firestore 127.0.0.1:8099; rules `../../firestore.rules`; UI/auth/functions/storage absent |
| `tests/emulator/seed.mjs` | rules-disabled seed via `@firebase/rules-unit-testing`; no Admin SDK/creds |
| `tests/emulator/lane.mjs` + `run-lane.mjs` | preflight/hash/seed/Vite/Playwright/teardown; env strip + `emulators:exec` |
| `tests/emulator/{lane-fixture.ts,emulator-catalog.spec.ts,playwright.emulator.config.ts}` | guards, positive flow, 320/375 geometry |
| `tests/emulator/connect-emulators.test.ts` | pure rejection tests (non-demo project, non-loopback host) |

Do not edit `src/**`, rules/indexes, package/vite configs, or existing tests/specs. Needed packages are declared (`package.json:77,106,119`; root `package.json:4-5`).

## 4. Seed (exact shapes; stable IDs; no food claims)
`demo-burgonomics-emulator`, 2 stores; every visible string starts `EMULATOR ONLY —`; image is the existing brand asset `/burgonomics-logo.png` (not a fake food photo and not a `placeholder` URL).
```jsonc
// stores/emu-store-alpha; beta = "… Test Kitchen Beta", city/area "… B", lat 12.001, lng 77.001,
// petpoojaRestId "emulator-rest-beta"
{ "name":"EMULATOR ONLY — Test Kitchen Alpha", "address":"EMULATOR ONLY — 1 Synthetic Lane",
  "city":"EMULATOR ONLY City", "area":"EMULATOR ONLY Area", "lat":12.0, "lng":77.0,
  "phone":"+910000000000", "imageUrl":"/burgonomics-logo.png", "hours":{"open":"00:00","close":"23:59"},
  "isOpen":true, "supports":{"delivery":true,"takeaway":true,"dineIn":true},
  "etaMinutes":20, "pickupEtaMinutes":15, "deliveryRadiusKm":50,
  "petpoojaRestId":"emulator-rest-alpha", "partnerBranchId":null,
  "pricing":{"deliveryFeeFlat":0,"gstRate":5,"packingChargePerItem":0,"minOrderAmount":0} }
// products/prod_emulator-rest-alpha_emu-001 … -048
{ "id":"…emu-001", "petpoojaItemId":"emu-001", "name":"EMULATOR ONLY — Test Burger 001",
  "description":"Synthetic local-emulator record. Not a real menu item.", "price":100,
  "categoryId":"emu_cat_burgers", "categoryName":"EMULATOR ONLY — Burgers",
  "imageUrl":"/burgonomics-logo.png", "inStock":true, "isVeg":true,
  "branchId":"emulator-branch-alpha", "restId":"emulator-rest-alpha" }
```
48 alpha items = 3 derived categories × 16; every 8th `inStock:false`; no tags/discounts/customizations. Three beta sentinels `prod_emulator-rest-beta_emu-b01..03` prove `restId` scoping. No banners/categories/offers/combos docs: home queries may log handled empties, but no index or marketing claim is fabricated. Idempotent deterministic IDs.

## 5. Commands (proposed; not run)
```powershell
# customer worktree root
node tests/emulator/run-lane.mjs
# → sanitized env → firebase emulators:exec --only firestore --project demo-burgonomics-emulator
#   --config tests/emulator/firebase.emulator.json "node tests/emulator/lane.mjs"
# lane.mjs → seed → vite --config tests/emulator/vite.emulator.config.ts --port 5199
#   → npx --no-install playwright test -c tests/emulator/playwright.emulator.config.ts
npm run build   # assert dist/ lacks: connectFirestoreEmulator, EMULATOR ONLY,
                # demo-burgonomics-emulator, tests/emulator
```

## 6. Safety (fail-closed)
1. **Target:** project `^demo-[a-z0-9-]+$`; host `127.0.0.1`/`::1`; port exactly 8099 (Auth 9098 reserved, Phase 2). The browser connector repeats the assertion before connecting.
2. **Rules:** load customer `firestore.rules`; SHA-256 must equal `CANONICAL_RULES_PATH` (default sibling backend worktree). Divergence aborts with both hashes. Never load loosened rules, never edit rules, never run the rules suite concurrently (it clears data and owns 8080).
3. **Ports:** loopback listen-probe 8099/5199. If busy, abort with the port; never kill an unknown PID. Only spawned children are stopped; `emulators:exec` owns its emulator.
4. **Env:** delete keys by name only (`VITE_*`, `FIREBASE_*`, `GOOGLE_*`, `GCLOUD_*`, `RAZORPAY_*`, `PETPOOJA_*`, `BORZO_*`, `SHADOWFAX_*`, `FCM_*`, `SMTP_*`, `TWILIO_*`) without reading values; set only demo `VITE_FIREBASE_*`, `VITE_APP_ENV=development`, push/petpooja/analytics off. `envDir` is empty so no local `.env*` loads. No `.env`, ADC, or credential file is read, hashed, logged, or copied.
5. **Seed:** no Admin SDK/credential; `initializeTestEnvironment({projectId, firestore:{rules,host,port}})` with `withSecurityRulesDisabled` for writes only. Refuses non-loopback/non-demo/other-port targets.
6. **Emulators:** Firestore only. Auth/functions/storage/UI are not started; no provider, Razorpay, Petpooja, FCM, or SMS path is reachable. Production isolation: connector/fixtures live outside `src`; never a deploy target.

## 7. Browser network policy
Allow only `http(s)/ws://127.0.0.1:5199` and `http/ws://127.0.0.1:8099`; abort all else and assert **zero blocked requests**, plus every `page.on("websocket")` host is loopback. Test CSP drops Google Fonts (font fidelity not claimed) and allows `'unsafe-inline'` scripts only for Vite's dev preamble. `serviceWorkers: "block"`, notification permission not granted, push flag false. A stray `firestore.googleapis.com`, `identitytoolkit`, `securetoken`, `fcm.googleapis.com`, or `razorpay.com` request fails the test. Any future global Vitest guard must allow loopback only under explicit per-test opt-in (`EMULATOR_LANE=1`), never by default.

## 8. Acceptance (guest, real UI, no mocks)
1. Cold `/` → `/stores`; exactly two `EMULATOR ONLY — Test Kitchen Alpha/Beta` cards; "No stores" absent.
2. Store search `Alpha` → 1; `EMULATOR ONLY` → 2; clearing restores 2. Card `aria-label` carries name/open/ETA/distance (`StoreCard.tsx:49-57,175`).
3. Select Alpha → `/home`; open Menu → derived categories/items; beta IDs absent; ≥1 sold-out item. `/search` input (`aria-label="Search the menu"`, `search.tsx:244-252`) finds `Test Burger 0`.
4. 320×568 and 375×812: focus search, scroll 0/mid/end; sticky form visible, `elementFromPoint` at its visible midpoint hits the input/descendant, header no overlap; assert measured rects, never a hardcoded pass. Honest limit: headless Chromium has no OS keyboard, so keyboard inset is **not** claimed.
5. Badge `EMULATOR TEST — synthetic data, not live` in every screenshot.
6. With 8099 closed the spec **fails** (no skip, no production fallback). Pure tests reject non-demo/non-loopback.
7. Fresh context: no auth/IdentityToolkit calls (guest bootstrap returns before network, `authStore.ts:170-181`); no console message contains email-shaped or 10+ digit values.

**Phase 2 only:** Auth on 9098, `connectAuthEmulator` when explicitly configured, synthetic `+9100000000xx` accounts with the emulator's fixed test code — no SMS, no real OTP, no production-user impersonation, no weakened rules, no payment/POS proof.

## 9. Rejected alternatives
| Alternative | Why |
|---|---|
| Mock/fixture or route interception | Forbidden; proves UI, not SDK/rules/mappers |
| Production or a real project | Credentials forbidden and unprovable safely |
| Edit `firebase.ts`/`boot.tsx` for emulator wiring | Owned elsewhere; widens runtime surface |
| Root `index.html` unchanged | CSP `connect-src` blocks 8099 → WebChannel fails (`index.html:15`) |
| Load monorepo root rules | Stale by 96 lines; validates the wrong rules |
| Functions emulator for "real" orders | Late autoload + secrets; money paths out of scope |

## 10. Bounded tasks (permission required; do not start)
1. **P0, customer test/dependency owner:** connector + entry + Vite/firebase configs. Verify test entry/emulator CSP is served, connector rejects bad targets, `npx tsc --noEmit` green.
2. **P0, test owner:** `seed.mjs`, `lane.mjs`, `run-lane.mjs`. Verify port/target refusal, 2 stores + 51 products, no credential access, no orphan children.
3. **P0, test owner:** fixture/spec/config. Verify positive flow, 320/375 geometry, zero non-loopback requests, and failure with the emulator stopped.
4. **P1, Firestore stage:** pure `connect-emulators.test.ts`; verify `npx vitest run tests/emulator --exclude 'tests/rules/**'`.
5. **P1, orchestrator:** reconcile the three rules copies, then re-run the parity gate.

No dependency, script, or source edit without explicit approval. No task is a live-catalog or payment/POS proof.

## 11. Open questions (escalate, do not guess)
1. **Rules source of truth:** root copy differs from customer/backend copies. Which file merges/deploys? Owner: orchestrator/backend. The lane deliberately fails on divergence.
2. **Lane ownership:** may the customer test owner accept `tests/emulator/**` into `polish-core-20261025`? If not, run it in a throwaway worktree and do not commit it.
3. **CI:** per-PR (Java + Firebase CLI + Playwright) or manual pre-merge gate? Not granted; default manual, never auto-deploy.
