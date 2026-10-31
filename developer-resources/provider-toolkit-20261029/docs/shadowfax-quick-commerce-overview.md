# Official Shadowfax quick commerce overview

Source: https://developer.shadowfax.in/docs/quick-commerce/overview
Retrieved UTC: 2026-10-29T11:22:21.871852+00:00
Retrieval method: static

Public webpage text snapshot for local development reference. Not an API conformance or vendor-approval verdict; copyright remains with the publisher. Scripts/styles were not retained or executed.

---

Copy page
Quick Commerce
Quick Commerce
The Quick Commerce Order Management API integrates dark-store and quick-commerce clients with the Shadowfax delivery platform via the unified client gateway. It covers four core operations:
Operation
Description
Create Order
Raise a new delivery request for an order placed at a store/dark-store
Edit / Update Order
Update order attributes, OTPs, pickup readiness, and returns after creation
Cancel Order
Cancel an order up to the point the rider enters the customer's delivery geofence
Live Order Location
Receive real-time rider GPS pushes on your webhook while an order is out for delivery
Order Status Callbacks
Receive push notifications when an order changes status — created, out for delivery, arrived, etc.
All requests and responses are JSON over HTTPS.
Placeholders such as
<CLIENT_ID>
,
<STORE_UNIQUE_CODE>
, and
<AWB_NUMBER>
in these guides must be replaced with values specific to your integration. Contact your Shadowfax integration POC for client credentials and store code mapping.
Next Steps
Quickstart
— token to first order on staging
Order Status Callbacks
— webhook payloads for order-status changes
Errors
— error envelope and common scenarios
API Reference
— interactive endpoint documentation
Last modified on
July 17, 2026
Quickstart
On this page
Next Steps
