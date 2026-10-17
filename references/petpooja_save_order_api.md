# Petpooja Save Order API + Sandbox — Reference (Layer 3)

> Extracted from the official PDFs supplied by the user (2026-10-06):
> - `API Guide for Placing Orders on Petpooja POS.pdf` (9 pages)
> - `Petpooja Sandbox Guide for Integration Testing.pdf` (6 pages)
> Source text: `C:\Users\DELL\AppData\Local\Temp\opencode\petpooja_guides.txt`

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
5 required scenarios can produce fulfilled order IDs.

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

> **Correction (2026-10-17, see §16.8).** This section treated an empty
> `orderID` as evidence the relay had not landed. It has not: Petpooja's own
> Order List for outlet 5439 shows the orders these probes placed, plus the five
> deliverable scenarios. An empty `orderID` is the normal shape of a successful
> save and says nothing about fulfilment — only the dashboard Order List does.

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
2. **The POS id was never read.** `payload.orderID` was ignored, so a callback was
   swallowed by the store-status branch. Fixed: `orderID` is read, and a payload
   carrying it is never treated as a store-status ping.
3. **Nothing was keyed on the POS id.** Fixed: `resolveOrderByPosOrderId` resolves
   `orders.petpoojaOrderId == orderID` (single-field equality, so no composite
   index), and refuses a match outside the `restID`'s branch.
4. **The callback never persisted the POS id.** Fixed: when a callback teaches us
   the id, the order stores `petpoojaOrderId` and is promoted
   `pending_retry -> synced`, so the retry worker stops re-pushing an order the POS
   has already accepted.

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

### 16.8 Fulfilment is proven: the empty `orderID` is not a failure

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

Consequences — every one a correction to an earlier claim in this document:

- **The five scenarios are FULFILLED.** `scripts/petpooja-sandbox-evidence.json`
  scored them `ok:false` and §15 read that as 0/5. That was **our false
  negative**: the runner required the response to carry an order id. Petpooja
  registers the order and leaves `orderID` empty.
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
4. `scripts/petpooja-sandbox-5scenarios.mjs` — the verdict is fulfilment, not id
   presence; the evidence separates `petpoojaOrderId: null` from rejection and
   counts `acceptedWithoutId`.

Reconciliation artifact: `scripts/petpooja-sandbox-fulfillment-reconciliation.json`
pairs each evidence row with its Order List row. No order-listing route exists on
either host (§16.2), so the dashboard Order List is the only fulfilment oracle and
the pairing is manual, by `clientOrderID` + total.

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

