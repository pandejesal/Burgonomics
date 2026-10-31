# Official Shadowfax Hyperlocal orders API page (place/edit/dispatch/tracking/cancel)

Source: https://developer.shadowfax.in/docs/api/hyperlocal-marketplace/orders
Retrieved UTC: 2026-10-29T11:22:20.785682+00:00
Retrieval method: static

Public webpage text snapshot for local development reference. Not an API conformance or vendor-approval verdict; copyright remains with the publisher. Scripts/styles were not retained or executed.

---

Shadowfax Hyperlocal Marketplace API
Shadowfax Hyperlocal Marketplace API
Orders
Server
https://hlbackend.staging.shadowfax.in
https://api.shadowfax.in
Place, edit, track, cancel, and manage hyperlocal delivery orders.
Place an order
POST
https://hlbackend.staging.shadowfax.in
/api/v2/orders/
Authorization (header)
or
Bearer
Place a hyperlocal delivery order. Returns delivery cost and a
track_url
for live order tracking.
Place an order ›
Request Body
PlaceOrderRequest
client_code
​
string
·
required
Merchant code shared by Shadowfax.
order_details
​
OrderDetails
·
required
pickup_details
​
LocationDetails
·
required
drop_details
​
LocationDetails
·
required
order_items
​
OrderItem[]
·
required
has_tip
​
boolean
tip_amount
​
number
Place an order ›
Responses
201
400
401
500
Order placed successfully
OrderSuccessResponse
message
​
string
data
​
OrderData
POST
/
api/
v2/
orders/
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
https://hlbackend.staging.shadowfax.in/api/v2/orders/
\
--header
'Content-Type: application/json'
\
--data
@-
<<
EOF
{
"has_tip": true,
"tip_amount": 35,
"order_details": {
"scheduled_time": "2026-03-12 16:00:00",
"order_value": 248,
"paid": "false",
"client_order_id": "379984400",
"pickup_otp": "1232",
"return_otp": "1234",
"rain_flag": false,
"delivery_instruction": {
"drop_instruction_text": "Don't call me. Please come to the first floor and ring the doorbell.",
"take_drop_off_picture": true,
"drop_off_picture_mandatory": true,
"client_surge": 0
}
},
"client_code": "merchant001",
"pickup_details": {
"city": "Delhi",
"contact_number": "9876543210",
"name": "Store name",
"longitude": 77.0563207,
"address": "Store address in plain text",
"latitude": 28.5833332
},
"order_items": [
{
"name": "Item name",
"price": 259,
"quantity": 3,
"id": "29656019"
}
],
"drop_details": {
"name": "Customer name",
"longitude": 77.037531,
"address": "Customer address in plain text",
"latitude": 28.588891,
"contact_number": "9987654321",
"city": "Delhi",
"delivery_otp": "7412"
}
}
EOF
shell
Example Request Body
{
"has_tip"
:
true
,
"tip_amount"
:
35
,
"order_details"
: {
"scheduled_time"
:
"2026-03-12 16:00:00"
,
"order_value"
:
248
,
"paid"
:
"false"
,
"client_order_id"
:
"379984400"
,
"pickup_otp"
:
"1232"
,
"return_otp"
:
"1234"
,
"rain_flag"
:
false
,
"delivery_instruction"
: {
"drop_instruction_text"
:
"Don't call me. Please come to the first floor and ring the doorbell."
,
"take_drop_off_picture"
:
true
,
"drop_off_picture_mandatory"
:
true
,
"client_surge"
:
0
}
},
"client_code"
:
"merchant001"
,
"pickup_details"
: {
"city"
:
"Delhi"
,
"contact_number"
:
"9876543210"
,
"name"
:
"Store name"
,
"longitude"
:
77.0563207
,
"address"
:
"Store address in plain text"
,
"latitude"
:
28.5833332
},
"order_items"
: [
{
"name"
:
"Item name"
,
"price"
:
259
,
"quantity"
:
3
,
"id"
:
"29656019"
}
],
"drop_details"
: {
"name"
:
"Customer name"
,
"longitude"
:
77.037531
,
"address"
:
"Customer address in plain text"
,
"latitude"
:
28.588891
,
"contact_number"
:
"9987654321"
,
"city"
:
"Delhi"
,
"delivery_otp"
:
"7412"
}
}
json
application/json
Example Responses
201
400
401
500
No example specified for this content type
application/json
Edit an order
PUT
https://hlbackend.staging.shadowfax.in
/api/v2/orders/{sfx_order_id}/edit/
Authorization (header)
or
Bearer
Edit
order_items
and
order_details
only. Other fields must match the original order. Editable until the rider picks up the order.
Edit an order ›
path Parameters
sfx_order_id
​
integer
·
required
Edit an order ›
Request Body
EditOrderRequest
client_code
​
string
·
required
order_details
​
OrderDetails
·
required
pickup_details
​
LocationDetails
·
required
drop_details
​
LocationDetails
·
required
order_items
​
OrderItem[]
·
required
Edit an order ›
Responses
201
400
401
500
Order updated successfully
OrderSuccessResponse
message
​
string
data
​
OrderData
PUT
/
api/
v2/
orders/
{sfx_order_id}
/
edit/
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
https://hlbackend.staging.shadowfax.in/api/v2/orders/:sfx_order_id/edit/
\
--header
'Content-Type: application/json'
\
--data
'
{
"client_code": "client_code",
"order_details": {
"order_value": 0,
"paid": "true",
"client_order_id": "client_order_id",
"scheduled_time": "scheduled_time",
"pickup_otp": "pickup_otp",
"return_otp": "return_otp",
"rain_flag": true,
"delivery_instruction": {
"drop_instruction_text": "drop_instruction_text",
"take_drop_off_picture": true,
"drop_off_picture_mandatory": true,
"client_surge": 0
},
"client_surge": 0,
"allow_undelivered": true,
"rts_required": true,
"lm_distance": 0,
"preparation_time": 0,
"pickup_eta": 0,
"drop_eta": 0,
"allot_time": "allot_time",
"arrival_time": "arrival_time",
"dispatch_time": "dispatch_time",
"delivery_time": "delivery_time",
"vehicle_number": "vehicle_number",
"order_date": "order_date"
},
"pickup_details": {
"city": "city",
"name": "name",
"address": "address",
"latitude": 0,
"longitude": 0,
"contact_number": "contact_number",
"masked_customer_contact_number": "masked_customer_contact_number",
"delivery_geofence_radius": 0,
"delivery_otp": "delivery_otp"
},
"drop_details": {
"city": "city",
"name": "name",
"address": "address",
"latitude": 0,
"longitude": 0,
"contact_number": "contact_number",
"masked_customer_contact_number": "masked_customer_contact_number",
"delivery_geofence_radius": 0,
"delivery_otp": "delivery_otp"
},
"order_items": [
{
"id": "id",
"name": "name",
"price": 0,
"quantity": 0,
"weight": 0,
"category": "category",
"unit_price": 0,
"return_condition": "return_condition"
}
]
}
'
shell
Example Request Body
{
"client_code"
:
"client_code"
,
"order_details"
: {
"order_value"
:
0
,
"paid"
:
"true"
,
"client_order_id"
:
"client_order_id"
,
"scheduled_time"
:
"scheduled_time"
,
"pickup_otp"
:
"pickup_otp"
,
"return_otp"
:
"return_otp"
,
"rain_flag"
:
true
,
"delivery_instruction"
: {
"drop_instruction_text"
:
"drop_instruction_text"
,
"take_drop_off_picture"
:
true
,
"drop_off_picture_mandatory"
:
true
,
"client_surge"
:
0
},
"client_surge"
:
0
,
"allow_undelivered"
:
true
,
"rts_required"
:
true
,
"lm_distance"
:
0
,
"preparation_time"
:
0
,
"pickup_eta"
:
0
,
"drop_eta"
:
0
,
"allot_time"
:
"allot_time"
,
"arrival_time"
:
"arrival_time"
,
"dispatch_time"
:
"dispatch_time"
,
"delivery_time"
:
"delivery_time"
,
"vehicle_number"
:
"vehicle_number"
,
"order_date"
:
"order_date"
},
"pickup_details"
: {
"city"
:
"city"
,
"name"
:
"name"
,
"address"
:
"address"
,
"latitude"
:
0
,
"longitude"
:
0
,
"contact_number"
:
"contact_number"
,
"masked_customer_contact_number"
:
"masked_customer_contact_number"
,
"delivery_geofence_radius"
:
0
,
"delivery_otp"
:
"delivery_otp"
},
"drop_details"
: {
"city"
:
"city"
,
"name"
:
"name"
,
"address"
:
"address"
,
"latitude"
:
0
,
"longitude"
:
0
,
"contact_number"
:
"contact_number"
,
"masked_customer_contact_number"
:
"masked_customer_contact_number"
,
"delivery_geofence_radius"
:
0
,
"delivery_otp"
:
"delivery_otp"
},
"order_items"
: [
{
"id"
:
"id"
,
"name"
:
"name"
,
"price"
:
0
,
"quantity"
:
0
,
"weight"
:
0
,
"category"
:
"category"
,
"unit_price"
:
0
,
"return_condition"
:
"return_condition"
}
]
}
json
Example Responses
201
400
401
500
No example specified for this content type
application/json
Get order details
GET
https://hlbackend.staging.shadowfax.in
/api/v2/orders/{sfx_order_id}/status/
Authorization (header)
or
Bearer
Get order details and current status. Rider location is updated every 60 seconds.
Get order details ›
path Parameters
sfx_order_id
​
integer
·
required
Get order details ›
Responses
200
401
500
Order details
OrderSuccessResponse
message
​
string
data
​
OrderData
GET
/
api/
v2/
orders/
{sfx_order_id}
/
status/
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
GET
\
--url
https://hlbackend.staging.shadowfax.in/api/v2/orders/:sfx_order_id/status/
shell
Example Responses
200
401
500
No example specified for this content type
application/json
Cancel an order
PUT
https://hlbackend.staging.shadowfax.in
/api/v2/orders/{sfx_order_id}/cancel/
Authorization (header)
or
Bearer
Cancel a delivery order with a reason and the user initiating cancellation.
Cancel an order ›
path Parameters
sfx_order_id
​
integer
·
required
Cancel an order ›
Request Body
CancelOrderRequest
reason
​
string
·
maxLength: 128
·
required
user
​
string
·
enum
·
required
Enum values:
Customer
Seller
Rider
Cancel an order ›
Responses
200
401
500
Order cancelled
OrderSuccessResponse
message
​
string
data
​
OrderData
PUT
/
api/
v2/
orders/
{sfx_order_id}
/
cancel/
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
https://hlbackend.staging.shadowfax.in/api/v2/orders/:sfx_order_id/cancel/
\
--header
'Content-Type: application/json'
\
--data
'
{
"reason": "Seller missing items",
"user": "Seller"
}
'
shell
Example Request Body
{
"reason"
:
"Seller missing items"
,
"user"
:
"Seller"
}
json
application/json
Example Responses
200
401
500
No example specified for this content type
application/json
Dispatch ready indicator
PUT
https://hlbackend.staging.shadowfax.in
/api/v2/orders/{coid}/dispatch-ready/
Authorization (header)
or
Bearer
Notify Shadowfax when the shipment is ready for pickup so the rider can collect it.
Dispatch ready indicator ›
path Parameters
coid
​
string
·
required
Client order ID (COID)
Dispatch ready indicator ›
Request Body
DispatchReadyRequest
shipment_ready_timestamp
​
string
·
date-time
·
required
UTC timestamp when shipment was ready.
Dispatch ready indicator ›
Responses
200
401
500
Dispatch ready acknowledged
MessageResponse
message
​
string
PUT
/
api/
v2/
orders/
{coid}
/
dispatch-ready/
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
https://hlbackend.staging.shadowfax.in/api/v2/orders/:coid/dispatch-ready/
\
--header
'Content-Type: application/json'
\
--data
'
{
"shipment_ready_timestamp": "2022-09-14T17:50:00Z"
}
'
shell
Example Request Body
{
"shipment_ready_timestamp"
:
"2022-09-14T17:50:00Z"
}
json
application/json
Example Responses
200
401
500
{
"message"
:
"done successfully"
}
json
application/json
success
invalid_order
MDND cancellation
POST
https://hlbackend.staging.shadowfax.in
/api/v2/{coid}/post_closure_remarks/
Authorization (header)
or
Bearer
Mark Delivered Not Delivered (MDND) — highlight orders marked delivered but not physically delivered. Always returns 200 even without request body parameters.
MDND cancellation ›
path Parameters
coid
​
string
·
required
Client order ID (COID)
MDND cancellation ›
Request Body
MDNDRequest
mdi_claimed
​
boolean
Customer collected refund from client.
Default:
false
order_rating
​
number
remarks
​
string
MDND cancellation ›
Responses
200
401
500
MDND claim recorded
MessageResponse
message
​
string
POST
/
api/
v2/
{coid}
/
post_closure_remarks/
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
https://hlbackend.staging.shadowfax.in/api/v2/:coid/post_closure_remarks/
\
--header
'Content-Type: application/json'
\
--data
'
{
"mdi_claimed": false,
"order_rating": 4.5,
"remarks": ""
}
'
shell
Example Request Body
{
"mdi_claimed"
:
false
,
"order_rating"
:
4.5
,
"remarks"
:
""
}
json
application/json
Example Responses
200
401
500
{
"message"
:
"done successfully"
}
json
application/json
Serviceability
Sandbox
