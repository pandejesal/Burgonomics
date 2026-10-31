# Official Shadowfax exchange quickstart

Source: https://developer.shadowfax.in/docs/exchange/quickstart
Retrieved UTC: 2026-10-29T11:22:21.607247+00:00
Retrieval method: static

Public webpage text snapshot for local development reference. Not an API conformance or vendor-approval verdict; copyright remains with the publisher. Scripts/styles were not retained or executed.

---

Copy page
Exchange
Quickstart
Get an exchange order live on staging in under 10 minutes.
Authentication and Environments
Identical to Forward Logistics — see
Authentication
for token/OAuth2 setup and the
Forward Logistics Quickstart
for staging/production base URLs. All examples below use the staging base URL.
1. Check Serviceability
Verify that delivery and pickup are available at the relevant pincodes.
Terminal
Code
curl
"https://dale.staging.shadowfax.in/api/v1/clients/serviceability/?service=marketplace&pincodes=700016"
\
-H
"Authorization: Token your_api_token"
2. Place an Exchange Order
Create an exchange order with both forward and reverse legs. The request has three sections:
customer_details
,
fwd_order
(new item to customer), and
rev_order
(old item from customer).
Terminal
Code
curl
-X
POST
https://dale.staging.shadowfax.in/api/v4/clients/orders/
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
"name": "Amit Kumar",
"contact": "9876543210",
"address": "23 Park Street, Flat 4B",
"city": "KOLKATA",
"pincode": 700016
},
"fwd_order": {
"order_details": {
"client_order_id": "EXC-FWD-TEST-001",
"product_value": 1499.0,
"payment_mode": "prepaid",
"cod_amount": 0,
"order_service": "Regular"
},
"pickup_details": {
"pickup_type": "seller",
"name": "MobileHub Retail",
"contact": "9876543211",
"address": "56 Sector V, Salt Lake",
"city": "KOLKATA",
"pincode": 700091
},
"return_details": {
"return_type": "seller",
"name": "MobileHub Retail",
"contact": "9876543211",
"address": "56 Sector V, Salt Lake",
"city": "KOLKATA",
"pincode": 700091
},
"sku_details": [
{
"sku_name": "Premium Phone Case - Black",
"sku_id": "SKU-CASE-001",
"price": 1499.0,
"category": "Accessories"
}
]
},
"rev_order": {
"order_details": {
"client_order_id": "EXC-REV-TEST-001"
},
"sku_details": [
{
"sku_name": "Old Phone Case - Worn",
"sku_id": "SKU-CASE-OLD-001",
"price": 0.0,
"return_reason": "Exchange",
"qc_required": true
}
],
"return_details": {
"return_type": "seller",
"name": "MobileHub Retail",
"contact": "9876543211",
"address": "56 Sector V, Salt Lake",
"city": "KOLKATA",
"pincode": 700091
}
}
}'
The response includes AWB numbers for both the forward and reverse orders. See
Place Exchange Order
in the API Reference for the full schema.
3. Track Both Legs
Each order has its own AWB. Track them independently:
Terminal
Code
# Track forward delivery
curl
https://dale.staging.shadowfax.in/api/v4/clients/orders/FWD_AWB_NUMBER/track/
\
-H
"Authorization: Token your_api_token"
# Track reverse pickup
curl
https://dale.staging.shadowfax.in/api/v4/clients/requests/REV_AWB_NUMBER
\
-H
"Authorization: Token your_api_token"
4. Set Up Webhooks
Register a webhook URL in the
SFX 360 Partner Portal
to receive status updates for both legs automatically.
Go Live
Once your staging integration passes all test scenarios, swap the base URL and token to production. No other code changes required.
Next Steps
Order Lifecycle
— how each leg progresses
Placing Exchange Orders
— detailed guide to request structure and validation rules
API Reference
— explore the endpoint in the interactive playground
Last modified on
August 2, 2026
Exchange Orders
On this page
Authentication and Environments
1. Check Serviceability
2. Place an Exchange Order
3. Track Both Legs
4. Set Up Webhooks
Go Live
Next Steps
