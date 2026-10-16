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
   treated as a win: it invented `pp_<epoch>` and stamped `kotPrinted:true`,
   telling the kitchen a KOT had printed that Petpooja never registered. The
   fabricated id was then truthy, so the idempotency guard skipped every later
   retry and the order became unrecoverable. Now an empty id parks the order
   `pending_retry` and stores the raw POS body in `lastPetpoojaError`. The
   response's real `orderID` spelling is also read now — the old code only
   looked for snake_case, so a genuine id would have been discarded.
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

### 14.4 Open — identifier resolution drift

`references/petpooja_pos.md` P3 and `references/known_issues.md` R13 both state
that the authoritative restaurant identifier is the **nested**
`branches/{branchId}.petpooja.restId`. The code does not read that location.
Every server path reads the **flat** `petpoojaStoreId`:

- `orderPush.ts:463`, `menuSyncWebhook.ts:52,60,65`, `item86ingSync.ts:127,135,253`

and `firestore.rules` gates the nested `petpooja.restId` to brand owners. So an
operator following the runbook writes one location while the relay reads another.
Compounding this, no real outlet has ever been linked: all 25 branch docs hold
seeded placeholders (`petpoojaStoreId = str_001…str_016`,
`petpoojaRestId = rest_<slug>`), neither of which is a real Petpooja id.

This is deliberately fail-closed (the code refuses to fall back to the branch
doc id or invent one), so it was left as-is rather than re-plumbed blind — there
is no linked outlet to validate a resolution-order change against. Resolve the
doc/code disagreement before linking the first real outlet.

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

