# Petpooja vendor attachment reconciliation — 2026-10-28

> **Post-reading correction:** `documentation-review.md` supersedes this report's
> unresolved pricing/discount questions and its narrow candidate assessment.
> The earlier tests prove attachment shape and GST conservation, not financial
> compliance. Restaurant-only totals, GST ownership, COD collection applicability
> and selection mappings remain implementation/reconciliation blockers. Use
> `email-draft-doc-reviewed.md`, not the preserved initial `email-draft.md`.

## Scope and evidence

- Input attachment: `C:\Users\DELL\Downloads\commented payload.txt`, SHA-256
  `4af49d4f6f4313bf71234579aaa0b41b9364a58946ea03597062e28c621144e2`.
- Context: user-provided `C:\Users\DELL\Desktop\PETPOOJA NEW EMAIL.txt`; Petpooja's
  reply identifies structural issues and requests the same five sandbox cases again.
- Owned candidate: `.swarm-worktrees/petpooja-vendor-contract-20261028`, based on
  the clean approved backend `c26effe`. The dirty root checkout and the original
  backend checkout were not overwritten. Candidate changes are uncommitted.
- No credentials were read, no provider/API call or sandbox order was sent, and
  no deployment or email send occurred. This is offline implementation evidence.

## What actually differed

The clean backend already includes the earlier vendor-envelope corrections.
New tests derived from this exact attachment confirmed every supplied object key
and primitive type on both builders for the five requested scenario shapes:

| Check | Clean backend result |
|---|---|
| Root auth fields and lower-case `orderinfo` | Matches after the caller adds credentials |
| `OrderInfo`, `udid`, `device_type` nesting | Matches |
| Five `OrderInfo` sections with `details` wrappers | Matches |
| Order, customer, restaurant, item, add-on and tax keys/types | Matches |
| Numeric add-on `group_id`; Boolean flags; string amounts/quantity | Matches |
| Per-unit `final_price = price - item_discount` | Matches |
| No legacy duplicate envelope members or `Discount` object | Matches |
| Odd-paise GST conservation | FAILED in both builders before this correction |

The newly reproduced failure is concrete: for the combined add-on/variation case,
the authoritative order GST is **₹13.95**. Independently formatting each half
emitted **₹6.97 + ₹6.97 = ₹13.94** in the clean backend. The revised allocation
uses integer paise, retains the authoritative GST total and captured rates, and
builds summary amounts from the exact serialized item-tax rows. The same example
now allocates **₹6.98 + ₹6.97 = ₹13.95**. No GST rate, order total, discount policy,
delivery-fee policy or liability choice was changed.

Positive GST with no matched item tax rows is now refused rather than producing
an untaxed item alongside a taxed summary. Existing outlet/metadata/identifier
guards remain in force; the sample's illustrative IDs are never treated as real
outlet configuration.

## Exact historical submissions are not available here

The five order IDs in the email were not found in the searched local source and
JSON/Markdown/text evidence. The available `scripts/petpooja-sandbox-evidence.json`
in the root is a later **dry run of one scenario**, not those five HTTP requests.
Therefore this report does not claim a byte-for-byte audit of the rejected bodies,
the deployed artifact, their callbacks, or physical KOT printing.

The root checkout has a different, uncommitted version of these modules and the
sandbox script. Changes must be reviewed/integrated deliberately; passing this
candidate does not certify or install the dirty root version.

## Reference extraction and tests

The attachment is annotated, not a ready-to-send HTTP body. The test contract was
derived by removing line comments and the unprefixed explanatory text after
`final_price` on source line 132 **in memory only**. No original file was edited.
Only object keys and primitive types were retained in
`functions/tests/fixtures/petpooja-vendor-attachment-shape.json`; no credentials,
customer contacts, coordinates, illustrative prices or example outlet IDs were
copied. Populated array members supply the schema for empty example arrays.

The ten builder/scenario combinations use explicitly synthetic, numeric shape
fixtures. They are unit tests, **not sendable outlet-configured orders**. A mutation
test detects misplaced envelope fields and string add-on group IDs. Additional
tests cover GST conservation and deterministic minor-unit allocation.

Initial focused test: **11 passed / 2 failed**, exposing the rounding defect.
After correction: **65 focused tests passed** plus typecheck exit 0. One additional
negative regression then pinned the positive-GST/empty-tax-row guard.

Final backend gates on the complete candidate:

```text
npx tsc --noEmit                                      exit 0
npx vitest run --maxWorkers=1 --no-file-parallelism     1,345 passed / 2 skipped / 0 failed
npm run build                                        exit 0
```

There were 124 passing test files and one skipped file. The skipped tests are
not emulator, vendor or production proof. `gates-final.json`, `typecheck-final.log`,
`tests-final.log` and `build-final.log` retain the final evidence; the earlier
`gates.json` and logs are preserved separately. Seven source/test/reference files
are fingerprinted in `candidate-manifest.json`. No test expectations were weakened
and no skip/filter was added to obtain a passing result.

## What remains before resubmission

1. Confirm current sandbox item/add-on/group/variation mappings. The last recorded
   vendor menu snapshot described in `references/petpooja_save_order_api.md §19.3`
   has no usable add-on/variation definitions; no current live menu fetch is claimed.
2. Confirm add-on price inclusion, item versus order discount treatment, odd-paise
   rounding expectations and the integration's GST/charge liability decisions.
3. Review and integrate the candidate into the intended serving backend, then
   explicitly authorize the sandbox-only run. Capture the actual redacted request
   bodies, new client IDs and responses without overwriting older evidence.
4. Obtain Petpooja's review/approval. HTTP save acknowledgement, downstream order
   state and physical KOT printing are separate evidence gates.

`email-draft.md` is a truthful clarification/retest-preparation email, not a claim
that five revised orders have already been sent or approved. It has not been sent.
