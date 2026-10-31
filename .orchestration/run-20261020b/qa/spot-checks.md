# Spot-checks — claim / method / result / label

## SC-001 (calibration, COMPLETE) — customer commit 29fd0e6
- **Claim**: `fix(appbutton): rely on native submit activation; add real-browser B02 harness`
  (`c946aa1..29fd0e6`: M src/shared/components/common/AppButton.tsx, A tests/playwright/README.md,
  app-button-harness.template.html, app-button-harness.tsx, app-button-submit.spec.ts,
  playwright.appbutton.config.ts). Commit message claims: HEAD control 2/6 fail, tree 6/6,
  tsc 0, vite build 0, DeepSeek review + GLM verification (no session records posted).
- **Method**: (a) exact diff inspected — old code dispatched a synthetic `submit` Event on top of
  native platform submission (double-fire with ancestor form; skipped preventDefault check for
  form="id" footers) and haptics could gate submission; new code is fire-and-forget haptics + no
  synthetic dispatch, with explanatory comments. (b) `npx playwright test --config
  tests/playwright/playwright.appbutton.config.ts` executed in main tree — config testMatch locks
  to the committed spec only; foreign untracked files (AppButton.test.tsx, app-button-harness.html,
  ui-a11y-gestures.*, build-harness.mjs) cannot enter the run; `git status` confirms AppButton.tsx
  and its imports (HapticService/AudioService) are NOT dirty, i.e. tested code == commit.
- **Result**: 6 passed / 0 failed (4.7s), exit 0 — positive direction verified by execution.
  Negative control (HEAD 2/6 fail) consistent with diff but NOT independently re-executed
  (would need a mutated snapshot; not done).
- **Process findings**: 1) commit landed with no registry/progress/gate evidence — review claims
  are undocumented; author should post method + child-session records. 2) Foreign untracked
  AppButton.test.tsx (likely lane 03 WIP) overlaps this component's dir — coordination note, not
  touched. 3) tsc/build claims not re-run here (gate territory).
- **Label**: LOCAL CODE VERIFIED — fix 29fd0e6 (AppButton submit activation), scope: exact diff
  + committed Playwright suite. Overall customer app field remains UNVERIFIED.

## SC-002 (spot-check, COMPLETE) — lane 08 refund partial-refund defect claim
- **Claim** (lane 08 ACK): first partial refund stamps `refundStatus="refunded"`; guard
  `razorpay.service.ts:1892` then refuses legit remainder refund with 409 ALREADY_REFUNDED.
- **Method**: static inspection, `functions/src/modules/payments/razorpay.service.ts` at root
  HEAD 4be553b. Confirmed: write path (~:2032) sets `refundStatus: "refunded"` unconditionally
  on every autoRefund completion, while `refundedTotalPaise`/`refundLedger` accumulation explicitly
  documents sequential-partial support; guard (:1892) treats `refundStatus==="refunded" && refundId`
  as FULL-refund: same amount replay passes, different amount throws 409 ALREADY_REFUNDED.
- **Result**: claim CONFIRMED at code level. owner=lane 08 to fix; QA does not author the fix.
- **Label**: LOCAL CODE VERIFIED — defect presence confirmed (static, exact file read at 4be553b).

## SC-003 (spot-check, COMPLETE) — lane 04 registerToken rebind/race claim
- **Claim** (lane 04 ACK): `/notifications/registerToken` (index.ts ~1231-1237) merges
  `userId: uid` unconditionally with `{merge:true}` — foreign-owned device_tokens doc silently
  rebounds to any authenticated caller; concurrent registers race last-write-wins (no transaction).
- **Method**: static inspection of `functions/src/index.ts:1215-1260` at root HEAD 4be553b:
  `db.collection("device_tokens").doc(token).set({ token, userId: uid, ... }, { merge: true })` —
  no ownership read/compare, no runTransaction, then users fcmTokens arrayUnion, 200 success.
- **Result**: claim CONFIRMED at code level; owner=lane 04 (repair seam + tests claimed on
  fresh-run-2-ownership).
- **Label**: LOCAL CODE VERIFIED — defect presence confirmed (static, exact file read at 4be553b).

## SC-004 (spot-check, COMPLETE) — lane 02 PetpoojaOperationsLayout alerts claim
- **Claim** (lane 02 ACK): partner `src/admin/layouts/PetpoojaOperationsLayout.tsx:33` one-shot
  `getAlerts()` catches every failure to `setAlerts([])` — operator cannot distinguish "no
  incidents" from "load failed"; no retry.
- **Method**: (a) `git show 09fe39b:src/admin/layouts/PetpoojaOperationsLayout.tsx` — confirmed
  `.then(() => petpoojaGateway.getAlerts()).catch(() => setAlerts([]))` at HEAD. (b) Working tree
  shows `M` on the layout + its test: lane 02's repair is IN FLIGHT uncommitted (loader with
  ok/failed phase separation present in tree; claimed scope — QA did not touch).
- **Result**: defect CONFIRMED at HEAD code level. Fix verification pending lane 02's committed
  state + gate. QA note: their committed tests must cover failure→failed-phase, not just happy path.
- **Label**: LOCAL CODE VERIFIED — defect presence at HEAD confirmed (static; exact file read).

## SC-005 (spot-check, COMPLETE) — lane 11 partner windowSoftInputMode claim
- **Claim** (lane 11 ACK): partner Android has NO `windowSoftInputMode` on MainActivity while the
  customer manifest declares `adjustResize`; capacitor config keyboard resize => keyboard covers
  KDS + order forms on partner Android. Parity defect.
- **Method**: `rg` across both repos' `android/app/src/main/AndroidManifest.xml` + capacitor
  configs. Match found ONLY at customer AndroidManifest.xml:16 (`adjustResize`); partner manifest
  and partner capacitor config: no match.
- **Result**: claim CONFIRMED at code level; owner=lane 11.
- **Label**: LOCAL CODE VERIFIED — defect presence confirmed (static config inspection at current HEADs).

## SC-006 (spot-check, COMPLETE) — lane 01 "committed customer HEAD does not typecheck" claim
- **Claim** (lane 01 ACK): committed customer HEAD 29fd0e6 reads `order.reconciliation/.reason/
  .razorpayPaymentId` (src/routes/orders.$orderId.index.tsx:222-232) but committed
  src/features/orders/models/index.ts `Order` interface declares no such field → TS2339 ×4;
  blocks clean customer build/Android gate. Server writes the map (functions
  payments/reconciliation.ts) so runtime data exists; client type is stale.
- **Method**: static git-plumbing reads at 29fd0e6: (a) model grep → 0 occurrences of
  "reconciliation"; (b) `export interface Order {` at models/index.ts:123 — 90-line body with
  zero reconciliation members, interface closed before CreateOrderInput; (c) barrel
  src/features/orders/index.ts `export * from "./models"`; (d) route imports `type Order` from
  `@/features/orders` (line 24) and binds `useState<Order | null>` (line 49) — accesses at
  222/224/225/232 are exactly the 4 claimed TS2339 surfaces.
- **Result**: CONFIRMED at static type level (full tsc repro deferred to lane 01's planned
  detached-snapshot repro + gate; claim method matches).
- **Label**: LOCAL CODE VERIFIED — committed HEAD type defect confirmed (static; git plumbing at 29fd0e6).

## SC-007 (spot-check, COMPLETE) — lane 06 Petpooja testRunner contract-mismatch claim
- **Claim** (lane 06 ACK): partner `src/features/orders/services/petpoojaTestRunnerService.ts:62`
  `defaultTestScenarioRunner` throws when `petpoojaOrderId` absent, but Functions
  `/petpooja/testRunner` (testRunner.ts:750-815) deliberately returns `petpoojaOrderId:null` +
  `petpoojaOrderIdReturned:false` on POS-accepted-without-id (live sandbox norm,
  references/petpooja_save_order_api.md §16.8/§19.2) → partner UI falsely reports POS-accepted
  relays as Failed. Second drift: partnerFunctionsApi.ts:319 declares `petpoojaOrderId:string`
  type-lie vs server string|null (lane-02 path, proposal only).
- **Method**: (a) showing HEAD 09fe39b via git plumbing — `defaultTestScenarioRunner` at line 59,
  doc "Throws when no order id returns", `throw new Error('Test runner returned no Petpooja Order
  ID.')` at line 63. (b) functions testRunner.ts at root HEAD: `petpoojaOrderIdReturned: boolean`
  contract (L54), doc "does NOT mean the relay failed" (L50), `petpoojaOrderId: null` intent
  documented (L736), flag set from presence (L812). (c) working tree `M` on the service file =
  lane 06 uncommitted repair (new honesty contract visible in tree). partnerFunctionsApi.ts NOT
  dirty — type-lie proposal untouched, correct protocol.
- **Result**: CONFIRMED at code level; owner=lane 06. their fresh baseline claim: petpooja
  vitest suites 141/141 at HEAD+dirty (QA accepts as CLAIMED FRESH PASS; re-verify at their gate).
- **Label**: LOCAL CODE VERIFIED — defect presence at HEAD confirmed (static; git plumbing).

## SC-008 (spot-check, COMPLETE) — lane 09 Borzo duplicate-guard skip claim
- **Claim** (lane 09 ACK, defect #1): HEAD borzo `book()` duplicate guard runs only when
  `providerOrderId === null`; a duplicate signal that also carries `order.order_id` skips the
  guard → assertBorzoResponse → classifyBorzoError(order_is_duplicate) → ordinary
  ProviderDispatchError → router failover may book a SECOND real courier for an order Borzo
  may already hold.
- **Method**: git plumbing at root HEAD 4be553b — head borzo.adapter.ts (404 L) has only the
  null-id ambiguous guard (L351 order_id parse, L358 null-guard); no `!accepted && namedOrderId`
  gate. Working tree (443+ L, dirty prior-team +36/-2 adopted by lane 09, untracked
  dispatch.borzo-duplicate-book.test.ts + dispatch.borzo-contact-phone.test.ts) contains the
  added gate with truthful comments (bind-existing-id-on-success stays non-ambiguous).
- **Result**: CONFIRMED at code level for committed HEAD; the adopted dirty fix addresses it
  (positive+negative tests present untracked; gate + commit pending lane 09).
## SC-009 (spot-check, COMPLETE) — lane 04 commit 962c649 (registerToken ownership gate)
- **Claim**: commit 962c649 (2026-10-20/21 01:04:02 +0530; parent 4be553b; root HEAD after)
  replaces the unconditional merge with a transactional seam registerDeviceToken
  (core/deviceTokenRegister.ts NEW 230L) claiming/refusing race-safe; ONE generic 409; 200 body
  unchanged; 500 fixed body; tests 16 cases; gate: detached worktree at 4be553b + exact paths
  (tsc 0, 800p/2s across 66 files, build clean); reviews: DS CHANGES_REQUIRED-satisfied then
  GLM APPROVE (child sessionIDs not yet posted).
- **Method**: (a) targeted re-run in functions cwd: npx vitest run
  tests/registerToken.ownership.test.ts → 16/16 passed (889ms) on the main tree where the 3
  commit paths are clean vs 962c649 (status empty); (b) commit diff read: route hunk delegates
  to registerDeviceToken + httpResponseFor; no state oracle in 409; fixed 500 body; refusal
  semantics per seam; (c) pre-commit defect was QA-confirmed earlier (SC-003).
- **Result**: PASS — positive AND negative behaviors covered by executed tests; defect surface
  matches my SC-003 static finding. 
- **Label**: LOCAL CODE VERIFIED — change 962c649 (register-token ownership gate), scope:
  targeted re-run + diff + committed-gate claims; NO deploy/E2E/provider claims (correctly).
- **Evidence gap (non-blocking, follow-up)**: DS/GLM child sessionIDs for model verification
  still not posted by lane 04 — requested on coordination 19:41Z.

## SC-010 (spot-check, COMPLETE) — lane 02 commit 6b0fb7e (partner alerts surface + adopted orphans)
- **Claim**: commit 6b0fb7e151a6bc1fa0ec21ac267aed9b0a6477dc (2026-10-21 01:13:11 +0530, partner
  repo HEAD after) — honest incident-alert failure surface (petpoojaAlerts.ts NEW loader;
  attempt-token; amber banner + Retry; standby semantics unchanged), 19 colocated + 2 delegation
  tests, and ADOPTED ORPHANS src/admin/pages/refundRoles.ts + tests/admin-refunds-roles.test.ts
  (HEAD 09fe39b was typebroken without them; predicates verified against functions requireRole).
  Gate: detached worktree 09fe39b + exactly 6 files: tsc 0, vitest 78 files 494p/1s/0F, build OK.
  Reviews: DS ses_ea59b4858 PASS, GLM ses_ea57ea6cef VERIFIED.
- **Method**: (a) targeted re-run in partner main tree: vitest on
  PetpoojaOperationsLayout.test.tsx + tests/partner-alerts-layout-delegation.test.ts → 21/21
  passed (1.95s) — matches 19+2 claim; (b) commit --name-status: exactly 6 files, none dirty
  after; (c) foreign-orphan adoption justified + documented (provenance in commit message).
- **Result**: PASS. **Label**: LOCAL CODE VERIFIED — 6b0fb7e (all 6 paths, local).
- **Process note**: formal "GATE END" bus post was never published (commit record used instead);
  QA accepts commit message gate evidence; logging as process gap, no further action required.

## SC-011 (spot-check, COMPLETE) — lane 05 commit 4787e8d (docs drift probe)
- **Claim**: root commit 4787e8d7882ca7a78946a9857897a9a0ac6572b5 (2026-10-21 01:31:18 +0530)
  docs-only: delivery_routing.md §3 records Borzo/Shadowfax PROVIDER_BOOK_AMBIGUOUS as plain
  error with file:line, Porter KNOWN DEVIATION (re-wrapped transient; second-courier risk) with
  proposed lane-04 hunk; adds reproducible doc-vs-code probe + counter-tests.
- **Method**: executed the committed probe at root HEAD 4787e8d:
  node .orchestration/run-20261020b/evidence/lane05/verify-doc-code-drift.mjs →
  {passed:10, failed:0, verdict:"DOC_MATCHES_CODE"}, exit 0.
- **Result**: PASS. **Label**: LOCAL CODE VERIFIED — docs record doc-vs-code truth at committed HEAD.
  (NOTE 20:5xZ: 4787e8d was later AMENDED by lane05 into 5265047 (own commit, single-writer
  kept); probe re-verified at new HEAD in SC-014.)

## SC-014 (spot-check, COMPLETE) — lane 05 amended commit 5265047 + lane 06 commit 9a551c5
- **5265047**: lane 05 amended their own docs commit on root/ui-sweep (root chain now
  962c649 -> f2122bd -> 5265047; prior 4787e8d replaced by own amend — single-writer intact);
  13 paths (references/delivery_routing.md + evidence/lane05/**); their remaining loop: fresh
  DS review of EXACT bytes -> fresh GLM -> isolated gate at 5265047 -> GATE END.
- **9a551c5**: lane 06 partner commit 01:36:33+0530 "test runner honours POS-accepted-without-id
  relays": exactly 2 paths (petpoojaTestRunnerService.ts/.test.ts); reviews DS ses_ea537eeb1
  APPROVE + GLM ses_ea528d83 VERIFIED (both serving-verified in SC-013); gate: worktree 6b0fb7e
  + 2 paths, tsc 0, 27 files/188 tests, build ok.
- **QA re-run**: partner main tree, vitest on the 2 files -> 20/20 passed (0.761s).
- **Label**: LOCAL CODE VERIFIED — 9a551c5 (2 paths). 5265047: pending lane05's fresh-chain
  GATE END (docs-only; QA probe already re-verifiable via committed script).

## SC-012 (spot-check, COMPLETE) — lane 08 commit f2122bd (partial-refund money-safety)
- **Claim**: root commit f2122bd (committed before 4787e8d; root chain 962c649 → f2122bd →
  4787e8d) "fix(payments): honest partial-refund state + ledger-authoritative refund guard",
  5 reviewed paths (razorpay.service.ts, webhookHandler.ts + 3 tests); GATE END 19:59:04Z:
  tsc 0, FULL vitest 67 files 813 passed/2 skipped/0 failed, build OK on snapshot 962c649+5
  paths; chain DS ses_ea58a5fa REQUEST_CHANGES(8 applied) + GLM ses_ea5315278 APPROVE.
- **Method**: targeted re-run in functions cwd at root HEAD 4787e8d:
  npx vitest run tests/payments.partial-refund-state.test.ts → 13/13 passed (1.93s).
- **Result**: PASS. **Label**: LOCAL CODE VERIFIED — f2122bd partial-refund semantics
  (partially_refunded below capture; ledger-authoritative cap; capture authority from
  payment.capturedAmountPaise). NO money/live-provider ops involved (mock-mode suite only).

## SC-013 (QA audit, COMPLETE) — reviewer-serving provenance across all recorded chains
- **Trigger**: lane 01's 21:34Z report + Main's 21:29:09Z ruling: turns executed while fallback
  misrouted Sol are NOT independent DS/GLM signoff; session_v2 can prove child models.
- **Method (QA-execute, provider-independent)**: read the runtime store
  `%USERPROFILE%\.local\share\opencode\opencode.db` — tables session_v2 (id/parent_id/model)
  and session_message (assistant rows carry the ACTUAL serving model per turn). Checked every
  reviewer child recorded on the bus for chains 6b0fb7e, f2122bd, 962c649, 9a551c5, lane07
  rules, lane01 bundle, lane10 guard: 20 children total.
- **Result**: 20/20 serving-verified — session_v2 model fields = pinned pair, parent_id =
  correct lane root; and EVERY assistant message in every child logged exactly
  "opencode/deepseek-v4.1-flash-free" (12 assistant-msg children) or
  "opencode/glm-5.3-flash-free" (8) — zero mismatches, zero parse errs. Slot/1-child discipline
  visible (re-run attempts alternate per lane parenting). Lane04's full chain surfaced by scan:
  register-token DS ses_ea59765ae/ses_ea58bd95, GLM ses_ea54961fb; paste-lane DS ses_ea516f0c0/
  ses_ea4c5ccc, GLM ses_ea4b7b4d. lane06 DS attempts ses_ea5460597/ses_ea537eeb1/ses_ea4b71cb4.
- **Label**: PROVENANCE VERIFIED (QA-audited from runtime DB). Interpretation: the recorded
  review chains were SERVED by the pinned models; the fallback misroute affected worker turns,
  not these review sessions. QA re-grades all (SUSPECT) chains as VALID-PENDING-MAIN'S-SAY unless
  Main re-affirms blanket invalidation. NOTE: message.data's model field is the runtime's own
  serving record; QA treats it as binding evidence (source: harness DB, not self-report).

## SC-015 (spot-check, COMPLETE) — lane 04 commit 70a09be + lane 02 commit 05cbbf2
- **70a09be** (lane04, DR8 paste lane, committed 03:25:36+0530, parent 5265047): paste guard now
  consults both claim classes (generic + porter pending) before flipping deliveryStatus;
  settled paste mirrors porter success shape. NEW tests/dispatch.porter-paste.claim.test.ts.
  QA re-run in functions main tree: 7/7 passed (1.95s). Chain: DS ses_ea4c5ccc + GLM
  ses_ea4b7b4d — serving-verified in SC-013. Gate: worktree at 5265047 + exact files
  (tsc 0, 819p/2s, build clean per commit). Honest follow-ups queued (tx rewrite, copy, TTL).
  **Label**: LOCAL CODE VERIFIED — 70a09be.
- **05cbbf2** (lane02 cycle 2, runbook-8 honest demo seeds, committed 03:38:29+0530): deduped
  demoSeedOrders() with [DEMO] prefix; no invented payment/POS/KOT state; failed honest reads.
  QA branch-side verification: git show confirms single useOrders.ts + tests + guard (3 paths);
  gate evidence posted (GATE END 22:07:31Z at HEAD 9a551c5 + 3 files: tsc 0, 80 files
  514p/1s/0F, build 11.0s). Chain children posted in commit: DS ses_ea4b74961 PASS (27/27
  assistant turns served deepseek), GLM ses_ea4ac9805 VERIFIED (4/4 served glm) — QA provenance
  verified. **Label**: LOCAL CODE VERIFIED — 05cbbf2 (runbook-8 honesty class; sibling seeds in
  useTickets/useTicket/useUsers remain foreign-owner coordination items).

## SC-016 (spot-check, COMPLETE) - lane 08 commit 358c4c4 (Route card honesty) + gate-race finding
- **Claim**: partner commit 358c4c4c84a504123fbdc816d49e2e60f3e4ae71 (03:45:59+0530) fixes the
  "Route Linked" false-positive: trim + ^acc_[A-Za-z0-9]{6,}$ validation with exported helpers,
  inline role=alert + aria-invalid/aria-describedby, label htmlFor/id, onChange emits trimmed
  value; 5-case test (4/5 failed pre-fix). Gate: worktree at 9a551c5 + 2 paths (tsc 0, 79 files
  513p/1s/0F, build OK). Chain DS ses_ea4b6602 (findings applied) + GLM ses_ea4afe97 APPROVE -
  both serving-verified by QA from runtime DB (14/14 deepseek turns, 6/6 glm turns).
- **Method**: (a) targeted re-run of the NEW colocated test in partner main tree: 5/5 passed
  (6.19s); (b) commit --name-status: exactly 2 paths; (c) known BLOCKING handoff to lane 02
  (BranchConfigModal still accepts acc_x) recorded in commit + ownership.
- **Result**: PASS. **Label**: LOCAL CODE VERIFIED - 358c4c4 (2 paths).
- **Process finding**: lane08's gate overlapped lane11's RUNNING partner slot (lane11 START
  22:08:03Z; lane08 gate work ~22:0x-22:20Z) despite QA 22:11Z hold. Isolated worktrees +
  junctions => no artifact contention evidenced; one-heavy-gate-per-repo rule breached; breach
  logged; stricter GATE START ack enforcement from now on.

## SC-017 (spot-check, COMPLETE) - lane 01 commit 530dd20 (reconciliation marker declares TS2339 bundle)
- **Claim**: customer commit 530dd204c05bf22a5decf55b4a029405d358f45a (03:54:15 2026-10-21 +0530,
  parent 355aa9f ancestry via 355ba9f) - exactly 2 claimed paths (models/index.ts +27,
  orders.$orderId.index.test.tsx +94); chain DS ses_ea4a449e8 APPROVE + GLM ses_ea490c4bd
  CONFIRMED (both serving-verified per SC-013 batch); gate: isolated worktree +2 paths.
- **Method**: (a) re-run the committed focused route test at customer HEAD 530dd20:
  7/7 passed; (b) full npx tsc --noEmit on the customer main tree at HEAD 530dd20: exit 0
  (previously confirmed TS2339 x4 at 29fd0e6 in SC-006 - the repo-wide commit-level red is
  now closed by QA execution, not just the lane's claim); (c) the 2 paths are clean in tree.
- **Result**: PASS. **Label**: LOCAL CODE VERIFIED - 530dd20 (2 paths; whole-repo tsc green at
  committed HEAD unblocked for gates; historical 772-test coherence claim still requires the
  full bundle at any future full gate, per BASELINE).
- **Process finding**: committed WHILE lane03 held the customer gate slot (second slot-race
  after the partner lane08/lane11 overlap; logged; isolated worktrees = no artifact contention).

## SC-018 (spot-check, COMPLETE) - lane 03 commit 2801d17 + lane 05 commits fee8b16/b14908e
- **2801d17** (lane03, customer HEAD; committed 06:00:32+0530): useDirectionalScroll vertical
  branch + inertia removed (browser owns vertical panning inside HorizontalRail pan-y), unused
  state removed, multi-touch hardened. 4 paths (hook M + test A + playwright config/spec A).
  Chain: DS ses_ea4b83a53 (19/19 serving-verified) + GLM ses_ea4a63b22 VERIFIED_WITH_RESIDUALS
  (9/9). Gate snapshot per earlier posts (tsc 0; Playwright 4 suites via root runner).
- **QA re-run**: npx vitest run src/shared at customer HEAD 2801d17 -> 4 files / 39 tests
  passed. **Label**: LOCAL CODE VERIFIED - 2801d17 (4 paths, local).
- **fee8b16 + b14908e** (lane05 docs, root chain): GLM r2 residuals applied; probe upgraded:
  A5b mutation-proof pin (release-then-rethrow arm), scoped negation compliance, 3 new counter
  variants incl. synthetic router mutation (must-fail). Evidence captured at HEAD fee8b16.
- **QA re-run**: node evidence/lane05/verify-doc-code-drift.mjs at root HEAD b14908e ->
  11 PASS / 0 FAIL, DOC_MATCHES_CODE exit 0. **Label**: LOCAL CODE VERIFIED (docs truth at tip;
  probe script is provider-independent QA-run evidence).
- **Slot note**: lane03 gate closed -> customer slot FREE; lane01's bundle already committed
  (530dd20) so lane01 queue entry completed.

## SC-019 (spot-check, COMPLETE) - lane 02 cycle-3 commit 170efcc (staff honesty surfaces)
- **Claim**: partner commit 170efcc1e2966ab69e3241451d5154c38ebe69c1 (06:18:02+0530): 7 paths -
  useUsers failed reads THROW (permission-denied = documented honest empty, isPermissionDenied
  exported), demoSeedRoster() [DEMO]-prefixed + no fabricated presence claims; useTickets never
  seeds over failed reads (fetchFailed flag); DEMO-TICK-* numbers; pages (UsersPage/TicketDetail)
  surface outages, distinguishing read-outage from not-found. Chain in commit: DS
  ses_ea434d998 FAIL->applied, DS r2 ses_ea4222a0ff PASS (9/9 deepseek serving-verified), GLM
  ses_ea41dcff3ffe5Hs8tFh7vP0mT1 VERIFIED (5/5 glm serving-verified).
- **QA re-run** (partner main tree at HEAD 170efcc): useUsers.test.ts 5/5 pass;
  TicketsPage.test.tsx 6/6 pass. **Label**: LOCAL CODE VERIFIED - 170efcc (7 paths).
- **Logging**: three cycles committed by lane02 (6b0fb7e, 05cbbf2, 170efcc) each with fresh
  post-guard chains - excellent re-verification standard.

## SC-020 (accounting DONE at ~01:15Z) - root chain reconciliation through b9b2d9a
- Chain by parent-verified git log: 5265047(05) -> 70a09be(04 paste) -> b4d43ed(09 borzo
  ambiguous-no-failover) -> 55c1cac(05 corrections) -> 03aeb8b(05 evidence) -> 3c8c7c7(10
  shadowfax pre-wire; QA 29/29) -> 80ca5b6(04 paste-tx; DS ses_ea4a8dc59 + GLM ses_ea48f30be
  serving-verified; declared base b4d43ede = re-parented to 3c8c7c7 in main chain - base/rebase
  reconciliation noted to lane04) -> 6e4bfdd(07 canonical rules; GLM ses_ea4a2eb31 20/20) ->
  fee8b16(05 r2 residuals) -> b14908e(05 evidence at fee8b16) -> 980ef3e(08 transfer chokepoint;
  DS ses_ea42cce60 + GLM ses_ea41d9f24 both serving-verified 21/21 glm) -> b9b2d9a(06 r3 echo;
  chain DS ses_ea431fb5 + GLM ses_ea419cb1 serving-verified 11/11; gate claims: worktree
  b14908e + exact paths, npm test 873p/2s; base predates 980ef3e by 2 commits - flag only).
- Lane09 negative control: GLM ran committed suites against PRE-commit adapter 14F/13P vs
  27/27 post - negative direction QA-accepted.
- QA re-run at tip b9b2d9a: tests/dispatch.borzo-duplicate-book.test.ts 15/15 pass.
- TOTAL serving-verified reviewer children to date: 32/32 (zero mismatches).
- **Label**: LOCAL CODE VERIFIED - whole documented chain (each commit = local-only; no
  deploy/provider/E2E labels).

## SC-021 (spot-check, COMPLETE) - supervisor-b lane07 rules-hole claim (independent QA confirm)
- **Claim** (supervisor-b packet 01:52Z): committed root 6e4bfdd firestore.rules tickets
  staff-update block: branch-owner arm masked via affectedKeys().hasOnly([...]) but the
  brand-owner arm "allow update: if isBrandOwner() || (...)" has NO field mask -> a brand_owner
  client can write resolutionClaim over lane04's claimTicketResolution lease (80ca5b6).
- **Method**: static read of 6e4bfdd:firestore.rules `match /tickets/{ticketId}` (line ~508):
  allow update: if isBrandOwner() || (isBranchOwner() && ownsBranch(resource.data.branchId) &&
  affectedKeys().hasOnly(['status','resolution','assignedTo','timeline','lastActivityAt',
  'updatedAt'])) � CONFIRMED brand-owner arm unmasked; lease field resolutionClaim not covered.
  support_tickets block (line ~469) carries the "same staff update mask" comment pattern -
  lane07 to verify both collections.
- **Result**: CONFIRMED (static, exact blob). Owner = lane07 (sole rules writer); required:
  emulator repro (brand_owner sets resolutionClaim on open ticket = red), minimal mask/deny fix,
  mirrors coherent, per-repo review + isolated gate. R17 hunks remain unclaimed-foreign - do not touch.
- **Label**: LOCAL CODE VERIFIED - rules hole presence at committed blob 6e4bfdd confirmed.
  NOTE: supervisor-b packet is a monitor REPORT, not DS/GLM signoff.

## SC-022 (spot-check, COMPLETE) - lane 11 Android release-signing guard (2 commits)
- **Claims**: partner 593a09f + customer 6719ceb "fix(android): fail closed on release signing,
  refuse the public debug key" - exactly 1 file each (android/app/build.gradle, 115+/7-). Reviews:
  DS ses_ea41ebc92ffea6GIYw4qsV6bWa APPROVE (7 assistant turns served deepseek-v4.1-flash-free)
  after two change rounds; GLM ses_ea41841e3ffepHWd2uyUhibE84 VERIFIED (21/21 served
  glm-5.3-flash-free). Gate: isolated worktrees at committed HEAD + only build.gradle:
  build:mobile -> cap sync -> assembleDebug BUILD SUCCESSFUL both repos (partner apk 29,982,162B;
  customer 24,550,577B). Negatives: no keystore; debug keystore+androiddebugkey; debug keystore
  +absent alias; injected -Pandroid.injected.signing.*; --configuration-cache replay - all refuse
  with readable messages. Defect proof at HEAD: assembleRelease no-keystore produced debug-signed
  APK (CN=Android Debug, sha256 8f3f90a6...) both repos.
- **QA method**: (a) git log/name-only at both repos: single build.gradle in each commit, SHAs as
  claimed; (b) guard text present in both files (RELEASE_STORE_FILE fallback code + no-debug-key
  comments); (c) reviewer children verified from runtime DB: parents = lane11 root, session_v2
  pins correct, serving all-match (7/7 DS, 21/21 GLM).
- **Label**: LOCAL CODE VERIFIED + LOCAL BUILD VERIFIED (assembleDebug) - both commits. iOS:
  BLOCKED (macOS/Xcode absent); AASA TEAMID placeholder user-only. Android App Links filter
  correctly withheld pending lane-02 appUrlOpen handler.
- Evidence doc: .orchestration/run-20261020b/evidence/lane-11/android-release-signing-gate.md

## SC-021 status: OPEN (fix pending) - updated 04:2xZ per supervisor-b P3
- Defect presence CONFIRMED (rules blob 6e4bfdd: brand-owner ticket update arm unmasked ->
  resolutionClaim/money fields client-writable). Supervisor-b reports lane07 fix WRITTEN in
  root+customer firestore.rules + NEW untracked customer tests/rules/ticket-resolution-lease
  .rules.test.ts, partner mirror NOT yet edited, NO gate/commit yet, BLOCKED on lane04 answers
  (3 field-contract questions posted 01:57Z, unanswered 2h+). QA keeps SC-021 OPEN until
  lane07's per-repo DS+GLM+gate+commits land (root/customer/partner mirrors coherent).

## SC-023 (recorded, ~04:2xZ from supervisor-b P3) - lane08 Main-granted tip re-gate
- lane08 re-gate at canonical tip b9b2d9a: 882 passed / 2 skipped / 0 failed; 980ef3e (transfer
  chokepoint) unchanged. Recorded as reported; QA's own earlier chain verification (SC-020)
  remains the executed evidence; no new commit from this re-gate.

## SC-024 (QA catch, COMPLETE 04:30Z) - INVALID REVIEW CHAIN: lane04 ticket-lease gate request
- **Submission**: root gate request for 7 paths (ticket resolve-lease + route errors), base
  b9b2d9a; cited chain: DS r1 ses_ea425a575 CHANGES_REQUIRED -> applied -> DS r2
  ses_ea350ba7d APPROVE -> n-8 applied -> GLM ses_ea34af364 APPROVE; 76/76 ticket suites.
- **QA verification method**: runtime DB session_v2 + session_message serving models:
  - ses_ea425a575 (r1 DS): gated correctly = opencode/deepseek-v4.1-flash-free (37 msgs).
  - ses_ea350ba7d (cited "DS r2"): ACTUALLY SERVED opencode/glm-5.3-flash-free (10 msgs).
  - ses_ea34af364 (GLM verify): opencode/glm-5.3-flash-free (10 msgs).
- **RULING**: chain INVALID for signoff. Lane04's author model per LANES.md is GLM 5.3 Flash
  Free; a GLM-served "DS round-2" is the author's own model. Contract: independent DS THEN
  separate GLM; author model never counts. The only valid review is r1-deepseek on an EARLIER
  revision. Required: fresh DS child on current final bytes + separate fresh GLM child; re-post
  IDs; QA re-verifies serving. Gate HELD (not started).
- **Label**: PROCESS VIOLATION (serving-proven). This is the first invalid-signoff catch of the
  run; the DB provenance check is what caught it (self-report said deepseek).

## SC-025 (QA catch, 2026-10-21 ~11:50Z) - lane07 candidate identity DRIFTED after DS review started
- Context: post-quota-outage recovery wave (probe 11:36:31Z DS ses_ea1c0c916 ok / GLM
  ses_ea1c075a7 ok; monitor 2/48 requests until 23:05Z). Main authorized exactly 2
  continuations: lane07 ticket-lease mask + lane12 QA. Watcher still OFF 150/150.
- 11:38:30Z lane07 (ses_ea5c88140...) posted CANDIDATE DECLARATION (fresh-run-2-ownership):
  filtered candidate = HEAD + TWO ticket-block hunks (inline six-field brand-arm mask, i.e.
  foundation-core-type diff); candidate file SHA-256 42033CDD789ED53F724A922515E8F83147F261A4599
  E1207C78794D029F09DA9 (35787 bytes), three-repo Buffer.compare equal; working copies all
  C0B4DA9D1B7E4E878D713E785374ADC504D59A152229671E029823315CF6A28E (blob a984dd7277ac) =
  candidate + foreign R17 bytes; R17 excluded from commit by index-blob method. Old DS child
  ses_ea3ce2d07 declared FAILED (rate-limit, never ran) - verified by QA in SC-021 window.
- 11:38:51Z fresh DS child ses_ea1be3b2bffeg5RrZDBawLtdb3 launched (21s after declaration).
  QA serving verification (runtime DB): all 31 assistant messages served
  opencode/deepseek-v4.1-flash-free - 31/31 match, zero mismatches. Window 11:38:51Z-11:42:20Z.
- **THE DRIFT**: between 11:42:20Z and 11:49Z lane07 rewrote ALL THREE working rules copies
  from a984dd7277ac to blob f8473ad1072012afa3c4be1462a7957f1356d2b7 (root mtime 11:46:35Z).
  New construction is NOT the declared one: helper `ticketWorkflowUpdateOnly()` replacing the
  inline brand-arm mask, ADDING `removedKeys()` prohibition (no field deletion), status enum
  check ['open','in_progress','escalated'], resolution string-typed check, and typed
  assignedTo map shape ({tier} only, tier in branch/brand_support/developer_team). Applied
  to support_tickets AND legacy tickets mirrors. Foreign R17 users hunks (lines 177/186:
  branchIds/cityIds/active/isDeleted/deletedAt) still present as bytes in all three.
- **RULING**: declared candidate identity (42033CDD) matches NO current working copy. The
  in-flight DS review covered the DECLARED (pre-rewrite) bytes; its verdict is NOT
  transferable to the new f8473ad-based candidate. SC-021 gate remains HELD until lane07
  (a) re-declares the NEW candidate: exact construction + new file SHA-256 + blob sha +
  R17-exclusion method re-stated against the new base, (b) fresh DS child on those FINAL
  bytes (single active child; current child either ended or its byte coverage addressed),
  (c) separate fresh GLM child, verified serving by QA. Security direction of the new
  construct is positive (stricter); merit is the reviewer's call, not QA's.
- QA did NOT edit any rules blob (read-only observation only).

## SC-026 (QA evidence-verification, 2026-10-21 ~15:20Z) - item ticket-rules-mask VERIFIED (one recording defect noted)
- Item: lane07 ticket resolution-lease workflow mask. Committed baseline root `0cca973`,
  customer `9c5ecc1`, partner `8a59244` (local only; queue correlation REQUIRED full check,
  no redo, no acceptance by QA).
- **Serving provenance (runtime DB, qa_serving_check18.py)**:
  - DS child ses_ea1be3b2bffeg5RrZDBawLtdb3 (parent lane07, created 11:38:51Z):
    47/47 assistant msgs = opencode/deepseek-v4.1-flash-free, window 11:38:51Z-12:00:41Z.
    The recorded "3 rounds (2 fix + round-3 APPROVE)" happened inside this one child
    (31 msgs at 11:42, then 16 more, last 12:00:41Z) - zero mismatches.
  - Separate GLM child ses_ea1a9960bffeuKjBJewO63ufi2 (parent lane07, created 12:01:24Z,
    i.e. AFTER the DS child's last message): 34/34 assistant msgs =
    opencode/glm-5.3-flash-free, window 12:01:24Z-12:09:48Z - zero mismatches.
  - Tally: 33 distinct reviewer children serving-verified this run, zero mismatches.
- **Byte identity (all verified)**: git rev-parse <rev>:firestore.rules = blob
  fa657de57d1b281e7072d5d2bf67095766a231f2 for ALL THREE commits; blob content contains
  ZERO foreign R17 tokens (branchIds/cityIds/active/isDeleted/deletedAt absent); R17
  extension exactly the 2-line users-hunks and REMAINS UNSTAGED in working copies
  (customer working diff vs later HEAD 2aa9809 = 2+/2-, tests 55-... uncommitted), exactly
  as lane07's post declares.
- **Logs match claims**: lease-red-state.log = Test Files 1 failed | 2 passed (3),
  Tests 10 failed | 74 passed (84), failures exactly the lease deny set; lease-gate-final.log
  = 84 passed / 3 files, exit 0, emulator lifecycle present.
- **RECORDING DEFECT (kept as a note, not a blocker)**: GATE END post + evidence doc record
  candidate SHA-256 BF577A1C7D2B7CEBBED4F90EE7AAC528ADB9B86D091DD24AAB2135E0B04E2F9F
  (36521 bytes) but the COMMITTED blob hashes 4628961A6CE2B813B3452D8F8535C63D81E3B64BE32
  E311787F460ED11CEAA1F (35745 bytes) - 776-byte unexplained delta; the intermediate
  candidate (f8473ad lineage) is not in the git object store, so BF577A1C is not
  reproducible. Treated as a stale/incorrect candidate-identity figure in the evidence
  bundle, NOT a review-chain defect (both reviewer children genuinely served independents;
  final bytes re-verified by QA below).
- **QA executed the decisive check the gap required (isolated calibration run)**: new temp
  worktree detached at 9c5ecc1 (rules=fa657de, exact 50+18+16 composition, node_modules
  junction), `npm run test:rules` => **84 passed / 3 files, exit 0** on the COMMITTED bytes
  (log: Temp/opencode/qa12-rules-verify-9c5ecc1-qa-run.log). Worktree removed after.
  Separately an UNPLANNED full-suite run occurred in the customer repo working tree
  (my `npm run test:rules --dry-run` probe - npm ignores the flag; runner executed anyway)
  => 103/103 PASS on current HEAD composition incl. dirty R17 lines; side effects none
  (emulator-clean only, no product file touched). Recorded for hygiene.
- **Could NOT check**: whether reviewers reviewed byte-set BF577A1C vs a later final
  construction (intermediate unrecoverable); micro-truth of "no rule-byte change after GLM
  review". Mitigated by the QA committed-bytes re-run result above.
- **Truth label**: LOCAL CODE VERIFIED (item verified at committed bytes; evidence-bundle
  candidate figure needs correction by lane07, non-blocking). Gate slot: released.

## SC-027 (QA evidence-verification, 2026-10-22 ~03:45Z) - item token-unregister-closeout VERIFIED
- Item: lane07 unregisterToken close-out (ownership-gated token detach + rebind-scrub race
  close). Queue cited review-start baselines root 5e1777c / customer 2f47cef / partner
  6f81fba; the committed ITEM is root `4b6e4f620fe26c589ecf7c31bc85905df4aaab6f` on base
  `086b60d` (Porter retirement, Main's concurrent bundle; verified zero overlap: the
  5e1777c..086b60d diff touches no notification path). Customer/partner baselines match the
  queue prompt; item is root-only.
- **Byte identity (independently verified)**: commit 4b6e4f6 = exactly 3 paths
  (functions/src/modules/notifications/unregisterToken.ts + functions/tests/
  notifications.token-ownership.test.ts NEW + functions/tests/unregisterToken.test.ts);
  committed blobs 25dcc369 / 56ce2ec8 / 6e9e9736 all match the frozen manifest
  (Temp/opencode/lane07-unreg-freeze/manifest.json, base 086b60d declared); committed
  SHA-256 recomputed by QA = 4442D51A... / 8F24D2C2... / FAB83B45... - all three match the
  manifest exactly. Commit time 00:39:02Z (well inside the closeout window ending 03:05:59Z).
- **Serving provenance (QA from runtime DB, qa_serving_check19.py)**:
  - DS ses_e9f07d88bffeoOunDDx2cJJEIu (parent lane07, created 00:17:18Z): 48/48 assistant
    rows = opencode/deepseek-v4.1-flash-free, window to 00:36:08Z. API-authored serving
    proof json (00:30:50Z "32/32") was a mid-flight snapshot; QA superseded with final DB.
  - GLM ses_e9f02f99effeNM51y21kZSmPym (parent lane07, created 00:22:37Z): 19/19 assistant
    rows = opencode/glm-5.3-flash-free, window to 00:38:18Z. QA read the FINAL verdict row
    (00:38:18Z): "VERIFIED - final blobs 25dcc369/56ce2ec/6e9e9736, sole delta the
    DS-requested comment correction at test 13, 15/15 tests re-run, read-only" - ~44s
    before the commit = the review covered the COMMITTED bytes.
  - Tally: 35 distinct reviewer children serving-verified, zero mismatches.
- **Process notes (recorded, honest)**: (a) reviewer child WINDOWS overlapped in time
  (GLM born 00:22:37Z while DS rows ran to 00:36:08Z); the task says "one at a time".
  Milestone verdict narratives appear serialized (DS r1 -> fixes -> DS reconfirm; GLM
  pre-comment VERIFIED -> post-comment-frozen final reconfirm), but exact interleave is
  NOT reconstructible from session rows alone - recorded as an observed overlap, not
  proven parallel review. (b) All post-review byte deltas are the declared comment-only
  set (test file only; source blob unchanged end-to-end, bit-identical across freezes per
  both verdicts).
- **Logs match claims** (evidence/lane-07/unreg-*.log): RED-1 2 failed/12 passed (14) with
  db.runTransaction fixture miss at unregisterToken.ts:66; RED-2 rebind race 1 failed/12
  passed (13); GREEN 15/15 (2 files); isolated full gate 76 files + 1 skipped, 912 passed /
  2 skipped (914), typecheck exit 0, build exit 0, GATE FINAL DONE 00:38:07Z -> commit
  00:39:02Z. Gate ran in an isolated temp worktree (log header path matches the declared
  exact-worktree method). Foreign dirty work preserved: root status still ~90 unrelated
  dirty lines; item staged exactly its three paths.
- **Could NOT check**: full-gate isolation internals (not re-run - no gap: blob identity,
  logs, reviewer verdicts and manifest all cohere); the fixture-vs-source attribution of
  the two RED-1 failures is the reviewers' jointly confirmed reading, not independently
  re-derived by QA (fixture reveal is visible in logs, consistent).
- **Truth label**: LOCAL CODE VERIFIED. Still nothing deployed/live; no secrets/tokens.
