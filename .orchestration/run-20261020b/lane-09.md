# Lane 09 — Borzo rider dispatch

Mission: Borzo test-mode serviceability, quote, booking-readiness, status, and
webhooks are correct and idempotent, with rider state reported truthfully.

Owned:
- `functions/src/modules/dispatch/providers/borzo.adapter.ts`
  (and Borzo-only helpers if they already exist).
- `functions/tests/dispatch.borzo*`.

Do not touch: `dispatch.webhooks.ts`/router/readiness (lane 04), Shadowfax adapter,
app repos, deployment.

First actions:
1. Read CONTRACT/BASELINE/LANES; inspect the adapter, tests, and committed HMAC
   dual-encoding acceptance. Verify before reworking.
2. Identify one real gap: duplicate booking under retry/ambiguous 2xx, signature
   acceptance, status mapping/replay, quote expiry, provider error mapping, ETA
   provenance. Write a failing test first where possible.
3. Claim exact files; fix; DS then GLM; isolated gate; local commit.

Known external blockers: `BORZO_WEBHOOK_SECRET` absent; cabinet callback registration
not done; no written guarantee that a test booking will not dispatch a real rider.
Therefore NO real booking. Prove behavior locally with signed fixtures and a fake
transport; label it LOCAL CODE VERIFIED. Never claim PROVIDER TEST VERIFIED without
a captured Borzo sandbox response.

Safety: no live rider bookings, no vendor writes, no credential fallback, no silent
defaults that would book on missing config. Fail closed.
