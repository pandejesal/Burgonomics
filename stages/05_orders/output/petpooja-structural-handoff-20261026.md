# Petpooja Structural Handoff (2026-10-26)

**Status:** documentation only — not a vendor reference change, not an integration claim.
**Source:** user-supplied handoff text relayed in-session. The commented payload file in
Downloads was deliberately NOT opened (possible credentials). No vendor endpoint, outlet ID,
API key, or credential value is reproduced here.

---

## 1. Observed failure mode

Five Sandbox orders were **rejected structurally** by Petpooja even though the transport
returned HTTP 200 with `success: 1`. A successful HTTP status is therefore **not** structural
acceptance; only the vendor's structural validation counts.

## 2. Required credential names (placeholders only)

The vendor requires these at the ROOT of the payload, by name. Values are placeholders in this
note and must never be committed:

- `<ROOT_API_KEY_PLACEHOLDER>`
- `<ROOT_CLIENT_ID_PLACEHOLDER>`

## 3. Accepted envelope shape

```json
{
  "orderinfo": {
    "OrderInfo": {
      "Restaurant": { "details": {} },
      "Customer": { "details": {} },
      "Order": { "details": {} },
      "OrderItem": { "details": [] },
      "Tax": { "details": [] }
    },
    "udid": "",
    "device_type": "Web"
  }
}
```

No `Discount` block and no legacy aliases in this shape.

## 4. Field rules that matter structurally

| Rule | Detail |
|---|---|
| `final_price` | UNIT price minus `item_discount`; not a line total |
| Tax `price` | Numeric string, **not** a percentage |
| Charge fields | Numeric strings |
| Full order numeric fields | Numeric strings with the correct types |
| `tax_inclusive` | `false`, and must match the pricing model used |
| Order ID | Firestore document ID, passed as the optional 5th argument |
| Add-on `group_id` | Integer |
| Add-on `qty` | String |
| Legacy item aliases | Not permitted |

## 5. Totals and business decisions

Vendor arithmetic shown in examples is **illustrative, not a truth source**. Retained business
decisions: `gst_liability` = restaurant, COD = `collect_cash` for the full amount, ONLINE = 0.

## 6. Reported (not independently verified) work state

The user reports fixes in `orderPush`, `testRunner`, `petpooja.service.test`, and the sandbox-5
script, with TS/build passing at 85 files / 1025 tests / 2 skips.

- This is **not independently verified** by the document owner.
- It is **not** the same snapshot as the 1187-test backend run recorded in Phase 1.

## 7. Repository state to preserve

- Root dirty main `31e82c3` contains those four modified files.
- Isolated backend worktree `ac6cea2` has **no** modified Petpooja files.
- The user's diff must be preserved: no whole-file copy over stress hardening, no revert of main.

## 8. Pending, not performed by us

- Vendor re-relay and email — **not sent**.
- Reference §18.4 / §18.5 updates — **pending**.
- Incoming corrections need a 3-way review **before** backend publication.
- Do not claim the vendor accepted this worktree.

## 9. Precedence

The vendor's official sample is authoritative and supersedes stale internal references.
HTTP success does not imply structural acceptance.

---

## 10. Review findings (read-only, not vendor acceptance)

Read-only comparison of the corrected sample and the vendor email against the current builders.
Neither source was modified; nothing was relayed or emailed.

**Matches sample:** envelope shape, no `Discount` block, no legacy aliases, numeric-string
types, `final_price` as unit price minus item discount, Order ID from the Firestore document
ID, required `Order` fields present, and `callback_url` consistent with the sample. The pricing
engine applies GST 5% to food only, so charging zero tax on delivery/packing is internally
consistent.

**Confirmed non-blockers (withdrawn):**

- `enable_delivery: 0` is correct for third-party riders (reference lines 69 and 172; the sample's `1` is a restaurant-rider example; zero also holds for takeaway/dine-in).
- Price is all-in and already includes add-ons (reference line 104); `AddonItem` rows are descriptive, not a double count.
- `item_discount: 0` is truthful: the pricing engine has order-level coupon/loyalty discount only.
- `item.id` precedence is latent because no writer sets `id` — but accepting an empty id remains a risk below.

**Confirmed blockers:**

1. **Add-on group mapping.** Cart modifiers DO persist, but `groupId` is the app's own id (`grp_bun`), never the numeric Petpooja `addon_group_id`; `Number(...) || 0` yields `0`, and tests pin `0` with internal ids. The outlet publishes `addon: []` / `itemallowaddon: 0`, so scenarios 2/3/5 have no real add-on or variation ids. Needs Petpooja outlet add-on/variation configuration plus mapping, or those scenarios dropped by agreement.
2. **Test-runner contact fields.** Empty customer phone/email/address/lat/lng and restaurant contact versus the sample. Use synthetic non-empty values or obtain vendor confirmation.
3. **GST liability.** All-restaurant liability versus the sample's vendor/restaurant split is a product decision.
4. **Tax metadata dropped in sync.** `menuSyncWebhook` drops per-item `item_tax`/`tax_inclusive` and `petpoojaTaxes` is never written, so mixed-rate/9% and tax-inclusive items cannot be represented. The current outlet (`false`, 3928/3929) is acceptable for today.
5. **Delivery in total.** `total = grandTotal` includes `deliveryFee`, while reference line 57 says restaurant-due excludes delivery; verify vendor semantics.
6. **Empty item id.** Empty `item.id` is accepted and pinned, and add-on ids fall back to the literal `addon` or internal option ids; needs fail-closed or real mapping.
7. **Test evidence limits.** Placeholder-pinning tests; the 1025 count is unverified; vendor acceptance is pending and HTTP 200 / `success: 1` is not acceptance.
**Status:** HTTP 200 / `success: 1` was not acceptance — the vendor rejected the structure. Read-only independent review is recorded in `polish-current\petpooja-sample-review.md`; no Petpooja edits were made.
Re-relay, email and reference updates remain pending. The 1025-test count is user-reported and
not independently verified. Sample arithmetic is illustrative/inconsistent and is not a totals
oracle.