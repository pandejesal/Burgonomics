# Lane 10 — Shadowfax rider dispatch

Mission: Shadowfax integration is either correctly implemented against a verified
official contract or fails closed with no ambiguity. No invented signatures.

Owned:
- `functions/src/modules/dispatch/providers/shadowfax.adapter.ts`
  (and Shadowfax-only helpers).
- `functions/tests/dispatch.shadowfax*`.

Do not touch: dispatch shared webhooks/router/readiness (lane 04), Borzo adapter,
app repos, deployment.

First actions:
1. Read CONTRACT/BASELINE/LANES; inspect the adapter, committed `08ec278` fail-closed
   work, and the review packet referenced in prior evidence.
2. Verify the fail-closed credential/provenance behavior and identify one real gap
   that does not require live credentials: config validation, error mapping, retry
   semantics, declared-value handling, status mapping, response parsing.
3. Claim exact files; fix with tests; DS then GLM; gate; commit.

Known external blockers: no verified official contract or credentials; declared-value
policy unresolved; production host untested. Do not fabricate a contract, signature,
or sandbox result. Mark PROVIDER TEST as BLOCKED. Fail-closed behavior is the
deliverable until real credentials/contract exist.

Safety: no live bookings; no production-host calls; no made-up secrets.
