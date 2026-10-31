# OFFICIAL Shadowfax Hyperlocal Marketplace API developer documentation

Source: https://developer.shadowfax.in/docs/api/hyperlocal-marketplace
Retrieved UTC: 2026-10-29T11:18:57.384077+00:00
Retrieval method: static

Public webpage text snapshot for local development reference. Not an API conformance or vendor-approval verdict; copyright remains with the publisher. Scripts/styles were not retained or executed.

---

Shadowfax Hyperlocal Marketplace API
Shadowfax Hyperlocal Marketplace API
APIs for integrating Shadowfax hyperlocal order delivery (Marketplace format 1A). Merchants can place orders, cancel orders, get order details, check serviceability, and receive callbacks for status changes and rider locations. This model does not require stores to be created upfront at Shadowfax.
Authentication
Hyperlocal Marketplace supports both Token and OAuth2 authentication — OAuth tokens expire after 24 hours (longer than other Shadowfax products) and are generated via
POST /oauth/token/
. See
Authentication
for the full setup.
IP Whitelisting
Share your IP address list with Shadowfax to access production APIs.
Order Status
Status
Description
ACCEPTED
Order accepted by Shadowfax for delivery
ALLOTTED
Order allotted to a rider
ARRIVED
Rider arrived at pickup (callback-only, optional)
DISPATCHED
Order picked up and dispatched for delivery
ARRIVED_CUSTOMER_DOORSTEP
Rider arrived at drop location (callback-only, optional)
DELIVERED
Order delivered to customer
CANCELLED
Order cancelled
CANCELLED_BY_CUSTOMER
Order cancelled by customer
RETURNED_TO_SELLER
SKUs or COD returned to seller (callback-only, optional)
Callbacks
Configure a webhook URL with Shadowfax to receive order status and rider location updates. See the
Callbacks guide
for payload formats, retry policy, and idempotency requirements.
Tags
Authentication
OAuth2 client credentials token exchange.
Serviceability
Check whether Shadowfax can serve an order before placement.
Orders
Place, edit, track, cancel, and manage hyperlocal delivery orders.
Sandbox
Staging-only endpoints to simulate order status transitions and rider location callbacks.
Security Schemes
ApiTokenAuth
Client API token. Format:
Token <api_token>
apiKey
OAuth2BearerAuth
OAuth2 access token. Format:
Bearer <access_token>
. Tokens expire after 24 hours.
http
Servers
https://hlbackend.staging.shadowfax.in
Staging
https://api.shadowfax.in
Production
