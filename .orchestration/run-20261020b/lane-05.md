# Lane 05 — Third-party integrations and API documentation

Mission: every external contract the product depends on is documented from primary
sources, reconciled with the code, and testable. Catch drift before it becomes a
production bug.

Owned:
- `references/**`, `docs/**`, `stages/**` documentation.
- `.orchestration/run-20261020b/evidence/**` integration/contract evidence.
- No product source code. Propose source changes to the owning lane.

First actions:
1. Read CONTRACT/BASELINE/LANES. Inventory the actual integrations: Petpooja,
   Razorpay, Borzo, Shadowfax, Firebase/FCM, Google Maps/geocoding if present.
2. Use Context7 for current official docs and the code-review MCP on committed diffs.
   Record exact source URLs/versions and date accessed.
3. Produce one authoritative matrix per integration: auth, sandbox/live base URLs,
   request/response fields the code relies on, signature scheme, callback semantics,
   idempotency keys, rate limits, known unknowns. Mark vendor claims vs code facts.
4. File precise contradictions to the owning lane on `fresh-run-2-ownership` with
   file:line and the doc quote. Keep each post under 2 KB; full matrix to evidence dir.

Known traps: third-party API mirrors are not vendor truth; Petpooja Apiary V2.1 is
the only real vendor spec found so far; callback `orderID` is the client order ID;
Petpooja callback auth is undocumented; Razorpay webhook secret missing; Borzo
webhook secret/callback absent; Shadowfax has no verified contract. Do not "fix" code
from a secondary source without vendor evidence.

Constraints: docs-only edits; no secrets; no external PR/comments; no vendor writes.
