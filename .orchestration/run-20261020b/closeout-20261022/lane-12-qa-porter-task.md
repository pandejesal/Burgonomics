# Existing session: independent QA of the Porter-retirement commit

Queue task: `qa-porter-retirement`. Owner: original root12
`ses_ea5c87413ffeBOyHpHeVPuHIoW` (GLM 5.3 Flash Free), the independent QA session.
No replacement writer. Read `AUTONOMOUS_WINDOW.md`. Deadline 2026-10-22T03:05:59Z.
Main is coordinator only. You are VERIFYING, not accepting and not implementing.

## What is under review

Root commit `086b60d5afe492391d222873f259e6ddc7d760ad` on parent `5e1777c`, exactly
11 paths:

`functions/.env.example`, `functions/src/config/env.ts`,
`functions/src/modules/dispatch/dispatch.router.ts`,
`functions/src/modules/porter/porter.service.ts`,
`functions/tests/dispatch.autoRebook.test.ts`,
`functions/tests/dispatch.porter-retired-guard.test.ts`,
`functions/tests/dispatch.porter-retired.test.ts`,
`functions/tests/e2e.flow.test.ts`,
`functions/tests/env.staging-readiness.test.ts`,
`functions/tests/porter.service.test.ts`, `references/delivery_routing.md`.

Frozen manifest with per-file Git blobs and SHA256:
`C:/Users/DELL/AppData/Local/Temp/opencode/main-porter-retired-v5/manifest.json`
(reference blob `49ecbdaccf04261214e413b381064eab3d76d33c`).

Business decision under test: **Porter is cancelled.** Live dispatch is Borzo or
Shadowfax, or the restaurant assigns its own in-house rider. `PORTER_ENABLED` must be
exactly `"true"` to re-arm Porter, and that re-arms FULL dispatch (new quotes, paid
book, rebook) — there is **no history-only mode**. No real environment variable or
credential was changed by the commit.

## Claims to verify (and the ones that must NOT be believed)

Main's records claim: DeepSeek `ses_e9fd2d77cffe1Dr1APyx5XDaYD` APPROVE (42 assistant
rows, all actually `opencode/deepseek-v4.1-flash-free`), then a separate GLM
`ses_e9f91be90ffeUfDpIdC1zuqEyI` APPROVE (47 rows, all actually
`opencode/glm-5.3-flash-free`); isolated exact-bundle gate at `5e1777c` = typecheck 0,
899 passed / 2 skipped, build 0; pristine-base negative control = 6 failed / 5 passed.

Verify independently and report the truth, including if any of it is wrong:

1. **Commit identity and scope.** Exactly those 11 paths, parent `5e1777c`, no foreign
   paths, no binaries, no secrets, no `.env` values, nothing pushed.
2. **Default is closed.** With `PORTER_ENABLED` unset, `"false"`, `"1"` or any
   non-`"true"` value, Porter must not be quoted, not be booked, not be rebooked, and
   must not appear in the quote fan-out. A fail-open default is the worst outcome.
3. **No spend path survives while retired.** Every automated and direct route that
   could book a paid Porter rider must refuse before any provider HTTP call and
   before any order mutation, with a typed error. Check the fan-out, the direct book
   and rebook routes, the auto-rebook worker, the paste lane, and the poller.
4. **Boot resilience.** Production/staging boot must not require the cancelled Porter
   secrets, while a deliberately re-enabled configuration must still be subject to the
   mandatory-secret and mock-key checks (a mock key must still be refused).
5. **Historical compatibility is preserved where it must be.** Key-authenticated
   historical callbacks and staff-recorded paste bookings keep working; do not demand
   that they be deleted, and do not accept a claim that they are "history-only".
6. **Truth of the documentation.** `references/delivery_routing.md` must not promise a
   history-only mode, must state that in-house delivery is the restaurant's own rider
   (`POST /orders/manualDispatch`, `dispatchType: manual_branch_terminal`,
   `deliveryStatus: dispatched`), must not claim `manually_assigned` is written by the
   backend, and must name the 503 copy's in-house hint accurately.
7. **Test quality.** The new tests must be discriminating (they fail against the
   pristine base — the recorded negative control claims 6 failures) and must not
   assert a mock, a class name, or a comment as behaviour. Flag any test that would
   pass with the protection removed.
8. **No environment or credential mutation.** The commit must not change a real env
   file, and no live Porter integration may be re-enabled by it.

## How to verify

Read-only: you may read the committed tree and the frozen snapshot, run the local
suites with mocks/fakes, and write your report. Do NOT edit source or tests, do not
commit, do not deploy, do not call any provider, do not print secrets. If you need to
prove a negative, use a read-only probe that writes nothing into the repo (a temp
script is fine) and say exactly what you ran.

You may use ONE fresh read-only actual DeepSeek Free reviewer child and THEN a
DIFFERENT fresh read-only actual GLM Free verifier child for your findings; verify
their actual serving models via the local session API; reviewers write nothing and
spawn no children. On 429/transport stop and report.

## Output

Write `.orchestration/run-20261020b/closeout-20261022/qa-porter-retirement.md`
(evidence: git output, commands with real counts, byte-identity checks, verified /
not-verified / could-not-check sections) and post the summary on the bus under
`queue-item-porter-retirement`. Your report is EVIDENCE, not acceptance — Main
accepts or rejects.

Report `QUEUE_TASK: qa-porter-retirement` with the document path, the verified and
refuted claims, any defect with file:line and severity, and the truth label (at most
`LOCAL CODE VERIFIED`). End with the exact unquoted final line
`SUPERVISOR_STATE: COMPLETE` only when the verification is really finished.
