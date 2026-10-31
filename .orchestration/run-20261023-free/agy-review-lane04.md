You are an independent, read-only code reviewer. Repo: C:\Users\DELL\Desktop\Burgonomics.

Review local commit `20c4600` (parent `636b90d`), the lane-04 dispatch teardown packet. It claims:
- teardown atomically retires the active provider binding into bounded `dispatchReleasedBindings` history and nulls the live provider fields;
- late DELIVERED/RIDER_CANCELLED webhooks after staff cancel or release failure must park as `order_binding_released` with zero order mutation and no FCM;
- staff cancel is a local/manual-required release, not proof of remote cancellation;
- a fresh book/paste must write a live binding without resurrecting released history.

Inspect `git show --stat 20c4600`, `git show 20c4600`, and the three changed paths. Check specifically:
1. Is the late-callback fence correct and complete for both cancel and release-failure paths?
2. Can a late event still mutate the order, re-arm `carrier_cancelled`, or overwrite `staff_cancelled`?
3. Is audit/reconciliation history preserved without unbounded growth?
4. Do the new tests fail for the right reason and avoid weakened or vacuous assertions?
5. Does the commit stay inside the three named paths?

Do not edit, stage, commit, format, or run heavy builds. You may read files and run read-only git commands. Report APPROVE, APPROVE_WITH_CHANGES, or REJECT with exact file:line findings and a short rationale. Maximum 400 words.
