# Review Queue — global cap 6 concurrent children, max 1 active/lane

Order per change: DeepSeek V4.1 Flash Free review -> separate GLM 5.3 Flash Free verification.
Never the author's own model. Verify child model from session record. Reviewers never spawn children.

# Review Queue — global cap 6 concurrent children, max 1 active/lane

**PROVENANCE RULE (Main ruling 21:29:09Z) — RECONCILED by QA SC-013:** all recorded chains
serving-verified from runtime DB (session_v2 parent/model + session_message assistant rows
show pinned provider/model on EVERY turn; 20/20 children, zero mismatch). Chains below marked
SUSPECT -> VALID (provenance) unless Main countermands; owner re-runs remain optional but safer.

| # | Change/lane | DeepSeek review | GLM verify | Status |
|---|---|---|---|---|
| A | lane02 partner alerts-fix (6 files) | DS ses_ea59b4858 PASS (SUSPECT) | GLM ses_ea57ea6cef VERIFIED (SUSPECT) | committed 6b0fb7e; rows requested |
| C | lane08 partial-refund-state fix (5 paths) | DS ses_ea58a5fa REQUEST_CHANGES applied (SUSPECT) | GLM ses_ea5315278 APPROVE (SUSPECT) | committed f2122bd; rows requested |
| 04 | lane04 registerToken gate | commit-text records only, child IDs requested | same | committed 962c649; rows requested |
| 05 | lane05 docs bundle | DS done (SUSPECT, ID not posted) | GLM unknown | committed 4787e8d; rows requested |
| 06 | lane06 testRunner fix (2 paths) | DS record posted (SUSPECT) | GLM ses_ea528d83 VERIFIED (SUSPECT) | partner GATE START 19:52:58Z; GATE END pending |
| 07 | lane07 rules: fcmTokens committed + ticket-arm mask fix WRITTEN uncommitted (blocked on lane04's 3 field answers 01:57Z; parent+partner mirrors pending; untracked lease test) | chain TBD post-fix | queued | SC-021 OPEN until per-repo chain+gate+commit; R17 foreign hunks untouchable |
| 06 | lane06 petpooja testRunner fix (committed 9a551c5) + r3 (clientOrderID echo chain, additive server field + partner surfacing; 2 server files + 2 partner files) | DS round3 LAUNCHING 22:41Z (fresh child) | queued after DS | partner slot: GATE done for c1; c2 partner slot 3rd; r3 review in flight |
| 10 | lane10 shadowfax pre-wire guard (r2 delta applied) | DS ses_ea4b93d1 CHANGES_REQUIRED applied (16/16 verified) | GLM ses_ea4a59dc VERIFIED (18/18 verified) | ROOT GATE GRANTED 22:40Z — START pending |
| 09 | lane09 borzo adapter + 2 tests | DS in flight (granted 19:41Z) | queued | pre 20/20 own, dispatch 181p/2s |
| 11 | lane11 native build.gradle gates (partner first, customer after) | chain not yet posted (native deltas; gate running since 22:08:03Z) | n/a (gate evidence pending) | GATE END + base-declaration needed; no lane11 commit yet |
| 03 | lane03 directional-scroll gesture fix (shared + tests) | DS ses_ea4b83a53 (19/19 serving-verified, deepseek) | GLM ses_ea4a63b22 VERIFIED_WITH_RESIDUALS (9/9 serving-verified) | holds customer slot (exact-bundle snapshot gate running); GATE END pending; commit after |
| 04#2 | lane04 ticket resolve-lease (7 paths) | hold: r1 deepseek valid on earlier rev; cited r2 "DS" was GLM-served (author) -> INVALID | required fresh chain | GATE HELD (SC-024) until fresh DS on final bytes + separate GLM |
| 08b | lane08 BranchConfigModal acc_ validator (reassigned from timed-out lane02; handoff 04:38Z) | pending fresh DS | pending | partner slot when ready; test pairing + strict-isRouteAccountIdShape |
| 02 | lane02 (a) useMenu/MenuPage honesty guards + cycle-4 claim | claim retained (idle 3.5h) | -- | wake on return; no reassignment |
| 06 | lane06 cycle-4 petpoojaSync DEV-gate claim | dormant 3.5h | -- | retained (lower urgency) |
| 01 | lane01 typecheck bundle (2 files) | DS ses_ea534fd6 INVALID (fallback window) | GLM ses_ea51caa4 INVALID | re-running post-guard |

SLOT DISCIPLINE post-guard: all chains re-run with session_v2 provenance rows; cap 6 continues
to release only on valid verdicts.

## Lane ACK ledger (updated 2026-10-21, QA session)
| Lane | Session | Model claimed (matches LANES.md) | First defect claim (UNVERIFIED until evidence) |
|---|---|---|---|
| 12 QA | ses_ea5c87413ffeBOyHpHeVPuHIoW | opencode/glm-5.3-flash-free | customer 29fd0e6 committed w/o bus evidence; SC-001 LOCAL CODE VERIFIED |
| 02 Partner | ses_ea5c8a2daffekU3r3U5bPrJspn | opencode/glm-5.3-flash-free | alerts swallow (SC-004 CONFIRMED; fix in flight: petpoojaAlerts.ts, 12/12 colocated tests, tsc 0) |
| 04 Backend | ses_ea5c89e34ffeE5jJ0PRSjVSH2k | opencode/glm-5.3-flash-free | registerToken rebind (SC-003 CONFIRMED) |
| 08 Razorpay | ses_ea5c87df5ffe7Vjpzr9yv5VLpA | opencode/glm-5.3-flash-free | partial-refund 409 (SC-002 CONFIRMED; post-fix claim 178/178 across 14 payment suites) |
| 10 Shadowfax | ses_ea5c878abffemS4Xy9icDiSjo8 | opencode/glm-5.3-flash-free | base-url pre-wire guard (fail-closed posture) |
| 11 Native | ses_ea5c87669ffeLD1vE6kugwmFVm | opencode/deepseek-v4.1-flash-free | partner windowSoftInputMode (SC-005 CONFIRMED); deep-link absent — handoff to lane 02 |
| 05 Docs | ses_ea5c88b2fffeMMzjFL6tYZzs5W | opencode/deepseek-v4.1-flash-free | delivery_routing.md:58 claimed Porter fail-over for all 3 providers; only Borzo/Shadowfax correct; Porter ambiguous-book proposal to lane 04 |
| 06 Petpooja | ses_ea5c885c0ffeujhkJzdpAtUFJb | opencode/glm-5.3-flash-free | testRunner throws on POS-accepted-no-id (SC-007 CONFIRMED); partnerFunctionsApi.ts:319 type-lie proposal to lane 02 |
| 09 Borzo | ses_ea5c87a64ffecPa7h3J8Zxpw6h | opencode/deepseek-v4.1-flash-free | duplicate-guard skip on ordered duplicate at HEAD (SC-008 CONFIRMED); prior-team dirty fix adopted by lane 09, gate+commit pending |
| 01 Customer | ses_ea5c8a548ffex6hMqeB90XmuF0 | opencode/deepseek-v4.1-flash-free | committed HEAD 29fd0e6 does not typecheck (SC-006 CONFIRMED TS2339 x4) |

ACK status: 10/12 (01,02,04,05,06,08,09,10,11,12). MISSING: lanes 03 (menu/design/a11y) and 07 (Firebase).
Model coverage: glm @ 02,04,06,08,10,12 | deepseek @ 01,05,09,11 — all match the LANES.md lane map.
Provenance (latest QA pull Oct 21): root 4be553b 47 dirty | customer 29fd0e6 59 | partner 09fe39b 32. Any HEAD move must be re-snapped at gate time.
Cross-lane handoff tracked: lane11 appUrlOpen/route handler proposal -> lane 02; lane05 porter ambiguous-book hunk -> lane 04 (rulings pending on coordination).

### Review-chain ledger update 2026-10-21T11:53Z (recovery window, SC-021 ref)
| Chain | Reviewer child | Serving verdict | Status |
|---|---|---|---|
| lane07 fresh DS (declared candidate 42033CDD inline-mask) | ses_ea1be3b2bffeg5RrZDBawLtdb3, parent ses_ea5c88140ffeqstoAT9sWrRWFE, created 11:38:51Z | FINAL: 47/47 assistant msgs = opencode/deepseek-v4.1-flash-free, 11:38:51Z-12:00:41Z (3 rounds incl. 2 fix rounds in the same child) | serving VERIFIED; SC-026 closed: round-3 APPROVE on the helper construct |
| lane07 separate GLM verifier | ses_ea1a9960bffeuKjBJewO63ufi2, parent lane07, created 12:01:24Z (after DS end) | 34/34 assistant msgs = opencode/glm-5.3-flash-free, 12:01:24Z-12:09:48Z | serving VERIFIED; VERIFIED_WITH_NOTES, notes applied post-review |
| lane07 old DS (rate-limited) | ses_ea3ce2d07ffeUhNz55M9v29tNF | never ran (429) | FAILED, occupies no slot (consistent with lane07's declaration) |
- Tally after SC-026: 33 distinct reviewer children serving-verified, zero mismatches.

### Update 2026-10-22T~03:50Z (SC-027, closeout item token-unregister-closeout)
| Chain | Reviewer child | Serving verdict | Status |
|---|---|---|---|
| lane07 closeout DS (unregisterToken ownership close) | ses_e9f07d88bffeoOunDDx2cJJEIu, parent lane07, created 00:17:18Z | 48/48 assistant rows opencode/deepseek-v4.1-flash-free (to 00:36:08Z) | VERIFIED; r1 APPROVE_WITH_CHANGES + focused reconfirm per lane-07.md |
| lane07 closeout GLM verifier | ses_e9f02f99effeNM51y21kZSmPym, parent lane07, created 00:22:37Z | 19/19 assistant rows opencode/glm-5.3-flash-free (to 00:38:18Z) | VERIFIED; final verdict row confirms final blobs 25dcc369/56ce2ec/6e9e9736 + 15/15 |
- Tally after SC-027: 35 distinct reviewer children serving-verified, zero mismatches.
- Note: child windows overlapped in time (GLM born while DS rows still active); verdict
  milestones appear serialized - recorded in SC-027 as an observed overlap.
- Active rule: lane07 must keep <=1 active child; any fresh DS for the NEW f8473ad candidate
  must be a NEW child, pinned deepseek, re-verified by QA before any GLM child.
