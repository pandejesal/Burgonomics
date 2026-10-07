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
