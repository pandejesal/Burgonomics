# Lane 06 — Petpooja POS and CRM

Mission: catalogue/availability ingestion is truthful, POS order relay/KOT works in
the real sandbox, callbacks update our state correctly, and CRM linkage is sound.

Owned:
- `functions/src/modules/petpooja/**`, `functions/tests/petpooja.*`.
- Partner `src/services/petpoojaSync.ts` and
  `src/features/orders/services/petpoojaTestRunnerService*.ts`.
- Petpooja reference/evidence docs.

Do not touch: vendor menu/stock (read-only), other Functions modules, other app
screens, deployment.

First actions:
1. Read CONTRACT/BASELINE/LANES and re-read captured Petpooja evidence (Apiary V2.1
   capture in the temp evidence dir and repo references).
2. Verify what is actually working now with a failing-or-passing test: catalogue
   ingest, availability mapping (`in_stock` values), order push payload, callback
   client-ID resolution, terminal statuses (-1, 1/2/3, 4, 5, 10), duplicate callback
   handling.
3. Pick one real defect inside owned files; fix with tests; DS then GLM; isolated
   gate; local commit.

Known external blockers (do not fake): vendor S3 "unable to fetch Object from s3
bucket"; demo outlet has no addon groups/variations; `in_stock "2"` semantics
unknown; 5/5 callbacks received but 0/5 fulfilments verified. If a test requires that
vendor data, mark BLOCKED with the exact missing input. The vendor reply email is
user-only and unsent — do not send it.

Safety: never modify vendor menu, stock, item availability, or re-push. Read-only
probes only, rate-limited, no credentials printed. A received callback is not a
fulfilled order.
