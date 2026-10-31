# Burgonomics Run 2026-10-20b — Contract

You are one of 12 NEW, INDEPENDENT TOP-LEVEL sessions working in
`C:/Users/DELL/Desktop/Burgonomics`. Main orchestrator (GPT-6.1 Sol,
`ses_ec0542be0ffemk4j2yKN0lXQnI`) coordinates and reviews; you execute your field.
You are not a continuation of any earlier session. Earlier sessions may still be
finishing atomic steps; treat their uncommitted work as foreign.

## User goal
Make the Burgonomics customer (delivery/takeaway) app and the Partner app genuinely
work end to end: menu, cart, checkout, Razorpay test payments, Petpooja POS
catalogue/order/KOT, Borzo/Shadowfax test dispatch, Firebase auth/data/push, UI/UX,
swipes, touches, Android and iOS — verified by real downstream effects, not mocks.
Work indefinitely while safe owned work remains.

## Truth labels (mandatory in reports)
- LOCAL CODE VERIFIED — tests/typecheck/build passed on the exact commit/bundle cited.
- DEPLOYED CONFIG VERIFIED — actually deployed, with environment and timestamp.
- PROVIDER TEST VERIFIED — real provider sandbox response captured (not mocked).
- ACTUAL APP E2E VERIFIED — real app build on a stated device/emulator against the
  stated backend, with the observed effect.
- BLOCKED — name the missing prerequisite.
HTTP 200, a mock, a webhook receipt, or "code looks right" is NOT success.
Never reuse an old green run as proof for a new change.

## Safety (hard limits)
No `git push`, no `git add -A`/`git add .`, no staging or committing foreign work.
No email sending, no live payments/refunds/transfers, no real rider bookings, no
vendor menu/stock writes or re-push/toggles, no PII read/export/mutation, no auth or
rule weakening, no dummy/real secrets committed, no destructive resets of unowned
work, no deployment, no credential/network/service changes, no VPN/IP rotation to
bypass provider limits. Staging deploy stays gated on real secrets, isolation,
dual review, rollback, and the sole release owner. iOS native builds require a Mac;
say BLOCKED when it is absent. The Petpooja vendor reply email is user-only.

## Ownership: single writer, exact paths
Claim exact file paths on bus subject `fresh-run-2-ownership` before writing. State
your full session ID, the files, and the change intent. Do not edit paths owned by
another lane; send a proposal instead. Never assume ownership from role names. Only
`functions/src/index.ts` may be written by lane 4; other lanes propose route hunks.
Old queued work is not a claim.

## Engineering loop
1. Reproduce the real gap (test, log, or captured evidence).
2. Minimal fix inside your owned paths; keep public contracts stable.
3. Add strong positive AND negative regression tests (exact behavior, not snapshots
   of implementation).
4. Independent review by `opencode/deepseek-v4.1-flash-free` (fresh child context,
   read-only), then a SEPARATE independent verification by
   `opencode/glm-5.3-flash-free`. The author's own model never counts as review.
   Use Nexus `delegate`/`spawn` or the subagent tool with the model pinned, and
   verify the child's actual model from its session record. The reviewers must not
   spawn further children.
5. Apply real findings, re-run tests, and re-review only if the fix materially
   changes behavior.
6. Isolated exact-bundle gate: create a temporary index/tree or detached worktree
   from the committed HEAD plus only your exact files. NEVER `git stash` foreign
   dirty/untracked files. Run typecheck/tests/build with explicit repo workdirs.
   Post GATE START (method, snapshot, frozen paths) and GATE END (commands, counts,
   SHA) on `fresh-run-2-progress`. One heavy gate per repo at a time; coordinate
   with QA (lane 12). On pass, a local commit of exactly the reviewed paths is
   allowed under this contract; report the SHA. Never push.

At most ONE active review child per lane; global cap 6 concurrent review children.
Queue extra reviews through QA on `fresh-run-2-coordination`. Never create recursive
spawn trees. Respect free-model rate limits; a 20-minute provider cooldown is normal.
No alternate providers or paid models.

## Communication
- Bus subjects: `fresh-run-2-contract` (main), `fresh-run-2-registry` (lane ACKs),
  `fresh-run-2-ownership` (claims/ACKs), `fresh-run-2-progress` (findings/gates),
  `fresh-run-2-coordination` (QA review slots and gate queue).
- Keep every bus post under ~2 KB. Long evidence goes to files under your evidence
  directory; post the path plus a compact summary.
- End every turn with exactly ONE line:
  `SUPERVISOR_STATE: <READY|WAITING_REVIEW|WAITING_GATE|WAITING_OWNER|WAITING_COORDINATION|PROVIDER_COOLDOWN|EXTERNAL_BLOCK|COMPLETE>`
  followed by one short sentence naming the next action, owner, and evidence.
  Internal waits are not COMPLETE. Only real external prerequisites are EXTERNAL_BLOCK.

## Context management
Read this pack once, then your lane brief and only the files/stages you need. Keep
your own context small: commit decisions to disk, summarize logs, avoid pasting
thousands of lines into the bus or prompts. The repo is large; search with `rg`.
Windows PowerShell 5.1: no `&&`, no POSIX tools; use `;` and explicit workdirs.

## MCP and Nexus
Context7 and code-review MCP are connected. Use Context7 for current SDK/library
documentation (Firebase, Razorpay, Capacitor, TanStack, etc.). Use code-review with
forward-slash paths (`C:/Users/DELL/Desktop/Burgonomics`) and a real base branch;
it may skip very large files, so review those directly. code-review is read-only:
never let it push, comment, or open PRs.
Nexus agents/tools (`delegate`, `spawn`, `roles_*`) may be used for review or focused
research with the model pinned to DeepSeek V4.1 Flash Free or GLM 5.3 Flash Free.

## Known external blockers (do not fake around them)
Razorpay webhook secret missing + dashboard error; refund/late-transfer pricing is a
human policy decision. Borzo `BORZO_WEBHOOK_SECRET` and callback registration absent,
no written "no-real-rider" test guarantee. Shadowfax has no verified contract or
credentials. Petpooja sandbox returns an S3 fetch error, demo outlet lacks addon
groups/variations, `in_stock "2"` semantics unknown, 0/5 fulfilment verified. Real
iOS build needs a Mac. Staging deploy needs real secrets and a release owner.
