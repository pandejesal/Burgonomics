# Petpooja Structural Workstream — READY_REVIEW Report

## Coordinator wakeup status
Direct-channel delivery attempted per instructions: OpenCode background service found at
`http://127.0.0.1:49380` (`opencode service get`), API requires a password
(`OPENCODE_PASSWORD`) that is set in neither the environment scopes, `.config/opencode/.env`,
auth.json, the session DB, nor service config — not discoverable non-interactively.
`opencode api` CLI path errors identically. Discovered schema/CLI as instructed; no retries
beyond one probe per endpoint. **The bus post (finish-coordination-20261027) is the delivery
channel that succeeded** — coordinator should read this report file for full evidence.

- **Session:** ses_e8881ff0dffowHGEHoHqzomqvF
- **Coordinator:** ses_e94d6379dffePDVml2TD7LGSxA
- **Date:** 2026-10-27
- **Scope honored:** Petpooja ONLY in `.swarm-worktrees/polish-backend-20261025` @ac6cea2 (+ other lanes' pre-existing uncommitted fixes untouched). No merges, no deploys, no vendor relay, no emails, no credentials printed, dry-run only for the sandbox script. Root dirty repos untouched.

## Verdict: READY_REVIEW (structural port complete, gated, zero fabricated acceptance)

## What was done (iteration 1 — change list)

Three-way inspection: ac6cea2 (base, hardening-rich, OLD payload structure) vs root dirty
(user's vendor-structure edits, hardening-stripped) vs vendor sample `commented payload.txt`
+ handoff `petpooja-structural-handoff-20261026.md`. The vendor structure was ported into
the isolated worktree builders; ALL base hardening (F3 posAccepted reconciliation, F5 crash-lane
claim marker, K1 transport-ambiguity parking, F7 tombstone/ghost-SKU guards, doc-id anomaly
census, branch-scoped relay access) retained. Never whole-file copy.

### Changed files (SHA256 of the working-copy bytes)

| File | SHA256 |
|---|---|
| functions/src/modules/petpooja/orderPush.ts | e3c560ffc6e80fc187ea64d671bccc17619ca8926bb80fe5f66479eab388a074 |
| functions/src/modules/petpooja/testRunner.ts | 319043894d73f5ce66c581f942dffd9d1c88d2d0b61eebcec5e500c2b8937be5 |
| functions/src/modules/petpooja/menuSyncWebhook.ts | e34f1e1fc228493866353fae7dbd18f262d01c13c2ac0a51e0b7c118b3f45d8d |
| functions/tests/petpooja.service.test.ts | aa71032ec19dc8297f4676dffbae576c78f0e278df407d9cc68340c64d5bef40 |
| functions/tests/petpooja.structural-contract.test.ts (NEW) | 39a6c058ee5a62c87d62f180f5b7979fc2e992b1b694ed125f81a42dfd51389e |
| functions/src/modules/petpooja/testRunner.test.ts | 2ba0647c638d55f6a85a15d03e2d3aec6d198aae543896be51004463c7709c01 |
| scripts/petpooja-sandbox-5scenarios.mjs | a9f255a3be2fb7e79a8e959d0d135b0d14c6394628153af631dee18ee6a7da53 |
| references/petpooja_save_order_api.md | 54a07f0bf7a864a38b75c215a7cb0798bbf9d54480eed1e5a71439294c6e625f |

Not touched: notifications/payments/auth/rules files, petpooja.scheduler.ts,
petpooja.kot-ambiguity.stress.test.ts, all root files.

### orderPush.ts (app order path)
1. Envelope LOCKED to the vendor sample: root body = credentials + one `orderinfo`
   containing ONLY `OrderInfo` (Restaurant/Customer/Order/OrderItem/Tax, each
   `{details}` wrapper) + `udid:""` + `device_type:"Web"`. Removed: root-level echo
   fields (`restID/res_name/...`), `Discount` member, legacy aliases
   (`tax_details/order_items/items/customer_name/customer_phone/...`), line aliases
   (`addon_id/addon_name/addon_items/item_id/item_name/addons/item_attribute`).
2. New `orderDocId` param — `Order.details.orderID` is now the FIRESTORE document
   id (the callback resolution key), not the decorative order number.
3. `final_price` = UNIT price (`price - item_discount`), per vendor sample; OLD
   line-total form removed (was wrong for qty>1). `tax_inclusive: false` matches
   our tax-exclusive pricing + the outlet menu.
4. `Tax[].price` numeric percentage string ("2.5", not "2.5%").
5. Sample-required members added: `sc_tax_amount`, `dc_tax_amount`, `dc_tax_percentage`,
   `dc_gst_details`, `pc_*` equivalents, `ondc_bap`, `urgent_order`, `urgent_time`,
   `no_of_persons`, `description`, `collect_cash` (COD=full total, ONLINE=0.00 — retained
   policy), `otp:""`. Typing per sample: `enable_delivery`/`min_prep_time`/`urgent_time`
   NUMBERS; `no_of_persons`/`collect_cash`/`otp`/`preorder_*` strings.
6. Customer lat/lng now carried from the order's delivery address (was always "").
   Address/truthfulness: nothing invented.
7. RETAINED BUSINESS POLICY (not flipped to sample arithmetic): `gst_liability:"restaurant"`,
   COD full-total / ONLINE 0 collect, enable_delivery 0 (third-party riders).
8. Fail-closed structural gates (fail-open gaps fixed): exported
   `PetpoojaStructuralError` (`code: "BLOCKED_CONFIGURATION"`) thrown by the builder when
   (a) a line's Petpooja item id cannot be verified (no empty ids), (b) add-ons carry
   no verified NUMERIC POS addon id / numeric `group_id` (no literal "addon", no
   `Number(internal) || 0` fabrication, no `mod_` fixtures pretending configured),
   (c) a line that declares a variation need carries no verified variation id.
   `pushOrderToPetpooja` catches the gate, parks `pending_configuration` (NOT
   pending_retry — config is the cure, retry can never fix it), writes a HIGH severity
   snapshot, makes NO vendor call, and returns false honestly.
9. Debug visibility paths re-pointed to the new envelope; POST headers extended with
   `Content-Type-Override` + `app-key`/`app-secret`/`access-token` (the tested sandbox
   relay's header set), `Content_key`/`Authorization` kept.

### testRunner.ts (sandbox relay path)
1. Same vendor-locked envelope ported (identical members/typing, no aliases, no
   Discount, no root echo).
2. Contacts: clearly-SYNTHETIC non-empty values only in this test-only path —
   `9000000000` (reserved fictional), `sandbox.tester@example.com` (RFC 2606),
   "Sandbox" naming; matches sample's non-empty contact expectations without risking a
   production customer identity. Never a fake production customer.
3. NEW exported `evaluatePetpoojaTestOrderSendability(order)` — structural verdicts
   mirroring the app-path gates (missing/non-numeric item id, unverified addon id,
   unverified variation id). `relayScenarioToPetpooja` REFUSES to POST any order with
   gaps: returns `{ok:false, reason:"BLOCKED_CONFIGURATION"}` — the blocked report is
   the product, never a fabricated acceptance. `runPetpoojaTestScenario` surfaces it as
   statusCode 409 with `code: "BLOCKED_CONFIGURATION"` + gap detail.
4. Relay headers extended to the tested set (as above). Prompt-generation and MT-01
   scenario fixtures unchanged in identity; canonical scenarios keep HONEST ids
   (mod_/var_ fixtures are NOT presented as configured — they UNSIGNED-verdict to
   BLOCKED_CONFIGURATION).

### menuSyncWebhook.ts (ingest path)
1. TAX CATALOGUE CAPTURE (record-only + provenance): exported typed helpers
   `captureTaxCatalogue`, `parseItemTaxCsv`, `parseTaxInclusiveFlag` +
   `CapturedPetpoojaTaxRow`. Outlet `taxes[]` rows are captured to
   `branches/{id}.petpoojaTaxes` ONLY when id + parseable positive rate resolve, stamped
   `petpoojaTaxesSource:"menu_push"` + timestamp; unsupported rows are counted
   (`petpoojaTaxesUnsupportedRowCount`) and surfaced. A catalogue that captures ZERO rows
   leaves petpoojaTaxes UNWRITTEN (a guessed id could name no outlet row) and emits a
   MEDIUM snapshot with actionable reasons + "vendor decision needed".
2. Per-item tax metadata captured on product docs: `petpoojaItemTaxIds` (CSV → string
   list), `petpoojaTaxInclusive` (STRICT decode; `null` = undecodable, recorded, never
   coerced), `petpoojaGstType`, `petpoojaTaxUnsupported` (tax-inclusive items or item tax
   rows not named by the captured catalogue — unrepresentable in the uniform GST model,
   flagged truthfully). Mixed/inclusive catalogues emit a MEDIUM "vendor decision needed"
   snapshot; the order push keeps branch-level rows until the vendor decides. Census on
   the sync-log row: taxCatalogCaptured/Unsupported(+reasons)/petpoojaTaxesWritten/
   itemsTaxInclusiveTrueCount/itemsTaxInclusiveUnknownCount/itemTaxIdsUnresolvableCount.

### scripts/petpooja-sandbox-5scenarios.mjs (DRY RUN ONLY — no vendor call made)
1. Dry-run no longer requires credentials/mapping code (prints masked placeholders);
   LIVE mode unchanged and still aborts on missing config — and was NOT invoked.
2. Reads totals from the new envelope paths.
3. Per scenario, imports the dist sendability gate and reports BLOCKED_CONFIGURATION
   scenarios (addons/variation cases this outlet cannot configure) WITHOUT relaying them
   — dry-run never claims acceptance; success:1 is NOT acceptance (as before, verdicts
   require vendor success + order id).

### references/petpooja_save_order_api.md
§18.4 rewritten: Discount member removed entirely per sample; §18.5 rewritten: final_price
tension RESOLVED by the vendor sample (unit figure) with the pinning test list, the
sample-locked typing facts, retained-policy non-flips, and the outstanding vendor
questions recorded (total-includes-delivery semantics; GST liability split). Unsupported
scenarios stated truthfully: addons/variations on this outlet are configuration-blocked,
not payload-fixable.

## Tests (all exits real)

Focused (petpooja.service + structural-contract + testRunner.test):
**83 passed / 0 failed** (~8.5s).
- petpooja.service.test.ts — 37: full envelope sweep, unit final_price qty3, COD/ONLINE
  collect_cash policy, variation empty-vs-set + legacy spellings, order_type H/P/D,
  CartLine id/price resolution + prefix stripping, GST line-share arithmetic,
  BLOCKED_CONFIGURATION for missing item id / "mod_" id / literal "addon" / missing
  group id / non-numeric internal group id (old `Number(...)||0` fabrication banned) /
  unverified variation need; hardening blocks (bruteforce, not-found snapshots etc.)
  retained and green.
- petpooja.structural-contract.test.ts (NEW) — 7: shared sanitized vendor-shape fixture
  across BOTH builders; sample-strict sweep (envelope only, `udid/device_type`,
  no Discount, numeric tax strings, unit final_price invariant per line, numeric-string
  quantity, orderID == doc id callback resolution, COD full collect); forbidden legacy
  key JSON-string sweep; all-5-scenario runner payloads + sendability verdicts (exactly
  takeaway-with-modifiers blocked); menuSync tax-capture helpers (typed rows, refused
  non-array, strict tax_inclusive decoding); orderPush builder refuses unverified addon.
- testRunner.test.ts — 39: NEW builder-structure describe (envelope, orderID=client
  reference + callback, COD collect, unit final_price qty2, numeric tax price + integer
  group_id, synthetic contacts non-empty) + sendability describe with the RELAY refusing
  to fetch on BLOCKED_CONFIGURATION (fetch mock asserted never called).

Full functions gate (this workstream owns the slot):
- Run 1: 1302 passed / 1 failed / 2 skipped — the single failure was a payments-lane
  file (`config.mock.paymentGateway = false; razorpay.keyId ...` assertion, another
  owner's uncommitted work, not my files) — non-deterministic, NOT asserted as green on run 1.
- Run 2 (immediately after, full): **1303 passed / 0 failed / 2 skipped, exit 0**
  (raw log: `C:\Users\DELL\AppData\Local\Temp\opencode\petpooja-3way\full-vitest-run2.txt`).

Compiles/builds: `npx --no-install tsc --noEmit` exit 0; `npm run build` exit 0.
History baseline (1283 pass) invalidated by all lanes' changes as instructed; no reuse.

Dry-run evidence (no vendor call):
`node scripts/petpooja-sandbox-5scenarios.mjs --dry-run` → scenario 1 (items_tax) +
4 (discount_tax) print structurally-reviewed payloads; scenarios 2 (addons_tax),
3 (variation_tax), 5 (addon_variation_tax) → **BLOCKED_CONFIGURATION (dry-run reported,
no relay)** with field/reason detail; exit 1 honestly reports blocked scenarios.

## Vendor questions outstanding (recorded in §18.5, not guessed)
1. Total-includes-delivery semantics (our order total includes the delivery fee; sample
   example agrees arithmetically but wording pending) — preserved existing explicit policy.
2. GST liability split: sample's example rows differ from our full-restaurant policy —
   retained ours pending vendor confirmation.
3. Sandbox addon/variation configuration: cases 2/3/5 need vendor-side sandbox test
   configuration on a outlet that PUBLISHES addon groups/variations (§19.3: current
   capture has none — no valid id could ever be sent).
4. Unsupported tax shapes (tax-inclusive items / mixed-rate catalogue): captured
   truthfully on product docs; push keeps branch-level rows until the vendor decides.

## Explicit non-claims
- No structural acceptance claimed: ANY vendor call (relay/verify) remains human-gated
  and was not performed. Empty sandbox contacts replaced with clearly synthetic
  test-only values; no fake production customer fabricated.
- The Payments-lane run-1 flake is reported as seen, not smoothed over.
