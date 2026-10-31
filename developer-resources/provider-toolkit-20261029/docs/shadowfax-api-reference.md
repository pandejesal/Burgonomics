# Official Shadowfax API reference index

Source: https://developer.shadowfax.in/docs/api-reference
Retrieved UTC: 2026-10-29T11:22:21.350664+00:00
Retrieval method: static

Public webpage text snapshot for local development reference. Not an API conformance or vendor-approval verdict; copyright remains with the publisher. Scripts/styles were not retained or executed.

---

Copy page
API Reference
Select the API you want to explore. Each section includes endpoint documentation, request/response examples, and an interactive playground.
Order Types
Every order Shadowfax handles is one of three types. Each has its own API section below — this is just to help you find the right one.
Type
Direction
Description
Forward
Warehouse/Seller → Customer
Standard delivery from seller/warehouse to customer doorstep
Reverse (Pickup)
Customer → Warehouse/Seller
Customer return — rider picks up from customer and delivers to seller or warehouse
Exchange
Both simultaneously
Forward delivery + reverse pickup in a single visit
13 endpoints
Forward Logistics
Order placement, tracking, cancellation, updates, serviceability, labels, POD, escalations, and AWB generation.
8 endpoints
Reverse Logistics
Pickup orders, tracking, cancellation, order updates, proof of delivery, serviceability, and AWB generation.
1 endpoint
Exchange
Forward delivery + reverse pickup in a single rider visit, with optional QC on the reverse leg.
16 endpoints
Hyperlocal Marketplace
Serviceability, order placement, tracking, cancellation, dispatch ready, MDND, and sandbox status simulation.
15 endpoints
Hyperlocal Dedicated Store
Store serviceability, store orders, edit, tracking, cancellation, dispatch ready, re-attempt, and sandbox simulation.
4 endpoints
Quick Commerce
Token generation, order creation with ETA details, order updates (OTPs, pickup readiness), cancellation, and live rider location webhook.
Coming soon
Shopify Integration
OAuth, order sync, fulfillment callbacks, and storefront shipping rates.
Coming soon
Webhooks
Push callback payloads, signature verification, retry logic, and event types.
Last modified on
August 17, 2026
On this page
Order Types
