# Delivery and backend implementation checks — 28 October 2026

Status: **work in progress, not release acceptance**. This record follows the
completed launch-planning packet; it does not replace that packet or reopen its
settled loyalty decisions. No production deployment, provider operation, payment,
or store submission is authorised by these checks. The user's later, separate
approval for a compatible debug app update is recorded below.

## Continuation — 29 October

### Owner brand content and providers — later intake

- The owner supplied `Burgonomics Franchise PPT (6).pdf` and designated
  `C:\Users\DELL\Desktop\BURGONOMICS WEBSITE\burgonomics final ebsite - Copy`.
  Evidence, extracted assets and transcription are in
  [brand-provider-evidence-20261029](brand-provider-evidence-20261029/README.md).
- **Awards & Recognition** now ships **three** owner-supplied awards instead of an
  empty hidden section: Times Hospitality Icons 2025 (Iconic Burger) and two Food
  Connoisseurs India Awards 2026 (Best Quick Service Restaurant Chain; Best Burger
  Joint — Ahmedabad). Each entry has a certificate thumbnail and ceremony photo
  extracted from the deck.
- **Upcoming Stores** ships the eight records the owner site marks
  `status: "upcoming"`. Dates read "Planned for …" or "Opening date to be
  announced"; no entry becomes an orderable outlet. Already-open/new records were
  excluded.
- Brand language is used as a field, not a theme: deep green award panel
  (`--brand-field`), one MonstroSolid display heading, gold rule and year marks,
  warm ceremony photography. Inline copy stays Inter 16/14px in white or
  `#D8E8DE`; gold is never body copy. Upcoming Stores keeps the normal canvas and
  a 22px Inter heading.
- Browser QA at 390px and 320px: six award images loaded, no horizontal overflow,
  zero overflowing descendants, dark field `rgb(8,36,21)` on the black canvas.
  A right-aligned year chip and a same-line date chip were replaced because they
  squeezed long names at 320px.
- Home focused checks: **11 files / 74 tests passed**, typecheck clean. Exact
  measurements and screenshots: `brand-provider-evidence-20261029/qa-browser.md`.
- Final combined non-rules gate on the source that ships these sections:
  `npx tsc --noEmit` exit 0 and `npx vitest run --exclude 'tests/rules/**'
  --maxWorkers=1` → **132 files / 1,125 tests passed**, exit 0, 511.05 s. This
  includes the new `approvedHomeContent.test.ts` and the relaxed
  `home-landing`/`theme-foundation` contracts, which now allow MonstroSolid for the
  single ceremonial heading while still requiring Inter for body, caption, button,
  price and label roles. It is a source gate, not a native/APK result.
- The earlier "Inter only, never MonstroSolid" assertion was corrected rather than
  deleted: the tests now check that `.type-brand-heading` is the only role using
  `--font-brand`, and that the five interface roles still use `--font-sans`.
- Petpooja item images are already wired
  (`itemimageurl → item_image_url → image_url → image` → `products.imageUrl` →
  curated local fallback). The captured vendor sample sends `item_image_url: ""`
  for every item, so the app shows local photography until the merchant uploads
  images in Petpooja. No URL is invented.
- The independent backend review found real defects in the previously "green"
  patch (cash orders serialized as prepaid, a webhook window that dropped valid
  Razorpay retries, an order id used as a payment id, add-on/line totals that did
  not reconcile, unbound tax rows). Those are repaired with hermetic tests:
  `tsc` exit 0, full `functions` suite **85 files passed / 1 skipped, 1,134 tests
  passed / 2 skipped**, `npm run build` exit 0, and a mechanical red→green check
  (**43 failed** before the fix, **97 passed** after). No live provider call,
  deployment or commit was made.
- Provider status is **not** production-accepted: unit `final_price` at quantity
  > 1, real outlet `taxes[]` ids and a COD `collect_cash`/`total` pair still need
  one merchant sandbox run. Every live branch must receive a menu push with
  `taxes[]` or explicitly opt in, otherwise its KOT refuses pre-send with
  `PETPOOJA_OUTLET_TAXES_UNKNOWN` (deliberate fail-closed). Ops must also define a
  response for terminal `failed` KOT rows and `unmatched_payments`
  (`order_paid_missing_payment_id`). Full plain-language status:
  [backend-status.md](brand-provider-evidence-20261029/backend-status.md).

### UI-first implementation checkpoint

- The user reasserted the original UI requirements and asked implementation to
  continue. Delivery now has isolated theme, Menu, Cart and remaining-surface
  lanes; Partner has its own clean UI candidate. The original dirty app checkouts
  remain untouched. All new UI source is **uncommitted and not release accepted**.
- Delivery integration is still
  `.swarm-worktrees/delivery-launch-ui-20261028` at clean base `7affdf6…`.
  It now contains the Inter/theme foundation, Home image-only flips, conditional
  Home announcements, continuous Menu candidate and initial Cart/reorder/notes
  candidate. Remaining-surface typography/spacing changes are also integrated.
  Cart safety follow-ups and independent Menu review are in progress; a green
  typecheck is not acceptance of these business paths.
- Home retains exactly four 2×2 shortcuts. Real alternate burger/fries/shake
  photographs flip once after loading and visibility; labels do not rotate.
  Missing Wraps imagery/category remains an honest unavailable state. Awards &
  Recognition precedes Upcoming Stores, but both stay hidden while the
  developer-maintained owner-approved content arrays are empty.
- Self-hosted Inter v4.1 includes the rupee glyph and weight range 100–900.
  Font SHA-256: `693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3`.
  OFL licence SHA-256: `262481e844521b326f5ecd053e59b98c8b2da78c8ee1bdbb6e8174305e54935a`.
  An integration check caught Git's LF→CRLF conversion of the licence; its exact
  original LF bytes were restored, not the test expectation weakened.
- Menu's strict `getProduct(id, storeId)` binds reads to the outlet's verified
  `petpoojaRestId` and rejects unresolved/ambiguous scope. Phase 1 deliberately
  retains the existing scoped full-catalog read/cache and local slicing. Section
  paging bounds rendered cards; it is **not network cursor pagination or bounded
  full-catalog memory**.
- Partner candidate `.swarm-worktrees/partner-launch-ui-20261029` uses clean base
  `7374d3e…`. The worker completed its 150-file appearance/readability conversion
  and reported **20 focused files / 145 tests passed**, plus typecheck. Full
  unit verification now reports **88 files / 612 tests passed, 1 pre-existing
  skip**, exit 0 (227.69 s), plus a fresh typecheck pass. Import-time Firebase
  failures were repaired with a credential-free test-boundary mock in the
  affected helper tests, never a production fallback; stale badge assertions
  now require the exact semantic classes. Build/browser acceptance remains
  separate from unit proof. Build was initially withheld at ~0.69 GiB free;
  after a fresh **1,179,193,344-byte** preflight it passed `npm run build`, exit
  0 (39.251 s), using only existing publishable configuration. QA flags disable
  FCM/analytics/reCAPTCHA; this is not production-accurate coverage of those
  services. Main chunk warning (948.63 kB > 800 kB) and three ineffective dynamic
  import warnings remain disclosed, not silently called clean.
  No Partner native replacement is authorised.
- Source typecheck and focused Home/theme checks have passed on their recorded
  snapshots. The first combined non-rules run **timed out after 600 seconds**
  without a final result; it is not a pass. A longer current-source full gate is
  still required after review repairs. Combined build/native acceptance is also
  pending. Earlier 818-test or installed
  APK results below must not be relabelled as proof of this newer source.
- A fresh isolated Chromium session at the current-source dev server
  `http://127.0.0.1:48176` verified loaded Inter, white/light and black/dark
  canvases, and Home reflow with no horizontal overflow at 320/390/768px. The real
  local food images loaded; normal-motion image flip was observed with the label
  outside the transformed element. Burgers opened the exact real category ID;
  Menu rendered **15 real category sections** and zero tablists. These are
  bounded source/dev-browser checks, not current-APK or release acceptance.
- Browser inspection caught a genuine sticky-header failure: `body` horizontal
  `hidden` overflow implicitly created a non-scrolling vertical ancestor. The
  integration now uses `overflow-x: clip; overflow-y: visible`. Menu jump
  measurement now uses computed sticky `top + height`, not the pre-stuck
  `rect.bottom`. On a fresh reload the header measured y=0, the rail y=56–187,
  section scroll margin 195px and the Momos heading y=218.5625. The retained
  `menu-jump-light-390.png` predates the margin correction;
  `menu-jump-fixed-light-390.png` follows it. Final post-integration replay is
  still required.
- Guest Cart browser checks observed exactly one 16px textarea, no history rail,
  whole-change rejection at 241 UTF-16 units preserving `Less spicy`, and draft
  persistence across Home/Cart navigation. A locally populated guest basket also
  had one order-level field and no per-item editor. No order, payment, OTP or
  provider action ran. `cart-populated-light-390.png` predates the companion
  readability import; it is not a screenshot of the final polished Cart.
- The eight companion Cart/Checkout readability components are now imported in
  integration. Their worker reported **21 + 17 focused tests passed** and
  typecheck; the parent also removed the obsolete welcome-points promotion from
  QuickAuthSheet while preserving the server ledger. Route-level spacing and
  CartItemRow/PromoInput/closed-kitchen typography are now polished in source.
  The source contract includes these routes, and the parent ran **6 files / 54
  component/theme tests passed**, exit 0 (26.50 s). Address edit links are outside
  their selection radio, not nested controls. These checks do not replace the
  combined typecheck/full suite/build/runtime gates.
- The latest Menu repair report covers complete-vs-partial snapshots, empty/re-add
  recovery, modal focus/Escape/semantics, required and unavailable options,
  malformed-page recovery, repeat highlights, paint-timed jumps and removal of
  nested card controls. It is now integrated; parent review additionally required
  canonical-prefix reconciliation for bulk arrivals/category moves and controlled
  handling of rejected add promises. **22 Menu files / 176 tests passed** in the
  integration tree. Its typecheck exposed six incomplete parent Checkout
  draft-contract errors, not a green combined gate. The fresh Cart repair worker
  reports **8 files / 92 tests passed**, plus isolated typecheck, for fresh
  confirmation reads, owner/lifecycle fences, validation and safe legacy-note
  handling. Its bounded main-tree integration and actual rendered Checkout-note
  tests are in progress; the old 175-test Cart report is not repair evidence.
- Owned UI QA browser contexts and Vite server were stopped. Server exit 1 after
  deliberate process termination is expected, not a build/test verdict. Retained
  dev logs include an HMR ResizeObserver loop warning and fail-closed missing
  Razorpay publishable-key warnings; final runtime must be rechecked, not called
  warning-free. Disk had fallen to ~164 MiB; the next observation recovered to
  ~1.5 GiB without a new parent deletion. Build/native gates must recheck space.
- Parent independently re-hashed the Partner QA build: `dist/index.html`
  `b86fba4bf2895c02316ae0b63e975c19c395aaa6892cddffda0d14eae839a71d`;
  `index-BjI58kTU.js`
  `76cce7fe467c462b0eaa37cce94f793e80a8bc6d4ae0850136cd4d77b5a8c5eb`;
  `index-cjlLhwYw.css`
  `971453c2399dd7e894a096c9e5e89d5364cef06c16268db6a80c88fc1419ad42`.
  The isolated static preview at port 48177 blocked **all nonlocal requests**.
  Login had no horizontal overflow at 320/390/768/1280px or 200% root text resize,
  16px inputs and 44px password/48px submit controls. Loaded Inter, white/light,
  black/dark and persisted Light override under dark OS were observed. Password
  visibility toggled without submitting credentials; `/dashboard` correctly
  returned the unauthenticated context to Login. No page errors were captured.
  Authenticated operational screens and native Partner remain unverified.
- The first Partner dark screenshot caught the colour-transition midpoint;
  `partner-login-dark-stable-390.png` is the fresh persisted-dark reload. Its
  actual inputs measured black backgrounds, white values, #C9CFC8 placeholders
  and #7A8279 borders, not the intermediate pale fill. The light and stable-dark
  PNGs are under the existing `delivery-ui-qa-20261029` Temp evidence directory.
  Parent closed only its one Partner context and identity-verified preview PID
  14496. The expected stopped-server exit 1 is not the build verdict above.
- Delivery's first full non-rules gate after the final integration produced
  **130 passed files / 1 failed file, 1,120 passed tests / 1 failed test**. The
  single failure was a stale expectation for the old all-caps countdown label
  (`Mins Remaining`) while the shipped copy is sentence-case
  (`Minutes remaining`). The assertion was updated to the current copy; the
  honesty assertion (no estimate means no countdown) was unchanged and still
  passes. This was not a product defect or a weakened test.
- The rerun gate then passed in the same integration tree:
  `npx tsc --noEmit` exit 0 and `npx vitest run --exclude 'tests/rules/**'
  --maxWorkers=1` → **131 files / 1,121 tests passed**, exit 0, 218.40 s. After the
  final native Menu-landing repair, the same gate was repeated on the exact final
  source: **131 files / 1,121 tests passed**, exit 0, 215.10 s, with typecheck 0.
  That run is the strongest current-source unit/type evidence. It is still not a
  provider, release-signing, iOS or store-acceptance pass.
- Post-gate browser replay on the current dev source confirmed: Home renders four
  shortcuts that now measure exactly **173 × 173 px** each (square aspect, labels
  outside the flipping photo frame), real burger/fries/shake photos load, Wraps
  remains honestly disabled with `Photo unavailable`, and Awards/Upcoming stay
  hidden while their approved content arrays are empty. Inter loaded; the light
  canvas was `rgb(255,255,255)` with no horizontal overflow at 390px.
- Menu replay rendered **15 real category sections** in one vertical flow with
  zero tablists. Jumping to Momos measured header y=0, sticky rail y=56–187,
  section scroll-margin 195px and heading y=218.5625, with focus on the section
  heading and **zero** nested link/button controls.
- Cart replay observed exactly one order-note textarea at 16px, no per-item note
  editor, whole-change rejection at 241 units keeping `Less spicy, no onions`,
  and the draft persisting across Home/Cart navigation. The kitchen-closed,
  price-lock, delivery-progress and bill surfaces were checked in the new
  semantic tokens. No order, payment, OTP, POS or rider action ran.
- Disposable-only space recovery removed the already-built `dist`, Vite dependency
  caches in the two UI worktrees, and the Partner `dist` preview (its build hashes
  are recorded above). No source, evidence, canonical APK or installed-before APK
  was deleted. Free space rose from ~0.39 GiB to ~1.05 GiB before the APK build.
- The `build:mobile` step passed (`2885 modules`, built in 15.36 s) and
  `npx cap sync android` copied assets and updated 11 plugins (sync 2.074 s).
  The first Gradle attempt failed because `ANDROID_HOME`/SDK location was not set
  in that shell; no source or `local.properties` change was made. The retry with
  the SDK path exported succeeded (`BUILD SUCCESSFUL`, 427 tasks).
- Native Delivery update completed with data preserved. Final candidate
  `afe1012638dd0f15a8ace0c0b0fab9b65c1853da4725be34436f0e1614428a31` passed the
  read-only preflight: same `com.burgonomics`, code 1, same Android Debug signer,
  debuggable, **170** bundled web files matched `dist/mobile`, no remote server URL
  and WebView debugging off. Install used only
  `adb install --no-incremental -r`; exit 0. `firstInstallTime` stayed
  **27 October 11:32:45**; `lastUpdateTime` became **29 October 07:07:27**, so app
  data survived.
- On the updated native app: Home restored the previously selected outlet and
  mode; four shortcut tiles measured **474 × 477 / 474 × 471 px** (square, tiny
  sub-pixel rounding) with real burger photography and honest `Photo unavailable`
  for Wraps at outlets that do not list it. Menu opened at the real
  `big-bang-burgers` category with **15 categories • 56 items** and a real American
  Burger card.
- A native-only defect was found and repaired before acceptance: the initial
  category landing placed the section heading underneath the sticky chrome.
  `scrollIntoView` + CSS `scroll-margin` was unreliable in the Android WebView, and
  a smooth scroll raced the correction. The jump now measures the app bar + rail
  from live layout, scrolls the window to `sectionTop − margin`, then performs one
  geometric correction (`heading.top − (rail.bottom + 8)`). Post-fix native
  observations put `Big Bang Burgers` at y=762 with chrome ending at y=612, and a
  rail jump to Pasta landed its heading fully below the rail. Focus and the active
  chip still followed the section.
- Native Cart rendered the closed-kitchen banner, price lock, delivery row, free
  delivery progress, item row, sticky total and the single `order-notes` editor
  with its `0/240` counter and order-level description. Adding a second item still
  produced one note field only. The attempt to type a note was interrupted by the
  phone's own 07:10 alarm app coming to the foreground; automation stopped rather
  than dismissing the user's alarm, so typed-note persistence on the phone remains
  browser/unit-verified, not native-verified.
- Superseded intermediate APK copies were removed only after printing each hash;
  the final candidate and the original installed-before APK remain. Gradle/bundle
  caches and `dist` were removed as regenerable output, recovering disk from
  ~133 MiB to ~350 MiB. No source or evidence was deleted.
- Free DeepSeek workers hit their usage limit. The user explicitly authorised
  switching those workers to **paid `opencode-go/deepseek-v4.1-flash`**. The main
  session may remain GPT; no GPT subagent or global provider configuration change
  is authorised or used. Workers continue existing isolated source rather than
  restarting the implementation.
- The user confirmed the phone is connected. Mobile MCP observed Samsung
  `RZCX51TXRKB` online; fresh REA package inspection still shows Delivery code 1,
  UID 10671, first install 27 October 11:32:45 and last update **29 October
  02:42:40**. Thus the installed APK still predates the latest UI lanes. Only a
  compatible data-preserving Delivery debug update is permitted after gates; no
  uninstall, clear-data, downgrade, live order/payment/POS/rider operation,
  deployment, store submission, commit or push.
- Disk exhaustion interrupted earlier Git/font writes and one backend test file.
  The backend author restored that file and reran its focused checks. Parent
  removed only two hash-verified duplicate APKs: the generated worktree debug APK
  and `installed-after/com.burgonomics/base.apk`. Their canonical candidate copy
  and the original installed-before APK remain retained. References below to the
  removed duplicate paths are historical; use the canonical candidate directory.
- Backend email/precision/unit-`final_price` patch remains frozen in
  `.swarm-worktrees/backend-email-contract-20261029`: **101 focused tests passed**,
  but the disk-aborted full run is not a pass. Final post-edit typecheck, full
  suite, build, diff and independent review remain separate pending gates.
- The repaired old POS snapshot `pos-owner-ready-02` passed **7/7** actual local
  emulator/native-wire cases in `pos-final-20261029-02`, exit 0, with strict
  loopback listener verification and complete own-process cleanup. This resolves
  the old listener-infrastructure blocker below; it does not validate the newer
  email patch. Final dispatch emulator replay remains pending.
- Reelo/Petpooja D31–D33 remain settled: no app loyalty balance/redemption UI,
  preserve existing balances/history, Petpooja remains the sole bill producer to
  Reelo. No migration or duplicate upload was implemented. **OPEN-EARN-1** remains
  unresolved. Original **3 November RC/submission-readiness / 8 November launch**
  targets remain conditional, not reset or promised.

- The supplied four provider documents and franchise PDF were re-hashed on
  29 October. All five fingerprints below are unchanged; no replacement source
  was silently adopted.
- All three backend candidates are now combined **only** in
  `.swarm-worktrees/backend-integration-20261028`. The main dirty checkout remains
  untouched. No new commit, merge to main, push or deployment was performed.
- The combined backend passed `npx tsc --noEmit`, `npm run build` and the full
  `npx vitest run`: **1073 passed, 2 skipped**, across 83 passing files and one
  skipped provider-wire file. Those skips are not live-provider acceptance.
- Critical combined POS/dispatch source files were compared with the frozen
  reviewed candidates: the bytes and SHA-256 hashes match, not merely the names
  or line-ending-normalized text.
- Final POS native-emulator attempt `pos-final-20261029-01` stopped during actual
  listener verification, **before any application case**. Its exit 1 is an
  infrastructure blocker, not a passing or failing verdict on the final POS
  code. Earlier negative case evidence is retained. The next run must preserve
  loopback verification rather than bypass it.
- The final dispatch bounded replay passed its callback/rebook/delete,
  ready-during-book/concurrent-ready and callback-before-ACK cases. It uses an
  MVCC/Firestore double and stubbed provider responses; final native-emulator
  replay is still a separate gate.
- The Delivery checkout's unchanged `firestore.rules` passed **108 actual local
  emulator tests**, with CI-style fail-on-unavailable behaviour and sequential
  rule files. Rules SHA-256:
  `bf491f4cc46c8d1e1a9678a20456755155d56f7a6bd9e7ccef3e2edaab600282`.
  This verifies that exact copied ruleset, not the unrelated dirty root rules.
- Delivery now contains four explicit Home groups, native touch/pen carousel
  ownership, mouse drag suppression, notified hydration, and store/user-scoped
  Home request ownership. Newest source build and phone replay remain required;
  an older browser bundle does not inherit those results.
- Per the user's clarified routing: the main session may remain GPT, but **no
  GPT subagents**. Current explicit workers use DeepSeek V4.1 Flash Free for
  Delivery implementation, NVIDIA's DeepSeek V4.1 Flash for native verification,
  and GLM 5.3 Flash Free for bounded review. Provider catalog availability is not
  proof of restored quota. No global model/account configuration was changed.

### Phone browser replay and native-update approval

- The rebuilt web preview served `/assets/index-cmzRA8em.js` at port 48173.
  On the physical Samsung phone in **Android Firefox**, a vertical swipe inside
  the banner with stable browser chrome moved the Explore Menu heading
  **1220 → 671 device pixels (549px)**. A horizontal swipe moved one banner
  **1080 device pixels**, selected banner 2 and left the URL on Home.
- Home showed four shortcuts. Tapping disabled Wraps kept Home open with
  “Not listed for this store”; tapping Burgers opened
  `/menu?category=big-bang-burgers` with actual products. The category-only crop is
  `C:\Users\DELL\AppData\Local\Temp\opencode\delivery-four-home-20261029-crop.png`.
  These are browser checks, **not updated-native-app acceptance**.
- The user selected **“Update app (Recommended)”**: build a debug APK, verify
  signing compatibility, and apply only a data-preserving update. No uninstall,
  clear-data, downgrade, release signing or store submission is permitted.
- Following the restart, Mobile MCP again observed device `RZCX51TXRKB` online.
  REA's installed-package pull completed with one base APK and no splits/failures
  (`ev_6cba8ffafff03984f885e9056546e6335570544a600fa6e2ae9c32411991cd0b`).
  Installed package: `com.burgonomics`, version `1.0.0` / code `1`, debuggable,
  min SDK 24, target SDK 36. APK SHA-256:
  `035690a03f52cd541dbce5c52d8acb38f4309330b6c5f43194f08f04f40ec240`.
- SDK 36 `apksigner verify --verbose --print-certs` exited 0 and verified its
  v2 signature with one Android Debug signer. Certificate SHA-256:
  `8f3f90a62057409a48d7fc2a750798ec2e209b889ab377ba692204c94a069a48`.
  The pulled APK, signature verification and package metadata are under
  `C:\Users\DELL\AppData\Local\Temp\opencode\delivery-native-20261029\installed-before\`.
  This was the installed-side observation before the candidate was built.
  The subsequent candidate comparison is recorded below; no installation has run.

### Debug APK built and independently checked — pre-update checkpoint

- DeepSeek completed `npm run build:mobile`, `npx --no-install cap sync android`
  and both Gradle debug assemblies using JBR 21 and `--offline`; all exited 0.
  No SDK/dependency install, release signing, commit or deployment occurred.
- Final QA APK SHA-256:
  `3d6e217310ac20576f2710719cc11e6f50bc9831f07bd05fd8ee669b0fd2286e`
  (24,559,894 bytes). Parent re-hashed it and copied it without overwriting an
  existing artifact to
  `C:\Users\DELL\AppData\Local\Temp\opencode\delivery-native-20261029\candidate-3d6e217310ac2057\app-debug.apk`.
- Parent independently reran SDK 36 `apksigner` and `aapt` through the read-only
  `verify-update.py` preflight: both installed and candidate signatures verify;
  their complete one-signer certificate sets match. Package and version match
  (`com.burgonomics`, code 1 / `1.0.0`); candidate is debuggable, not a downgrade.
- Parent verified all **170 bundled UI/web files** against `dist/mobile` by
  SHA-256. The only omissions are the two hosted `.well-known` association
  documents; the only additions are two empty generated Cordova placeholders.
  The initial strict preflight rejected those omissions (exit 1); that failure
  and the precise correction are preserved in `preflight-01-failure.md`.
  The APK has no remote server URL and keeps WebView debugging disabled.
- Parent independently checked the compiled APK manifest: native Firebase init
  provider, FCM receiver and both messaging services are absent; FCM auto-init and
  analytics collection are false; analytics collection-deactivated is true.
  This uses a **TEMP-only debug manifest overlay**, not an app/release policy
  change. Overlay SHA-256:
  `77e4802b27c2d9d62baeeb9a7271e5f2742b59e3c152a4021a91908772df9691`;
  debug init script:
  `856b9268ad9f3cd1284226742ea2126467a887f7b0e03051fccb0d45c95ac749`.
- JS push/FCM/analytics flags were separately checked as compiled `false`
  literals without printing client configuration values. Parent re-hashed the
  builder's sixteen recorded source inputs: every value matches its reported
  pre/post hash. This bounded check is not a whole-repository reproducible-build
  proof. Full web-file fingerprints are retained with the copied candidate.
- **QA limitation:** removing native Firebase auto-init makes native App Check
  unavailable. Source inspection suggests Capacitor/JS handle its failed plugin
  initialization, but runtime startup has **not** been tested. No claim is made
  about deployed App Check enforcement or “monitor mode”, zero device-wide
  network traffic, successful native startup, or release/security readiness.
- After the build, **both** Mobile MCP discovery and ADB listed **no device**.
  No install command was issued. Reconnection of the same Samsung phone is
  required; immediately recheck its current package/version/update identity
  before using the existing certificate comparison. Do not downgrade if another
  update occurred while it was disconnected.
- Local proof: `compatibility-3d6e217310ac2057.json`,
  `candidate-3d6e217310ac2057/source-and-web-fingerprints.json`, and `build/`
  under the native evidence directory above. None is native UI acceptance.

### Reconnected phone: update and bounded native checks passed

- The user confirmed reconnection and asked for the provider emails to be used.
  Mobile MCP observed the same Samsung serial online. Fresh REA/ADB checks still
  found code 1, UID 10671 and the unchanged 27 October install/update identity.
- Parent verified the copied candidate hash and ran only
  `adb -s RZCX51TXRKB install --no-incremental -r <verified APK>`: **exit 0,
  Success**. No uninstall, clear-data, downgrade or permission grant ran.
- REA post-update evidence
  `ev_deb6110a2e340490b24852098ab11627372c60b9aee779ab6030b8ab1ebaaea6`
  retained UID 10671 and first install **27 October 11:32:45**; last update became
  **29 October 02:42:40**. Existing outlet/mode selection restored on launch.
- REA pulled the installed-after APK with complete coverage and no failures:
  `ev_647e214d7d01218540725ac2d5439602a246f2762a59e2049afe947a59c673f8`.
  Its bytes/hash exactly match candidate `3d6e217310ac2057…2286e`, not an older
  APK or browser build.
- **Actual updated native app:** Home loaded; successive upward swipes starting
  inside the banner moved Explore Menu **1635 → 1071 → 678 device pixels**.
  A horizontal swipe changed banner selector **1 → 2** without navigation.
  Disabled Wraps kept Home open; Burgers opened native Menu with Big Bang Burgers
  selected and real selected-store product cards. No ADD/checkout action ran.
- Returned via Home navigation, terminated only `com.burgonomics`, and relaunched
  it: the separate **cold start also reached Home** with the new shortcuts.
  The app is left open on Home for user review. This establishes bounded native
  startup/gesture/navigation behaviour despite the documented QA App Check
  limitation, not release security, iOS or whole-app acceptance.
- Privacy-cropped native evidence and full bounded record:
  `delivery-native-20261029/home-native-crop.png` and `NATIVE-CHECKS.md` under the
  existing Temp evidence root. The transient full-screen capture was removed.
  Continuous Menu, reorder/notes, loyalty UI retirement and remaining Inter/theme
  work were still outstanding **in that 02:42 APK**; it must not be described as
  completing them. The later **07:07** update recorded above supersedes it for the
  Delivery UI, while the native App Check limitation is unchanged.

### New provider emails and requested MCP checks — 29 October

- Newly supplied `ALL PETPOOJA EMAILS.txt`: 9,135 bytes / 282 lines; SHA-256
  `2f8e269dcb7f4d8c5881bf4a774c5ac204d1dc3986a29d88f5481797ee55170c`.
  It contains a sandbox password; output was redacted and no credentials were
  copied into code, tests, Git or documentation queries. Original stays read-only.
- The vendor's **28 October 16:01** reply, lines **276–278**, explicitly requires:
  `total` includes `tax_total` (350 + 17.50 = 367.50); COD collection equals the
  order total; GST liability belongs to the restaurant, including any actually
  charged delivery/packing GST. The supplied API body uses canonical
  **`collect_cash`**. An already tax-inclusive server grand total must not have
  GST added a second time merely because of this email.
- Vendor rejected payload structure on 26 October and referred to an attachment
  not embedded in the email text. The sender's earlier sandbox ACK/listing claims
  do not establish final vendor approval, physical KOT printing or callback
  authenticity. No live resubmission was authorised or attempted here.
- `Firebase Docs.txt`: 6,764 bytes / 108 lines, SHA-256
  `ce6e421406f062ef3d9eb6364185d1c160e54db25146297d400e42f4124648a1`.
  It is an Apple/Android module/package index, not a Firestore schema/transaction
  contract or a dependency-upgrade mandate. The three re-supplied provider API
  documents retain their fingerprints below.
- **Firebase MCP** confirmed the current environment is the existing
  billing-enabled project, not a sandbox; only environment/resource metadata was
  read. **REA MCP** supplied actual phone/package/APK identity evidence above.
  **Razorpay Docs MCP** confirmed raw-body HMAC validation and at-least-once
  webhook delivery/event-ID deduplication from
  `https://razorpay.com/docs/webhooks/validate-test/` and
  `https://razorpay.com/docs/webhooks/best-practices/`.
  A contradictory Node sample was reported via its docs-feedback tool without
  sending any project/customer/credential data. No payment/account operation ran.
- A new isolated `.swarm-worktrees/backend-email-contract-20261029` uses base
  `31e82c3…` plus the approved staged combined backend patch. Parent verified its
  critical POS/scheduler/dispatch/stock bytes match the frozen input candidates.
  DeepSeek owns only the email-driven formatter/runner/regression/reference
  corrections there. The old candidates and old emulator snapshots stay frozen;
  changed code needs fresh gates and independent review. **Implementation is in
  progress, not yet accepted or deployed.** Sanitised contract extract:
  `C:\Users\DELL\AppData\Local\Temp\opencode\petpooja-email-contract-20261029\SOURCE-NOTES.md`.

### Continuous Menu: source-only contract review

- A DeepSeek read-only investigation and parent inspection confirmed that
  `menuService.ts` currently scans a store's full product list and slices it
  locally (`218–228`, `281–304`). `menuStore.ts:130–136` also removes loaded
  products merely because they are absent from a limited live response. Neither
  behaviour is acceptable evidence for bounded, continuous-menu loading.
- Complete, branch-scoped category discovery without that full scan is still an
  unverified data contract. The inspected sync writes real category IDs/names to
  products but no separate complete branch category index. Global merchandising
  categories cannot silently substitute for that ID source. A partial rail must
  not be presented as the complete Menu.
- The explorer's initial claims about **deployed** field/index absence and a
  mandatory new index deployment were withdrawn. Source inspection cannot prove
  either. Current official Firestore documentation explicitly supports index
  merging for equality filters; a missing local composite-index entry alone is
  not proof that the proposed cursor query fails.
- Exact vendor sorting and category counts were also withdrawn as invented hard
  requirements. Preserve the existing legitimate ordering and real IDs; omit
  unknown counts rather than invent them. No new product decision or deployment
  permission follows from this review.
- Backend citations initially used the dirty root working tree. Parent compared
  bytes with the approved combined candidate: `menuSyncWebhook.ts` is identical
  (SHA-256 `a668058c3ad7e4b42b22d661ce1879208257b0604d9a98ffa0c24d2b226079e7`),
  as is `firestore.indexes.json`
  (`a6578704ed7aca6703fd02167291d5844b977bb6f2b9c609386fbba24153b042`).
  Root rules are **different** and were not adopted. Public product/store/category
  reads were separately checked in the combined candidate's own rules. These are
  source facts, not inspection of the deployed database or an approved metadata
  writer. No Menu implementation or query/deployment acceptance is claimed here.

### Cart migration: implementation-first review

GLM 5.3 Flash Free returned a read-only assessment of the frozen Delivery code;
the parent separately read the critical hook, Cart, checkout state and menu
service. These are **open findings**, not repaired acceptance:

- `useReorderItems.ts:55–84` invents `store_default`, resets an existing basket
  before availability fetch succeeds, and requests up to 1,000 products. There
  is no cross-outlet confirmation or shared in-flight/account-generation fence.
  Stock-only validation does not verify retired selections or present changed
  prices before mutation. Adding an empty-Cart rail must not reuse this unsafe
  path unchanged.
- A suggested targeted-read replacement needs another guard:
  `menuService.getProduct(id, _storeId)` currently **ignores the store argument**
  (`311–335`) and its legacy item-ID lookup is unscoped. Passing `storeId` to that
  API is not proof of outlet ownership. Any replacement must enforce it.
- Cart's mixed delivery/kitchen chips, item-note editors and Checkout's duplicate
  editor still coexist. `checkoutStore.ts:84` silently slices at 240 UTF-16 units
  and can split a surrogate pair. Legacy literal text and item notes require
  explicit, lossless review; a pipe is not proof that a user intended separate
  fields. Do not auto-classify or move delivery requests into another channel.
- No product call to the checkout store's `reset()` was established in this
  review. Order/account/outlet lifecycle cleanup needs exact ownership fences;
  blindly clearing on route unmount would itself lose the draft during ordinary
  Cart/Checkout navigation and is not an approved repair.
- Hiding loyalty UI alone leaves persisted redemption capable of reaching order
  and payment payloads. The client must prevent invisible redemption while
  preserving every server balance/history entry. **OPEN-EARN-1 remains open**;
  this does not authorise changing server earning or migrating/deleting points.
- Reorder must validate a real supported current outlet/mode; matching the past
  order's fulfillment mode is not an invented additional requirement. Existing
  legitimate ordering/navigation and Order History reorder must be preserved.

## Source ownership

| Candidate | Baseline | Scope |
| --- | --- | --- |
| `.swarm-worktrees/delivery-launch-ui-20261028` | `7affdf698576110a64e008a492f2d8380abe2d58` | Approved clean Delivery baseline; Home/banner changes and fresh-session hydration repair |
| `.swarm-worktrees/backend-webhook-20261028` | root `31e82c3c415757064e3b33010ade4d2b0d8ebd6f` | Default-deny Petpooja order/stock handling; local candidate commit `ef4cbfd1f95822c7a69ffe62a32a3497065356c5` |
| `.swarm-worktrees/backend-pos-20261028` | same root baseline | POS outcome classification, durable send ownership and scheduler safety; repair ongoing |
| `.swarm-worktrees/backend-dispatch-20261028` | same root baseline | Borzo/Shadowfax cancellation and readiness; repair ongoing |
| `.swarm-worktrees/backend-integration-20261028` | same root baseline | Combined staged candidate; local typecheck/unit/build passed, final emulator/native-wire acceptance pending |
| `.swarm-worktrees/backend-email-contract-20261029` | same root baseline + approved combined staged patch | New email-driven payload corrections in progress; separate gates required |

The main checkout's unrelated modifications/untracked files were not imported.
Missing untracked main-checkout tests do not become part of a clean candidate by
being named in an old verification command.

## Phone evidence, not synthetic pointer proof

Target: the user's connected Samsung SM-S921B, Android 16. REA observed installed
Delivery package `com.burgonomics`, version `1.0.0` / code `1`, last updated
27 October. This is **not** the newly changed worktree build. REA evidence:
`ev_471939319ed6c4d627f157a289decc20986380ee0300176aa823227bdb7144c1`.

Paired physical swipes using Mobile MCP:

| Target | Gesture | Explore Menu heading, device y | Result |
| --- | --- | --- | --- |
| Installed Delivery | Inside banner, upward 600px | 1827 → 1827 | Blocked |
| Installed Delivery | Outside banner, upward 600px | 1827 → 1218 | Page moved 609px |
| Worktree production web preview in Android Firefox | Inside banner; browser toolbar already hidden | 1635 → 1635 | Still blocked despite pointer-capture changes |
| Same web preview | Outside banner, upward 600px | 1635 → 1029 | Page moved 606px |

The preview's first gesture moved the heading by 192px because Firefox's toolbar
collapsed. That movement was **not** counted as page-scroll success. A second
inside-banner gesture with stable browser chrome established the failure above.

The compiled carousel's computed CSS was independently inspected in the isolated
desktop browser: `touch-action: pan-y`, both overflows `auto`, and **both overscroll
axes `contain`**. `src/styles.css` gives `.no-scrollbar` the shorthand
`overscroll-behavior: contain`; an x-axis utility alone does not restore y-axis
scroll chaining. A scoped source fix and another physical replay remain required.

The unconfigured clean web build initially showed its explicit missing-service
screen. A later read-only preview reused only the existing publishable Firebase
client configuration at build time; no env file was copied and no values were
printed. Analytics/push remained disabled and no ordering/provider action ran.
This configuration step is not proof of release configuration readiness.

## Fresh-session runtime finding

On a fresh browser origin, `/home` remained visually empty even though the actual
store reported `isHydrated: true`, with no selected store. The hydration callback
mutated a previously published Zustand snapshot. Explicitly notifying through
the actual store's `setState({ isHydrated: true })` immediately allowed navigation
to `/stores`. This is a fresh-session browser finding, **not** a claim that the
installed app fails to launch. A minimal notified-state repair is in progress.

## Backend: why green suites were not enough

Independent implementation-first review reproduced these counterexamples against
the first candidates. They are findings to repair, not accepted final behaviour:

- Borzo incomplete/malformed/wrong-ID/non-canceled 2xx responses released a local
  booking. Success fixtures omitted the provider's canceled order object.
- Concurrent cancellations could clear a subsequently rebooked rider binding.
- Post-wire state-write failures allowed another cancellation request.
- Staff-cancel ambiguity was not contained across callback and automatic-rebook
  paths; the callback-to-worker trace was source-derived, not a live operation.
- Food-ready before booking lost the Shadowfax ready signal; old review flags
  also affected a replacement booking.
- A native-fetch experiment against **two loopback HTTP servers only** showed a
  followed redirect forwarding a synthetic Borzo header to a second origin.
- POS ACK/timeout followed by failed state persistence left only an expiring
  claim; after eleven minutes a direct caller could POST again.
- POS 429, malformed success responses and legacy retry records did not provide
  proof that replay was safe.
- The scheduler interleaved transaction reads/writes. The actual installed
  Firestore Transaction implementation rejected this ordering with networking
  blocked; hand-written test doubles had permitted it.
- A stale dead-letter snapshot could overwrite reconciliation state and advise
  manual KOT entry, risking duplication. Relay ACKs also asserted printing without
  physical printer evidence.

State replays used transpiled application source with in-memory dependencies,
not real Firestore isolation. The redirect experiment used native fetch/local
HTTP. A separate actual-Firestore-emulator harness is being prepared; preparation
does not constitute an executed acceptance result.

The webhook regression suite was also mutation-checked: replacing its strict auth
decision with always-trust caused **28 of 46** tests to fail. The candidate was
restored and its checkout verified clean. This establishes useful regression
coverage, not real webhook authenticity or emulator/production proof.

## Supplied documents: exact intake fingerprints

SHA-256 values were computed independently from the supplied originals. Text line
counts include blank lines and are not claims of full human reading coverage.

| Supplied file | Bytes / lines | SHA-256 |
| --- | --- | --- |
| `PETPOOJA API Docs.txt` | 254679 / 9950 | `ff6abc5801ed836eb45f2d7f35f4a7dd5bd6fd4407ebb0f6430001f5216e20ea` |
| `Borzo API Docs.txt` | 223039 / 7246 | `c74fbe21023c80932a80c0b9d67a6b8049ad77eaf4d491c670219cf37a8bbd78` |
| `Shadowfax - Official Rider Booking API Docs.txt` | 37208 / 2091 | `3f82aaf144514c43ebae337f8494e196994b35aa9fba859728f4ece02819c760` |
| `Shadowfax - Integration Gap Analysis.md` | 4242 / 89 | `8089057361f112a920082fbe76082098ccc543d6ccc01f387a89a20f37457dcd` |
| `Burgonomics Franchise PPT (6).pdf` | 18468582 / 21 slides | `5cc429e1465fbe9b9a2cc41c4e2a8c2735f8ff53a3403b4b0ce8c397448cf528` |

The Shadowfax gap analysis remains supplied analysis, not vendor authority.
Petpooja callback auth and an authoritative order-status lookup are not documented
in the inspected contract sections and broad document searches. Do not invent
either. Its documented status codes 1/2/3 all mean accepted, not separate kitchen
stages. Shadowfax cancel/dispatch-ready methods and bodies are documented, but
their success body/error schema is not. Borzo's cancellation example contains
positive success plus the matching order in `canceled` status.

Petpooja default-deny has a deployment consequence: credential-less callbacks
become hints, not canonical status/stock authority. The actual merchant callback
trust arrangement or a vendor-supported reconciliation mechanism must be resolved
before deployment; no such mechanism was invented here.

## Brand direction and outstanding assets

The source researcher inspected shipped CSS from `https://burgonomics.com` and
reported visual review of all 21 raster PDF slides. Full temporary research:
`C:\Users\DELL\AppData\Local\Temp\opencode\burgonomics-brand-reference.md`.

- Website primary green: `#0E4825`, with related green variants; PDF grounds also
  include `#034A18` and `#0D4825`. These are distinct sampled values, not identical
  spellings.
- PDF lime sample: `#C2D929`. This is source evidence, not blanket approval to add
  lime throughout the app. Some website text/CTA colour pairs fail normal-text
  contrast and must not be copied blindly.
- Keep the approved **Inter UI**, white/light and black/dark surfaces, green
  primary, sparse accessible orange and existing approved brand assets. Website
  Montserrat and the unidentified raster deck display face do not override that.
- Downloadable MonstroSolid does not establish a font licence. Do not add it on
  that assumption.
- Martino'z was opened on the phone. Use its spacious square image-led layout,
  not its photographs, offers, prices or identity. Its rotating labels are not
  a reason to rotate Burgonomics' labels: requested flips are image-only.
- Genuine local burger, fries and shake photography exists. No genuine Wraps
  photograph or selected-store Wraps category was verified. Never substitute a
  burger image, synthetic POS ID or fabricated availability. An unavailable
  shortcut must explain that honestly.
- Four Home shortcuts do not remove the other actual Menu categories. Continuous
  all-category Menu, empty-Cart reorder, consolidated notes and remaining theme/
  typography work are still outstanding.

## Local evidence locations and next gate

Privacy-cropped Martino'z reference:
`C:\Users\DELL\AppData\Local\Temp\opencode\martinoz-20261028-category-reference-crop.png`.
The transient full-screen capture created for this crop was removed; no personal
address/status-bar image is included in this packet.

Independent dispatch audit bundle (pre-repair snapshot, with fingerprints):
`C:\Users\DELL\AppData\Local\Temp\opencode\dispatch-readonly-audit-20261028\`.

Next: finish bounded repairs, inspect exact diffs, run current-source
typecheck/unit/build gates and adversarial integration checks, then repeat
physical gestures and navigation on the rebuilt candidate. Report emulator,
browser, native-installed and live-provider evidence separately. No old APK or
test total can stand in for another surface's acceptance.
