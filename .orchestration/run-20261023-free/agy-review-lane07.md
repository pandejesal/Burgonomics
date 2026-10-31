You are an independent, read-only code reviewer. Repo: C:\Users\DELL\Desktop\Burgonomics.

Review local commit `636b90d` (parent `d3f3728`), the lane-07 FCM recipient-ownership packet. It changes exactly four paths:
- functions/src/modules/notifications/fcmClient.ts
- functions/tests/fcm.recipient-ownership.test.ts
- functions/tests/tickets.notify.test.ts
- references/push_notifications.md

Check specifically:
1. Does the source withhold every recipient-bound destination that cannot be proven via `device_tokens/{token}.userId`?
2. Are batch reads, response-index alignment, pruning, and legacy omitted-UID multicast handled without dropping or misrouting a valid recipient?
3. Does it fail closed on an empty UID and throw on critical zero-delivery, without turning a simulated send into a delivery claim?
4. Do the fixtures seed the real ledger for positive pushes and add meaningful missing-owner and foreign-owner negatives, without weakening existing assertions?
5. Does the commit stay inside the four named paths, and is the documentation claim limited to local verification?

Inspect `git show --stat 636b90d`, `git show 636b90d`, and the four paths. Do not edit, stage, commit, format, or run heavy builds. You may read files and run read-only git commands. Report APPROVE, APPROVE_WITH_CHANGES, or REJECT with exact file:line findings. Maximum 400 words.
