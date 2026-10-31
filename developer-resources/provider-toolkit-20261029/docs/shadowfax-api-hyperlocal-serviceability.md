# Official Shadowfax Hyperlocal serviceability API page

Source: https://developer.shadowfax.in/docs/api/hyperlocal-marketplace/serviceability
Retrieved UTC: 2026-10-29T11:22:20.787206+00:00
Retrieval method: static

Public webpage text snapshot for local development reference. Not an API conformance or vendor-approval verdict; copyright remains with the publisher. Scripts/styles were not retained or executed.

---

Shadowfax Hyperlocal Marketplace API
Shadowfax Hyperlocal Marketplace API
Serviceability
Server
https://hlbackend.staging.shadowfax.in
https://api.shadowfax.in
Check whether Shadowfax can serve an order before placement.
Check order serviceability
PUT
https://hlbackend.staging.shadowfax.in
/api/v1/order-serviceability/
Authorization (header)
or
Bearer
Check whether Shadowfax can serve the order. Only when the response is
serviceable: true
should you place an order — do so within a couple of minutes of the check.
Rate limit:
1200 requests per minute.
Check order serviceability ›
Request Body
ServiceabilityRequest
pickup_latitude
​
string
·
required
Pickup latitude (converted to float).
pickup_longitude
​
string
·
required
Pickup longitude (converted to float).
drop_latitude
​
string
·
required
Drop latitude (converted to float).
drop_longitude
​
string
·
required
Drop longitude (converted to float).
paid
​
string
·
enum
·
required
false
for COD,
true
for prepaid.
Enum values:
true
false
order_value
​
number
·
required
Order value.
COID
​
string
Client order ID for mapping.
stage_of_check
​
string
·
enum
pre_order
or
post_order
.
Enum values:
pre_order
post_order
rain_flag
​
boolean
Pass true if rain-impacted.
client_surge
​
number
Extra surge incentive for the rider.
Check order serviceability ›
Responses
200
400
401
Serviceability result
ServiceabilityResponse
serviceable
​
boolean
delivery_cost
​
number
Estimated delivery cost including GST.
pickup_eta
​
number
Pickup ETA in minutes.
drop_eta
​
number
Drop ETA in minutes.
pickup_rain_mode_flag
​
boolean
drop_rain_mode_flag
​
boolean
rain_surge_amount
​
number
reason
​
string
Reason when not serviceable.
serviceability
​
boolean
PUT
/
api/
v1/
order-serviceability/
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
PUT
\
--url
https://hlbackend.staging.shadowfax.in/api/v1/order-serviceability/
\
--header
'Content-Type: application/json'
\
--data
'
{
"pickup_longitude": "77.5620661",
"drop_latitude": "12.897338",
"drop_longitude": "77.552905",
"pickup_latitude": "12.9276526",
"paid": "false",
"COID": "order_23434",
"stage_of_check": "post_order",
"order_value": 250,
"rain_flag": false,
"client_surge": 0
}
'
shell
Example Request Body
{
"pickup_longitude"
:
"77.5620661"
,
"drop_latitude"
:
"12.897338"
,
"drop_longitude"
:
"77.552905"
,
"pickup_latitude"
:
"12.9276526"
,
"paid"
:
"false"
,
"COID"
:
"order_23434"
,
"stage_of_check"
:
"post_order"
,
"order_value"
:
250
,
"rain_flag"
:
false
,
"client_surge"
:
0
}
json
application/json
Example Responses
200
400
401
{
"serviceable"
:
true
,
"pickup_eta"
:
10
,
"drop_eta"
:
35
,
"delivery_cost"
:
42
,
"pickup_rain_mode_flag"
:
false
,
"drop_rain_mode_flag"
:
false
,
"rain_surge_amount"
:
0
}
json
application/json
Location is serviceable
No riders available
Authentication
Orders
