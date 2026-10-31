# Official Shadowfax reference authentication page

Source: https://developer.shadowfax.in/docs/reference/authentication
Retrieved UTC: 2026-10-29T11:22:21.462405+00:00
Retrieval method: static

Public webpage text snapshot for local development reference. Not an API conformance or vendor-approval verdict; copyright remains with the publisher. Scripts/styles were not retained or executed.

---

Copy page
Reference
Authentication
Shadowfax's client gateway (
dale.staging.shadowfax.in
/
dale.shadowfax.in
) supports two authentication methods: static Token Authentication and OAuth2 client-credentials. Which methods are available, how long an OAuth2 token lasts, and where credentials come from all vary by product — see the table below before you build against a specific API.
Token Authentication
Pass your API token in the
Authorization
header on every request:
Code
Authorization: Token your_api_token
The token is static and does not expire — no exchange or refresh step is needed. For most products, generate it from the
SFX 360 Partner Portal
; Hyperlocal Dedicated Store is the exception — see the table below.
OAuth2 Client-Credentials
Exchange your client credentials for a short-lived Bearer token, then pass that token on every subsequent request.
Generate a Token
Terminal
Code
curl
--location
'https://dale.staging.shadowfax.in/api/v1/clients/token/'
\
--header
'Authorization: Basic <CLIENT_BASIC_AUTH_TOKEN>'
\
--header
'Content-Type: application/x-www-form-urlencoded'
\
--data-urlencode
'grant_type=client_credentials'
<CLIENT_BASIC_AUTH_TOKEN>
is a Base64-encoded
client_id:client_secret
pair. Contact your Shadowfax integration POC for your client credentials. Hyperlocal Marketplace uses a different token endpoint (
POST /oauth/token/
) — otherwise the flow is the same.
Response
Code
{
"access_token"
:
"KrCTg7CZ8Ykr7do3gdRre0z6zCjObG"
,
"expires_in"
:
3600
,
"token_type"
:
"Bearer"
,
"scope"
:
"read write"
}
Using the Token
Code
Authorization: Bearer <access_token>
Request a new token before expiry using the same credentials exchange — there is no refresh-token grant. Expiry varies by product, see below.
Which method should I use?
Product
Token Auth
OAuth2
Notes
Reverse Logistics
Supported
Supported
OAuth token expires after 1 hour
Forward Logistics
Supported
Supported
OAuth token expires after 1 hour
Exchange
Supported
Supported
OAuth token expires after 1 hour
Hyperlocal Marketplace
Supported
Supported
OAuth token expires after 24 hours; generated via
POST /oauth/token/
Hyperlocal Dedicated Store
Only method
—
Staging and production keys are shared by the Shadowfax team via email, not the Partner Portal
Quick Commerce
—
Only method
OAuth token expires after 1 hour
Last modified on
August 2, 2026
Serviceability
On this page
Token Authentication
OAuth2 Client-Credentials
Generate a Token
Response
Using the Token
Which method should I use?
