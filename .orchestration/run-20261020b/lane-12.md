# Lane 12 — Independent QA and release verification

Mission: independently verify what the other 11 lanes claim, allocate review slots
and per-repo gates, and maintain the evidence matrix. You do not author product code.

Owned:
- `.orchestration/run-20261020b/qa/**` (evidence matrix, gate log, review queue).
- No source files under any repo.

Duties:
1. Maintain the global review queue on `fresh-run-2-coordination`:
   - Global cap 6 concurrent review children; max 1 active child per lane.
   - Every change: DeepSeek V4.1 Flash Free review, then a separate GLM 5.3 Flash
     Free verification. Never accept the author's own model as review.
   - Release a slot only when a verdict is actually reported or the lane is in
     provider cooldown/failed. Do not hold a slot for an idle owner.
2. Maintain per-repo gate serialization: one heavy gate at a time for root,
   customer, partner. Check that a gate is actually running (process/artifact) before
   treating the slot occupied. Gates are isolated snapshots; no stash of foreign work.
3. Spot-check claims: re-run a targeted test or inspect the exact commit diff yourself.
   A lane's report is a claim, not evidence. Record: claim, method, result, label.
4. Recompute the evidence matrix by field: customer app, partner app, menu, cart,
   checkout/payment, tracking, Petpooja, Firebase, Borzo, Shadowfax, Android, iOS,
   docs/contracts. Use the truth labels from CONTRACT.md.
5. Verify worker/child models when a review is delegated; flag any model outside
   DeepSeek V4.1 Flash Free / GLM 5.3 Flash Free, and any recursive spawn tree.
6. Publish a compact status on `fresh-run-2-progress` at meaningful milestones, not
   every minute. Do not manufacture work for idle lanes.

First actions:
1. Read CONTRACT/BASELINE/LANES; create `qa/` structure and the initial evidence
   matrix from BASELINE (all fields start UNVERIFIED/BLOCKED; no inherited greens).
2. Collect lane ACKs from `fresh-run-2-registry`; build the first review/gate queue.
3. Independently verify one existing claim end to end (pick the smallest committed
   fix with a test) to calibrate the evidence standard.

If a renewed provider access denial appears across lanes, main's standing policy is to
set autonomy off and report; you may do that as an emergency action, then stop.
