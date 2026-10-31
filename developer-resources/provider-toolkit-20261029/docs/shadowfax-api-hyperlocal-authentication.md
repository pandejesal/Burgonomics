# Official Shadowfax Hyperlocal authentication page (token + OAuth2)

Source: https://developer.shadowfax.in/docs/api/hyperlocal-marketplace/authentication
Retrieved UTC: 2026-10-29T11:22:20.755658+00:00
Retrieval method: static

Public webpage text snapshot for local development reference. Not an API conformance or vendor-approval verdict; copyright remains with the publisher. Scripts/styles were not retained or executed.

---

Shadowfax Hyperlocal Marketplace API
Shadowfax Hyperlocal Marketplace API
Authentication
Server
https://hlbackend.staging.shadowfax.in
https://api.shadowfax.in
OAuth2 client credentials token exchange.
Obtain OAuth access token
POST
https://hlbackend.staging.shadowfax.in
/oauth/token/
Exchange client credentials for a Bearer access token. Token expires in 86400 seconds (24 hours).
Obtain OAuth access token ›
Request Body
OAuthTokenRequest
client_id
​
string
·
required
client_secret
​
string
·
required
grant_type
​
string
·
enum
·
required
Enum values:
client_credentials
Obtain OAuth access token ›
Responses
200
401
Access token issued
OAuthTokenResponse
access_token
​
string
expires_in
​
integer
token_type
​
string
POST
/
oauth/
token/
cURL
JavaScript
Python
Java
Go
C#
Kotlin
Objective-C
PHP
Ruby
Swift
curl
--request
POST
\
--url
https://hlbackend.staging.shadowfax.in/oauth/token/
\
--header
'Content-Type: application/x-www-form-urlencoded'
\
--data
client_id=your_client_id
\
--data
client_secret=your_client_secret
\
--data
grant_type=client_credentials
shell
Example Request Body
{
"client_id": "your_client_id",
"client_secret": "your_client_secret",
"grant_type": "client_credentials"
}
text
application/x-www-form-urlencoded
Example Responses
200
401
{
"access_token"
:
"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
,
"expires_in"
:
86400
,
"token_type"
:
"Bearer"
}
json
application/json
Serviceability
