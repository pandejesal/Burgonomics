# Correction and sandbox resubmission progress — 2026-10-28

## Working contract

The user explicitly corrected the sequence: implement and verify, resubmit the
five sandbox scenarios, and only then prepare a results-bearing vendor email.
Do not send an acknowledgement or recycle the earlier clarification drafts.
No email has been sent by this task.

Owned worktree: `.swarm-worktrees/petpooja-vendor-contract-20261028`, clean base
`c26effe867c662f2008445ee6dae73d176c77bb8`. The dirty root checkout is not the
implementation target. Changes remain uncommitted, unmerged and undeployed.

## Implemented since the documentation review

- New shared `financials.ts` keeps restaurant due separate from customer total.
  Item GST ownership is derived explicitly from captured menu `gst_type`:
  `services` → vendor, `goods` → restaurant; missing/unknown values block.
- Both builders exclude vendor-remitted GST and third-party courier charges
  from restaurant due. `restaurant_liable_amt` sums only restaurant-owned tax.
  The customer's charged total and the payment pricing engine were not changed.
- `collect_cash` is zero unless the order is COD plus merchant self-delivery.
  Production reads the existing persisted `manual_branch_terminal` dispatch
  marker; counter orders do not become self-delivery from that marker alone.
- The trusted product prefetch now carries captured GST ownership. The live
  test-runner resolves ownership through product snapshots, not hardcoded test
  scenarios, and reports malformed/missing configuration before provider traffic.
- Persisted all-in `unitPrice` takes precedence over legacy `basePrice`.
  A base-only legacy line includes its explicit modifier prices once.
- Coupon and loyalty discounts both contribute to the order-level discount.
- Earlier attachment-shape and integer-paise GST conservation corrections remain.

## Tests and boundaries

The new financial contract tests first reproduced nine real failures. All eleven
new tests then passed. Existing fixtures were updated to explicitly declare
their synthetic GST ownership. Old assertions expecting courier charges in POS
total or positive merchant cash instructions on third-party orders were replaced
with the documented exact amounts, not removed or weakened.

Focused verification: `npx tsc --noEmit` exited 0 and
`npx vitest run petpooja --maxWorkers=1 --no-file-parallelism` passed
**282 tests in 17 files**. No skips or timeouts were added.

Full package gates were inspected after completion: typecheck exit 0, build
exit 0, **1,356 tests passed / 2 skipped / 0 failed**, with 125 passing files and
one skipped file (150.14 seconds). Results are retained in `gates-financial.json`
and the matching typecheck/test/build logs. All 16 changed application/test files
in `financial-corrections-manifest.json` still matched their fingerprints after
the gates. No provider, deployment or emulator approval is inferred from this.

The work is not a blanket financial-compliance or production-readiness verdict.
Current outlet charge-tax settings, selected add-on membership, variation
child-item/master mappings and actual five-scenario coverage still need to be
verified against current sandbox data. The older MT-01 aliases do not themselves
prove all five vendor cases: a generic delivery or bulk case must not be reported
as a variation or combined-modifier test merely because its alias says so.

## Current sandbox evidence

- A read-only menu query for **only** demo mapping `31z58ciw0h` returned HTTP 200
  with `success: "0"`, message `unable to fetch Object from s3 bucket`, no menu.
  This is not an order submission or a basis for invented option mappings.
- The existing reserved-IP tunnel was restored after the restart. Its status
  reported egress `137.23.58.8` and sandbox HTTP 200. No new cloud VM was created.
- Staging sign-in displays a reCAPTCHA and disables Sign In until completed.
  No CAPTCHA was solved automatically or bypassed. A visible, isolated Brave
  session through the tunnel was opened and its supplied staging credentials
  filled without printing or exporting their values. The user must complete the
  human check and sign in.
- The accessible browser CDP endpoint is loopback-only `127.0.0.1:9222`; the
  temporary profile is `Temp/opencode/petpooja-resubmit-browser-20261028`.
  Do not use a personal profile or dump cookies/configuration/credential fields.

No revised Save Order request has been sent. After access is available, read the
existing sandbox menu/configuration, map every selected option to that outlet,
validate the corrected five payloads, and submit each once while retaining its
redacted request, response and client reference. A transport ambiguity requires
listing reconciliation, not a blind retry. Then verify listing/callback evidence
and draft the results email. Do not edit the sandbox menu or callback settings
merely to force a successful test, and do not claim physical KOT/vendor approval.

## Sandbox configuration checkpoint — 2026-10-28 07:19 UTC

This section supersedes the earlier CAPTCHA/menu-edit restriction: the user
completed CAPTCHA and explicitly chose **Configure demo (Recommended)**. This
authorizes only the test mappings needed in outlet 5439 / `31z58ciw0h`, not
production data/configuration changes or sending email. The authenticated Brave
session and reserved-IP tunnel survived earlier restarts. Check liveness before
restarting either. No revised order has been submitted, no menu push pressed,
and no email sent.

Configuration evidence is under
`C:\Users\DELL\AppData\Local\Temp\opencode\petpooja-docs-20261028`.
Do not repeat the successful saves below:

- 30674, Paneer Achari Tikka, INR310: add-ons enabled, real group 17259
  **Soft Drinks**. Initial save succeeded. API-area-only repair subsequently
  returned success but did not persist. Root cause: the parent item was inactive
  even before our edits, so saving an inactive parent disabled API exposure.
  Activation plus API-area 3737 enabled was saved and freshly read back as
  active/API-enabled (`sandbox-item-30674-activation-071409.json` and matching
  readback HTML). No price change.
- 30672, Tandoori Paneer Tikka, INR270 variant: child **10657617**, variation
  master **14178 Full [8 Pieces]**. Active parent, API-enabled parent and child
  were verified after activation (`sandbox-item-30672-activation-071413.json`
  and matching readback HTML). Parent base price zero is the native variation
  editor's behavior; variant API price remains 270. Group17259 is currently
  **single selection, min1/max1**, not optional. Use it for the combined case,
  not a variation-only case.
- 30673, Paneer Malai Tikka, INR290: separate variation-only demo configuration,
  child **10657618**, master **14178**, no add-ons. Saved once and verified
  active, parent/child API-enabled, API variant price290, packing0. Evidence:
  `sandbox-item-30673-variation-only-config-071644.json` and
  `sandbox-final-additional-items-readback-*.json`.
- 30791, Tandoori Dahi Kebab, INR350: activated once for plain Items+Tax and
  Discount+Tax; no add-ons or variations. Fresh readback active/API-enabled.
  Evidence: `sandbox-item-30791-activation-*.json` and additional-items readback.
- Master group17259 options verified earlier: 93021 Coke10, 93023 Diet Coke20,
  93019 Thumps Up30, 93027 Fanta40, 93025 Nescafe Cold Coffee50.
- Tax editors read ONLY: 3928 CGST2.5%, 3929 SGST2.5%, active forward percentage
  taxes, both assigned to API area3737 and all three order types. No tax
  configuration was changed. Evidence: `sandbox-tax-readback-*.json`.
- Read-only Custom Configuration returned allow_packaging_charge1,
  packaging_applicable_on NONE, fixed charge blank; current item packing0.
  Evidence: `sandbox-charge-configuration-071850.json`. Do not infer universal
  zero charge taxation. The five vendor cases can avoid nonzero charge scenarios.
- Staging account configuration confirms Save Order host
  `https://qle1yy2ydc.execute-api.ap-southeast-1.amazonaws.com/V1/save_order`.

Read-only Firestore discovery: `stores/demo` maps petpoojaRestId31z58ciw0h to
partnerBranchId demo, isDemoOutlet true. A masked get of
`products/prod_demo_30674` confirmed branchId/demo and petpoojaItemId30674, but
returned no petpoojaGstType or tax metadata in the requested mask. The document
last changed 2026-10-17. This does not establish GST ownership. Do not inject
synthetic ownership into the live builder just to clear its fail-closed gate.

Next: obtain authoritative item gst_type/tax-inclusivity and item-specific tax
mapping read-only; the published-menu request previously returned missing S3
object. A menu push would reach the registered production Firebase webhook and
can update app data: do not press it under demo-only approval. Inspect native
read-only item detail/menu sources first. Build genuine vendor cases from the
verified compiled builder, not the stale placeholder script or MT-01 aliases;
then validate, submit once per case with restart-safe redacted evidence, and
reconcile listing/callbacks before drafting a results email.

Immediately before the restart, navigation from Custom Configuration back to
Menu list and the subsequent CDP-liveness probe timed out without output. Check
the actual browser URL/session and tunnel; do not assume navigation succeeded,
and do not repeat any successful configuration save.

## Completed resubmission checkpoint — 2026-10-28 07:55 UTC

**Do not resend any of the five orders below.** This section supersedes earlier
"no revised orders" and metadata-blocker statements. The user separately chose
**Publish demo menu**, authorizing that specific publication to the existing
Firebase webhook. The normal first tax-confirmation screen did not publish.
Its confirmation was performed once; final webhook delivery returned HTTP503.
The exact generated outgoing menu was captured in
`sandbox-menu-publish-final-response-redacted.json` in the temporary evidence
directory, providing current services/vendor GST, tax-exclusive pricing,
3928/3929 tax mappings, real options, and explicit zero charge-tax flags.
No retry of the failed menu publication was made. Firebase sync is not verified.

The already-verified compiled **production** builder was used with snapshots
derived from that generated vendor menu. All16 existing application/test hashes
still matched the passed typecheck/full-test/build manifest. No new application
code was changed in this resumed portion. A preparation-only script checked all
five against the attachment key/type fixture, verified memberships and child/
master identities, all-in unit prices, quantity, discount and paise conservation.
The old placeholder script and mislabeled MT-01 aliases were not executed.

Each order was sent exactly once at 13:23:38–41 IST:

| Case | Client reference | Restaurant due | GST | Portal internal ID |
|---|---|---:|---:|---|
| Items + Tax | bgx2_items_tax_1793173921627 | 350 | 17.50 | 255258 |
| Addons + Tax | bgx2_addons_tax_1793173921628 | 320 | 16.00 | 255259 |
| Variation + Tax | bgx2_variation_tax_1793173921629 | 580 | 29.00 | 255261 |
| Discount + Tax | bgx2_discount_tax_1793173921630 | 300 | 15.00 | 255260 |
| Addon + Variation + Tax | bgx2_addon_variation_tax_1793173921631 | 580 | 29.00 | 255262 |

All five responses were HTTP200/success1, `Your order is saved.`, matching
restID/clientOrderID and an empty POS orderID. Each was independently verified
in Order Listing and its order detail, including expected add-on/variation
labels, quantity2 in variant cases, discount50, GST and restaurant total.
All remain **Waiting For Acceptance**. Portal internal IDs are not API-returned
POS order IDs. No Accept/Cancel/status action was taken. Lifecycle callbacks,
physical KOT printing and vendor approval remain unverified.

Restart-safe original transmission journals are
`Temp/opencode/petpooja-docs-20261028/save-order-bgx2_*.json`, each written and
fsynced BEFORE transmission; the transport refused any existing batch journal
and had retries0. **Never rerun `submit-verified-five-once.py` for this batch.**
The preparation plan preserves the same IDs; do not regenerate them.

Durable credential-scanned exports in this worktree's output directory:
- `sandbox-resubmission-results.json`: receipts, listing/detail evidence, IDs,
  totals and remaining gates.
- `sandbox-resubmission-payloads-redacted.json`: five exact request structures
  with credential values redacted and their responses; safe email attachment.
- `sandbox-menu-mappings-verified.json`: vendor-generated menu provenance.
- `email-draft-resubmission-results.md`: substantive Reply All draft, written
  only after all five were saved and verified. **Not sent.** Earlier drafts
  remain preserved but are superseded.

References now record current runtime results in Save Order §22 and POS §6.1.
No deployment, commit or merge. Remaining work is webhook503 remediation,
persisted production option provenance/ingestion, callback lifecycle proof,
physical KOT evidence and vendor review/production approval, not another batch
submission. `git diff --check` passed (only Windows line-ending warnings).
