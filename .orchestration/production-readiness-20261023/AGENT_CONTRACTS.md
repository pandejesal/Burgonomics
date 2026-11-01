# Agent contracts and independent evidence

Only the explicitly selected zero-cost routes are used by worker sessions. Nexus
default role models are not relied on: they include non-free/stale model IDs.
An agent marked running is not evidence of completion or correctness.

| Role | Model | Session | Exclusive write scope / status |
|---|---|---|---|
| Explorer | `google/antigravity-gemini-3.8-flash-high` | `ses_e98a83498ffezWoMbsEDKvM3aq` | Read-only; three static candidates returned |
| Dispatch author | `opencode/deepseek-v4.1-flash-free` | `ses_e98a67aaeffeezdPJz2GuK8oid` | Porter service, dispatch router, new race tests; writer finished |
| Dispatch reviewer | `opencode/glm-5.3-flash-free` | `ses_e988bd589ffeEqpagZ5Do1rMiC` | Read-only; CHANGES_REQUIRED; 59 focused tests reproduced |
| Petpooja author | `google/antigravity-gemini-3.8-flash-high` | `ses_e988b2d69ffeFJOf0eS0zQxgXa` | Petpooja push, scheduler, stock service and scoped tests only |
| Mobile artifact tester | `google/antigravity-gemini-3.8-flash-low` | `ses_e9889ce77ffe42WIAZFTydscHu` | Read-only; do not repeat completed build or customer gate |
| Stage architect | `google/antigravity-gemini-3.8-flash-medium` | `ses_e98882e3bffeJC18r8B6EtMDLB` | Read-only; propose next-stage contract, not deployment |

## Known verification boundaries

- Dispatch author: 59 focused PASS / tsc 0; 16 new tests fail on base source.
  Reviewer independently reproduced the 59 PASS, but found blockers. No acceptance.
- Customer: isolated committed tree `7affdf6`, 99 files / 757 PASS, tsc 0.
  Rules tests excluded, no rules/emulator pass implied. Mobile build exit 0.
- Hosting validator tests: 22/22 PASS. Assembled mobile hosting fixture:
  25 PASS / 2 FAIL (Apple Team ID placeholders); release remains BLOCKED.
- Petpooja findings are candidates until discriminating regression tests pass;
  suggested fixes from a static audit are not automatically authorized designs.
- No live provider, money, rider, device, deployment, or store approval evidence.

## Review and acceptance sequence

1. Finish the sole scoped writer; freeze exact changed files.
2. Reproduce negative controls in an isolated external fixture.
3. Independently review with a model different from the author.
4. Apply blocker fixes; re-review changed bytes.
5. Run one isolated full backend gate: typecheck, tests, build. Record real exits
   and counts; aborted attempts are incomplete, never passes.
6. Commit exact accepted files locally on the worktree branch; no broad staging.
7. Enter offline production rehearsal with explicit human external gates. Do not
   equate local test success or a receipt HTTP status with provider fulfilment.
