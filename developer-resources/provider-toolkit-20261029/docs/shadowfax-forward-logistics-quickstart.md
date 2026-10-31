# Official Shadowfax forward logistics quickstart

Source: https://developer.shadowfax.in/docs/forward-logistics/quickstart
Retrieved UTC: 2026-10-29T11:22:21.829775+00:00
Retrieval method: static

Public webpage text snapshot for local development reference. Not an API conformance or vendor-approval verdict; copyright remains with the publisher. Scripts/styles were not retained or executed.

---

Copy page
Forward Logistics
Quickstart
Get a forward delivery order live on staging in under 10 minutes.
Authentication
Forward Logistics supports both Token and OAuth2 client-credentials authentication — see
Authentication
for how to generate and use each.
Environments
Environment
Base URL
Purpose
Staging
https://dale.staging.shadowfax.in/api
Integration testing, development
Production
https://dale.shadowfax.in/api
Live operations
Staging and production use
separate tokens
. Staging mirrors production topology — same hubs, pincodes, and routing logic. Orders placed in staging do not trigger real pickups. Webhook callbacks fire normally, so you can test end-to-end without operational impact.
All examples below use the staging base URL.
1. Check Serviceability
Verify that delivery is available at the customer's pincode.
Terminal
Code
curl
"https://dale.staging.shadowfax.in/api/v1/clients/serviceability/?service=marketplace&pincodes=560034"
\
-H
"Authorization: Token your_api_token"
Returns a list of serviceable pincodes with available service tiers. See the
Serviceability API
for the full response schema.
2. Place a Forward Order
Create a delivery order. Fields are flat at the top level —
customer_details
(where to deliver),
order_details
,
pickup_details
,
return_details
(where failed deliveries go back to), and
product_details
(item list).
Terminal
Code
curl
-X
POST
https://dale.staging.shadowfax.in/api/v3/clients/orders/
\
-H
"Authorization: Token your_api_token"
\
-H
"Content-Type: application/json"
\
-d
'{
"customer_details": {
"name": "Rahul Sharma",
"contact": "9876543210",
"address_line_1": "42 MG Road, Koramangala",
"city": "BANGALORE",
"pincode": 560034
},
"order_details": {
"client_order_id": "FWD-TEST-001",
"product_value": 1299.0,
"payment_mode": "prepaid",
"cod_amount": 0,
"order_service": "Regular"
},
"pickup_details": {
"pickup_type": "seller",
"name": "TechStore Pvt Ltd",
"contact": "9876543211",
"address_line_1": "15 Industrial Area Phase 2",
"city": "BANGALORE",
"pincode": 560058
},
"return_details": {
"return_type": "seller",
"name": "TechStore Pvt Ltd",
"contact": "9876543211",
"address_line_1": "15 Industrial Area Phase 2",
"city": "BANGALORE",
"pincode": 560058
},
"product_details": [
{
"sku_name": "Wireless Bluetooth Headphones",
"sku_id": "SKU-HEADPHONE-001",
"price": 1299.0,
"category": "Electronics"
}
]
}'
return_type: "seller"
above returns the item to the seller if delivery fails. Use
"origin"
instead if it should return to your warehouse. This example is a Marketplace order (the default) — see
Order Types
for how Warehouse, D2D, and MPS orders differ.
The response includes an
awb_number
— this is your tracking reference for all subsequent calls. See the
Place Forward Order
API for the full request/response schema.
3. Track the Order
Query the tracking endpoint with the AWB number from the previous step.
Terminal
Code
curl
https://dale.staging.shadowfax.in/api/v4/clients/orders/YOUR_AWB_NUMBER/track/
\
-H
"Authorization: Token your_api_token"
Returns the current status plus a timeline of all tracking events. For production, prefer
webhooks
over polling.
4. Set Up Webhooks
Register a webhook URL in the
SFX 360 Partner Portal
to receive status updates automatically. You'll get callbacks at every major transition — dispatched, in transit, out for delivery, delivered, and more.
See
Callbacks
for payload format and event types.
Go Live
Once your staging integration passes all test scenarios (order placement, tracking, webhook receipt), swap the base URL and token to production. No other code changes required.
Next Steps
Order Lifecycle
— understand the states your order will pass through
Orders
— detailed guide to placing, cancelling, and updating orders
Label & POD
— generate shipping labels and fetch proof-of-delivery details
AWB Generation
— pre-generate AWBs ahead of order creation
Bulk Operations
— track or fetch POD for many orders at once
Escalations
— raise a support escalation against an order
API Reference
— explore all endpoints in the interactive playground
Last modified on
August 2, 2026
Forward Logistics
On this page
Authentication
Environments
1. Check Serviceability
2. Place a Forward Order
3. Track the Order
4. Set Up Webhooks
Go Live
Next Steps
