# Evidence Matrix (reconciled ~02:3xZ 2026-10-21; lane 12 QA)

Rules: every cell needs method + result + truth label. Historical BASELINE greens are CLAIMS only.
Labels: UNVERIFIED / LOCAL CODE VERIFIED / LOCAL BUILD VERIFIED / DEPLOYED CONFIG VERIFIED /
PROVIDER TEST VERIFIED / ACTUAL APP E2E VERIFIED / BLOCKED(reason).

| Field | Label | Evidence / gap |
|---|---|---|
| Customer app (delivery/takeaway) | PARTIAL-LOCAL | Commits QA-verified: 29fd0e6 (SC-001 6/6), 355ba9f rules, 530dd20 (SC-017: repo-wide tsc 0), 2801d17 (SC-018 39/39). Full historical 772/55 coherence NOT re-run in this session; whole-suite gate still outstanding |
| Partner app | PARTIAL-LOCAL | QA-verified commits: 6b0fb7e (SC-010 21/21), 9a551c5 (SC-014 20/20), 05cbbf2 (SC-015 gate 514p/1s/0F), 170efcc (SC-019 5/5+6/6), 358c4c4 (SC-016 5/5), 593a09f (SC-022), 643eb09 oldest-wins (lane gate 205p claim), d7b8d69 mirror rules. Full partner suite not re-run wholesale |
| Menu | UNVERIFIED | Petpooja sync defects being repaired (lane06 cycle2 committed 643eb09); client-side menu functions unproven this run |
| Cart | UNVERIFIED | No targeted evidence captured yet |
| Checkout/payment (Razorpay) | PARTIAL-LOCAL | Defect SC-002; fixes f2122bd (SC-012) + 358c4c4 (SC-016) + 980ef3e chokepoint (chain serving-verified) LOCAL CODE VERIFIED. External: webhook secret missing + dashboard error => PROVIDER TEST impossible; no money ops |
| Tracking | UNVERIFIED | No fresh gate evidence in this session |
| Petpooja POS/CRM | BLOCKED | External blockers (S3 fetch error, in_stock '2', addons/variations, 0/5 fulfilment) + lane06 fixes committed (testRunner 9a551c5, echo chain 64fc3c0/b9b2d9a) LOCAL CODE VERIFIED, but fulfilment stays unverified. Vendor menu/stock writes prohibited |
| Firebase auth/data/rules/FCM | PARTIAL-LOCAL | 962c649 registerToken (SC-009 16/16) + lane07 rules chain (355ba9f/6e4bfdd/d7b8d69; GLM ses_ea4a2eb31 20/20; 70+18 emulator cases claim) + SC-021 ticket-arm hole confirmed & lane07 fix in flight (supervisor-b packet). No deploy allowed. R17 foreign hunks unclaimed |
| Borzo dispatch | BLOCKED | External: no BORZO_WEBHOOK_SECRET, no callback registration, no no-real-rider guarantee. Duplicate-book guard committed b4d43ed (lane09 chain verified; negative control 14F/13P pre-commit vs 27/27 post; QA re-ran 15/15) |
| Shadowfax dispatch | BLOCKED | External contract/credentials absent; fail-closed guard committed 3c8c7c7 (serving-verified chain; QA re-ran 29/29) |
| Android | LOCAL BUILD VERIFIED | SC-022: release signing fail-closed guard both apps (593a09f, 6719ceb); assembleDebug BUILD SUCCESSFUL both repos (apks 29.98MB/24.55MB) + 5 negative controls + pre-fix debug-signed release defect proof; DS+GLM serving-verified. Not an E2E label; no device install claimed |
| iOS | BLOCKED | macOS/Xcode absent (lane11); AASA TEAMID placeholder user-only. No native build possible |
| Docs/contracts | PARTIAL-LOCAL | SC-011/014/018: delivery_routing.md doc-vs-code truth; probe DOC_MATCHES_CODE 11/11 at HEAD b14908e; evidence bundles committed (03aeb8b, b14908e, fee8b16). Wider references/ docs unaudited |

## Provenance snapshot (current)
- root HEAD b9b2d9a (14-commit verified chain per SC-020; 47+ foreign dirty preserved)
- customer HEAD 6719ceb (dirty firestore.rules foreign M preserved)
- partner HEAD 593a09f (26+ foreign dirty preserved)
All dirty/untracked = FOREIGN until claimed. QA labels only from executed/observed evidence.

## QA evidence compliance
- 32/32 reviewer children serving-verified from runtime DB (session_v2 + session_message);
  monitors/supervisors explicitly NOT counted as signoff.
- Two gate-slot overlap events logged (no artifact contention); enforcement notes issued.
