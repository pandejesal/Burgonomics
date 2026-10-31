# Lane 07 — Ticket resolution lease is client-writable (main critical path)

Truth label: **LOCAL CODE VERIFIED** (Firestore emulator on the exact bundle).
No deployment, no live project, no PII read/write.

## Delivery record

`functions/src/modules/tickets/tickets.service.ts` owns a **resolution lease** on
`support_tickets/{id}` (mirrored on legacy `tickets/{id}`):

- `resolutionClaim = { actorUid: string|null, claimedAt: <ms epoch> }`
- written inside `claimTicketResolution()`; `RESOLUTION_CLAIM_TTL_MS = 2.5 min`;
  `commitResolvedTicket()` fences on `claim.claimedAt === claimToken`; success
  and `releaseResolutionClaim()` delete the field.

The rules allowed `allow update: if isBrandOwner() || (branch arm with a field
mask)`. Because the brand arm had **no mask**, a brand_owner client could:

1. plant a fresh `resolutionClaim` → every staff resolver gets a 409
   `TICKET_RESOLUTION_IN_PROGRESS` for 2.5 minutes;
2. clear/overwrite a **live** claim → the in-flight resolver's fenced commit
   fails with `TICKET_RESOLUTION_CLAIM_LOST`;
3. fabricate the server's money-audit `resolution` **map**
   (action/amount/refundResult/resolvedBy — `tickets.service.ts:769-778`);
   the partner UI renders it as a done refund and the genuine resolve then
   fails with `TICKET_ALREADY_RESOLVED`;
4. re-stamp `branchId`/`customerId`; and
5. `deleteField()` server fields straight through `affectedKeys().hasOnly()`
   (MapDiff counts removals as affected).

## Fix (no role widening, no branch-arm semantic change)

One helper, `ticketWorkflowUpdateOnly()`, used by **both arms of both
collections**: no `removedKeys()` among the six workflow fields,
`affectedKeys().hasOnly([status, resolution, assignedTo, timeline,
lastActivityAt, updatedAt])`, `status` a non-terminal string
(`open`/`in_progress`/`escalated` — `resolved`/`closed` stay server-only),
`resolution` string-only on both sides (the server's money map is untouchable),
`assignedTo` a single-tier map with `tier` in
[`branch`, `brand_support`, `developer_team`] (`tickets.service.ts:171`).

## Evidence

- **RED** (final 16-test file, emulator, against committed HEAD bytes
  `44f4b476…`): **10 failed / 74 passed (84)** — every deny assertion fails with
  "Expected request to fail, but it succeeded": claim inject, claim clear,
  money-map fabrication, tenant re-stamp, no-claim-after-refusal,
  deleteField erasure, terminal status, legacy mirror, dual-role, assignedTo
  shape. Log: `lease-red-state.log`.
- **GREEN** (exact-bundle gate, customer worktree detached at `6719ceb` +
  node_modules junction, overlay = rules blob + test + runner only): **84 passed
  / 3 files, exit 0** (50 pre-existing + 18 FCM + 16 lease). Log:
  `lease-gate-final.log`.
- **Reviews**: DeepSeek V4.1 Flash Free (`ses_ea1be3b2bffeg5RrZDBawLtdb3`) —
  3 rounds, round-3 **APPROVE** after applying: deleteField/removedKeys guard,
  string-only client `resolution` + non-terminal `status` enum (its suggested
  alternative would have broken the committed "Looking into it" pin),
  `assignedTo` tier shape+enum, single helper instead of 4 duplicated masks,
  legacy+dual-role tests, and an isolated deny payload for the money-map guard.
  GLM 5.3 Flash Free (`ses_ea1a9960bffeuKjBJewO63ufi2`) — **VERIFIED_WITH_NOTES**
  (pre-fix abilities re-derived independently from `git show HEAD`);
  its 3 actionable notes applied after the review (assignedTo mutation
  coverage, `closed` deny test, real RED re-run). GLM residual notes:
  timeline whole-list swap remains possible inside the mask (pre-existing,
  rules cannot distinguish `arrayUnion`); file as follow-up.

## Commits (local only, never pushed)

| Repo | SHA | Paths |
|---|---|---|
| root | `0cca973` | `firestore.rules` |
| customer | `9c5ecc1` | `firestore.rules`, `tests/rules/ticket-resolution-lease.rules.test.ts` |
| partner | `8a59244` | `firestore.rules` |

All three committed copies are git blob `fa657de57d1b281e7072d5d2bf67095766a231f2`
(verified `git rev-parse <rev>:firestore.rules`). Candidate SHA-256
`BF577A1C7D2B7CEBBED4F90EE7AAC528ADB9B86D091DD24AAB2135E0B04E2F9F` (36521 bytes).

The unclaimed foreign R17 hunks (`users/{uid}` deny-list additions + tests 50-54)
remain in all three working copies (`M firestore.rules` everywhere), unstaged and
uncommitted; the next owner must re-apply them on top of `fa657de`.
