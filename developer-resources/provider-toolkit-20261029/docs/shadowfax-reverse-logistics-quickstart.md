# Official Shadowfax reverse logistics quickstart

Source: https://developer.shadowfax.in/docs/reverse-logistics/quickstart
Retrieved UTC: 2026-10-29T11:22:21.801658+00:00
Retrieval method: static

Public webpage text snapshot for local development reference. Not an API conformance or vendor-approval verdict; copyright remains with the publisher. Scripts/styles were not retained or executed.

---

Copy page
Reverse Logistics
Quickstart
Get a pickup order live on staging in under 10 minutes.
Authentication
Reverse Logistics supports two methods:
Token Authentication
(static token from the
SFX 360 Partner Portal
) and
OAuth2 client-credentials
(short-lived Bearer token, valid 1 hour). See
Authentication
for the full token request and response for both.
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
Verify that pickup is available at the customer's pincode.
Terminal
Code
curl
"https://dale.staging.shadowfax.in/api/v1/clients/serviceability/?service=customer_pickup&pincodes=560001"
\
-H
"Authorization: Token your_api_token"
A successful response confirms the pincode is serviceable. See the
Serviceability API
for the full response schema.
2. Place a Pickup Order
Create a reverse pickup order. The request has four sections:
customer_details
(who to pick up from),
return_details
(where to return it),
order_details
(order-level info), and
sku_details
(what's being returned).
Terminal
Code
curl
-X
POST
https://dale.staging.shadowfax.in/api/v1/clients/pickup/orders/
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
"name": "Test Customer",
"contact": "9999999999",
"address": "123 Test Street, HSR Layout",
"city": "Bangalore",
"pincode": 560001
},
"return_details": {
"return_type": "origin",
"name": "Warehouse",
"address": "456 Hub Road, Koramangala",
"pincode": 560002
},
"order_details": {
"client_order_id": "TEST-001"
},
"sku_details": [
{
"sku_name": "Blue T-Shirt",
"price": 500,
"return_reason": "Size mismatch"
}
]
}'
The response includes an
awb_number
— this is your tracking reference for all subsequent calls. See the
Pickup Orders API
for the full request/response schema.
3. Track the Order
Poll the tracking endpoint with the AWB number from the previous step.
Terminal
Code
curl
https://dale.staging.shadowfax.in/api/v4/clients/requests/YOUR_AWB_NUMBER
\
-H
"Authorization: Token your_api_token"
For production, prefer
webhooks
over polling for real-time updates.
4. Set Up Webhooks
Register a webhook URL in the
SFX 360 Partner Portal
to receive status updates automatically. You'll get callbacks at every major transition — pickup assigned, picked up, delivered, and more.
See
Webhooks
for payload format and event types.
Go Live
Once your staging integration passes all test scenarios (order placement, tracking, webhook receipt), swap the base URL and token to production. No other code changes required.
Next Steps
Order Lifecycle
— understand the states your order will pass through
Quality Check
— enable doorstep QC for returns
API Reference
— explore all endpoints in the interactive playground
Last modified on
August 2, 2026
Reverse Logistics
On this page
Authentication
Environments
1. Check Serviceability
2. Place a Pickup Order
3. Track the Order
4. Set Up Webhooks
Go Live
Next Steps
