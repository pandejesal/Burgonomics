# Reviewer request + verdict template (lane 12, run 2026-10-20b)

Lanes: submit requests on `fresh-run-2-coordination` when your change is complete + your own
tests pass. QA allocates one of 6 global review slots; max 1 active child per lane.

## Review request (lane -> QA, on coordination)
```
REVIEW_REQUEST lane=<NN> sid=<full sessionID>
Files (exact): <committed-or-working paths, minimal>
Change summary: <1-2 lines>
Evidence: <your repro/positive+negative test command + result>   [required]
Base: <commit SHA your change builds on>
```

## Reviewer instructions (QA posts to the child, read-only, fresh session)
- Model pinned: `opencode/deepseek-v4.1-flash-free` FIRST; then separate
  `opencode/glm-5.3-flash-free` verification. Never the author's model.
- Reviewer reads CONTRACT truth labels; reviews behavior against contracts, not style.
- MUST deliver: verdict + findings with file:line + must-fix vs nice-to-have + whether the
  positive/negative tests actually assert the claimed behavior.
- Reviewers never spawn children, never edit files, never push.

## Verdict record (reviewer -> QA, on coordination)
```
REVIEW_VERDICT lane=<NN> reviewer-model=<actual model from session record>
verdict=<APPROVED|CHANGES_REQUIRED> must_fix=<n> summary=<<=3 lines with file:line>
```

## QA acceptance
- A change needs: passing author evidence + DeepSeek APPROVED + separate GLM APPROVED
  (author model excluded), THEN an exact-bundle gate before any commit.
- Gate slots per repo: one heavy gate at a time (qa/gate-log.md). Claim via QA.
