# Lane 04 — registerToken ownership seam (run 2026-10-20b)

Session: ses_ea5c89e34ffeE5jJ0PRSjVSH2k  Model: opencode/glm-5.3-flash-free
HEAD at start: root 4be553b, customer 29fd0e6, partner 09fe39b.

## Defect
`functions/src/index.ts:1231-1237` (POST /notifications/registerToken) writes
`device_tokens/{token}` with `{ merge: true }` and unconditional `userId: uid`:
1. any authenticated caller can REBIND a token already owned by another user
   (silent ownership steal; victim's fcmTokens list keeps the token → both
   accounts' fan-outs hit the same device);
2. two concurrent registers race (read-less merge, last-write-wins) — the
   ratified "race-safe" bar is unmet;
3. ownerless legacy docs can be claimed by anyone (fail-open).

Ratification note in functions/tests/notifications.token-ownership.test.ts
lines 1-4 assigns this seam to lane 4 explicitly.

## Fix shape (single writer: lane 04 only)
- NEW `functions/src/core/deviceTokenRegister.ts` — core/** is lane-04-owned;
  modules/notifications/** is lane 07's, so the sibling of unregisterToken.ts
  lives here. Contract mirrors unregisterToken's ratified shape:
  1 transaction = read token doc + conditional writes (claim | owner refresh);
  foreign/ownerless refuse with ZERO mutation; bounded (20) best-effort prune
  of OTHER users' stale fcmTokens lists afterwards; warns, never echo token.
- `functions/src/index.ts` — route hunk: handler delegates to the seam.
  200 body UNCHANGED { success: true }. Refusals: 409
  refuses with generic message (never echo token/owner).
- NEW `functions/tests/registerToken.ownership.test.ts` — 13 cases: claim
  (+metadata), stale-holder prune, foreign zero-mutation refuse, ownerless
  refuse+warn (absent + non-string userId), idempotent owner refresh,
  claim-cap + warn, prune-query-failure resilience, per-holder scrub failure,
  TOCTOU owner-flip inside tx, tx-infra failure rethrow, missing uid, own-doc
  prune exclusion.

Foreign-dirty files NOT touched: core/validation.ts,
modules/dispatch/dispatch.webhooks.ts, unregisterToken.ts,
tests/notifications.token-ownership.test.ts, tests/dispatch.webhook-boundary.fresh.test.ts.

## Sequence
red test -> fix -> green -> DS review -> GLM verification -> isolated gate
-> local commit (never push).
