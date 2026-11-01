# Petpooja Save Order API + Sandbox — Reference (Layer 3)

> **Current interpretation: §21 (2026-10-28).** Earlier audit sections are
> historical records, not a current payload recipe. §21 corrects the earlier
> uncertainty about add-on pricing, unit `final_price`, discounts, restaurant-only
> totals, GST liability, `collect_cash` and callback authentication. The offline
> candidate still has unresolved financial/mapping gaps; a passing shape test is
> not complete vendor compliance or permission to resubmit/deploy.

> Extracted from the official PDFs supplied by the user (2026-10-06):
> - `API Guide for Placing Orders on Petpooja POS.pdf` (9 pages)
> - `Petpooja Sandbox Guide for Integration Testing.pdf` (6 pages)
> The PDFs were never committed to this repo. The plain-text extracts used to
> build this reference (`api_guide_placing_orders.txt`, `sandbox_guide_testing.txt`,
> captured 2026-10-19) and the Apiary V2.1 blueprint (`petpooja_v210.apib`) are
> local scratch copies outside the repository; a clean checkout cannot re-derive
> them from inside the repo.
> Authority note: the Apiary V2.1 blueprint is the vendor reference. Third-party
> mirrors are NOT independent vendor confirmation. No sample credentials or
> values are reproduced here.

---

## 1. Authentication & Setup

Every request must include all three credentials (from the sandbox dashboard **Configuration** section):

| Field | Description | Required |
|---|---|---|
| `app_key` | Unique restaurant identifier | ✅ |
| `app_secret` | Secure key for safe communication | ✅ |
| `access_token` | Temporary pass to send orders | ✅ |

Sandbox tokens are **only valid for sandbox use** — production uses different tokens.

## 2. Restaurant Information

| Field | Description | Required |
|---|---|---|
| `restID` | Unique Petpooja ID — use the **menu sharing code** from the menu push payload, or the alphanumeric code provided by Petpooja | ✅ |
| `res_name` | Restaurant name | ❌ |
| `address` | Restaurant location | ❌ |
| `contact_information` | Phone number | ❌ |

## 3. Customer Information

| Field | Description | Required |
|---|---|---|
| `name` | Person ordering | ✅ |
| `address` | Delivery location | ✅ |
| `phone` | 10-digit contact number | ❌ |
| `email` | Customer email | ❌ |
| `latitude` / `longitude` | GPS coordinates | ❌ |

## 4. Order Details

| Field | Description | Required |
|---|---|---|
| `orderID` | Unique order reference | ✅ |
| `preorder_date` | `YYYY-MM-DD` | ✅ |
| `preorder_time` | `HH:MM:SS` | ✅ |
| `advanced_order` | `"Y"` or `"N"` | ✅ |
| `order_type` | `H` = Home Delivery, `P` = Parcel, `D` = Dine-in | ✅ |
| `total` | Total due to the restaurant = item final price − order discount + GST (if restaurant-liable) + packing charges. **Only the amount due to the restaurant** | ✅ |
| `tax_total` | Total tax on order | ✅ |
| `created_on` | `yyyy-mm-dd H:i:s` | ✅ |
| `dc_tax_percentage` | Tax % applied on **delivery charges** | ✅ |
| `pc_tax_percentage` | Tax % applied on **packing charge** | ✅ |
| `description` | Special instructions | ❌ |

## 5. Payment & Delivery

| Field | Description | Required |
|---|---|---|
| `payment_type` | `COD` = Cash, `CARD` = Card, `ONLINE` = Online | ✅ |
| `enable_delivery` | `0` = third-party rider, `1` = restaurant rider | ✅ |
| `delivery_charges` | Delivery charge amount | ❌ |
| `urgent_order` | `true` / `false` | ❌ |
| `urgent_time` | Prep time in minutes if urgent | ❌ |

## 6. Callbacks & Charges

| Field | Description | Required |
|---|---|---|
| `callback_url` | URL to receive order updates (accept / ready / reject) | ✅ |
| `packing_charges` | Packaging charge | ❌ |
| `service_charge` | Service fee | ❌ |
| `OTP` | Verification code for order pickup | ❌ |

## 7. Order Items (`order_items[]`)

```json
[{
  "id": "101", "name": "Margherita Pizza",
  "tax_inclusive": true, "item_discount": "",
  "price": "250.00", "final_price": "250",
  "quantity": "2", "gst_liability": "restaurant",
  "item_tax": [
    {"id": "11213", "name": "CGST", "tax_percentage": "2.5", "amount": "3.15"},
    {"id": "20375", "name": "SGST", "tax_percentage": "2.5", "amount": "3.15"}
  ],
  "variation_name": "", "variation_id": "",
  "addon_items": [{"id": "201", "name": "Extra Cheese", "price": "50.00", "quantity": "1"}]
}]
```

| Field | Description | Required |
|---|---|---|
| `id` | Item ID from menu push payload | ✅ |
| `name` | Dish name | ✅ |
| `price` | Unit price = item unit price + add-ons price | ✅ |
| `final_price` | Price − item-level discount | ✅ |
| `quantity` | Units | ✅ |
| `gst_liability` | `vendor` / `restaurant` | ✅ |
| `item_tax` | CGST + SGST bifurcation | ✅ |
| `tax_inclusive` | Whether amount includes tax | ✅ |
| `tax_percentage` | % tax on item | ✅ |
| `variation_id` / `variation_name` | Variant from menu payload | ❌ |
| `addon_items` | Extra add-ons | ❌ |

## 8. Tax & Discounts

- **Do NOT send the `discount` object.** Use exactly two keys on the Order object:
  - `discount_type`: `"F"` (fixed) or `"P"` (percentage) — e.g. `100 [F]`, `10% [P]`
  - `discount_total`: the discount amount/percent
- `tax_details[]`:

```json
[{"id": "301", "title": "CGST", "type": "P", "price": "9%", "tax": "45.00", "restaurant_liable_amt": "0.00"},
 {"id": "302", "title": "SGST", "type": "P", "price": "9%", "tax": "45.00", "restaurant_liable_amt": "0.00"}]
```

## 9. Endpoint

```
POST https://qle1yy2ydc.execute-api.ap-southeast-1.amazonaws.com/V1/save_order
```

Workflow: gather details → format payload → POST → receive confirmation & track via **callback URL**.

> **⚠️ VERIFIED 2026-10-13 (live sandbox probe) — see §12.** The only reachable
> `save_order` endpoint is the one the official Apiary docs label **"Dev URL"**:
> `https://47pfzh5sf2.execute-api.ap-southeast-1.amazonaws.com/V1/save_order`
> (and the same behind `qle1yy2ydc…`). Both are **Petpooja's dev environment**,
> NOT the assigned sandbox. Every doc example above was probed against them and
> the results are logged in §12 — do not treat those hosts as the sandbox.

Petpooja contacts (from guide): malvi.vaghela@petpooja.com, rohan.sakhrani@petpooja.com

---

## 10. Sandbox Environment

1. **Access**: share your public IP for whitelisting; dashboard login via emailed ID/password (Petpooja Developer API dashboard).
2. **Dashboard sections**: API Documentation, Configuration, Menu Management, Order Listing.
3. **Configuration tab**: App Key / App Secret / Access Token + webhook setup.
   - **Base URL**: common URL for all webhooks, e.g. `https://developerapi.petpooja.com/` → Menu Sharing Endpoint = `<base>/pushmenu`
   - **Webhook URL for Testing**: base URL used for all webhooks during testing.
   - Optional client authorization + header configuration.
4. **Testable endpoints**: Save Order API, Update Order Status API (cancel), Rider Info Webhook.
5. **Menu Management**: Menu List triggers **Push Menu API** to the Menu Sharing Endpoint; Item On/Off webhook for stock status; Store On/Off webhooks.
6. **Order Listing**: verify relayed orders; test callback URL (accept / food ready / reject); Rider Information API if managing delivery.
7. **Example workflow**: login → configure webhooks → test API calls → push menu → place sample orders → verify listing + callbacks.
8. **Notes**: sandbox is IP-restricted; demo tokens valid for sandbox only; separate tokens for production.

---

## 11. Conformance checklist for this repo

- [ ] Save-order payload includes `restID` (menu sharing code), not just Firestore doc ID (see R13 resolution — verify it still holds).
- [ ] `callback_url` present and points at the deployed functions base URL.
- [ ] `dc_tax_percentage` + `pc_tax_percentage` always sent (marked required).
- [ ] `advanced_order`, `preorder_date`, `preorder_time`, `created_on` populated.
- [ ] Discounts sent as `discount_type` + `discount_total` only — **no `discount` object**.
- [ ] Each `order_items[]` entry carries `item_tax` (CGST/SGST) + `tax_inclusive` + `tax_percentage`.
- [ ] `tax_details[]` with `restaurant_liable_amt`.
- [ ] `order_type` mapped correctly from fulfillment mode: delivery=`H`, takeaway/parcel=`P`, dine-in=`D`.
- [ ] `payment_type` mapped from payment method: online→`ONLINE`, COD→`COD`.
- [ ] `enable_delivery` = `1` for restaurant rider / `0` for third-party (Porter/Borzo/Shadowfax).

---

## 12. Live sandbox probe results (2026-10-13)

Probed with the real sandbox credentials from `functions/.env` (all three
authenticated successfully — no auth rejection at any point).

| Probe | Result |
|---|---|
| `GET https://developerapi.petpooja.com/` (pre-whitelist) | HTTP 403 — IP-restricted dashboard |
| `GET https://developerapi.petpooja.com/` (post-whitelist, from reserved IP `137.23.58.8`) | HTTP 200 |
| `POST developerapi.petpooja.com/V1/save_order` (+ 20 other path guesses) | **HTTP 404** — no API route exists on the dashboard host |
| `POST 47pfzh5sf2…/V1/save_order` — **complete flat body per the official PDF** (all required fields incl. customer `name` + `address`) | `{"success":"0","message":"Invalid order relay payload "}` |
| `POST 47pfzh5sf2…/V1/save_order` — flat + `udid`/`device_type` | `{"success":"0","message":"Invalid order relay payload "}` |
| `POST 47pfzh5sf2…/V1/save_order` — flat + numeric prices | `{"success":"0","message":"Invalid order relay payload "}` |
| `POST 47pfzh5sf2…/V1/save_order` — flat + `item_discount: 0` | `{"success":"0","message":"Invalid order relay payload "}` |
| `POST 47pfzh5sf2…/V1/save_order` — flat, no `addon_items` key | `{"success":"0","message":"Invalid order relay payload "}` |
| `POST qle1yy2ydc…/V1/save_order` — same 7 flat variants | `{"success":"0","message":"Invalid order relay payload "}` (all) |
| `POST 47pfzh5sf2…/V1/save_order` — `orderinfo` (lowercase, single-nested, any child shape) | `{"success":"1","message":"Your order is saved.","restID":"","clientOrderID":"","orderID":"","code":200}` |
| `POST 47pfzh5sf2…/V1/save_order` — `OrderInfo` (capital, top-level, official doc shape) | `{"success":"0","message":"Invalid order relay payload "}` |
| `POST qle1yy2ydc…/V1/mapped_restaurant_menus` | `{"success":"0","message":"unable to fetch Object from s3 bucket"}` — no menu provisioned for the restaurant |

**Findings**

1. The official **API guide PDF** (`API Guide for Placing Orders on Petpooja POS.pdf`,
   read in full 2026-10-14) documents a **FLAT** body — credentials, `restID`,
   customer `name`/`address`, order, `order_items[]` and `tax_details[]` all at
   the top level — and names
   `https://qle1yy2ydc.execute-api.ap-southeast-1.amazonaws.com/V1/save_order`.
2. **Every** flat variant is rejected by the live API, including a body
   containing *every* field the PDF marks required (matrix in
   `scripts/petpooja-flat-matrix.mjs`). A lower-case `orderinfo` object is
   required. **The PDF does not match the deployed API version.**
3. ~~The accepted shape returns a canned success with `restID` /
   `clientOrderID` / `orderID` **always empty** — regardless of where the
   mapping code is placed.~~ **WITHDRAWN — see §15.1.** The bodies tested in this
   round put the members *directly* under `orderinfo` and **omitted the required
   inner `OrderInfo` level and the `details` wrappers**. The endpoint therefore
   had no `OrderInfo` to read, which is why nothing was echoed. With the
   documented envelope it echoes the real `restID` and `clientOrderID`.
4. The sandbox dashboard's API Documentation tab links to that same Apiary page,
   exposes no API route, and its **Order List stays empty** after every
   successful relay.
5. ~~Conclusion: relays are accepted by Petpooja's **dev environment**, not the
   assigned sandbox. The sandbox `save_order` endpoint was never published.~~
   **WITHDRAWN — see §15.3.** The endpoint does parse the documented envelope.

**Blocker to raise with Petpooja** — the sandbox endpoint URL (and confirmation
that the issued `app_key` is bound to the mapping code `31z58ciw0h`) before the
5 required scenarios can produce fulfilled order IDs. The vendor's own term
"fulfilled" is undefined in its documentation and is not a documented state
(§19.1); this document now reports 5/5 RECEIVED and 0/5 fulfilment VERIFIED.

**Implementation note** — because the PDF and the live API disagree, the relay
(`functions/src/modules/petpooja/orderPush.ts`, `testRunner.ts`) emits **both**
contracts: the official flat required fields at the top level AND the
`orderinfo`-wrapped structure the live API accepts, plus legacy field aliases.
Unknown keys are ignored, so a POST satisfies whichever contract the target
implements.

**Tools added (gitignored evidence output):**
- `scripts/petpooja-sandbox-5scenarios.mjs` — the 5 required scenarios
- `scripts/petpooja-probe-contract.mjs` — contract probe matrix
- `scripts/petpooja-verify-contract.mjs` — single contract verification
- `scripts/petpooja-real-item-probe.mjs` — relays a cart built from the outlet's OWN catalog

---

## 13. Stub proof + outlet configuration gaps (2026-10-15)

Two questions were open after §12: *is the endpoint merely misconfigured*, or
*is it not an order service at all* — and *does the outlet's own menu support
the five required scenarios*. Both are now answered.

### 13.1 The endpoint does not validate or persist

Two probes answer this, and neither one ends up shipping the guide's example ids.

`scripts/petpooja-real-item-probe.mjs` relays a cart built from the outlet's
**own** catalog — real ids `30791 Tandoori Dahi Kebab @350` and
`30778 Tandoori Dahi Ke Sholey @350` — using the production payload builder.
Result: HTTP 200,
`{"success":"1","message":"Your order is saved.","restID":"","clientOrderID":"","orderID":"","code":200}`.

> **Correction (2026-10-16).** An earlier revision of this section claimed that
> probe sent real tax ids `3928`/`3929`. It did not: `formatPetpoojaV21Payload`
> hard-coded `11213`/`20375` on item lines and `301`/`302` under `tax_details`,
> so those are what went out. The claim was wrong and is withdrawn. The probe
> below exists precisely to close that hole.

`scripts/petpooja-corrected-payload-probe.mjs` builds the body by hand from the
outlet's catalog and does **not** call the production builder, so no hard-coded
example id can contaminate it: item ids `30791`/`30778`, tax ids `3928`/`3929` on
both the item lines and `tax_details`, `order_type:"H"`, tax computed from the
outlet's own 2.5% + 2.5% rows, and no `Discount` object. Result:
**HTTP 200, `success:"1"`, `orderID:""`** — still no order id.

> **Correction (2026-10-17, amended 2026-10-20; see §16.8/§19.2).** This section
> treated an empty `orderID` as evidence the relay had not landed. It has not:
> Petpooja's own Order List for outlet 5439 shows the orders these probes placed,
> plus the five deliverable scenarios. An empty `orderID` is the normal shape of a
> successful save and says nothing about fulfilment. The listing snapshot itself
> is not proof of fulfilment either — only a terminal `10 Delivered` state is; the
> 2026-10-17 snapshot shows "Waiting For Acceptance" and later evidence is 0/5
> fulfilment VERIFIED (§19.2).

The same probe re-tests the flat contract with those real ids: still
`{"success":"0","message":"Invalid order relay payload "}`. So the flat body is
rejected on **shape**, not because of bad ids, while the envelope is accepted
regardless of content.

The decisive test is a **control**: an order that no order service could accept —
unknown `restID` `THIS_RES_ID_DOES_NOT_EXIST_999`, item id `999999999` that
exists nowhere, quantity `999`, total `999999.00`. It too returned
**HTTP 200 `success:"1"`**.

> An endpoint that accepts a non-existent restaurant and a non-existent item is
> not validating identifiers.
>
> **Correction (2026-10-16).** The second half of this claim — that it "never
> echoes back the unique `clientOrderID` it was sent" — did not survive checking.
> It was an artefact of the malformed envelope (§15.1): with the documented
> `orderinfo.OrderInfo.*.details` body the endpoint **does** echo our real
> `clientOrderID` and `restID`. Read §13.1 as "it does not validate
> identifiers", not "it does not read the body" — §15.2 shows it reads the body
> clearly enough to return our values.

Evidence: `scripts/petpooja-endpoint-stub-evidence.json` and
`scripts/petpooja-corrected-payload-evidence.json`.

### 13.2 The outlet's own menu cannot express three of the five scenarios

Harvested from the menu Petpooja **pushes to us** for `31z58ciw0h` (166 items,
21 categories) — the only working view of the outlet's catalog, since
`mapped_restaurant_menus` returns `unable to fetch Object from s3 bucket`:

| Capability | State in the pushed menu |
|---|---|
| Add ons | `addongroups` empty; `itemallowaddon = "0"` on **all 166 items** |
| Variations | `variations` empty; 81 items set `itemallowvariation = "1"` but carry **no definitions** and an empty `variation_groupname` |
| Discounts | `discounts` empty |
| Taxes | `3928` CGST 2.5% + `3929` SGST 2.5% (present, usable) |
| Attributes | `1` veg, `2` non-veg |

Consequence: **Item+Tax is expressible; Addons+Tax, Discount+Tax and
Addon+Variation+Tax are not**, and Variation+Tax has no valid variation id to
reference. Three of the five scenarios Petpooja asked for cannot be demonstrated
against this outlet as configured — a configuration request for Petpooja, not a
code defect here.

### 13.3 Relay honesty fixes (deployed 2026-10-15)

Because §13.1 proves every ack is empty, two fabrication paths were removed:

1. `orderPush.ts` — a `success:"1"` response with **no** order id used to be
   treated as a win: it invented `pp_<epoch>` and stamped `kotPrinted:true`. The
   fabricated id was then truthy, so the idempotency guard skipped every later
   retry and the order became unrecoverable. The response's real `orderID`
   spelling is also read now — the old code only looked for snake_case, so a
   genuine id would have been discarded.

   **Superseded 2026-10-17 — see §16.8.** This entry said the fabricated stamp
   told the kitchen a KOT had printed "that Petpooja never registered", and the
   replacement behaviour was to park the order `pending_retry` with the raw body
   in `lastPetpoojaError`. The parking half was itself wrong: Petpooja **did**
   register those orders, so parking re-POSTed each one on every retry. The
   relay now records an id-less ack as accepted (`petpoojaAcceptedNoId`), keeps
   the raw body, never invents an id, and does not retry.
2. `core/errors.ts` — four optional refs and `context` were written as explicit
   `undefined`, which Firestore rejects (`Cannot use "undefined" as a Firestore
   value`). The throw was swallowed by `captureErrorSnapshot`'s own catch, so
   **no** `dev_error_snapshots` row was ever written for a Petpooja failure
   while the endpoint still answered 200 — the ops trail silently did not exist.
   Undefined keys are now omitted.

---

## 14. Codebase audit findings (2026-10-16)

Four read-only sweeps of the whole repo (payload builder, identifier wiring,
both client apps + website, inbound webhooks/routes/auth) found the defects
below. They were found **because** §13.1 was drawn from a payload that was
itself wrong, which is what prompted the question "is the fault on our side?".
It partly was. All items in §14.1–14.3 are fixed and deployed in `3cf834d` /
`756b950`; §14.4 is open.

### 14.1 Payload defects (fixed)

Everything in §13.1–13.2 plus: the production builder (`orderPush.ts`) omitted
per-line `item_tax` / `tax_percentage` / `item_discount` entirely and sent the
tax ids `"cgst"` / `"sgst"`, which name no tax row; both builders dropped
`restaurant_liable_amt` from `Tax[]`; `tax_details` halved the tax percentage
twice (advertising 1.25% against a 2.5% row); `created_on` and the `preorder_*`
fields were written in the runtime's local zone (UTC) rather than IST;
`dc_tax_percentage` / `pc_tax_percentage` claimed `"5"` where production sent
`"0"`; `enable_delivery` was inverted; a `Discount` object was emitted although
the contract defines only `discount_type` + `discount_total`; and
`tax_inclusive` was declared inconsistently with the prices each builder actually
sends. The sandbox runner computes GST *on top of* its item prices, so it
declares `false`; the production relay sends the app's GST-inclusive
`CartTotals.subtotal`, so it declares `true` (`6ef7807`).

### 14.2 Fabricated identifiers (fixed)

Both the 5-scenario runner and the production relay derived item ids from the
**integration guide's illustrative examples** (`101`, `201`, `301`, `302`)
instead of the outlet's catalog. Item ids now come from the outlet's own menu
push.

One related claim was checked and **not reproduced**: the partner app does not
write fabricated `PP-*` ids into `products`. Those strings exist only in
DEV-gated demo data (`useMenu.ts:26`, `ALLOW_SEED_CATALOG = import.meta.env.DEV`,
and the mock branch of `petpoojaSync.ts`, which writes `menu/`, not `products`),
and `useBranchMenu.ts:273` explicitly refuses to stamp a synthetic
`petpoojaItemId` on combos. Partner-side `products` writes touch stock fields
only (`useBranchMenu.ts:85`, `:219`).

### 14.3 Untruthful success paths (fixed)

`/petpooja/testRunner` handed back a synthetic `pp_test_*` id whenever the relay
was not eligible, including in a live process with credentials present and only
`branchId` missing — reporting a fulfilled scenario that never reached the POS.
It now throws and names what is missing; only mock mode may synthesise an id.

### 14.4 Identifier resolution drift (RESOLVED 2026-10-17 — the code is right)

`references/petpooja_pos.md` P3 and `references/known_issues.md` R13 both state
that the authoritative restaurant identifier is the **nested**
`branches/{branchId}.petpooja.restId`. The code does not read that location.
Every server path reads the **flat** `petpoojaStoreId`:

- `orderPush.ts:463`, `menuSyncWebhook.ts:52,60,65`, `item86ingSync.ts:127,135,253`

This was recorded as an open drift on the assumption that the runbook matched the
nested form. It does not — the current operator-facing documents both say FLAT:

- `PRODUCTION_RUNBOOK.md:100` — "write that SAME restID to both records:
  `stores/{storeId}.petpoojaRestId` **and** `branches/{branchId}.petpoojaStoreId`".
- `STORE_SUBMISSION_GUIDE.md:253` — "Real branch→restID mapping = Firestore
  `branches/{id}.petpoojaStoreId` (fail-closed 503 if unset)".

So the flat read is correct and `petpooja_pos.md` P3/P4 and `known_issues.md` R13
describe an older nested design that was never implemented. Those two references
are stale; an operator who followed them would write a field nothing reads and the
integration would fail closed with no obvious cause.

Nothing was re-plumbed. What remains is a **data** step, not code: no branch has
ever been linked to a real outlet. All 25 branch docs hold seeded placeholders
(`petpoojaStoreId = str_001…str_016`, `petpoojaRestId = rest_<slug>`), so every
outlet-bound path fails closed. See §16.7 for the menu-push consequence.

### 14.5 Order-line field mismatch (fixed)

`orders.items` is written as the app's `CartLine[]` (`ordersService.ts:391`,
`OrderRepository.ts:178`). A `CartLine` carries `productId`, `unitPrice`, `veg`
and an optional `meta` bag — but the relay read `petpoojaItemId` / `itemId` /
`id`, `basePrice` / `price`, and `isVeg`. None of those exists on a CartLine, so
every production KOT went out with no item id at all (`undefined` is dropped by
`JSON.stringify`), price `0.00` on every line, `item_attribute:"1"` (veg) on
non-veg items too, and addon price `0.00` (`CartModifier` uses `priceDelta`).

The client's `mapProductDoc` (`menuService.ts:122`) is the deeper version of the
same problem: the menu sync writes `petpoojaItemId` onto each `products` doc
(`menuSyncWebhook.ts:204`) but the mapper drops it, so the id never survives into
the app's `Product` model, let alone the cart or the order.

Server side is fixed (`6ef7807`): `linePetpoojaItemId()` accepts an explicit
`petpoojaItemId`, `meta.petpoojaItemId`, a legacy `itemId`/`id`, then the menu doc
id `prod_<branchId>_<itemid>` stripped by exact prefix — never parsed loosely, and
never invented. Prices now read `unitPrice`, the veg flag now reads `veg`, and
addon prices read `priceDelta`. The mapper in `menuService.ts` is still worth
fixing so the id is carried in the model rather than recovered from a doc id.

---

## 15. Our envelope was wrong — the missing `orderinfo.OrderInfo` level (2026-10-16)

§12–§13 concluded that the sandbox `save_order` endpoint "does not validate or
persist", "never echoes what it was sent" and "was never published". That
conclusion was drawn from a body that was itself malformed, so it proved far
less than it claimed. **The fault was ours**, and the question "is the fault on
our side?" was the right one to ask.

### 15.1 The defect

Every relay we had ever sent put the members **directly** under `orderinfo`:

```json
{ "app_key": "…", "app_secret": "…", "access_token": "…",
  "orderinfo": { "Customer": {…}, "Order": {…}, "OrderItem": [ … ] } }
```

The published Orders API puts them under a **required inner `OrderInfo`** level
and wraps every member in a **`details`** object — with `OrderItem` / `Tax` /
`Discount` holding a `details` *array*:

```
orderinfo.OrderInfo.{Restaurant,Customer,Order,OrderItem,Tax,Discount}
  Restaurant / Customer / Order : { details: { … } }
  OrderItem / Tax / Discount    : { details: [ … ] }
```

Sources: the api-evangelist OpenAPI (`petpooja-orders-api-openapi.yml`, component
`OrderInfo`) and that spec's Postman collection body, matching the vendor Apiary
summary "an orderinfo object (restaurant, customer, order, order items, taxes,
discounts)". The vendor PDF instead describes a flat body with no `orderinfo` at
all — the PDF is stale, but the nested contract is what the deployed API parses.

The endpoint's validator only checks that `orderinfo` **is present**, so our body
passed it; the parser then found no `OrderInfo` to read and answered
`success:"1"` with empty ids because it had parsed nothing — not because it is a
stub.

### 15.2 The proof

Varying **only** the envelope — same credentials, same real outlet ids
(`scripts/petpooja-spec-shape-probe.mjs`, evidence
`scripts/petpooja-spec-shape-evidence.json`):

| Envelope | Response |
|---|---|
| ours: `orderinfo.{Customer,Order,OrderItem,Tax}` | `{"success":"1",…,"restID":"","clientOrderID":"","orderID":""}` |
| documented: `orderinfo.OrderInfo.*.details` | `{"success":"1",…,"restID":"31z58ciw0h","clientOrderID":"<our order ref>","orderID":""}` |

Both hosts (`47pfzh5sf2…` and `qle1yy2ydc…`) behave identically. How the three
collection members are wrapped makes no difference to the echo —
`scripts/petpooja-orderinfo-matrix.mjs` tries bare arrays (the OpenAPI typing)
and `details`-wrapped arrays (the Postman body) and both echo identically.

The endpoint therefore reads our body: it returns our restaurant mapping code and
our order reference, which it never did before. `restID` and `clientOrderID` are
no longer empty. Through the real runner, all five scenarios now echo
`restID:"31z58ciw0h"` and their own `clientOrderID`.

### 15.3 What is still not happening, and why it is not the payload

1. **`orderID` is still empty.** Petpooja assigns the POS order number when an
   order is registered; this endpoint returns none.
2. **It does not validate `restID`.** `scripts/petpooja-restid-validation-probe.mjs`
   sends the real code, the numeric `5439`, and `THIS_RES_ID_DOES_NOT_EXIST_999`
   — all three come back echoed verbatim
   (`scripts/petpooja-restid-validation-evidence.json`). Whatever the echo proves
   about parsing, it is not a restaurant lookup.
3. **`update_store_status` is not routed.** `POST /V1/update_store_status` on the
   menu host returns `HTTP 403 {"message":"Missing Authentication Token"}` — the
   API-Gateway response for a route that does not exist — so the store cannot be
   opened through the API (`scripts/petpooja-store-open-probe.mjs`).
4. **No callback has ever arrived.** `pos_webhook_audits` is empty. Note that our
   inbound route fails closed: `/petpooja/webhook` requires a credential header
   matching `PETPOOJA_APP_KEY` (`core/middleware.ts:259`), so a vendor callback
   carrying no such header would 401. That cannot be tested until a callback is
   ever sent.

So the remaining blocker is no longer our payload. Points 1–3 are properties of
the endpoint as deployed, and point 4 is untestable until it sends anything.

### 15.4 Fix

`orderinfo.OrderInfo.*.details` is now what both builders emit
(`orderPush.ts`, `testRunner.ts`); `AddonItem` is carried as `AddonItem.details`;
and the previous flat/nested spellings are kept as harmless aliases because
unknown keys are ignored. Regression guard: the `formatPetpoojaOrderPayload` test
asserts every member is reachable at `orderinfo.OrderInfo.<Member>.details`.
Commit `d87a579`.

Gates: build clean; `482 passed / 2 skipped / 0 failed`.

## 16. Second dig (2026-10-16, late): what the endpoint really is, and four inbound defects

### 16.1 A claim in section 14/15 corrected

**The endpoint DOES authenticate.** A bogus, absent, or header-only credential returns

```
{"success":"0","message":"Invalid client credentials.","errorCode":"GN_105","validation_errors":""}
```

Our credentials are valid; §15's remark that the endpoint validates nothing was half
wrong — it validates the client, not the restaurant. "restID is never validated"
stands: the real code, `5439`, and `THIS_RES_ID_DOES_NOT_EXIST_999` are all echoed
verbatim.

### 16.2 Only three routes exist on either host

A sweep of both hosts (POST plus GET, ~24 candidate spellings including
`store_status`, `updateStoreStatus`, `order_status`, `get_order`, `cancel_order`)
routed exactly three paths: `save_order`, `update_order_status`, and
`mapped_restaurant_menus`. Everything else is
`403 {"message":"Missing Authentication Token"}`. `update_store_status` and
`update_item_stock` are not deployed at all (the vendor itself marks them
"unreconciled"), so there is no API by which we can open the store, and no
order-listing or order-fetch route that could return a POS order id.

One genuine discovery: `update_order_status` IS deployed and authenticated on both
hosts — the undocumented route matching the sandbox guide's "Update Order Status
API (cancel)". It accepts `{restID, orderID, status}` and echoes them; it does not
mint ids.

### 16.3 `orderID` is empty under every request shape

Thirteen variants on the documented envelope — `orderID` omitted, `orderID` empty,
with `udid`+`device_type`, COD, dine-in with `table_no`, parcel, bare arrays,
`Tax` omitted, `Discount` omitted, advanced order, delivery enabled, non-zero
charges — every one returns `orderID:""`. No request shape registers the order, so
this is not a payload defect.

(`clientOrderID` in the response is simply the echo of the `Order.orderID` we send;
omit that key and the echo is empty too.)

Evidence: `scripts/petpooja-orderid-sweep.mjs` ->
`scripts/petpooja-orderid-sweep-evidence.json`, and
`scripts/petpooja-route-matrix.mjs` -> `scripts/petpooja-route-matrix-evidence.json`.

### 16.4 Four inbound defects fixed (these were ours)

The order-status callback is the only other carrier of the POS order id, and our
inbound path could not have received one:

1. **Auth mismatch.** We demanded a credential header; the vendor's documented
   callback sends none, so every real callback 401'd at `verifyPetpoojaAuth`.
   Fixed: the documented callback shape (`restID` + `status`) is now accepted,
   everything else keeps the fail-closed 401, and integrity is enforced in the
   handler rather than by a static header.
2. **The callback id was never read.** `payload.orderID` was ignored, so a callback was
   swallowed by the store-status branch. Fixed: `orderID` is read, and a payload
   carrying it is never treated as a store-status ping. **Current contract:** the
   vendor blueprint defines callback `orderID` as "Unique client order id which is
   used to update order status at client side" (§19.1), so it is resolved as OUR
   reference first; it is treated as the POS id only when a branch-scoped
   `petpoojaOrderId` lookup proves it.
3. **Nothing was keyed on a POS id.** Fixed: `resolveOrderByPosOrderId` resolves
   `orders.petpoojaOrderId == orderID` (single-field equality, so no composite
   index), and refuses a match outside the `restID`'s branch. It is the fallback,
   not the primary path.
4. **Callback sync state was conflated with POS-id provenance.** Current: any
   accepting callback promotes `pending_retry -> synced`, but only a proven
   POS-derived id is stored as `petpoojaOrderId`. A documented client-ref callback
   records `petpoojaAcceptedNoId` + `petpoojaCallbackClientRef` instead, so the
   retry worker stops re-pushing without fabricating a POS id. The inbound
   callback body is kept in `petpoojaCallbackAck`;
   `petpoojaAcceptedNoIdAck` remains the push-time `save_order` response and is
   never overwritten. A contradictory
   client ref/outlet, an ambiguous pair of refs, or a claimed outlet that does not
   resolve is parked for review rather than applied.

Tests added: four in `petpooja.webhook-terminal.test.ts`, one in
`env.failclosed.test.ts`.

### 16.5 Still open

- `orderID` is never returned, so the result stands at 0/5: the deliverable is
  blocked at the vendor endpoint, not in our payload.
- Four of the five scenarios reference outlet capabilities this DEMO outlet does
  not expose (`addongroups`, `variations`, `discounts` all empty).
- `PETPOOJA_ENABLED` is dead config (`functions/src/config/env.ts:38`, no other
  reference) — a misleading no-op, not an off-switch.
- Callback signing: the vendor documents no auth for the callback. Ask for a
  signing secret so the shape allowance can be replaced by HMAC
  (`verifyPetpoojaSignature`).

Gates: build clean; `487 passed / 2 skipped / 0 failed`.

### 16.6 Review hardening (same day, after an adversarial self-review)

The first cut of 16.4 relaxed `verifyPetpoojaAuth`, which is **shared** by
`/petpooja/webhook`, `/petpooja/stockWebhook` and `/petpooja/menu-sync`. Two of
those handlers never implemented the integrity checks the change promised, so
that cut would have handed an uncredentialed caller the ability to 86 arbitrary
menu items at any linked outlet and to trigger catalog-pull fan-out — worse than
the problem it fixed. What changed:

- **The shape allowance is scoped to `/petpooja/webhook` only.** Every other
  route keeps the fail-closed 401 (asserted by test).
- **Shape-admitted calls are marked untrusted** (`req.petpoojaAuthenticated` is
  set false; credential and HMAC paths set it true) and the handler receives it.
  An untrusted call may still apply a bounded status change, but it cannot write
  `petpoojaOrderId` / `petpoojaStatus:"synced"` — the retry worker and the
  outbound dedupe both key off those, so a forged value would silently drop a
  genuinely un-pushed order from the retry queue. What such a call claims is
  recorded under `petpoojaCallbackOrderId` for visibility only.
- **Untrusted calls are outlet-scoped.** They must carry a `restID` that resolves
  to a linked branch and must target an order belonging to that branch. The
  POS-id lookup now fails closed when the branch cannot be resolved (a bare
  `orderID` no longer reaches an arbitrary outlet), and the doc-id path is scoped
  the same way.
- **Promotion requires an accepting status.** A `Reject` no longer turns an order
  `synced` with no signal that the KOT was refused.
- **The two status-key predicates agree.** The middleware no longer accepts
  `order_status`, which `isStoreStatusPayload` never recognised; a body that
  passed the gate could otherwise reach the handler and answer HTTP 500.

Residual risk, recorded rather than silently fixed: the parking writes for an
unresolvable `restID` (`petpooja_store_status_events/*`,
`unmatched_petpooja_orders/*`) are unauthenticated and rate-limit-exempt, so an
internet caller can create documents without bound (cost/quota, not data
integrity). Closing it means either bounding the writes to linked outlets — which
reverses a prior deliberate decision to record unlinked pings so the real status
encoding could be learned — or adding a limiter/TTL to those two collections.
That is a product call, so it is left to the owner.

### 16.7 The "Burgonomics API Menu" push error is ours: the outlet was never linked

Petpooja's dashboard reported, for a menu push:

```
Request -  {"success":"1","message":"Menu items are successfully listed.", ...the full catalogue...}
Response - {"success":false,"itemCount":0,"http_code":200,"error":""}
```

`http_code` and `error` are NOT ours — `/petpooja/menu-sync` answers
`{success, itemCount}` only. Petpooja wrapped OUR 200 body: it lifted
`success:false` / `itemCount:0` out of it and added the HTTP status and a blank
error. So the push **reached us and we refused it**.

- `menuSyncWebhook.ts:397-400` returns `{success:false, itemCount:0}` when the
  outlet code resolves to no branch.
- Live proof, `pos_webhook_audits`: `/petpooja/menu-sync` rows with
  `detail: "outlet not linked — catalog pull skipped"`, `itemCount: 0`, at
  2026-10-14T15:16:35Z (that row carries `restId: "31z58ciw0h"`), 2026-10-15T08:32,
  09:06 and 11:40, and again 2026-10-17T08:23:28Z.
- Live proof, `branches`: 25 docs, 14 bound to seeded placeholders
  (`str_001…str_016`), ZERO carrying `31z58ciw0h` or `5439`.

Petpooja is calling us correctly and we refuse because
`resolveBranchIdForRestId("31z58ciw0h")` is null. Fixing the reported error is a
**data** step (bind the outlet — `PRODUCTION_RUNBOOK.md` §5 step 1), not a
payload change.

Defect fixed in the same pass: the audit row for a refused push recorded
`restId: null`, because the route read only top-level keys while a push nests the
code in `restaurants[0].details.menusharingcode`. It now resolves through
`extractMenuRestId` and the `success:false` reply carries a `reason` naming the
outlet. Three new tests pin the resolution order (top-level → nested
`menusharingcode` → `restaurantid` → null).

### 16.8 Received, not fulfilled: the empty `orderID` is not a failure

On 2026-10-17 the operator captured Petpooja's **Order List** for
`5439 - Burgonomics DEMO [135148] - 31z58ciw0h`. It holds every order this
integration has placed — 34 records — including all five deliverable scenarios,
matching our own runner evidence by `clientOrderID` **and** total:

| scenario | clientOrderID (shown as the Order No.) | our total | Order List total | placed | status |
| --- | --- | --- | --- | --- | --- |
| Items + Tax | `bgx_items_tax_1792168821493` | 598.50 | 598.5 | 2026-10-16 22:10:28 | Waiting For Acceptance |
| Addon and Variation + Tax | `bgx_addon_variation_tax_1792168826052` | 312.95 | 312.95 | 22:10:30 | Waiting For Acceptance |
| Variation + Tax | `bgx_variation_tax_1792168825392` | 283.50 | 283.5 | 22:10:31 | Waiting For Acceptance |
| Addons + Tax | `bgx_addons_tax_1792168824749` | 419.00 | 419 | 22:10:31 | Waiting For Acceptance |
| Discount + Tax | `bgx_discount_tax_1792168825788` | 252.00 | 252 | 22:10:31 | Waiting For Acceptance |

> The "status" column records the 2026-10-17 **listing snapshot** only. It is
> not evidence of fulfilment: later callbacks for these probes are recorded in
> §19.2 (case 2 `-1 Cancelled`, case 3 `5 Food Ready`, the rest none), and the
> vendor's own word "fulfilled" is not a documented state (§19.1).

Consequences — every one a correction to an earlier claim in this document:

- **All five scenarios were RECEIVED by the POS** and their totals reconcile to
  the paise (see §19.2). **0/5 fulfilments are VERIFIED**: the listing snapshot
  only shows "Waiting For Acceptance", case 2 was later cancelled, and case 3
  reached Food Ready — not `10 Delivered`. `scripts/petpooja-sandbox-evidence.json`
  scored them `ok:false` because the runner required an order id in the
  response; that requirement was the wrong test, but removing it does **not**
  upgrade the evidence to fulfilment.
- The vendor's Order No. column displays OUR `clientOrderID`. No separate POS id
  is exposed anywhere the API can reach, so that is the only identifier Petpooja
  surfaces for these orders.
- The variants took effect **on the POS**, not only in our builder: the sweep's
  rows are listed as Home Delivery (Delivery), Home Delivery (Self delivery),
  Parcel/Pickup, Table/Dine-in, and one Advanced Order — the same knobs §16.3
  varied.
- The empty-echo evidence in §12/§13.1 proves the payload was not *parsed*. It
  never proved that nothing *registered*; those two are different, and only the
  Order List settles the second.

Fixes forced by this evidence:

1. `orderPush.ts` — an `ok` ack with no id is now recorded as ACCEPTED
   (`petpoojaAcceptedNoId`, `petpoojaAcceptedNoIdAt`, raw body kept in
   `petpoojaAcceptedNoIdAck`), status `synced`, and deduped. It previously threw,
   the catch parked `pending_retry`, and the retry worker re-POSTed an order the
   POS already held — ringing the kitchen once per attempt. No id is invented.
2. `payments/webhookHandler.ts` — the duplicate-capture guard treats
   `petpoojaAcceptedNoId` as "already pushed", exactly like `petpoojaOrderId`.
3. `petpooja/testRunner.ts` — `ok` now means "POS accepted"; id availability is
   reported separately (`petpoojaOrderId: string | null`,
   `petpoojaOrderIdReturned: boolean`). Acceptance without an id no longer throws.
4. `scripts/petpooja-sandbox-5scenarios.mjs` — the verdict is RELAY ACCEPTANCE,
   not fulfilment and not id presence; the evidence separates
   `petpoojaOrderId: null` from rejection and counts `acceptedWithoutId`.
   Fulfilment needs the vendor Order List/callbacks and is recorded in §19.2.

Reconciliation artifact: `scripts/petpooja-sandbox-fulfillment-reconciliation.json`
pairs each evidence row with its Order List row. No order-listing route exists on
either host (§16.2), so the dashboard Order List is the only RECEIPT/listing
oracle available here and the pairing is manual, by `clientOrderID` + total.
Fulfilment needs a terminal `10 Delivered` state (§19.2). Its current verdict is
`received: 5`, `fulfilmentVerified: 0`; the 2026-10-20 correction is noted there
so the earlier "5/5 FULFILLED" reading survives only as history.

### 16.9 DEMO outlet linked; placeholder Petpooja identifiers cleared (2026-10-17)

The demo outlet is now bound, so the menu push resolves and the relay can be
exercised end to end. Writes went through Firestore REST (service-account auth),
dry-run first. Pre-change snapshot:
`scripts/petpooja-placeholder-backup-2026-10-17.json`; what was written:
`scripts/petpooja-demo-linkage-applied.json`.

- **`branches/demo`** — `petpoojaStoreId: "31z58ciw0h"` (the outlet's real menu
  sharing code, restaurant 5439), `petpoojaRestId` mirrored, `active: true`,
  Ahmedabad coordinates, `isDemoOutlet: true`.
- **`stores/demo`** — `petpoojaRestId: "31z58ciw0h"`, `partnerBranchId: "demo"`,
  plus `hours`, `supports.{delivery,takeaway,dineIn} === true`, `pricing` and
  finite lat/lng. Each of those is required for `mapStoreDoc` to render the store
  rather than drop it.
- **`storeBranchRegistry.ts`** — the registry's first (and only) `verified: true`
  link, `demo → demo`. Every other outlet stays unmapped.
- **14 branches** — `petpoojaStoreId: "str_001"…"str_016"` → `null`.

**What was deliberately NOT cleared, and why the cleanup plan was wrong about
it.** `stores/*.petpoojaRestId` (`rest_<slug>` on all 16) *looks* like the same
class of placeholder but is load-bearing:
`burgonomics-foundation-core/src/features/menu/services/menuService.ts` resolves
a store's product scope from it (`resolveRestId`, falling back to the store id
only when empty) and then queries `products.where("restId", "==", …)`. The seeded
products carry the matching value (`hl-road | rest_navrangpura`, 56 docs each).
Nulling it would have fallen back to `str_001` and **emptied all 16 delivery
menus** — a self-inflicted outage dressed up as cleanup. `branches/*.petpoojaRestId`
(`rest_<slug>` on all 25) is genuinely read by nothing — grepped across
`functions/`, `burgonomics-partner/` and `burgonomics-foundation-core/` — so it is
left alone rather than churned.

**Effect of the cleanup.** The menu scheduler fans out one Petpooja call per
`active` branch, using `petpoojaStoreId` as the restID. Previously 14 of those
used `str_001`-style values that map to no outlet (silent `created: 0` rows) and
11 threw for a missing binding. Now every unlinked branch fails closed with the
exact reason, and exactly one call — the demo outlet — can succeed.

**Expected next behaviour, read off the code path rather than hoped for:**

- A Petpooja **menu push** for 5439 now resolves to `demo` and ingests the
  catalogue straight from the push payload (`incomingMenu.items`), which the code
  deliberately does *not* re-fetch — re-fetching hits the Menu API's S3 lookup,
  the source of "unable to fetch Object from s3 bucket".
- The **scheduled** sync (no push payload) is a different matter — see §16.10.
  This document predicted it would fail loudly on the Menu API's S3 lookup. The
  10:30 UTC tick showed it does the opposite: it completes *silently* with zero
  items and `error: null`.
- **KOT pushes** can now satisfy `order.branchId = "demo"` →
  `branches/demo.petpoojaStoreId`, so a real order can be relayed and the inbound
  callback path (§16.8) exercised.

Gates: functions build clean, `494 passed / 2 skipped / 0 failed`; partner
`tsc --noEmit` clean and `vite build` clean.

**Deployed 2026-10-17.** `api`, `hourlyPetpoojaMenuSync` and `retryPetpoojaOrders`
were updated to the committed HEAD build — the three functions the Petpooja fixes
reach (`api` carries the routes; the other two are the schedulers). The payment
webhook is a route *inside* `api`, so this shipped all committed route code, but
NOT the two uncommitted `functions/src/modules/payments/*` files another session
holds in flight. That separation was achieved by building and deploying from a
clean `git worktree` at HEAD, then proven by hash: the worktree's
`payments/webhookHandler.ts` equalled HEAD-in-git (`41A3371…`) and differed from
the dirty working-tree copy (`2C1475F…`).

Two traps the deploy exposed, both now written up in Runbook §2a:

- the worktree had **no `functions/.env`** (gitignored, so absent from any
  checkout). Deploying as-is would have shipped zero environment variables, and
  `assertProductionKeys` refuses to boot in production on mock keys — an outage,
  not a degrade. The file was copied across first and confirmed byte-identical
  by SHA256, and the deploy logged `Loaded environment variables from
  functions\.env`.
- the first attempt failed on the CLI's 10 s source-analysis timeout. Cold cache:
  the bundle took 29 s to load, then 2.6 s once warm. The code was fine.

Deploy verification here is **by provenance, not by behaviour**: clean tree →
`tsc` → bundles grepped for `petpoojaAcceptedNoId` and the outlet-naming reason →
`Successful update operation` for all three from the deploy API. No behavioural
fingerprint is available to an unauthenticated caller, because every route that
would prove it is auth-gated (`/petpooja/menu-sync`, `/petpooja/pushOrder`), and
the vendor credential was not used to forge one. The first real proof is an order.

### 16.10 A failed Petpooja menu lookup is logged as a *successful* empty sync (2026-10-17)

**Evidence.** The 10:30 UTC hourly tick — the first after the DEMO outlet was
linked — wrote exactly one `petpooja_sync_logs` row:

```json
{ "storeId": "demo", "status": "COMPLETED", "version": "live", "scope": "FULL",
  "error": null, "created": 0, "createdAt": "2026-10-17T10:30:02.335Z" }
```

Every other branch wrote none (all unlinked → fail closed), so the noise fell from
14 rows/hour to 1. But that one row is wrong. `demo` is the outlet whose Menu-API
lookup answers `{"success":"0","message":"unable to fetch Object from s3 bucket"}`
(§16.7 probe), so a **failed** fetch was recorded as a healthy `COMPLETED` with
`created: 0` and `error: null`.

**Cause.** `menuSyncWebhook.ts:156-160` throws only on `!response.ok` and then
does `menuData = await response.json()`. The following lines read
`menuData.items || []` (`:173`) and `menuData.categories || []` (`:174`) and never
inspect `success` or `message` — a grep finds no other reader of either. The Menu
API reports its own failure with HTTP 200 + `success:"0"`, so the failure body
parses as an empty catalogue.

**Why it matters.** `petpooja_sync_logs` is the operator-facing answer to "did the
menu sync?". A vendor outage and an outlet that genuinely has no menu produce the
same green row. This is the same false-success class as the rest of this
document — the runner's `ok:false` false negative (§16.8), the id-less ack read
as failure — with the sign flipped: here a failure reads as success. It is also
why `created: 0` rows were tolerated for so long as "expected, fake rest ids".

**Fixed 2026-10-17.** `menuApiFailureReason` (exported from `menuSyncWebhook.ts`)
reads the response body, and the live fetch now throws when the body reports a
failure — so the existing `captureErrorSnapshot` (`:162-169`) records it and
carries the vendor's own message into the error instead of logging green. It is
deliberately conservative: only an explicitly falsy `success` (`false`, `0`,
`"0"`), or prose accompanying no `items` array at all, counts as a failure, so a
genuinely empty catalog (`{"success":"1","items":[]}`) still syncs.

`functions/tests/petpooja.menu-fetch.test.ts` drives the real live path
(`mock.petpoojaPos = false`) with the POS HTTP call stubbed, so a dropped wiring
fails the test even when the helper is correct: the failing-body case rejects with
no `petpooja_sync_logs` row and no `lastPetpoojaSync` stamp, the empty-catalog
case still resolves and logs `created: 0`, and a non-200 still rejects. Reverting
only the wiring makes the first test resolve with
`{itemCount: 0, categoriesCount: 0}` — the false success reproduced — so the test
is known to bite rather than merely pass. Full gate: build clean, 500 passed /
2 skipped / 0 failed.

**Deployed 2026-10-17** (`api`, `hourlyPetpoojaMenuSync`, `retryPetpoojaOrders`),
from a clean worktree at the commit, per §16.9. Because this fix lands on the
*scheduled* path, the next hourly tick fingerprints the build — the first such
check available for either deploy: pre-fix the 10:30Z tick wrote one row for
`demo` (`COMPLETED`, `created: 0`, `error: null`); post-fix that same outlet must
write **none**, because its lookup now throws. A `petpooja_sync_logs` row for
`demo` at 11:30Z therefore means the deploy did not take effect, and a row with
`created > 0` means Petpooja provisioned the outlet's menu in the meantime.

---

## 17. The captured Push Menu payload: what the vendor actually sends (2026-10-17)

§12–§16 worked the **order** side of the integration; §16.10 closed the
failure-reads-as-success class on the scheduled menu path. This section is the
first ground truth for the **ingest** side: a real Push Menu capture, what the
mapper did with it, and what the capture cannot settle. Where the payload does
not answer a question, it is marked open rather than inferred.

### 17.1 The capture

Captured 2026-10-17 for outlet **5439** (`menusharingcode` `31z58ciw0h`). Our
route's reply:

```json
{"success":true,"itemCount":166,"http_code":200,"error":""}
```

166 items, **32 keys per item**. Top-level keys: `success`, `message`,
`restaurants`, `ordertypes`, `group_categories`, `categories`, `parentcategories`,
`items`, `variations`, `addongroups`, `attributes`, `taxes`, `tables`, `discounts`,
`serverdatetime`, `db_version`, `application_version`, `http_code`, `error`.

The outlet key is **nested**: `restaurants[0].details.menusharingcode`. That is
exactly the shape `extractMenuRestId` reads first (`menuSyncWebhook.ts:531`),
falling back to `restaurants[0].menusharingcode` only if `details` carries
nothing — the order §16.7's audit-row fix and §16.10's fixture both depend on
(see also §17.11).

### 17.2 The item field spellings — the mismatch that shipped "uncategorized"

The payload sends `item_categoryid`, `itemdescription` and `item_image_url`. The
mapper read `itemcategoryid`, `item_description`, and `itemimageurl` /
`image_url` / `image`.

Production outcome of that mismatch: all 166 product docs were written
`categoryId "uncategorized"`, `categoryName "Other"`, `description ""`,
`imageUrl null` — while the payload carried **166 real category ids, 21 real
category names and 110 real descriptions**.

Fixed in `1627204`: the mapper reads **vendor-first**, with every legacy spelling
retained as a fallback (`menuSyncWebhook.ts:337,350,355`) — the same
alias-tolerance `orderPush.ts` uses on the order side. Follow-up `9407006` made
the categoryid→categoryname join first-wins and `String()`-normalised.

### 17.3 The category name join

The NAME exists only in the top-level `categories[]` array (`categoryid` +
`categoryname`, 21 entries); items carry only the id. The join
`item.item_categoryid -> categories[].categoryid -> categoryname` resolves
**166/166 with zero misses**. `group_categories` and `parentcategories` are empty
in this payload, so neither plays any part in name resolution.

### 17.4 `item_image_url` is empty on every item — a vendor data gap

`item_image_url` is the **empty string** on all 166 items, and no image URL
exists anywhere in the payload. So `imageUrl: null` is a **vendor data gap, not
a mapper defect** — it was previously suspected to be our bug; it is not ours to
fix and nothing in the mapper can recover it.

### 17.5 `item_attributeid` — the veg flag is decoded by the payload itself

`item_attributeid` is `"1"` x129 (veg) and `"2"` x37 (non-veg). The payload's own
`attributes[]` array decodes `1 = veg`, `2 = non-veg` (the mapper's type comment
also allows `3 = Egg`). The mapper's `=== "1"` test is correct as it stands.

### 17.6 `in_stock` — THE OPEN QUESTION

All 166 items carry the string `"2"`, and that is the **only** value present.
The mapper accepts only `1` / `"1"` / `true` (`menuSyncWebhook.ts:308`), so all
166 products were written `inStock: false` and the whole storefront rendered
**Sold Out**.

> **The meaning of `"2"` is UNRESOLVED. It is not guessed at here.** The evidence
> boundary: an independent read of the vendor's published API documentation found
> that the documented Push Menu item schema **does not document `in_stock` at
> all**, and that the stock signal it *does* document is a different one — a
> **boolean `inStock`** that Petpooja sends **to the integrator's endpoint** when
> an item is toggled, carrying `type`, `itemID`, `restID`. There is no
> documentation of the push field's encoding.

The instrument that will settle it from data rather than a hunch: `317b6ea` adds
an additive `inStockValues` census to the `petpooja_sync_logs` row
(`menuSyncWebhook.ts:495`) plus a console warning when an entire catalogue comes
out not-in-stock (`:387`). The next real push answers it.

### 17.7 `price` — 81 zero-priced items, and the definitions are absent

166/166 items carry a non-empty `price` string. **81 of them are `"0"`**, and
those 81 are **exactly** the items flagged `itemallowvariation: "1"` — a perfect
1:1 partition.

The variation **definitions** are absent: per-item `variation` is `[]` on all
166, and the top-level `variations` array is empty. So those prices are **missing
from the payload entirely**, not relocated onto a variation. A corrected mapper
still cannot price those 81 SKUs, and `Number(item.price) || 0` renders an
unknowable price as an **orderable zero**.

> **OPEN DECISION (repo owner) + ASK (to Petpooja):** how should a
> variation-flagged SKU with `price:"0"` and no variation definition be priced —
> and did Petpooja intend to send the variation definitions in this push?

The instrument: additive unpriced counts on `petpooja_sync_logs`, plus one console warning only when an unpriced SKU is in stock, with missing-variation attribution.

### 17.8 Fields the mapper reads nowhere (latent, no impact today)

All single-valued in this capture, so none changes behaviour now — recorded so a
later change does not rediscover them:

| Field | Value in the capture | Note |
|---|---|---|
| `active` | `"1"` x166 | never read by this path |
| `is_combo` | `"0"` x166 | the tombstone pass protects a field this path never writes |
| `item_ordertype` | `"1,2,3"` x166 | `ordertypes[]` names Delivery / Pick Up / Dine In |

**Tax does not reach the product document.** `item_tax` is `"3928,3929"`,
resolving through `taxes[]` to CGST 2.5% + SGST 2.5%, with `tax_inclusive:
false`, `gst_type: "services"`, and `ignore_taxes` / `ignore_discounts` `"0"`.
None of that is written onto the product doc, so **every stored price is ex-GST
with no tax metadata**. Open decision.

### 17.9 A dead end: the legacy `petpooja_products` collection

Recorded so nobody re-walks it. The 63 documents in the legacy
`petpooja_products` collection are **seeded fixtures**, not payload-derived data,
and carry **no information about the vendor's `in_stock` encoding**.

Their only writer was `burgonomics-foundation-core/scripts/seed.ts`, whose import
(`petpoojaSampleData.ts`) was **deleted 2026-10-11**, so the write path is dead;
`firestore.rules` denies client writes and no live function writes the
collection. Every doc is a literal boolean `true` with **no `in_stock` field at
all**, the ids are `prd_*` slugs matching the seed array **63/63**, and they
overlap the real payload's numeric ids (**30651–30791**) **zero** times.

### 17.10 The classification contract after `b26d5e3` / `9c20c12`

The menu-ingest boundary separates two failure kinds:

- **Vendor refusal** — a *present-and-falsy* `success`, or `status` when
  `success` is absent. Marked as a refusal, **not message-matched**; severity
  **medium**.
- **Malformed body** — not a plain object, or an empty object. Severity
  **high**.

The route answers **503 only for a vendor refusal** and **400 otherwise**. That
400 is a **DELIBERATE decision**, not an oversight: the route is
operator-triggered, so there is no automatic retry for the status code to steer.
The push branch **guards its own input at the boundary** (`throwIfVendorRefusal`,
`menuSyncWebhook.ts:148`) rather than trusting its caller.

### 17.11 New vendor-truth test fixture

`functions/tests/fixtures/petpooja-menupush-sample.json` — a sanitized **two-item**
fixture derived from the real captured push, so the alias work runs against
vendor truth. No PII: `restaurants[].details` carries only a sharing-code
placeholder.

The real nesting `restaurants[0].details.menusharingcode` is **preserved
deliberately**, because `extractMenuRestId` reads `details` first and only falls
back to `restaurants[0].menusharingcode` (§17.1). A fixture that flattened it
would stop exercising that resolution order.

### 17.12 Deploy coupling, and the read-only proof nothing shipped

`firebase deploy --only functions:api` ships the **WHOLE functions bundle**, so a
Petpooja deploy also ships whatever else is committed — including other lanes'
dispatch work. That is why the deploy must be scoped and coordinated rather than
fired off at HEAD, and why a deploy worktree needs the gitignored
`functions/.env` copied in before it will boot (see `PRODUCTION_RUNBOOK.md` for
the deploy/env traps).

As of these commits **none of this lane's work is deployed.** Read-only evidence:

- the newest `petpooja_sync_logs` row is still **2026-10-17T11:02:53Z**, with no
  tick rows after it — consistent with the refusal fix already deployed (§16.10)
  throwing for every branch instead of writing a fake `COMPLETED` / `created: 0`;
- no row carries `inStockValues`, which only `317b6ea` would write.

### 17.13 The re-sync requirement

The 166 demo product docs **still hold the mis-mapped values** until the
catalogue is re-synced — the fixes change the mapper, not the documents already
written.

The hourly pull refuses on the vendor's S3 lookup (§16.10), so it cannot rewrite
them. A **fresh Push Menu from Petpooja's dashboard** is what rewrites them — and
that same re-push, after turning **one item off in the POS**, is what settles
`in_stock` from the new census (§17.6).


## 18. The vendor's own PDFs — document-backed facts (read 2026-10-19)

Two vendor PDFs came with the onboarding email and are present locally
(`Downloads`, both dated 2026-10-06): *API Guide for Placing Orders on Petpooja
POS* (9pp) and *Petpooja Sandbox Guide for Integration Testing* (6pp). Both were
read and their text extracted outside the repo. The coordinator lane read the
same files independently and the readings below agree. Where a document conflicts
with our payload, the conflict is **recorded, not silently resolved**.

### 18.1 STOCK is a webhook, not a payload field

The Sandbox Guide (p.4, "Menu Item On/Off") makes the **Item On/Off Webhook** the
documented carrier of "the item stock status (in-stock or out-of-stock)", with a
separate **Store On/Off Webhook** for store availability; §6 repeats it as the way
to "test stock availability". **No vendor document describes an `in_stock` field
in the Push Menu payload at all.** So the push-side values (all 166 arrived as
`"2"`) have no documented encoding and the census cannot be read as a stock
signal. `in_stock` stays UNKNOWN — no mapping change, no tolerant fallback
(C07/C14). The authoritative signal is the inbound on/off webhook, which we
already expose at `/petpooja/stockWebhook`.

### 18.2 CALLBACK is `callback_url`, fronted by the dashboard base URL

The Save-Order guide (p.5) lists `callback_url` as REQUIRED — "URL to receive
order updates"; p.8 step 4 is "Receive confirmation & track via Callback URL".
The Sandbox Guide (p.5) names the three callback actions — "Accept orders, mark
food as ready, or reject orders via the callback URL" — i.e. the accept /
food-ready / reject channel our `/petpooja/webhook` maps. The Sandbox Guide (p.2)
also states the dashboard **Base URL is "The common URL used for all webhooks"**,
so every webhook is that base plus the configured path. Neither document describes
any callback authentication. Still UNVERIFIED (and human-gated): which base URL
the vendor has registered — the whitelist email names a Cloud Run host form while
the deployed config carries the `cloudfunctions.net/api` form. Both may route to
the same service, so the string difference is not by itself a defect.

### 18.3 VARIATION fields are optional, empty-string when absent

Save-Order guide (pp.6-7): `variation_id` = "Unique ID for variant received from
Menu Push Payload" (not required), `variation_name` = "Half Dish or Full Dish"
(not required), and the OrderItem example emits **both as `""`** for a line with
no variant. Our builder matches that shape (`|| ""`) and it is now pinned by
tests. The sandbox outlet exposes no variation definitions at all (81 of 166 items
set `itemallowvariation = "1"` with an empty `variation`, §17 census), so **V3/V5
are blocked on vendor data, not on our payload**.

### 18.4 DISCOUNT: no `discount` object — now sample-locked

Save-Order guide (§8): "For discounts you have to avoid 'discount' object from the
order payload. Please use two keys: discount type and discount total from the
'Order' object." Our builder sends `discount_type` + `discount_total` and an empty
`Discount` member — correct by contract, so the earlier "does the checker want a
line-level `item_discount`?" question is CLOSED, not open.

**Update 2026-10-26 (vendor-corrected sample):** the sample Petpooja sent back with
the structural rejection carries NO `Discount` member at all — only
`Restaurant / Customer / Order / OrderItem / Tax` under `orderinfo.OrderInfo`.
Both builders now omit the member entirely and send discounts as the two Order
scalars only. The guide's example shows `item_discount: ""` where we send
`"0.00"` — still cosmetic, still unchanged without a reason. A dry-run line
carrying a discount still reports `discount_total` truthfully and never claims
line-level discount semantics it does not have.

### 18.5 `final_price` — RESOLVED by the vendor's corrected sample (unit figure)

Guide p.6 describes `final_price` as "Item Price - Item level discount if any"
(**a unit figure**) and its example pairs price `"250.00"` with final_price
`"250"` at `quantity "2"`. The earlier builder emitted the LINE total
(unit x qty) against the `total`-formula reading, and this section recorded the
tension instead of flipping it.

**Update 2026-10-26 (vendor-corrected sample):** the vendor's sample settles the
reading — `final_price` is the UNIT figure (`price - item_discount`), explicitly
NOT the line total, and its OrderItem example has been sent back to us as the
authoritative ACCEPTED structure for these exact five scenarios (the sample's
totals/dates are illustrative, never a totals oracle for our engine). Both
builders (`orderPush.ts` app path, `testRunner.ts` sandbox path) now emit unit
`final_price` and the tests pin it at qty > 1:

- `petpooja.structural-contract.test.ts` — the unit invariant
  `final_price == (price - item_discount)` swept across BOTH builders;
- `petpooja.service.test.ts` — qty 3 line: price `"249.00"`, final_price
  `"249.00"`, `"747.00"` explicitly refused;
- `testRunner.test.ts` — qty 2 + add-ons: price `"150.00"`, final_price
  `"150.00"`.

Two adjacent sample-locked facts recorded with it: `Tax[].price` is the numeric
percentage string (`"2.5"`, not `"2.5%"`), and `enable_delivery` /
`min_prep_time` are NUMBERS while `no_of_persons` / `collect_cash` / `otp` are
strings. Retained business policy NOT flipped by the sample: full-restaurant
GST liability, COD collects the full total, ONLINE collects `"0.00"` — the
sample's own arithmetic differs in places, which is recorded as an OUTSTANDING
VENDOR QUESTION, not silently reconciled.

## 19. Consolidated integration evidence (verified 2026-10-19/20)

This section exists so the five-case status, the outlet's own limitations and the
sync-observability contract do not have to be re-derived. Every claim is labelled
with how it was established. Nothing here is a release authorisation.

### 19.1 Documented order-status table (DOC VERIFIED)

Source: Petpooja Online Ordering APIs **V2.1** blueprint, section
`order-callback-request-response` / `callback-request` / `data-structure`,
verbatim:

> Current status of order.[-1 = Cancelled, 1/2/3 = Accepted, 4 = Dispatch,
> 5 = Food Ready, 10 = Delivered]
>
> `orderID` — "Unique client order id which is used to update order status at
> client side."

Independently confirmed by two readers (the blueprint JSON and the rendered
documentation), so it is not a single-source claim. The `orderID` definition is
why the inbound handler resolves a callback as OUR client reference first
(`item86ingSync.ts`); it treats the value as a POS id only when a branch-scoped
`orders.petpoojaOrderId` match proves it. A client reference is never stamped as
`petpoojaOrderId`.

Consequences for our code:

- `normalizePetpoojaStatus` (`item86ingSync.ts:12-35`) already matches this
  table exactly: `-1 -> cancelled`, `1/2/3 -> accepted`, `4 ->
  out_for_delivery`, `5 -> ready`, `10 -> delivered`, anything else ->
  `unknown`. It is pinned by `petpooja.service.test.ts` (including
  `"INVALID_STATUS" -> "unknown"`), so no invented meaning can creep in.
- **"Fulfilled" is not a documented state.** The words fulfilled / completed /
  served do not appear as order states anywhere in the reference. `10 Delivered`
  is the only terminal success. Any vendor review that asks for "fulfilled order
  IDs" is asking for something its own documentation does not define.

### 19.2 The five sandbox cases (RUNTIME EVIDENCE + arithmetic reconciliation)

Capture: the vendor's own Order List for `5439 - Burgonomics DEMO [135148]`,
mapping code `31z58ciw0h`, taken 2026-10-17 14:05. The listing's "Order No."
column carries **our** `clientOrderID`; the vendor's own order id was never
exposed, so it is UNKNOWN and must not be invented.

| Case | clientOrderID | Listed total | Listed timestamp | Last documented callback | Verdict |
|---|---|---|---|---|---|
| 1 Items + Tax | `bgx_items_tax_1792168821493` | 598.50 | 2026-10-16 22:10:28 | none recorded | received; fulfilment NOT VERIFIED |
| 2 Addon + Tax | `bgx_addons_tax_1792168824749` | 419.00 | 22:10:31 | `-1 Cancelled` (2026-10-18 15:47:13Z) | cancelled at POS; NOT fulfilled |
| 3 Variation + Tax | `bgx_variation_tax_1792168825392` | 283.50 | 22:10:31 | `5 Food Ready` (2026-10-18 15:46:42Z) | progressed; NOT fulfilled |
| 4 Discount + Tax | `bgx_discount_tax_1792168825788` | 252.00 | 22:10:31 | none recorded | received; fulfilment NOT VERIFIED |
| 5 Addon + Variation + Tax | `bgx_addon_variation_tax_1792168826052` | 312.95 | 22:10:30 | none recorded | received; fulfilment NOT VERIFIED |

Every listed total reconciles to the paise against the harness arithmetic
(`scripts/petpooja-sandbox-5scenarios.mjs`), which is real evidence that the
pricing fields were carried: 570 + 5% GST = 598.50; 310 + addons 30 + 40 + 5% +
20 packaging = 419.00; 270 + 5% = 283.50; (290 - 50) + 5% = 252.00;
249 + addon 30 + 5% + 20 packaging = 312.95.

Path: all five were sent by the scripted probe harness, **not** by a customer
order. The harness imports the same payload builder as the Cloud Function relay
(`functions/dist/modules/petpooja/testRunner.js`), so shape-level evidence
transfers to the app path; end-to-end app evidence does not.

### 19.3 The outlet's own configuration limit (PROVIDER-ORIGIN DATA)

Extracted from the vendor's own captured push
(`Petpooja_menu_push_error.txt`, "Menu items are successfully listed"):

- `addongroups: []` - empty; every item also carries `addon: []`
- `itemallowaddon: "0"` on all **166** items
- `itemallowvariation: "1"` on **81** items, `"0"` on **85**
- top-level `variations: []` - empty; every item carries `variation: []`

Therefore no addon and no variation can resolve on this outlet: there is no
valid id we could ever send. Cases 1 and 4 (items, discount) are exercisable
today; cases 2, 3 and 5 as addon/variation cases require **vendor-side sandbox
test configuration** (or a sandbox outlet/item that already defines them). This
is configuration, not a payload defect on our side, and no production menu or
stock change is requested.

### 19.4 `in_stock` - one observed value, still unresolved

The same push carried `in_stock: "2"` on **166 of 166** items. The whitelist
(`menuSyncWebhook.ts:314`) recognises `1` / `"1"` / `true` only, so every item
normalised to `inStock: false` and the whole catalogue rendered Sold Out. Whether
`"2"` means available is **UNKNOWN** - the reference documents `in_stock` only in
examples. The mapping is deliberately unchanged, and the raw values are censused
on the sync-log row (`inStockValues`, e.g. `{ "2": 166 }`) so the next real push
answers the question without a code change.

### 19.5 Sync observability contract (LOCAL CODE VERIFIED)

The sync-log row now distinguishes the two things that were previously one
signal:

- a **refused pull** writes `status: "FAILED"` with the vendor error and
  `catalogueReady: false`; it never writes a green `COMPLETED` row and never
  stamps `lastPetpoojaSync`;
- a **completed ingest** writes `status: "COMPLETED"` plus `catalogueReady`
  (true only if at least one item came out available) and
  `availabilityWarning: "NO_ITEMS_IN_STOCK"` for the all-dark case only. An empty
  feed is `catalogueReady: false` with a null warning, because an API glitch must
  not read as a 100% 86-ing.

`status` and `error` keep their original meanings, so nothing that reads them
changes behaviour. Runtime illustration of why this matters: the deployed build
recorded a Petpooja failure every hour from at least 2026-10-19T13:30Z to 20:30Z
while `petpooja_sync_logs` stayed empty - failures were recorded only in
`dev_error_snapshots`, so a sync-log reader saw "nothing" rather than "failing".

### 19.6 Settled / UNKNOWN / BLOCKED

- **Settled**: the status table above; `callback_url` is sent on every
  `save_order`; `restID` is the restaurant mapping id used for both menu and
  orders; `OrderItem` and `AddonItem` carry the documented required fields;
  inbound callback authentication is **not documented** (so our unauthenticated
  webhook is contract-consistent and no vendor signature may be asserted).
- **UNKNOWN**: the meaning of `in_stock: "2"`; whether the outlet is provisioned
  for `mapped_restaurant_menus` (the refusal string is not documented); what state
  the vendor's review counts as "fulfilled".
- **BLOCKED externally**: addon/variation sandbox configuration; vendor-side
  fulfilment advancement; deployment of any local fix (the deployed artifact
  `api-00013-gis`, built 2026-10-17T10:49:44Z, predates every fix after
  2026-10-17T13:29Z, and also predates the vendorRefusal severity downgrade -
  the deployed build still pages on-call at `high` for a known vendor refusal).
  No deploy is authorised from this lane.

## 20. Vendor attachment reconfirmation and tax serialization — 2026-10-28

The user supplied the actual annotated attachment (`commented payload.txt`,
SHA-256 `4af49d4f6f4313bf71234579aaa0b41b9364a58946ea03597062e28c621144e2`)
and Petpooja's email requesting structural corrections and the same five sandbox
scenarios again. The clean backend `c26effe` already emits the attachment's
nesting, field names and primitive types. A type-only attachment fixture now
checks both formatters against every supplied key/type for all five case shapes;
it does not copy the sample's credentials, contact data, outlet IDs or money.

Independent decimal formatting of the tax components was not conservative:
an authoritative ₹13.95 GST total became ₹6.97 + ₹6.97 = ₹13.94. Allocate the
existing GST total in integer paise across item weights and captured tax rates,
then derive each order-level tax row from the exact serialized item-tax rows.
Do not independently round each half or recalculate the order's GST rate/base.
Positive GST with no matched item-tax rows must block rather than silently emit
untaxed lines beside a taxed order summary.

This is an offline candidate in `.swarm-worktrees/petpooja-vendor-contract-20261028`,
not an applied root repair or deployment. The existing liability, charge-tax,
discount and third-party-delivery policies are unchanged. The last recorded menu
snapshot still does not prove current add-on/variation mappings; obtain a fresh
vendor push/configuration before resubmitting those cases. A local schema pass
or API save acknowledgement is not Petpooja integration approval or physical KOT
proof. Exact rejected request bodies for the five client IDs in the newly supplied
email were not available in the searched local evidence; do not claim they were
audited byte-for-byte or that corrected orders have already been resubmitted.

## 21. Full primary-document reading and corrected interpretation — 2026-10-28

Read both vendor PDFs completely (Save Order: 9 pages; Sandbox: 6 pages), both
local Petpooja references, and the live public V2.1.0 documentation. The public
page's embedded schema was statically decoded to include the collapsed child
attributes, request examples and response examples across all ten API sections.
The old 749-line rendered snapshot alone did not expose those child definitions.
See `stages/05_orders/output/petpooja-vendor-review-20261028/documentation-review.md`
for sources, evidence locations, candidate findings and outstanding work.

### 21.1 Requirements already answered by the documents

- **Add-ons and variants:** Save Order PDF p.6 and Apiary `OrderItem.price`
  define an all-in **unit** price, including selected add-ons and the selected
  variation price. Add-on detail rows must not add the same price a second time.
- **Final price:** `final_price = price - item_discount`, also a unit figure;
  `quantity` remains separate. §18.5's old line-total interpretation is superseded.
- **Discounts:** PDF pp.3,7 distinguish the order-level `discount_type` /
  `discount_total` from item discounts. Do not emit a separate `Discount` object.
  The builders currently use fixed amount (`F`); do not introduce a percentage
  policy or double-subtract item discounts during this reconciliation.
- **Restaurant total:** PDF p.3 says `total` must contain **only the amount due
  to the restaurant**: item final amounts less order discount, plus applicable
  restaurant-liable GST and packing charges. Apiary explicitly excludes GST
  retained by the aggregator. Customer grand total is not automatically this
  amount; third-party courier charges must not be included merely because the
  customer pays them. Keep customer charging and restaurant settlement distinct.
- **GST ownership:** Apiary Push Menu `items.gst_type` defines `services` as
  integrator collection/remittance to government and `goods` as collection then
  settlement to the restaurant. This is not an undefined field. Reconcile the
  current authoritative menu/accounting contract before emitting `gst_liability`
  and `restaurant_liable_amt`; a blanket restaurant-liable default is not justified
  for a `services` item by the published semantics.
- **Charge tax configuration:** Push Menu defines `calculatetaxonpacking`,
  `pc_taxes_id`, `calculatetaxondelivery` and `dc_taxes_id`. Whether the current
  outlet enables those charges/taxes needs current data, not an invented zero or
  a generic question about whether such taxes exist.
- **Delivery:** PDF p.4 and Apiary explicitly define `enable_delivery: 0` for
  third-party riders and `1` for restaurant self-delivery. These are not competing
  sample conventions. Apiary restricts `collect_cash` to **COD and merchant
  self-delivery**; positive `collect_cash` on every COD order is not compliant.
- **Variation identity:** Consume item-local `variation`, not deprecated
  top-level `variations`. Apiary requires the variation **item** ID in order-item
  `id`, and the variation-master ID in `variation_id`. These are distinct values.
  Its public example maps parent `7765809` → child item `7765862`, master `89058`;
  these are illustrative public IDs, not sandbox outlet configuration.

### 21.2 Candidate gaps, not vendor-approved policies

The current candidate still copies `pricing.grandTotal` into `Order.total`, emits
`gst_liability: "restaurant"` and full restaurant liability for every tax row,
and fills `collect_cash` while setting `enable_delivery: 0`. Menu ingestion
records `petpoojaGstType`, but the trusted product snapshot/payload path does not
consume it. The last documented outlet capture says `gst_type: "services"`;
that is historical data, not a fresh live check. These findings invalidate any
claim that structure and paise-conservation tests establish financial compliance.

Charge taxes are hard-coded to zero; current menu settings and server pricing
must be reconciled before that can be claimed correct. The verified parent-item
snapshot is also not proof of a selected variation-item/master pair or add-on
membership. A fresh menu push is necessary but not, by itself, proof that all
selection mappings flow through to the payload.

This reading pass changes documentation/drafts only. It does not change customer
totals, tax policy, payload code, outlet settings or deployment. The original
seven-file test-time manifest remains historical evidence; the documentation
review manifest records the reference-only change separately.

### 21.3 Conflicts and genuine remaining confirmations

- PDF p.8 gives the `qle1yy2ydc.../V1/save_order` host; live Apiary gives
  `47pfzh5sf2.../V1/save_order`. Ask which is provisioned for this sandbox; do not
  operate either endpoint just to discover it.
- Public Apiary still describes/emits `Discount` and types add-on `group_id` as
  a string, although its example uses a number. The supplied corrected attachment
  and PDF no-discount-object instruction govern this candidate's wire shape:
  no `Discount`, numeric `group_id`, Boolean `tax_inclusive`, no legacy duplicates.
- The public Save Order example has internally inconsistent illustrative tax
  rates/amounts and mixed `tax_inclusive` spellings. It is not a financial oracle.
- The `in_stock: "2"` value appears in menu examples without a documented
  meaning. The authoritative toggle contract is Boolean `inStock`; keep the
  push-field encoding unresolved until Petpooja confirms it.
- The documents do not specify an odd-paise allocation convention. Conserving
  ₹13.95 as ₹6.98 + ₹6.97 fixes local arithmetic, not vendor rounding approval.
- Sandbox PDF p.2 explicitly supports optional **Client Authorization** and
  **Headers Configuration**. Earlier blanket claims that callback authentication
  is not described, or that unauthenticated callbacks are thereby production-safe,
  are withdrawn. No standardized vendor HMAC algorithm is specified here; confirm
  and enforce the provisioned authentication instead of inventing a signature.
- Keep refreshed item/add-on/variation/tax mappings, actual sandbox listing and
  callback evidence, vendor review and separate production tokens as independent
  gates. No orders, emails or deployments were sent by this documentation review.

## 22. Verified demo resubmission — 2026-10-28

This runtime checkpoint supersedes §21.2's then-current candidate gaps and
§21.3's unresolved host/stock statements; it is not production approval.

- The isolated candidate now derives GST ownership from captured `gst_type`,
  distinguishes restaurant due from customer total, conserves integer-paise tax,
  and restricts cash collection to COD merchant self-delivery. All 16 changed
  application/test fingerprints matched the previously passing typecheck,
  1,356-test and build gates immediately before preparing the live batch.
- The authenticated **Staging** account configuration explicitly provisioned
  `https://qle1yy2ydc.execute-api.ap-southeast-1.amazonaws.com/V1/save_order`.
  No exploratory order was used to choose between the conflicting public hosts.
- The native item editor defines stock2 as **Do Not Track**, stock1 as In Stock,
  stock0 as Out Of Stock. This observation does not itself repair stock ingestion.
- With explicit user approval, only required demo item configurations were
  changed at outlet5439 / `31z58ciw0h`. An inactive parent caused Save Change to
  disable its API area despite an API-enabled checkbox in the request. Activation
  plus API-area enablement persisted and was read back. The configured rows are:
  plain30791 INR350; add-on30674 INR310; variation-only parent30673 → child10657618
  INR290; combined parent30672 → child10657617 INR270. Both variants use master
  14178 **Full [8 Pieces]**. Group17259 **Soft Drinks** contains Coke93021 INR10
  and Diet Coke93023 INR20; the tested assignments require exactly one selection.
- The user separately authorized a demo menu push to the existing Firebase
  webhook. The initial Push Menu response was a tax confirmation, not a push.
  Its normal confirmation was submitted once. The final portal response reported
  `Burgonomics API Menu trigger failed`, with webhook HTTP503. No retry was made.
  The response included the exact generated outbound menu: selected items have
  `gst_type: services`, `tax_inclusive: false`, tax IDs3928/3929 at2.5% each;
  packing/delivery tax flags0, empty charge-tax IDs, packaging applicability NONE,
  item/variant packing0. This is authoritative generated-menu evidence despite
  callback delivery failure, not proof of a successful menu sync to Firebase.
- Five genuine cases were formatted by the verified compiled **production**
  builder with metadata snapshots derived from that vendor-generated menu.
  Parent/child/master and group/option membership, attachment key/type shape,
  quantity/unit pricing, discounts, paise conservation and ownership were checked
  before traffic. The stale placeholder script and MT-01 aliases were not run.
- Each Save Order was submitted **once**, 2026-10-28 13:23:38–41 IST. All returned
  HTTP200, `success: "1"`, `Your order is saved.`, matching restID/clientOrderID
  and an empty POS orderID. All five were independently found in Order Listing
  and their detail views, including real modifier labels and financial amounts:

| Case | Client reference | Restaurant due | GST, vendor-liable |
|---|---|---:|---:|
| Items + Tax | `bgx2_items_tax_1793173921627` | 350.00 | 17.50 |
| Addons + Tax | `bgx2_addons_tax_1793173921628` | 320.00 | 16.00 |
| Variation + Tax | `bgx2_variation_tax_1793173921629` | 580.00 | 29.00 |
| Discount + Tax | `bgx2_discount_tax_1793173921630` | 300.00 | 15.00 |
| Addon + Variation + Tax | `bgx2_addon_variation_tax_1793173921631` | 580.00 | 29.00 |

All remain **Waiting For Acceptance**. No Accept/Cancel/status action was taken.
The portal's internal listing IDs255258–255262 are not POS IDs returned by the
Save Order API. No callback lifecycle, physical printing or vendor approval is
claimed. Our webhook availability, persisted option provenance and full live
application ingestion/relay path remain separate production gates. Redacted
requests, receipts, detail evidence and results are retained in
`stages/05_orders/output/petpooja-vendor-review-20261028/` as
`sandbox-resubmission-payloads-redacted.json`, `sandbox-resubmission-results.json`
and `sandbox-menu-mappings-verified.json`. No deployment, merge or email send.
