QUEUE_TASK: customer-address-server-truth

Closed the four address debts in local commit `ea1bc3f` (base `98c8dc4`), 5 reviewed paths, 1148+/21-. 37 foreign dirty entries untouched; no push/deploy.

- **Debt 1 CLOSED — server seed.** `hydrate()` seeds the signed-in uid from `addressService.list()`. A failed read writes nothing; the uid guard blocks A→B; a revision merge protects newer local writes; tombstones block resurrection; unsynced local-only rows are kept. The route shows loading instead of a false empty state and a persistent alert on failure.
- **Debt 2 CLOSED — promotion truth.** Deleting the default clears the unconfirmed local promotion, mirrors via `setDefault`, and presents the default only after confirmation. A failed mirror keeps the committed delete, leaves no row flagged default, and returns `DEFAULT_PROMOTION_FAILED`; a mid-mirror switch returns `AUTH_CHANGED`.
- **Debt 3 — already correct.** `AddressForm` already showed an accessible error, no success toast, retained input, and did not call `onSaved` (no navigation). Test added only.
- **Debt 4 — adopted.** a11y suite 13/13 green against the committed component.

Blobs: `6c19548` repository, `50ec7ce` route, `edb191b` persistence tests, `a6ddc73` form tests, `ee4a87d` a11y (all equal to the frozen manifest; SHA256 in evidence).

RED: 10 of 12 new behaviour tests failed over `98c8dc4` (7 seed, 3 promotion). GREEN: 56/56 focused; dirty-tree regression 104 files/818 tests; isolated gate 94 files/721.

Review: `ses_e993a7074ffe2rkfvYY2nemzRZ`, actual serving model 12/12 `opencode/glm-5.3-flash-free` (author is DeepSeek; POLICY forbids author-model review, so GLM was the independent review), **APPROVE_WITH_NOTES**, no blocker/major.

Isolated gate at `98c8dc4` + only the 5 paths: `tsc` 0, `npm test` 0 (94/721), `build` 0 (7.51s). `GATE START`/`GATE END` posted; lane 03 released.

Remaining limits: seed runs on saved-addresses mount (checkout-first cold start); a server collection with no default clears an unmirrored local flag; tombstones are not pruned; the route loading/error branch is proven at repository level and by review only. Evidence: `.orchestration/run-20261020b/closeout-20261022/lane-01-address-debt.md`.

SUPERVISOR_STATE: COMPLETE