# Official Shadowfax Hyperlocal sandbox simulation API page

Source: https://developer.shadowfax.in/docs/api/hyperlocal-marketplace/sandbox
Retrieved UTC: 2026-10-29T11:22:21.171105+00:00
Retrieval method: static

Public webpage text snapshot for local development reference. Not an API conformance or vendor-approval verdict; copyright remains with the publisher. Scripts/styles were not retained or executed.

---

Shadowfax Hyperlocal Marketplace API
Shadowfax Hyperlocal Marketplace API
Sandbox
Server
https://hlbackend.staging.shadowfax.in
https://api.shadowfax.in
Staging-only endpoints to simulate order status transitions and rider location callbacks.
Allot rider (sandbox)
PUT
https://hlbackend.staging.shadowfax.in
/app/v3/sandbox/clusters/orders/{sfx_order_id}/allot/
Authorization (header)
or
Bearer
Staging only. Allot a rider to an order and mark status as
ALLOTTED
. Pass
"only_allot": 0
to trigger acceptance callback, or
"only_allot": 1
for allot callback.
Allot rider (sandbox) ›
path Parameters
sfx_order_id
​
integer
·
required
Allot rider (sandbox) ›
Request Body
AllotRiderRequest
rider_id
​
integer
·
required
only_allot
​
integer
0 for acceptance callback, 1 for allot callback.
Allot rider (sandbox) ›
Responses
200
400
Rider allotted
MessageResponse
message
​
string
PUT
/
app/
v3/
sandbox/
clusters/
orders/
{sfx_order_id}
/
allot/
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
https://hlbackend.staging.shadowfax.in/app/v3/sandbox/clusters/orders/:sfx_order_id/allot/
\
--header
'Content-Type: application/json'
\
--data
'
{
"rider_id": 136493
}
'
shell
Example Request Body
{
"rider_id"
:
136493
}
json
application/json
Example Responses
200
400
{
"message"
:
"Allotted Rider to Order"
}
json
application/json
Update rider arrival at pickup (sandbox)
POST
https://hlbackend.staging.shadowfax.in
/app/v3/sandbox/order/{sfx_order_id}/update-rider-arrival/
Authorization (header)
or
Bearer
Staging only. Mark status as
ARRIVED
at the pickup location.
Update rider arrival at pickup (sandbox) ›
path Parameters
sfx_order_id
​
integer
·
required
Update rider arrival at pickup (sandbox) ›
Request Body
RiderArrivalRequest
time_arrival
​
string
·
required
Format: YYYY-MM-DD HH:MM:SS
Update rider arrival at pickup (sandbox) ›
Responses
200
400
401
Arrival updated
SandboxStatusResponse
status
​
boolean
message
​
string
POST
/
app/
v3/
sandbox/
order/
{sfx_order_id}
/
update-rider-arrival/
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
https://hlbackend.staging.shadowfax.in/app/v3/sandbox/order/:sfx_order_id/update-rider-arrival/
\
--header
'Content-Type: application/json'
\
--data
'
{
"time_arrival": "2018-01-09 18:40:00"
}
'
shell
Example Request Body
{
"time_arrival"
:
"2018-01-09 18:40:00"
}
json
application/json
Example Responses
200
400
401
{
"status"
:
true
,
"message"
:
"Successfully updated."
}
json
application/json
Order collect / dispatch (sandbox)
PUT
https://hlbackend.staging.shadowfax.in
/app/v3/sandbox/order/{sfx_order_id}/collect/
Authorization (header)
or
Bearer
Staging only. Mark order as collected and dispatched (
DISPATCHED
).
Order collect / dispatch (sandbox) ›
path Parameters
sfx_order_id
​
integer
·
required
Order collect / dispatch (sandbox) ›
Request Body
CollectOrderRequest
status
​
string
·
enum
·
required
Enum values:
COLLECTED
pickup_lat
​
number
·
required
pickup_lng
​
number
·
required
Order collect / dispatch (sandbox) ›
Responses
200
400
401
Order collected
CollectOrderResponse
message
​
string
virtual_contact_number
​
string | null
PUT
/
app/
v3/
sandbox/
order/
{sfx_order_id}
/
collect/
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
https://hlbackend.staging.shadowfax.in/app/v3/sandbox/order/:sfx_order_id/collect/
\
--header
'Content-Type: application/json'
\
--data
'
{
"status": "COLLECTED",
"pickup_lat": 90,
"pickup_lng": 90
}
'
shell
Example Request Body
{
"status"
:
"COLLECTED"
,
"pickup_lat"
:
90
,
"pickup_lng"
:
90
}
json
application/json
Example Responses
200
400
401
{
"message"
:
"done successfully"
,
"virtual_contact_number"
:
null
}
json
application/json
Customer doorstep arrival (sandbox)
PUT
https://hlbackend.staging.shadowfax.in
/app/v3/sandbox/order/{sfx_order_id}/customer-doorstep-arrival/
Authorization (header)
or
Bearer
Staging only. Mark status as
ARRIVED_CUSTOMER_DOORSTEP
.
Customer doorstep arrival (sandbox) ›
path Parameters
sfx_order_id
​
integer
·
required
Customer doorstep arrival (sandbox) ›
Request Body
DoorstepArrivalRequest
time_arrival
​
string
·
required
arrival_lat
​
number
·
required
arrival_lng
​
number
·
required
arrival_accuracy
​
number
·
required
Customer doorstep arrival (sandbox) ›
Responses
200
400
401
Doorstep arrival updated
SandboxStatusResponse
status
​
boolean
message
​
string
PUT
/
app/
v3/
sandbox/
order/
{sfx_order_id}
/
customer-doorstep-arrival/
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
https://hlbackend.staging.shadowfax.in/app/v3/sandbox/order/:sfx_order_id/customer-doorstep-arrival/
\
--header
'Content-Type: application/json'
\
--data
'
{
"time_arrival": "2020-05-06 11:30:00",
"arrival_lat": 90,
"arrival_lng": 90,
"arrival_accuracy": 10
}
'
shell
Example Request Body
{
"time_arrival"
:
"2020-05-06 11:30:00"
,
"arrival_lat"
:
90
,
"arrival_lng"
:
90
,
"arrival_accuracy"
:
10
}
json
application/json
Example Responses
200
400
401
{
"status"
:
true
,
"message"
:
"Successfully updated."
}
json
application/json
Mark order delivered (sandbox)
PUT
https://hlbackend.staging.shadowfax.in
/app/v3/sandbox/order/{sfx_order_id}/deliver/
Authorization (header)
or
Bearer
Staging only. Mark order status as
DELIVERED
. Set
is_partial_delivery
to indicate partial delivery.
Mark order delivered (sandbox) ›
path Parameters
sfx_order_id
​
integer
·
required
Mark order delivered (sandbox) ›
Request Body
DeliverOrderRequest
status
​
string
·
enum
·
required
Enum values:
DELIVERED
delivery_latitude
​
number
·
required
delivery_longitude
​
number
·
required
is_partial_delivery
​
boolean
·
required
Mark order delivered (sandbox) ›
Responses
200
400
401
Order delivered
MessageResponse
message
​
string
PUT
/
app/
v3/
sandbox/
order/
{sfx_order_id}
/
deliver/
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
https://hlbackend.staging.shadowfax.in/app/v3/sandbox/order/:sfx_order_id/deliver/
\
--header
'Content-Type: application/json'
\
--data
'
{
"status": "DELIVERED",
"delivery_latitude": 90,
"delivery_longitude": 90,
"is_partial_delivery": true
}
'
shell
Example Request Body
{
"status"
:
"DELIVERED"
,
"delivery_latitude"
:
90
,
"delivery_longitude"
:
90
,
"is_partial_delivery"
:
true
}
json
application/json
Example Responses
200
400
401
{
"message"
:
"done successfully"
}
json
application/json
Customer return / cancelled by customer (sandbox)
PUT
https://hlbackend.staging.shadowfax.in
/app/v3/sandbox/order/{sfx_order_id}/customer-return/
Authorization (header)
or
Bearer
Staging only. Mark status as
CANCELLED_BY_CUSTOMER
.
Customer return / cancelled by customer (sandbox) ›
path Parameters
sfx_order_id
​
integer
·
required
Customer return / cancelled by customer (sandbox) ›
Request Body
CustomerReturnRequest
return_reason
​
string
·
required
Customer return / cancelled by customer (sandbox) ›
Responses
200
400
401
Customer return recorded
MessageResponse
message
​
string
PUT
/
app/
v3/
sandbox/
order/
{sfx_order_id}
/
customer-return/
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
https://hlbackend.staging.shadowfax.in/app/v3/sandbox/order/:sfx_order_id/customer-return/
\
--header
'Content-Type: application/json'
\
--data
'
{
"return_reason": "Damaged products"
}
'
shell
Example Request Body
{
"return_reason"
:
"Damaged products"
}
json
application/json
Example Responses
200
400
401
{
"message"
:
"Successfully updated."
}
json
application/json
Return to seller (sandbox)
PUT
https://hlbackend.staging.shadowfax.in
/app/v3/sandbox/order/{sfx_order_id}/seller-return/
Authorization (header)
or
Bearer
Staging only. Mark status as
RETURNED_TO_SELLER
when undelivered SKUs or COD is returned to the seller.
Return to seller (sandbox) ›
path Parameters
sfx_order_id
​
integer
·
required
Return to seller (sandbox) ›
Request Body
SellerReturnRequest
rts_order_id
​
integer
·
required
Return to seller (sandbox) ›
Responses
200
400
401
Seller return recorded
MessageResponse
message
​
string
PUT
/
app/
v3/
sandbox/
order/
{sfx_order_id}
/
seller-return/
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
https://hlbackend.staging.shadowfax.in/app/v3/sandbox/order/:sfx_order_id/seller-return/
\
--header
'Content-Type: application/json'
\
--data
'
{
"rts_order_id": 232
}
'
shell
Example Request Body
{
"rts_order_id"
:
232
}
json
application/json
Example Responses
200
400
401
{
"message"
:
"Successfully updated."
}
json
application/json
Update rider location (sandbox)
PUT
https://hlbackend.staging.shadowfax.in
/app/v3/sandbox/order/{sfx_order_id}/update-rider-location/
Authorization (header)
or
Bearer
Staging only. Simulate rider location updates to test rider location callbacks.
Update rider location (sandbox) ›
path Parameters
sfx_order_id
​
integer
·
required
Update rider location (sandbox) ›
Request Body
UpdateRiderLocationRequest
update_latitude
​
number
·
required
update_longitude
​
number
·
required
Update rider location (sandbox) ›
Responses
200
400
401
Rider location updated
message
​
boolean
PUT
/
app/
v3/
sandbox/
order/
{sfx_order_id}
/
update-rider-location/
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
https://hlbackend.staging.shadowfax.in/app/v3/sandbox/order/:sfx_order_id/update-rider-location/
\
--header
'Content-Type: application/json'
\
--data
'
{
"update_latitude": 12.387487873,
"update_longitude": 77.78787878
}
'
shell
Example Request Body
{
"update_latitude"
:
12.387487873
,
"update_longitude"
:
77.78787878
}
json
application/json
Example Responses
200
400
401
No example specified for this content type
application/json
Orders
