# Gate Log — one heavy gate at a time per repo

Slot states: FREE / CLAIMED(lane, since, evidence) / RUNNING(lane, process/artifact) / DONE.

| Repo | State | Lane | Evidence |
|---|---|---|---|
| root/functions | chain DONE x11, slot OPEN | 04,08,05,10,07,09,08,06 | Full parent-verified chain through HEAD b9b2d9a per SC-020: 962c649(04) -> f2122bd(08) -> 5265047(05) -> 70a09be(04) -> b4d43ed(09 borzo; negative control 14F/13P pre-commit vs 27/27) -> 55c1cac(05) -> 03aeb8b(05) -> 3c8c7c7(10; QA 29/29) -> 80ca5b6(04 tx; serving-verified; declared base b4d43ede = re-parented in main chain — reconciliation noted) -> 6e4bfdd(07) -> fee8b16(05) -> b14908e(05) -> 980ef3e(08 chokepoint; chain verified) -> b9b2d9a(06 r3 echo; chain verified; gate base b14908e 2 commits behind — declared, flag only). NEXT root candidates: lane08 r3 chain gate request (chain verified 17/17), lane04 canonical-tip full-bundle gate |
| partner | FREE | -- | HEAD 170efcc (lane02 c3, SC-019 verified); lane06 643eb09 committed (oldest-wins; chain DS ses_ea484dcb0 verified) + b-original 9a551c5; lane08 358c4c4 (SC-016); lane07 d7b8d69 mirror rules. lane11 GATE END never posted -> released per idle rule; must re-claim with base-declared START |
| customer | FREE | chain: 355ba9f (07) -> 530dd20 (01; SC-017 repo-wide tsc 0) -> 2801d17 (03; SC-018 39/39 src/shared) | next customer candidates: lane03 follow-up gesture/a11y packets, native lane11 customer gate, authorize to project per ownership |
| — (next) | QUEUED | lane 11 native | partner+customer native gates; lane11 must post GATE END/base-declaration; JDK21 JBR, compileSdk 36 |

Pending gate declarations (not yet occupying a slot; no process/artifact evidence yet):

### 2026-10-21T11:52Z QA recovery update (SC-021 lane07 rules packet)
- No gate/commit by anyone since HEAD b9b2d9a / 6719ceb / 593a09f (7h outage, verified by both
  supervisors). Recovery wave delivered 11:36:31Z both models ok; Main's 2 continuations
  (lane07 + lane12); watcher OFF.
- lane07 declared candidate 11:38:30Z (filtered 42033CDD over blob a984dd72 working) and
  launched fresh DS child ses_ea1be3b2b at 11:38:51Z - QA serving-verified 31/31 deepseek
  (window to 11:42:20Z).
- ALL THREE working rules copies then drifted to blob f8473ad (root mtime 11:46:35Z): a NEW
  helper-based construct (ticketWorkflowUpdateOnly + removedKeys prohibition + typed
  status/resolution/assignedTo checks), NOT the declared inline-mask candidate. Foreign R17
  users hunks still present as bytes in all three working copies.
- Rules gates (three-repo mirror) remain HELD pending: re-declaration of the new candidate
  bytes + fresh DS on final bytes + separate GLM (detail: SC-025 in spot-checks.md).
- **CLOSED ~13:20Z (SC-026)**: lane07 ran DS round-2/3 inside the same verified child
  (47/47 deepseek final), separate verified GLM child (34/34), GATE END 12:17:57Z with
  re-declared candidate, commits 12:18-12:19Z (root 0cca973 / customer 9c5ecc1 /
  partner 8a59244, blob fa657de three-way identical, R17 excluded), all QA-verified; QA
  independently re-ran the recorded 84-test suite on the committed bytes => 84/84 pass.
  Recording defect noted: evidence candidate figure BF577A1C/36521 ≠ committed
  4628961A/35745 (stale figure, non-blocking). Slot released.
- lane 03: customer gesture-fix gate — after DS+GLM reviews.
- lane 04: paste-lane (defect #2) gate — after chain completion.
- lane 01: typecheck bundle gate — re-run post-guard chain first.

Calibration runs (targeted single-test re-runs, not full gates) run in parallel only with
isolated snapshots (detached worktree/temp tree) and are logged in spot-checks.md.
