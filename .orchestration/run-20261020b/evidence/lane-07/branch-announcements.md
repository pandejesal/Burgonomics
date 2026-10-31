# Lane 07 — branch_announcements: cross-branch defacement + topic hijack

Truth label: **LOCAL CODE VERIFIED** (Firestore emulator on the exact bundle).
No deployment, no live project, no PII read/write.

## Hole (pre-fix)

`match /branch_announcements/{docId}` allowed: any staff/customer-relevant
writer to CREATE for any branch, and existing-writers to UPDATE/DELETE the
per-branch announcement record — including rewriting `branchId` and
`targetTopic` to point the record at another branch's subscriber channel
(`upcoming_{branchId}`). The partner app's only client writer is a single
`addDoc` (`burgonomics-partner/src/hooks/useBranches.ts:169-176`); the record
write is the audit artifact for launches (the `upcoming_*` topics are not in
the server's subscribable allowlist today), so record defacement/hijack was
the risk.

## Fix (append-only, topic-bound, shape-bounded)

- `create` = `(globalAnnouncementWriter() || ownsBranch(request.resource.data.branchId))`
  `&& branchAnnouncementTopicBound()` (`targetTopic == 'upcoming_' + branchId`,
  both strings, branchId non-empty) `&& branchAnnouncementShape()`
  (six keys only: `branchId, branchName, title, body, targetTopic, createdAt`;
  `title` ≤ 120 / `body` ≤ 1000 mirroring BroadcastSchema,
  `functions/src/modules/notifications/broadcast.ts`).
- `update, delete: if false` — append-only; no client update/delete path exists
  in either app (verified by sweep: exactly one client touch, the partner
  `addDoc`; zero `updateDoc`/`deleteDoc`/`setDoc` on the collection in app or
  functions source). Server moderation goes through the Admin SDK.
- Role matrix: global write only `brand_owner/developer/support`; `regional_manager`
  loses its undocumented all-branch write (UI Broadcast-button visibility for
  regional_manager on `BranchesPage.tsx:346-354` is lane 02's call, posted on
  the bus); `support` keeps its shipped all-branch write.

## Evidence

- **RED** (14-test pin against pre-fix working bytes, emulator): **5 failed /
  93 passed (98)** — every deny assertion fails with "Expected request to fail,
  but it succeeded": cross-branch create, cross-branch update, delete, topic
  hijack. Log: `announce-red.log`.
- **GREEN (full dir)** (working tree incl. foreign R17 hunks): **103 passed /
  4 files** (55 + 18 FCM + 16 lease + 14 announcements). Log:
  `announce-green-dir.log`.
- **Gate (isolated exact bundle)** (customer worktree detached at `9c5ecc1`,
  overlay = rules blob `6b48c1f…` + pin test + committed
  `scripts/test-rules.mjs` only, node_modules junction): **98 passed / 4 files,
  exit 0** (50 committed + 18 + 16 + 14). Log: `announce-gate.log`.
- **Reviews**: Design Sentinel (round 1 `ses_ea192cd03ffehRPFGakPre4TyO`
  APPROVE_WITH_CHANGES → findings applied: append-only `update,delete: if false`,
  exact-key shape caps, role-matrix cleanup; round 2 same session
  **APPROVE_WITH_NOTES**). GLM 5.3 Flash Free (`ses_ea178c517ffeW95Tfo0O3KSmLk`)
  — **VERIFIED_WITH_NOTES** (hole closure re-derived independently).
- Accepted residuals (documented in the rules comment and review notes, all
  non-blocking, no reader exists in either app today):
  - `branchName`/`title`/`body` text is caller-chosen → mislabeling possible;
    binding it costs one `get()` per write.
  - `createdAt` untyped/unpinned (partner writes client-side `Timestamp.now()`;
    `== request.time` would over-block the shipped flow) — use
    `is timestamp` if tightened.
  - Empty-string `title`/`body` pass (BroadcastSchema has `min(1)`); add
    `.size() > 0` if a reader appears.
  - `LaunchBroadcastModal.tsx` lacks client `maxLength` (120/1000); UX-only note.
  - Volume: no cap on records per branch (inherent to rules-layer fixes).

## Commits (local only, never pushed)

| Repo | SHA | Paths |
|---|---|---|
| root | `6312687` | `firestore.rules` |
| customer | `2aa9809` | `firestore.rules`, `tests/rules/branch-announcements.rules.test.ts` |
| partner | `050a4de` | `firestore.rules` |

All three committed rules copies are git blob
`6b48c1f4102acfa026b6c084a2f569b7e2e0aee5` (verified `git rev-parse
<rev>:firestore.rules`). Candidate SHA-256
`B85E9A5885FA2A90DC3BA7E67848327B0AA6469C638AAFDBB983410233C7874E` (38893 bytes).

The unclaimed foreign R17 hunks (`users/{uid}` deny-list additions + tests
50-54) remain in all three working copies, unstaged and uncommitted
(remaining WT diff: 2 insertions / 2 deletions on `firestore.rules`); the next
owner must re-apply them on top of `6b48c1f`. Indexes were refreshed to HEAD
after the temp-index commits, so the repos are in a sane state for the next
actor.
