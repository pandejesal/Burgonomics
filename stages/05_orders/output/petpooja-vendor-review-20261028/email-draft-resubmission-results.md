# Reply All draft — corrected five-case resubmission

Not sent. Reply in the existing Petpooja thread, retaining its subject and
recipients. Attach `sandbox-resubmission-payloads-redacted.json` if sending the
draft with payload evidence. Do not attach credentials or the original .env.

---

Hi Team,

We have corrected the payloads against your annotated attachment and resubmitted
all five requested cases for **Burgonomics DEMO [135148]**, restaurant 5439,
menu-sharing code **31z58ciw0h**, on **28 October 2026, 13:23:38–41 IST**.

Each submission returned HTTP 200, `success: "1"` and **“Your order is saved.”**
We also checked all five in Order Listing and opened their order details to
verify the item, add-on/variation labels, quantity, discount and GST amounts.

| Case | New client order reference | Restaurant total (INR) | GST (INR) |
|---|---|---:|---:|
| Items + Tax | bgx2_items_tax_1793173921627 | 350.00 | 17.50 |
| Item with Addons + Tax | bgx2_addons_tax_1793173921628 | 320.00 | 16.00 |
| Item with Variation + Tax | bgx2_variation_tax_1793173921629 | 580.00 | 29.00 |
| Item with Discount + Tax | bgx2_discount_tax_1793173921630 | 300.00 | 15.00 |
| Item with Addon and Variation + Tax | bgx2_addon_variation_tax_1793173921631 | 580.00 | 29.00 |

The corrected requests use your attachment's `orderinfo.OrderInfo` structure,
with `udid` and `device_type` inside `orderinfo`, the required `details` wrappers,
numeric add-on `group_id`, and no separate `Discount` object or duplicate envelope
fields. Prices and final prices are per unit; the two variation cases use
quantity 2. The discount case applies INR 50 before GST.

We used the demo's actual mappings: Soft Drinks group 17259 with Coke 93021 and
Diet Coke 93023; variation child items 10657618 and 10657617 with master 14178
“Full [8 Pieces]”. The captured menu specifies tax-exclusive `services` items
and CGST 3928/SGST 3929 at 2.5% each, so GST is vendor-liable and the restaurant
total excludes that GST. Delivery and packing charges are zero in these cases.

All five currently show **Waiting For Acceptance**. The save responses echo our
client references but return an empty POS `orderID`; we are not treating the
acknowledgements as confirmation of physical KOT printing or completed callbacks.

Separately, our registered menu webhook returned HTTP 503 during the demo menu
publication. We captured the generated menu for mapping verification, but are
tracking webhook availability and callback lifecycle verification as unresolved
work on our side before production readiness.

Please review these five replacement orders against the supplied attachment and
confirm the results of your verification. Production approval remains pending.

Regards,
Burgonomics Team
