# Petpooja documentation review — 2026-10-28

## Conclusion

The attachment-shape and one-paise allocation work remains useful, but the
candidate is **not ready for integration approval or sandbox resubmission**.
The full documentation answers questions the initial email should not have asked
and exposes financial/collection gaps that its shape tests do not cover.
This pass changes reference material and drafts only; no application source or
test expectation was changed, and no provider account was operated.

## Reading coverage and provenance

| Source | Coverage |
|---|---|
| `Downloads/API Guide for Placing Orders on Petpooja POS.pdf` | All 9 pages; rechecked the field tables and formula against the PDF text |
| `Downloads/Petpooja Sandbox Guide for Integration Testing.pdf` | All 6 pages, including optional authentication/header configuration and sandbox/production separation |
| `https://onlineorderingapisv210.docs.apiary.io/` | Introduction, changelog, all ten API sections, collapsed child attributes, public request/response examples and request-header names |
| Stored `docs/petpooja-online-ordering.md` | Complete 749-line rendered snapshot; insufficient alone because child attributes were collapsed |
| Local `references/petpooja_pos.md` and `petpooja_save_order_api.md` | Complete root references; historical/withdrawn findings separated from current requirements |
| Supplied annotated attachment | Structural reference from the preceding review, unchanged; not an arithmetic or outlet-configuration authority |

The public page was retrieved read-only with Scrapling. Its referenced SSR resource
was retrieved and the embedded JSON string decoded as a literal. Remote JavaScript
was **not executed**. No sandbox URL, credential store or merchant dashboard was
accessed. Context7 previously returned only an unofficial third-party SDK; it was
not substituted for vendor documentation.

Expanded official schema: `official-api-expanded-20261028.md` beside this report.
Raw public page, SSR response, parsed state and all ten extracted example sections
are preserved in:

`C:\Users\DELL\AppData\Local\Temp\opencode\petpooja-docs-20261028`

The SSR source linked by the page was:
`https://jsapi.apiary.io/apis/onlineorderingapisv210/ssr/68ef7e4dd63150f067a43496/0.38.0/Apiary.renderApiaryUI`.
Its SHA-256 is
`ac42eaaf64298840bfa237d4ce94b154da9a4ab9b012ecbc57bacb0db03a8f3f`.
`documentation-review-manifest.json` records source and artifact fingerprints.
Retrieval in 2026 does not imply that all publisher examples were updated in 2026.

## Settled requirements

1. **All-in unit prices.** PDF p.6 and Apiary `OrderItem.price` include the selected
   add-on/variation price. `final_price` is that unit price less item-level discount;
   quantity remains separate. The tested all-in inputs follow this convention;
   upstream price provenance still needs end-to-end verification.
2. **Separate order discounts.** PDF pp.3,7 use order `discount_type` and
   `discount_total`, not a separate `Discount` object. Item discounts belong in
   `item_discount`. The current fixed-amount (`F`) path must not double-count them.
3. **Restaurant-only total.** PDF p.3 says the total must only include the amount
   due to the restaurant. Apiary explicitly excludes aggregator-retained GST.
   This is not a generic question awaiting clarification. Actual outlet liability
   and ownership of each charge still require authoritative configuration.
4. **GST type has defined ownership semantics.** Apiary Push Menu says `services`
   means the integrator collects/remits GST; `goods` means GST is settled to the
   restaurant. That meaning cannot be ignored while choosing item and summary
   liability fields.
5. **Charge tax settings exist.** Menu fields `calculatetaxonpacking`,
   `pc_taxes_id`, `calculatetaxondelivery` and `dc_taxes_id` determine applicable
   charge-tax configuration. Do not manufacture rates or assume a universal zero.
6. **Delivery flags and collection.** PDF p.4 and Apiary define third-party riders
   as `enable_delivery: 0`, restaurant riders as `1`. Apiary restricts
   `collect_cash` to COD **and merchant self-delivery**, not all COD orders.
7. **Distinct variation identities.** The public menu example has parent item
   `7765809`, variation item `7765862`, master `89058`. Save Order uses the child
   item ID in `id`, master in `variation_id`. These public IDs are not sendable
   outlet mappings. Consume item-local `variation`; top-level `variations` is
   explicitly deprecated. Add-on group min/max values count selected choices,
   not their quantities.
8. **Callbacks and lifecycle.** `callback_url` accompanies every Save Order.
   Arrival creates a pending order. Callback `orderID` is the integrator/client
   reference. Statuses are `-1` cancelled, `1/2/3` accepted, `4` dispatched,
   `5` food-ready and `10` delivered. The outbound Update Order Status endpoint
   documents cancellation only. Rider-status updates are a separate API.
9. **Sandbox evidence.** Verify Order Listing plus callback actions; an HTTP save
   response is not integration approval or physical KOT proof. Production uses
   separate tokens after successful integration. No current live result is claimed.
10. **No documented provider replay guarantee.** `clientOrderID` in the Save Order
    response is an echo of the request's `Order.details.orderID`. The docs do not
    promise duplicate suppression or safe replay after a timeout. The old POS
    reference's provider-dedup assumption is corrected in its new §6; local claims,
    accepted markers and ambiguity reconciliation remain necessary.

## Candidate findings

Paths below are relative to the owned worktree
`.swarm-worktrees/petpooja-vendor-contract-20261028`, base
`c26effe867c662f2008445ee6dae73d176c77bb8`.

### Blocker: customer grand total is sent as restaurant due

- `functions/src/modules/petpooja/orderPush.ts:618` sends `grandTotal` as `total`.
- `functions/src/modules/petpooja/testRunner.ts:631` does the same.
- Neither separates aggregator-retained tax or third-party courier amounts from
  restaurant settlement. This conflicts with PDF p.3 whenever those components
  are present; equality is valid only when the components genuinely coincide.
- Illustrative arithmetic, **not an outlet order**: net food ₹200 + restaurant GST
  ₹10 + packing ₹20 + third-party courier ₹40 yields customer ₹270 but restaurant
  due ₹230. Do not change the customer's charged total to disguise this difference.
- Required next implementation: an authoritative settlement breakdown and tests
  where customer total differs from POS total, including both GST ownership modes.

### Blocker: captured GST ownership is not consumed

- `menuSyncWebhook.ts:666-669` records `petpoojaGstType`, but
  `orderPush.ts:744-752` omits it from the trusted product snapshot.
- `orderPush.ts:469,654-655` and `testRunner.ts:514,542-543` assign every item's
  GST and every summary amount to the restaurant.
- The last documented outlet capture says `gst_type: "services"`. Against the
  published meaning, this is a real liability mismatch, not simply an unanswered
  definition. A fresh menu/accounting contract is still needed before changing
  production financial policy. Unknown or inconsistent ownership must not silently
  become restaurant liability.

### Blocker: COD collection contradicts delivery mode

- `orderPush.ts:572,625,631` uses positive grand-total collection for COD while
  declaring third-party delivery; `testRunner.ts:636,639` does the same.
- The documented applicability condition is not satisfied. The attachment's
  positive `collect_cash` example is a self-delivery (`enable_delivery: 1`) example.
- A correction must preserve the actual delivery/payment model and determine the
  supported representation for an inapplicable optional field; do not request
  cash from a merchant rider on a third-party-delivered order.
- Stage 05 also permits in-house delivery. A blanket claim that riders are always
  third-party does not cover that path; delivery mode must come from authoritative
  order configuration, not be inferred from a sample.

### Reconciliation required: charge taxes and selection mappings

- `orderPush.ts:587-600` and `testRunner.ts:601-616` hard-code charge taxes to zero.
  No current outlet charge configuration was fetched here. Zero can be correct,
  but the candidate has not proved it matches the documented menu settings.
- The production prefetch verifies a parent catalog item and tax metadata. That
  alone does not establish the child-item/master variation pair or an add-on's
  membership in the selected item's allowed group. Numeric-looking IDs and a
  type-only fixture are not membership evidence.
- `orderPush.ts:170-171` prefers a present `basePrice` over `price` / `unitPrice`.
  If a persisted legacy line contains raw base price plus separate modifier costs,
  the all-in convention is not satisfied. Verify real persisted-order shapes and
  add a regression rather than treating the all-in comment as provenance proof.
- Fresh add-on/variation configuration remains externally necessary. It does
  not, by itself, prove those selections survive ingestion, order creation and
  payload construction. Do not describe these cases as blocked only by Petpooja.

## Source conflicts and genuinely unresolved details

- **Save Order host:** PDF p.8 names `qle1yy2ydc.../V1/save_order`; live Apiary names
  `47pfzh5sf2.../V1/save_order`. Request the endpoint provisioned for the demo;
  no exploratory order POST is authorized.
- **Wire-shape conflicts:** public Apiary still contains a `Discount` object,
  a string annotation for `group_id` versus numeric examples, and mixed
  `tax_inclusive` / `is_tax_inclusive` keys. Its sample monetary values also do not
  consistently match the displayed rates. Prefer the supplied corrected attachment
  and explicit PDF instructions for this integration; retain all conflicts visibly.
- **Odd paise:** the documents do not specify who receives the residual paise.
  Conservation is locally verified; vendor acceptance of the rounding convention
  is not. Do not confuse a vendor-specific convention with GST-rate uncertainty.
- **Stock:** examples contain `in_stock: "2"` without a documented encoding.
  Toggle callbacks explicitly use Boolean `inStock`. Do not infer that `"2"`
  means available or unavailable from its prevalence in one capture.
- **Callback authentication:** Sandbox p.2 expressly offers optional Client
  Authorization and Headers Configuration. The references' earlier suggestion
  that undocumented signatures make unauthenticated callbacks production-safe
  is withdrawn. No standard HMAC algorithm is defined by the read material;
  confirm the provisioned auth contract instead of inventing one.

## Draft correction and next boundary

The original `email-draft.md` and Desktop `PETPOOJA_REPLY_DRAFT_20261028.md` remain
unchanged as historical drafts. Use `email-draft-doc-reviewed.md` and Desktop
`PETPOOJA_REPLY_DRAFT_20261028_DOC_REVIEWED.md` instead. The revised draft removes
the answered add-on/discount questions and requests only current mappings, the
conflicting sandbox endpoint and an undocumented rounding convention.

The earlier 1,345-pass / 2-skip backend result proves the tested source's existing
checks, not coverage of these newly identified semantics. Application source and
tests are unchanged by this reading pass. The original test-time manifest and
logs are preserved; the separate documentation manifest identifies the changed
reference/report/draft and unchanged source fingerprints. No financial fix,
sandbox rerun, integration approval, merge, deployment or email send is claimed.
