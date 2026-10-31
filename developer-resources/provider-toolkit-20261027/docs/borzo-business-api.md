# Official Borzo India Business API documentation

Source: https://borzodelivery.com/in/business-api/doc
Retrieved UTC: 2026-10-27T14:49:37.058485+00:00

Public webpage text snapshot for local development reference. Not an API conformance or vendor-approval verdict; copyright remains with the publisher. Scripts/styles were not retained or executed.

---

Borzo Business API 1.8
Overview
Postman collection
Requests
Responses
Parameter data types
API methods
Order price calculation
Placing an order
Order editing
Canceling an order
List of orders
Courier info and courier location
Client profile info
Available bank cards
List of labels
Orders & Deliveries
Status model
Order statuses
Delivery statuses
Order types
Vehicle types
Payment methods
Label types
Notification about order changes
Notification about delivery changes
Use cases
How to place an order
How to place an endofday order
How to track order/delivery
Cash on delivery (COD) service
Error codes
Changelog
Overview
Business API allows you to automatically place delivery orders in Borzo. You also can manage your orders and subscribe to updates on any changes in them.
First you should register as a client at
apitest.borzodelivery.com
. If you are unable to receive the SMS code when registering, please ask for it at
[email protected]
, including your phone number in the email.
Integration of Borzo Business API is done in two steps:
Setting everything up using test environment at robotapitest-in.borzodelivery.com;
When it works with apitest, you can switch to production at robot-in.borzodelivery.com.
When you have successfully tested Business API integration with apitest.borzodelivery.com, please email us at
[email protected]
, so we can enable your access to Business API in production environment.
URL for test requests:
https://robotapitest-in.borzodelivery.com/api/business/1.8
URL for production requests:
https://robot-in.borzodelivery.com/api/business/1.8
Sample Postman collection
You can download a Sample Postman collection with all API methods and examples.
Download Sample Postman collection
Requests
All requests to Business API must be made via HTTPS. Only GET and POST request methods are supported. POST requests should send all parameters in the body of the request in
JSON
format and UTF-8 encoding; GET requests should send parameters in the query string.
All requests must include a HTTP header
X-DV-Auth-Token
.
X-DV-Auth-Token
string
Required
Secret auth token. Must be sent as a HTTP header.
Your auth token can be found in your
Personal cabinet
.
Important!
Never put your auth token in any public places!
If your token is compromised, it will be possible for anybody to place orders in your name.
Tokens can be changed in your Personal cabinet.
CURL
curl --include --header 'X-DV-Auth-Token: SECRET_AUTH_TOKEN' 'https://robotapitest-in.borzodelivery.com/api/business/1.8'
HTTP/1.1 200 OK
Date: Tue, 27 Oct 2026 14:49:39 GMT
Content-Type: application/json; charset=utf-8
{
"is_successful": true
}
PHP
<?php
$curl = curl_init();
curl_setopt($curl, CURLOPT_URL, 'https://robotapitest-in.borzodelivery.com/api/business/1.8');
curl_setopt($curl, CURLOPT_HTTPHEADER, ['X-DV-Auth-Token: SECRET_AUTH_TOKEN']);
curl_setopt($curl, CURLOPT_RETURNTRANSFER, true);
$result = curl_exec($curl);
if ($result === false) {
throw new Exception(curl_error($curl), curl_errno($curl));
}
echo $result;
{
"is_successful": true
}
Responses
Business API responses are in JSON format and UTF-8 encoding.
Successful responses will have HTTP code 200 (OK). Response JSON will always have
is_successful
field.
is_successful
boolean
Whether the request was successful or not.
Successful responses will have
true
here.
If there was an error, API response will have HTTP code 400 (Bad Request). The response JSON will have the following fields:
is_successful
boolean
Whether the request was successful or not.
In case of any errors it will be
false
.
errors
list
List of error codes.
Request error codes
parameter_errors
object
/
null
Error codes for request parameters. If
errors
field contains error code
invalid_parameters
, this field will have detailed parameter errors. Structure of this object corresponds to structure of the request.
Parameter error codes
CURL
curl --include --header 'X-DV-Auth-Token: SECRET_AUTH_TOKEN' --data '{"points":[{"address":"Saket, New Delhi, Delhi","contact_person":{"phone":"918880000001"}},{}]}' 'https://robotapitest-in.borzodelivery.com/api/business/1.8/create-order'
HTTP/1.1 400 Bad Request
Date: Tue, 27 Oct 2026 14:49:39 GMT
Content-Type: application/json; charset=utf-8
{
"is_successful": false,
"errors": ["invalid_parameters"],
"parameter_errors": {
"matter": ["required"],
"points": [
null,
{
"address": ["required"],
"contact_person": {
"phone": ["required"]
}
}
]
}
}
Parameter data types
boolean
Boolean value:
true
or
false
.
integer
Integer number without fractions.
string
A JSON string. Example:
"active"
.
date
Date according to ISO 8601: YYYY-MM-DD. Example:
"2026-10-27"
.
timestamp
Date and time according to ISO 8601: YYYY-MM-DDTHH:MM:SSZ. Example:
"2026-10-27T20:19:39+05:30"
.
Please use this exact format with semicolon in the timezone. Other ISO 8601 variants are not supported by Business API.
float
Floating point number with fractional part.
list
A JSON list. Example:
[{"address":"Saket, New Delhi, Delhi"}, {"address":"Janakpuri, New Delhi, Delhi"}]
.
object
A JSON object. Example:
{"address":"Saket, New Delhi, Delhi"}
.
money
Money amount (₹), rounded to 2 decimal places. Examples:
"190.00"
,
"-49.90"
.
This is a JSON string to prevent rounding errors.
phone
A JSON string with phone number. Example:
"918880000001"
.
coordinate
A JSON string with coordinate. Example:
"28.5235479"
.
null
Empty value:
null
.
API methods
Order price calculation
POST
https://robotapitest-in.borzodelivery.com/api/business/1.8/calculate-order
Use this method to calculate order prices and validate parameters before actually placing the order. It is possible to calculate an incomplete order, but such calculations may be imprecise.
In response to an empty request this method will respond with minimal order price.
Request parameters
Response parameters
Examples
Request parameters
type
string
Order type.
Default value:
"standard"
.
For orders of type
vip_delivery
Required
VIP delivery clients should set parameter value
vip_delivery
Order types
matter
string
/
null
Required
Delivery contents. Maximum length is 5,000 characters.
Try to make this description useful for the courier. For example, putting a category from your catalog here is better than only a concrete model number. If the item is fragile or oversized, please mention it here.
Default value:
null
.
vehicle_type_id
integer
Vehicle type.
For orders of type
standard
Default value: 8 (Motorbike (up to 20 kg)).
For orders of type
endofday
Prohibited
In
endofday
orders it is prohibited to set this parameter. Vehicle type will be set automatically as motorbike.
Vehicle types
total_weight_kg
integer
Total weight in kilograms.
For orders of type
standard
Default value:
0
.
For orders of type
endofday
Required
In
endofday
orders
total_weight_kg
parameter is required.
insurance_amount
money
Insured amount.
Default value:
"0.00"
.
is_client_notification_enabled
boolean
Whether to send SMS notifications to the client.
Default value:
false
.
is_contact_person_notification_enabled
boolean
Whether to send SMS notifications to recipients on addresses.
Default value:
false
.
is_route_optimizer_enabled
boolean
Automatically optimize route (addresses will be arranged in the optimal order).
Default value:
false
.
loaders_count
integer
Number of necessary loaders to move the delivered goods, including the driver. Maximum is 11.
Default value: 0.
is_motobox_required
boolean
Is motobox required.
Default value:
false
.
is_thermobox_required
boolean
Is thermobox required.
Default value:
false
.
payment_method
string
Payment method (if different from default).
Default value:
null
.
Payment methods
bank_card_id
integer
Bank card ID (required for
bank_card
payment method).
Default value:
null
.
promo_code
string
/
null
Promo code.
Default value:
null
.
points
list
Required
List of addresses (points) for the courier to visit.
For orders of type
standard
Maximum is 99 points. Default value:
[]
.
For orders of type
endofday
Must contain only 2 points.
Point parameters
address
string
/
null
Required
Street address. Maximum length is 350 characters.
We use Google Maps API to geocode addresses.
Default value:
null
.
contact_person
object
Required
Contact person on the address.
Contact person parameters
phone
phone
/
null
Required
Phone number of the person at the address.
Default value:
null
.
name
string
/
null
Name of the person on the address. Maximum length is 350 characters.
Default value:
null
.
client_order_id
string
/
null
Your eshop's order ID. It will be sent in notifications instead of our delivery order ID. Maximum length is 32 characters.
Default value:
null
.
latitude
coordinate
/
null
Latitude of the location.
Default value:
null
.
longitude
coordinate
/
null
Longitude of the location.
Default value:
null
.
required_start_datetime
timestamp
/
null
How early the courier may arrive at the address.
Default value:
null
.
For orders of type
endofday
Prohibited
In
endofday
orders it is prohibited to set this parameter. Delivery time will be set automatically.
required_finish_datetime
timestamp
/
null
How late the courier may arrive at the address.
Default value:
null
.
For orders of type
endofday
Prohibited
In
endofday
orders it is prohibited to set this parameter. Delivery time will be set automatically.
taking_amount
money
Backpayment sum to receive from the contact person at the address.
Default value:
"0.00"
.
buyout_amount
money
Buyout sum the courier pays to the contact person at the address.
Default value:
"0.00"
.
note
string
/
null
Additional information for the courier: office or appartment number, company name, whether any documents are required to enter the building.
Default value:
null
.
is_order_payment_here
boolean
Money will be paid to the courier at the address.
Default value:
false
.
building_number
string
/
null
Building number.
Default value:
null
.
entrance_number
string
/
null
Entrance number.
Default value:
null
.
intercom_code
string
/
null
Intercom code.
Default value:
null
.
floor_number
string
/
null
Floor number.
Default value:
null
.
apartment_number
string
/
null
Apartment/office number.
Default value:
null
.
invisible_mile_navigation_instructions
string
/
null
Instruction to courier how to get to recipient at the address.
Default value:
null
.
is_cod_cash_voucher_required
boolean
Whether to issue a cashier's check to the recipient at the point. If true, you should fill check amount in
taking_amount
.
Default value:
false
.
delivery_id
integer
/
null
Unique delivery ID (except first point).
Default value:
null
.
packages
list
List of packages at the point.
Default value:
[]
.
Package parameters
ware_code
string
Vendor code. Maximum length is 255 characters.
Default value:
null
.
description
string
Description. Maximum length is 1000 characters.
Default value:
null
.
items_count
float
Amount.
Default value:
0
.
item_payment_amount
string
Price per item.
Default value:
"0.00"
.
nomenclature_code
string
Nomenclature code. Maximum length is 255 characters.
Default value:
null
.
return_point
list
Return point to which the courier must return the order in case of failed delivery.
Return point parameters
checkin_code
string
/
null
Courier's arrival pin code at the point. Maximum length is 255 characters.
Default value:
null
.
address
string
/
null
Designated return address the courier must return the order to on failed delivery, instead of the pickup address. Available only if enabled for your account. Maximum length is 350 characters.
Cannot be changed after order creation.
Default value:
null
.
latitude
coordinate
/
null
Latitude of the designated return address.
Optional — resolved from
address
if not set.
Cannot be changed after order creation.
Default value:
null
.
longitude
coordinate
/
null
Longitude of the designated return address.
Optional — resolved from
address
if not set.
Cannot be changed after order creation.
Default value:
null
.
phone
phone
/
null
Contact phone number at the designated return address. Used for return handover verification.
Cannot be changed after order creation.
Default value:
null
.
Response parameters
is_successful
boolean
Whether the request was successful or not.
order
object
Calculated order data.
Order parameters
type
string
Order type.
Order types
matter
string
/
null
Delivery contents.
vehicle_type_id
integer
Vehicle type.
Vehicle types
total_weight_kg
integer
Total weight in kilograms.
is_client_notification_enabled
boolean
Whether to send SMS notifications to the client.
is_contact_person_notification_enabled
boolean
Whether to send SMS notifications to recipients on addresses.
loaders_count
integer
Number of necessary loaders to move the delivered goods, including the driver.
points
list
List of addresses (points) for the courier to visit.
Point parameters
address
string
/
null
Street address.
contact_person
object
Contact person on the address.
Contact person parameters
phone
phone
/
null
Phone number of the person at the address.
name
string
/
null
Name of the person on the address.
client_order_id
string
/
null
Your eshop's order ID. It will be sent in notifications instead of our delivery order ID.
latitude
coordinate
/
null
Latitude of the location.
longitude
coordinate
/
null
Longitude of the location.
required_start_datetime
timestamp
/
null
How early the courier may arrive at the address.
required_finish_datetime
timestamp
/
null
How late the courier may arrive at the address.
taking_amount
money
Backpayment sum to receive from the contact person at the address.
buyout_amount
money
Buyout sum the courier pays to the contact person at the address.
note
string
/
null
Additional information for the courier: office or appartment number, company name, whether any documents are required to enter the building.
packages
list
List of packages at the point.
Package parameters
ware_code
string
Vendor code.
description
string
Description.
items_count
float
Amount.
item_payment_amount
string
Price per item.
nomenclature_code
string
response.calculate_order.params.points.packages.nomenclature_code
is_cod_cash_voucher_required
boolean
Whether to issue a cashier's check to the recipient at the point.
is_order_payment_here
boolean
Money will be paid to the courier at the address.
building_number
string
/
null
Building number.
entrance_number
string
/
null
Entrance number.
intercom_code
string
/
null
Intercom code.
floor_number
string
/
null
Floor number.
apartment_number
string
/
null
Apartment/office number.
invisible_mile_navigation_instructions
string
/
null
Instruction to courier how to get to recipient at the address.
place_photo_url
string
/
null
Place photo when closing a point at the address.
sign_photo_url
string
/
null
Recipients signature photo when closing a point at the address.
checkin
object
/
null
Checkin information when closing a point at the address.
Checkin parameters
recipient_full_name
string
/
null
Full name of the recipient who met the courier.
recipient_position
string
/
null
Position of the recipient who met the courier.
tracking_url
string
/
null
Recipient's tracking link.
delivery
object
/
null
Delivery.
Delivery parameters
status
string
/
null
Delivery status.
payment_amount
money
/
null
Order price.
delivery_fee_amount
money
/
null
Delivery fee.
Part of order price (
payment_amount
).
weight_fee_amount
money
/
null
Large weight fee.
Part of order price (
payment_amount
).
insurance_amount
money
/
null
Insured amount.
insurance_fee_amount
money
/
null
Insurance fee.
Part of order price (
payment_amount
).
loading_fee_amount
money
/
null
Loading / heavy lifting fee.
Part of order price (
payment_amount
).
money_transfer_fee_amount
money
/
null
Money handling fee: backpayment transfer, buyout operations.
Part of order price (
payment_amount
).
promo_code_discount_amount
money
/
null
Discount amount by promo code.
Part of order price (
payment_amount
).
cod_fee_amount
money
/
null
Extra fee for issuing a cashier's check.
Part of order price (
payment_amount
).
return_fee_amount
money
/
null
Extra fee for return to first point.
Part of order price (
payment_amount
).
waiting_fee_amount
money
/
null
Extra fee for paid waiting at designated points.
Part of order price (
payment_amount
).
backpayment_details
string
/
null
Details of the money transfer for backpayment. A credit card number or other payment system information.
is_motobox_required
boolean
Is motobox required.
is_thermobox_required
boolean
Is thermobox required.
applied_promo_code
string
/
null
Applied promo code.
warnings
list
Warnings. You will receive these warnings as error codes if you try to create an order with the same data you calculated it with. Empty list of warnings means the order data is valid.
Request error codes
parameter_warnings
object
Parameter warnings. You will receive these warnings as parameter error codes if you try to create an order with the same data you calculated it with.
Parameter error codes
Request example
CURL
curl --include --header 'X-DV-Auth-Token: SECRET_AUTH_TOKEN' --data '{"matter":"Documents","points":[{"address":"Saket, New Delhi, Delhi"},{"address":"Janakpuri, New Delhi, Delhi"}]}' 'https://robotapitest-in.borzodelivery.com/api/business/1.8/calculate-order'
HTTP/1.1 200 OK
Date: Tue, 27 Oct 2026 14:49:39 GMT
Content-Type: application/json; charset=utf-8
{
"is_successful": true,
"order": {
"type": "standard",
"order_id": 1250032,
"order_name": null,
"vehicle_type_id": 8,
"created_datetime": "2026-10-27T20:19:39+05:30",
"finish_datetime": null,
"status": null,
"status_description": null,
"matter": "Documents",
"total_weight_kg": 0,
"is_client_notification_enabled": false,
"is_contact_person_notification_enabled": false,
"loaders_count": 0,
"backpayment_details": null,
"points": [{
"point_id": null,
"delivery_id": null,
"client_order_id": null,
"address": "Saket, New Delhi, Delhi",
"latitude": "28.5235479",
"longitude": "77.2045073",
"required_start_datetime": "2026-10-27T20:49:39+05:30",
"required_finish_datetime": "2026-10-27T21:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"estimated_arrival_datetime": "2026-10-27T20:49:39+05:30"
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": null
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [],
"is_cod_cash_voucher_required": false,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": null
}, {
"point_id": null,
"delivery_id": null,
"client_order_id": null,
"address": "Janakpuri, New Delhi, Delhi",
"latitude": "28.6210537",
"longitude": "77.0817532",
"required_start_datetime": "2026-10-27T21:49:39+05:30",
"required_finish_datetime": "2026-10-27T22:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"estimated_arrival_datetime": "2026-10-27T21:49:39+05:30"
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": null
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [],
"is_cod_cash_voucher_required": false,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": {
"status": "planned"
}
}],
"payment_amount": "170.00",
"delivery_fee_amount": "170.00",
"weight_fee_amount": "0.00",
"insurance_amount": "0.00",
"insurance_fee_amount": "0.00",
"loading_fee_amount": "0.00",
"money_transfer_fee_amount": "0.00",
"promo_code_discount_amount": "40.00",
"backpayment_amount": "0.00",
"cod_fee_amount": "0.00",
"return_fee_amount": "0.00",
"waiting_fee_amount": "0.00",
"backpayment_photo_url": null,
"waybill_document_url": null,
"courier": null,
"is_motobox_required": false,
"payment_method": "cash",
"bank_card_id": null,
"applied_promo_code": "FIRST_ORDER",
"is_return_required": false
},
"warnings": ["invalid_parameters"],
"parameter_warnings": {
"points": [{
"contact_person": {
"phone": ["required"]
}
}, {
"contact_person": {
"phone": ["required"]
}
}]
}
}
PHP
<?php
$curl = curl_init();
curl_setopt($curl, CURLOPT_URL, 'https://robotapitest-in.borzodelivery.com/api/business/1.8/calculate-order');
curl_setopt($curl, CURLOPT_CUSTOMREQUEST, 'POST');
curl_setopt($curl, CURLOPT_HTTPHEADER, ['X-DV-Auth-Token: SECRET_AUTH_TOKEN']);
curl_setopt($curl, CURLOPT_RETURNTRANSFER, true);
$data = [
'matter' => 'Documents',
'points' => [
[
'address' => 'Saket, New Delhi, Delhi',
],
[
'address' => 'Janakpuri, New Delhi, Delhi',
],
],
];
$json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
curl_setopt($curl, CURLOPT_POSTFIELDS, $json);
$result = curl_exec($curl);
if ($result === false) {
throw new Exception(curl_error($curl), curl_errno($curl));
}
echo $result;
{
"is_successful": true,
"order": {
"type": "standard",
"order_id": 1250032,
"order_name": null,
"vehicle_type_id": 8,
"created_datetime": "2026-10-27T20:19:39+05:30",
"finish_datetime": null,
"status": null,
"status_description": null,
"matter": "Documents",
"total_weight_kg": 0,
"is_client_notification_enabled": false,
"is_contact_person_notification_enabled": false,
"loaders_count": 0,
"backpayment_details": null,
"points": [{
"point_id": null,
"delivery_id": null,
"client_order_id": null,
"address": "Saket, New Delhi, Delhi",
"latitude": "28.5235479",
"longitude": "77.2045073",
"required_start_datetime": "2026-10-27T20:49:39+05:30",
"required_finish_datetime": "2026-10-27T21:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"estimated_arrival_datetime": "2026-10-27T20:49:39+05:30"
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": null
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [],
"is_cod_cash_voucher_required": false,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": null
}, {
"point_id": null,
"delivery_id": null,
"client_order_id": null,
"address": "Janakpuri, New Delhi, Delhi",
"latitude": "28.6210537",
"longitude": "77.0817532",
"required_start_datetime": "2026-10-27T21:49:39+05:30",
"required_finish_datetime": "2026-10-27T22:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"estimated_arrival_datetime": "2026-10-27T21:49:39+05:30"
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": null
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [],
"is_cod_cash_voucher_required": false,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": {
"status": "planned"
}
}],
"payment_amount": "170.00",
"delivery_fee_amount": "170.00",
"weight_fee_amount": "0.00",
"insurance_amount": "0.00",
"insurance_fee_amount": "0.00",
"loading_fee_amount": "0.00",
"money_transfer_fee_amount": "0.00",
"promo_code_discount_amount": "40.00",
"backpayment_amount": "0.00",
"cod_fee_amount": "0.00",
"return_fee_amount": "0.00",
"waiting_fee_amount": "0.00",
"backpayment_photo_url": null,
"waybill_document_url": null,
"courier": null,
"is_motobox_required": false,
"payment_method": "cash",
"bank_card_id": null,
"applied_promo_code": "FIRST_ORDER",
"is_return_required": false
},
"warnings": ["invalid_parameters"],
"parameter_warnings": {
"points": [{
"contact_person": {
"phone": ["required"]
}
}, {
"contact_person": {
"phone": ["required"]
}
}]
}
}
Placing an order
POST
https://robotapitest-in.borzodelivery.com/api/business/1.8/create-order
This API method creates a new delivery order.
Request parameters
Response parameters
Examples
Request parameters
type
string
Order type.
Default value:
"standard"
.
For orders of type
vip_delivery
Required
VIP delivery clients should set parameter value
vip_delivery
Order types
matter
string
Required
Delivery contents. Maximum length is 5,000 characters.
Try to make this description useful for the courier. For example, putting a category from your catalog here is better than only a concrete model number. If the item is fragile or oversized, please mention it here.
vehicle_type_id
integer
Vehicle type.
For orders of type
standard
Default value: 8 (Motorbike (up to 20 kg)).
For orders of type
endofday
Prohibited
In
endofday
orders it is prohibited to set this parameter. Vehicle type will be set automatically as motorbike.
Vehicle types
total_weight_kg
integer
Total weight in kilograms.
For orders of type
standard
Default value:
0
.
For orders of type
endofday
Required
In
endofday
orders
total_weight_kg
parameter is required. Must be greater than
0
.
insurance_amount
money
Insured amount.
Default value:
"0.00"
.
is_client_notification_enabled
boolean
Whether to send SMS notifications to the client.
Default value:
false
.
is_contact_person_notification_enabled
boolean
Whether to send SMS notifications to recipients on addresses.
Default value:
false
.
is_route_optimizer_enabled
boolean
Automatically optimize route (addresses will be arranged in the optimal order).
Default value:
false
.
loaders_count
integer
Number of necessary loaders to move the delivered goods, including the driver. Maximum is 11.
Default value: 0.
is_motobox_required
boolean
Is motobox required.
Default value:
false
.
is_thermobox_required
boolean
Is thermobox required.
Default value:
false
.
payment_method
string
Payment method (if different from default).
Default value:
null
.
Payment methods
bank_card_id
integer
Bank card ID (required for
bank_card
payment method).
Default value:
null
.
promo_code
string
/
null
Promo code.
Default value:
null
.
is_return_required
boolean
Need to create order with return.
Default value:
false
.
points
list
Required
List of addresses (points) for the courier to visit.
For orders of type
standard
Maximum is 99 points. Default value:
[]
.
For orders of type
endofday
Must contain only 2 points.
Point parameters
address
string
Required
Street address. Maximum length is 350 characters.
We use Google Maps API to geocode addresses.
contact_person
object
Required
Contact person on the address.
Contact person parameters
phone
phone
Required
Phone number of the person at the address.
name
string
/
null
Name of the person on the address. Maximum length is 350 characters.
Default value:
null
.
client_order_id
string
/
null
Your eshop's order ID. It will be sent in notifications instead of our delivery order ID. Maximum length is 32 characters.
Default value:
null
.
latitude
coordinate
/
null
Latitude of the location.
Default value:
null
.
longitude
coordinate
/
null
Longitude of the location.
Default value:
null
.
required_start_datetime
timestamp
/
null
How early the courier may arrive at the address.
Default value:
null
.
For orders of type
endofday
Prohibited
In
endofday
orders it is prohibited to set this parameter. Delivery time will be set automatically.
required_finish_datetime
timestamp
/
null
How late the courier may arrive at the address.
Default value:
null
.
For orders of type
endofday
Prohibited
In
endofday
orders it is prohibited to set this parameter. Delivery time will be set automatically.
taking_amount
money
Backpayment sum to receive from the contact person at the address.
Default value:
"0.00"
.
buyout_amount
money
Buyout sum the courier pays to the contact person at the address.
Default value:
"0.00"
.
note
string
/
null
Additional information for the courier: office or appartment number, company name, whether any documents are required to enter the building.
Default value:
null
.
is_order_payment_here
boolean
Money will be paid to the courier at the address.
Default value:
false
.
building_number
string
/
null
Building number.
Default value:
null
.
entrance_number
string
/
null
Entrance number.
Default value:
null
.
intercom_code
string
/
null
Intercom code.
Default value:
null
.
floor_number
string
/
null
Floor number.
Default value:
null
.
apartment_number
string
/
null
Apartment/office number.
Default value:
null
.
invisible_mile_navigation_instructions
string
/
null
Instruction to courier how to get to recipient at the address.
Default value:
null
.
is_cod_cash_voucher_required
boolean
Whether to issue a cashier's check to the recipient at the point. If true, you should fill check amount in
taking_amount
.
Default value:
false
.
delivery_id
integer
/
null
Unique delivery ID (except first point).
Default value:
null
.
checkin_code
string
/
null
Courier's arrival pin code at the point. Maximum length is 255 characters.
Default value:
null
.
packages
list
List of packages at the point.
Default value:
[]
.
Package parameters
ware_code
string
Vendor code. Maximum length is 255 characters.
Default value:
null
.
description
string
Description. Maximum length is 1000 characters.
Default value:
null
.
items_count
float
Amount.
Default value:
0
.
item_payment_amount
string
Price per item.
Default value:
"0.00"
.
nomenclature_code
string
Nomenclature code. Maximum length is 255 characters.
Default value:
null
.
return_point
list
Return point to which the courier must return the order in case of failed delivery.
Return point parameters
checkin_code
string
/
null
Courier's arrival pin code at the point. Maximum length is 255 characters.
Default value:
null
.
address
string
/
null
Designated return address the courier must return the order to on failed delivery, instead of the pickup address. Available only if enabled for your account. Maximum length is 350 characters.
Cannot be changed after order creation.
Default value:
null
.
latitude
coordinate
/
null
Latitude of the designated return address.
Optional — resolved from
address
if not set.
Cannot be changed after order creation.
Default value:
null
.
longitude
coordinate
/
null
Longitude of the designated return address.
Optional — resolved from
address
if not set.
Cannot be changed after order creation.
Default value:
null
.
phone
phone
/
null
Contact phone number at the designated return address. Used for return handover verification.
Cannot be changed after order creation.
Default value:
null
.
Response parameters
is_successful
boolean
Whether the request was successful or not.
order
object
The created order.
Order parameters
order_id
integer
Full order ID.
type
string
Order type.
Order types
matter
string
Delivery contents.
order_name
string
Order name (short order ID).
vehicle_type_id
integer
Vehicle type.
Vehicle types
created_datetime
timestamp
Order creation date and time.
finish_datetime
timestamp
/
null
Order completion date and time.
status
string
Order status.
Order statuses
status_description
string
Order status description.
total_weight_kg
integer
Total weight in kilograms.
is_client_notification_enabled
boolean
Whether to send SMS notifications to the client.
is_contact_person_notification_enabled
boolean
Whether to send SMS notifications to recipients on addresses.
loaders_count
integer
Number of necessary loaders to move the delivered goods, including the driver.
points
list
List of addresses (points) for the courier to visit.
Point parameters
point_id
integer
Point ID.
delivery_id
integer
/
null
Delivery ID.
address
string
Street address.
contact_person
object
Contact person on the address.
Contact person parameters
phone
phone
Phone number of the person at the address.
name
string
/
null
Name of the person on the address.
client_order_id
string
/
null
Your eshop's order ID. It will be sent in notifications instead of our delivery order ID.
latitude
coordinate
Latitude of the location.
longitude
coordinate
Longitude of the location.
required_start_datetime
timestamp
/
null
How early the courier may arrive at the address.
required_finish_datetime
timestamp
/
null
How late the courier may arrive at the address.
arrival_start_datetime
timestamp
/
null
Estimated courier arrival time, upper bound.
arrival_finish_datetime
timestamp
/
null
Estimated courier arrival time, lower bound.
courier_visit_datetime
timestamp
/
null
Actual courier arrival time.
taking_amount
money
Backpayment sum to receive from the contact person at the address.
buyout_amount
money
Buyout sum the courier pays to the contact person at the address.
note
string
/
null
Additional information for the courier: office or appartment number, company name, whether any documents are required to enter the building.
packages
list
List of packages at the point.
Package parameters
order_package_id
integer
Package ID.
ware_code
string
Vendor code.
description
string
Description.
items_count
float
Amount.
item_payment_amount
string
Price per item.
nomenclature_code
string
Nomenclature code.
is_cod_cash_voucher_required
boolean
Whether to issue a cashier's check to the recipient at the address.
is_order_payment_here
boolean
Money will be paid to the courier at the address.
building_number
string
/
null
Building number.
entrance_number
string
/
null
Entrance number.
intercom_code
string
/
null
Intercom code.
floor_number
string
/
null
Floor number.
apartment_number
string
/
null
Apartment/office number.
invisible_mile_navigation_instructions
string
/
null
Instruction to courier how to get to recipient at the address.
place_photo_url
string
/
null
Place photo when closing a point at the address.
sign_photo_url
string
/
null
Recipients signature photo when closing a point at the address.
checkin_code
string
/
null
Courier's arrival pin code at the point.
checkin
object
/
null
Checkin information when closing a point at the address.
Checkin parameters
recipient_full_name
string
/
null
Full name of the recipient who met the courier.
recipient_position
string
/
null
Position of the recipient who met the courier.
is_return_point
boolean
Return point (same as first or hub).
tracking_url
string
/
null
Recipient's tracking link.
delivery
object
/
null
Delivery.
Delivery parameters
status
string
Delivery status.
payment_amount
money
/
null
Order price.
delivery_fee_amount
money
/
null
Delivery fee.
Part of order price (
payment_amount
).
weight_fee_amount
money
/
null
Large weight fee.
Part of order price (
payment_amount
).
insurance_amount
money
/
null
Insured amount.
insurance_fee_amount
money
/
null
Insurance fee.
Part of order price (
payment_amount
).
loading_fee_amount
money
/
null
Loading / heavy lifting fee.
Part of order price (
payment_amount
).
money_transfer_fee_amount
money
/
null
Money handling fee: backpayment transfer, buyout operations.
Part of order price (
payment_amount
).
cod_fee_amount
money
/
null
Extra fee for issuing a cashier's check.
Part of order price (
payment_amount
).
return_fee_amount
money
/
null
Extra fee for return to first point.
Part of order price (
payment_amount
).
waiting_fee_amount
money
/
null
Extra fee for paid waiting at designated points.
Part of order price (
payment_amount
).
backpayment_details
string
/
null
Details of the money transfer for backpayment. A credit card number or other payment system information.
backpayment_photo_url
string
/
null
URL of backpayment photo (receipt or other payment verification).
waybill_document_url
string
/
null
URL of waybill document.
courier
object
/
null
Courier parameters.
Courier parameters
courier_id
integer
Courier ID.
surname
string
Surname of the courier.
name
string
Name of the courier.
middlename
string
Middlename of the courier.
phone
phone
Phone of the courier.
photo_url
string
/
null
URL of the courier's photo.
latitude
coordinate
/
null
Latitude of the location.
Only for active orders, if the courier is on the way.
longitude
coordinate
/
null
Longitude of the location.
Only for active orders, if the courier is on the way.
is_motobox_required
boolean
Is motobox required.
is_thermobox_required
boolean
Is thermobox required.
payment_method
string
Payment method.
Payment methods
bank_card_id
integer
/
null
Bank card ID for bank_card payment method.
applied_promo_code
string
/
null
Applied promo code.
is_return_required
boolean
Order has return.
promo_code_discount_amount
money
Discount amount by promo code.
Part of order price (
payment_amount
).
Request example
Example 1.
Create order with default payment method.
CURL
curl --include --header 'X-DV-Auth-Token: SECRET_AUTH_TOKEN' --data '{"matter":"Documents","points":[{"address":"Saket, New Delhi, Delhi","contact_person":{"phone":"918880000001"}},{"address":"Janakpuri, New Delhi, Delhi","contact_person":{"phone":"918880000001"}}]}' 'https://robotapitest-in.borzodelivery.com/api/business/1.8/create-order'
HTTP/1.1 200 OK
Date: Tue, 27 Oct 2026 14:49:39 GMT
Content-Type: application/json; charset=utf-8
{
"is_successful": true,
"order": {
"type": "standard",
"order_id": 1250032,
"order_name": "50032",
"vehicle_type_id": 8,
"created_datetime": "2026-10-27T20:19:39+05:30",
"finish_datetime": null,
"status": "available",
"status_description": "available",
"matter": "Documents",
"total_weight_kg": 0,
"is_client_notification_enabled": false,
"is_contact_person_notification_enabled": false,
"loaders_count": 0,
"backpayment_details": null,
"points": [{
"point_id": 202685,
"delivery_id": null,
"client_order_id": null,
"address": "Saket, New Delhi, Delhi",
"latitude": "28.5235479",
"longitude": "77.2045073",
"required_start_datetime": "2026-10-27T20:49:39+05:30",
"required_finish_datetime": "2026-10-27T21:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"estimated_arrival_datetime": null,
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": "918880000001"
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [],
"is_cod_cash_voucher_required": false,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": null
}, {
"point_id": 202686,
"delivery_id": null,
"client_order_id": null,
"address": "Janakpuri, New Delhi, Delhi",
"latitude": "28.6210537",
"longitude": "77.0817532",
"required_start_datetime": "2026-10-27T21:49:39+05:30",
"required_finish_datetime": "2026-10-27T22:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"estimated_arrival_datetime": null,
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": "918880000001"
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [],
"is_cod_cash_voucher_required": false,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": {
"status": "planned"
}
}],
"payment_amount": "170.00",
"delivery_fee_amount": "170.00",
"weight_fee_amount": "0.00",
"insurance_amount": "0.00",
"insurance_fee_amount": "0.00",
"loading_fee_amount": "0.00",
"money_transfer_fee_amount": "0.00",
"promo_code_discount_amount": "40.00",
"backpayment_amount": "0.00",
"cod_fee_amount": "0.00",
"return_fee_amount": "0.00",
"waiting_fee_amount": "0.00",
"backpayment_photo_url": null,
"waybill_document_url": null,
"courier": null,
"is_motobox_required": false,
"payment_method": "cash",
"bank_card_id": null,
"applied_promo_code": "FIRST_ORDER",
"is_return_required": false
}
}
PHP
<?php
$curl = curl_init();
curl_setopt($curl, CURLOPT_URL, 'https://robotapitest-in.borzodelivery.com/api/business/1.8/create-order');
curl_setopt($curl, CURLOPT_CUSTOMREQUEST, 'POST');
curl_setopt($curl, CURLOPT_HTTPHEADER, ['X-DV-Auth-Token: SECRET_AUTH_TOKEN']);
curl_setopt($curl, CURLOPT_RETURNTRANSFER, true);
$data = [
'matter' => 'Documents',
'points' => [
[
'address' => 'Saket, New Delhi, Delhi',
'contact_person' => [
'phone' => '918880000001',
],
],
[
'address' => 'Janakpuri, New Delhi, Delhi',
'contact_person' => [
'phone' => '918880000001',
],
],
],
];
$json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
curl_setopt($curl, CURLOPT_POSTFIELDS, $json);
$result = curl_exec($curl);
if ($result === false) {
throw new Exception(curl_error($curl), curl_errno($curl));
}
echo $result;
{
"is_successful": true,
"order": {
"type": "standard",
"order_id": 1250032,
"order_name": "50032",
"vehicle_type_id": 8,
"created_datetime": "2026-10-27T20:19:39+05:30",
"finish_datetime": null,
"status": "available",
"status_description": "available",
"matter": "Documents",
"total_weight_kg": 0,
"is_client_notification_enabled": false,
"is_contact_person_notification_enabled": false,
"loaders_count": 0,
"backpayment_details": null,
"points": [{
"point_id": 202685,
"delivery_id": null,
"client_order_id": null,
"address": "Saket, New Delhi, Delhi",
"latitude": "28.5235479",
"longitude": "77.2045073",
"required_start_datetime": "2026-10-27T20:49:39+05:30",
"required_finish_datetime": "2026-10-27T21:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"estimated_arrival_datetime": null,
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": "918880000001"
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [],
"is_cod_cash_voucher_required": false,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": null
}, {
"point_id": 202686,
"delivery_id": null,
"client_order_id": null,
"address": "Janakpuri, New Delhi, Delhi",
"latitude": "28.6210537",
"longitude": "77.0817532",
"required_start_datetime": "2026-10-27T21:49:39+05:30",
"required_finish_datetime": "2026-10-27T22:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"estimated_arrival_datetime": null,
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": "918880000001"
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [],
"is_cod_cash_voucher_required": false,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": {
"status": "planned"
}
}],
"payment_amount": "170.00",
"delivery_fee_amount": "170.00",
"weight_fee_amount": "0.00",
"insurance_amount": "0.00",
"insurance_fee_amount": "0.00",
"loading_fee_amount": "0.00",
"money_transfer_fee_amount": "0.00",
"promo_code_discount_amount": "40.00",
"backpayment_amount": "0.00",
"cod_fee_amount": "0.00",
"return_fee_amount": "0.00",
"waiting_fee_amount": "0.00",
"backpayment_photo_url": null,
"waybill_document_url": null,
"courier": null,
"is_motobox_required": false,
"payment_method": "cash",
"bank_card_id": null,
"applied_promo_code": "FIRST_ORDER",
"is_return_required": false
}
}
Example 2.
Create order with
bank_card
payment method.
CURL
curl --include --header 'X-DV-Auth-Token: SECRET_AUTH_TOKEN' --data '{"matter":"Documents","payment_method":"bank_card","bank_card_id":80,"points":[{"address":"Saket, New Delhi, Delhi","contact_person":{"phone":"918880000001"}},{"address":"Janakpuri, New Delhi, Delhi","contact_person":{"phone":"918880000001"}}]}' 'https://robotapitest-in.borzodelivery.com/api/business/1.8/create-order'
HTTP/1.1 200 OK
Date: Tue, 27 Oct 2026 14:49:39 GMT
Content-Type: application/json; charset=utf-8
{
"is_successful": true,
"order": {
"type": "standard",
"order_id": 1250032,
"order_name": "50032",
"vehicle_type_id": 8,
"created_datetime": "2026-10-27T20:19:39+05:30",
"finish_datetime": null,
"status": "available",
"status_description": "available",
"matter": "Documents",
"total_weight_kg": 0,
"is_client_notification_enabled": false,
"is_contact_person_notification_enabled": false,
"loaders_count": 0,
"backpayment_details": null,
"points": [{
"point_id": 202685,
"delivery_id": null,
"client_order_id": null,
"address": "Saket, New Delhi, Delhi",
"latitude": "28.5235479",
"longitude": "77.2045073",
"required_start_datetime": "2026-10-27T20:49:39+05:30",
"required_finish_datetime": "2026-10-27T21:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"estimated_arrival_datetime": null,
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": "918880000001"
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [],
"is_cod_cash_voucher_required": false,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": null
}, {
"point_id": 202686,
"delivery_id": null,
"client_order_id": null,
"address": "Janakpuri, New Delhi, Delhi",
"latitude": "28.6210537",
"longitude": "77.0817532",
"required_start_datetime": "2026-10-27T21:49:39+05:30",
"required_finish_datetime": "2026-10-27T22:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"estimated_arrival_datetime": null,
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": "918880000001"
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [],
"is_cod_cash_voucher_required": false,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": {
"status": "planned"
}
}],
"payment_amount": "170.00",
"delivery_fee_amount": "170.00",
"weight_fee_amount": "0.00",
"insurance_amount": "0.00",
"insurance_fee_amount": "0.00",
"loading_fee_amount": "0.00",
"money_transfer_fee_amount": "0.00",
"promo_code_discount_amount": "40.00",
"backpayment_amount": "0.00",
"cod_fee_amount": "0.00",
"return_fee_amount": "0.00",
"waiting_fee_amount": "0.00",
"backpayment_photo_url": null,
"waybill_document_url": null,
"courier": null,
"is_motobox_required": false,
"payment_method": "bank_card",
"bank_card_id": 80,
"applied_promo_code": "FIRST_ORDER",
"is_return_required": false
}
}
PHP
<?php
$curl = curl_init();
curl_setopt($curl, CURLOPT_URL, 'https://robotapitest-in.borzodelivery.com/api/business/1.8/create-order');
curl_setopt($curl, CURLOPT_CUSTOMREQUEST, 'POST');
curl_setopt($curl, CURLOPT_HTTPHEADER, ['X-DV-Auth-Token: SECRET_AUTH_TOKEN']);
curl_setopt($curl, CURLOPT_RETURNTRANSFER, true);
$data = [
'matter' => 'Documents',
'payment_method' => 'bank_card',
'bank_card_id' => 80,
'points' => [
[
'address' => 'Saket, New Delhi, Delhi',
'contact_person' => [
'phone' => '918880000001',
],
],
[
'address' => 'Janakpuri, New Delhi, Delhi',
'contact_person' => [
'phone' => '918880000001',
],
],
],
];
$json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
curl_setopt($curl, CURLOPT_POSTFIELDS, $json);
$result = curl_exec($curl);
if ($result === false) {
throw new Exception(curl_error($curl), curl_errno($curl));
}
echo $result;
{
"is_successful": true,
"order": {
"type": "standard",
"order_id": 1250032,
"order_name": "50032",
"vehicle_type_id": 8,
"created_datetime": "2026-10-27T20:19:39+05:30",
"finish_datetime": null,
"status": "available",
"status_description": "available",
"matter": "Documents",
"total_weight_kg": 0,
"is_client_notification_enabled": false,
"is_contact_person_notification_enabled": false,
"loaders_count": 0,
"backpayment_details": null,
"points": [{
"point_id": 202685,
"delivery_id": null,
"client_order_id": null,
"address": "Saket, New Delhi, Delhi",
"latitude": "28.5235479",
"longitude": "77.2045073",
"required_start_datetime": "2026-10-27T20:49:39+05:30",
"required_finish_datetime": "2026-10-27T21:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"estimated_arrival_datetime": null,
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": "918880000001"
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [],
"is_cod_cash_voucher_required": false,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": null
}, {
"point_id": 202686,
"delivery_id": null,
"client_order_id": null,
"address": "Janakpuri, New Delhi, Delhi",
"latitude": "28.6210537",
"longitude": "77.0817532",
"required_start_datetime": "2026-10-27T21:49:39+05:30",
"required_finish_datetime": "2026-10-27T22:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"estimated_arrival_datetime": null,
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": "918880000001"
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [],
"is_cod_cash_voucher_required": false,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": {
"status": "planned"
}
}],
"payment_amount": "170.00",
"delivery_fee_amount": "170.00",
"weight_fee_amount": "0.00",
"insurance_amount": "0.00",
"insurance_fee_amount": "0.00",
"loading_fee_amount": "0.00",
"money_transfer_fee_amount": "0.00",
"promo_code_discount_amount": "40.00",
"backpayment_amount": "0.00",
"cod_fee_amount": "0.00",
"return_fee_amount": "0.00",
"waiting_fee_amount": "0.00",
"backpayment_photo_url": null,
"waybill_document_url": null,
"courier": null,
"is_motobox_required": false,
"payment_method": "bank_card",
"bank_card_id": 80,
"applied_promo_code": "FIRST_ORDER",
"is_return_required": false
}
}
Example 3.
Create order from draft deliveries. First point cannot be delivery.
CURL
curl --include --header 'X-DV-Auth-Token: SECRET_AUTH_TOKEN' --data '{"matter":"Documents","points":[{"address":"Saket, New Delhi, Delhi","contact_person":{"phone":"918880000001"}},{"delivery_id":11712,"address":"Janakpuri, New Delhi, Delhi","contact_person":{"phone":"918880000001"}}]}' 'https://robotapitest-in.borzodelivery.com/api/business/1.8/create-order'
HTTP/1.1 200 OK
Date: Tue, 27 Oct 2026 14:49:39 GMT
Content-Type: application/json; charset=utf-8
{
"is_successful": true,
"order": {
"type": "standard",
"order_id": 1250032,
"order_name": "50032",
"vehicle_type_id": 8,
"created_datetime": "2026-10-27T20:19:39+05:30",
"finish_datetime": null,
"status": "available",
"status_description": "available",
"matter": "Documents",
"total_weight_kg": 0,
"is_client_notification_enabled": false,
"is_contact_person_notification_enabled": false,
"loaders_count": 0,
"backpayment_details": null,
"points": [{
"point_id": 202685,
"delivery_id": null,
"client_order_id": null,
"address": "Saket, New Delhi, Delhi",
"latitude": "28.5235479",
"longitude": "77.2045073",
"required_start_datetime": "2026-10-27T20:49:39+05:30",
"required_finish_datetime": "2026-10-27T21:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"estimated_arrival_datetime": null,
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": "918880000001"
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [],
"is_cod_cash_voucher_required": false,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": null
}, {
"point_id": 202686,
"delivery_id": 11712,
"client_order_id": null,
"address": "Janakpuri, New Delhi, Delhi",
"latitude": "28.6210537",
"longitude": "77.0817532",
"required_start_datetime": "2026-10-27T21:49:39+05:30",
"required_finish_datetime": "2026-10-27T22:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"estimated_arrival_datetime": null,
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": "918880000001"
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [],
"is_cod_cash_voucher_required": false,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": {
"status": "planned"
}
}],
"payment_amount": "170.00",
"delivery_fee_amount": "170.00",
"weight_fee_amount": "0.00",
"insurance_amount": "0.00",
"insurance_fee_amount": "0.00",
"loading_fee_amount": "0.00",
"money_transfer_fee_amount": "0.00",
"promo_code_discount_amount": "40.00",
"backpayment_amount": "0.00",
"cod_fee_amount": "0.00",
"return_fee_amount": "0.00",
"waiting_fee_amount": "0.00",
"backpayment_photo_url": null,
"waybill_document_url": null,
"courier": null,
"is_motobox_required": false,
"payment_method": "cash",
"bank_card_id": null,
"applied_promo_code": "FIRST_ORDER",
"is_return_required": false
}
}
PHP
<?php
$curl = curl_init();
curl_setopt($curl, CURLOPT_URL, 'https://robotapitest-in.borzodelivery.com/api/business/1.8/create-order');
curl_setopt($curl, CURLOPT_CUSTOMREQUEST, 'POST');
curl_setopt($curl, CURLOPT_HTTPHEADER, ['X-DV-Auth-Token: SECRET_AUTH_TOKEN']);
curl_setopt($curl, CURLOPT_RETURNTRANSFER, true);
$data = [
'matter' => 'Documents',
'points' => [
[
'address' => 'Saket, New Delhi, Delhi',
'contact_person' => [
'phone' => '918880000001',
],
],
[
'delivery_id' => 11712,
'address' => 'Janakpuri, New Delhi, Delhi',
'contact_person' => [
'phone' => '918880000001',
],
],
],
];
$json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
curl_setopt($curl, CURLOPT_POSTFIELDS, $json);
$result = curl_exec($curl);
if ($result === false) {
throw new Exception(curl_error($curl), curl_errno($curl));
}
echo $result;
{
"is_successful": true,
"order": {
"type": "standard",
"order_id": 1250032,
"order_name": "50032",
"vehicle_type_id": 8,
"created_datetime": "2026-10-27T20:19:39+05:30",
"finish_datetime": null,
"status": "available",
"status_description": "available",
"matter": "Documents",
"total_weight_kg": 0,
"is_client_notification_enabled": false,
"is_contact_person_notification_enabled": false,
"loaders_count": 0,
"backpayment_details": null,
"points": [{
"point_id": 202685,
"delivery_id": null,
"client_order_id": null,
"address": "Saket, New Delhi, Delhi",
"latitude": "28.5235479",
"longitude": "77.2045073",
"required_start_datetime": "2026-10-27T20:49:39+05:30",
"required_finish_datetime": "2026-10-27T21:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"estimated_arrival_datetime": null,
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": "918880000001"
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [],
"is_cod_cash_voucher_required": false,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": null
}, {
"point_id": 202686,
"delivery_id": 11712,
"client_order_id": null,
"address": "Janakpuri, New Delhi, Delhi",
"latitude": "28.6210537",
"longitude": "77.0817532",
"required_start_datetime": "2026-10-27T21:49:39+05:30",
"required_finish_datetime": "2026-10-27T22:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"estimated_arrival_datetime": null,
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": "918880000001"
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [],
"is_cod_cash_voucher_required": false,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": {
"status": "planned"
}
}],
"payment_amount": "170.00",
"delivery_fee_amount": "170.00",
"weight_fee_amount": "0.00",
"insurance_amount": "0.00",
"insurance_fee_amount": "0.00",
"loading_fee_amount": "0.00",
"money_transfer_fee_amount": "0.00",
"promo_code_discount_amount": "40.00",
"backpayment_amount": "0.00",
"cod_fee_amount": "0.00",
"return_fee_amount": "0.00",
"waiting_fee_amount": "0.00",
"backpayment_photo_url": null,
"waybill_document_url": null,
"courier": null,
"is_motobox_required": false,
"payment_method": "cash",
"bank_card_id": null,
"applied_promo_code": "FIRST_ORDER",
"is_return_required": false
}
}
Order editing
POST
https://robotapitest-in.borzodelivery.com/api/business/1.8/edit-order
This API method can be used to edit an order in statuses:
new
,
available
,
active
or
delayed
(
Order statuses
).
Request parameters
Response parameters
Examples
Request parameters
order_id
integer
Required
Full order ID.
To edit the order, send any number of extra parameters from
order creation
.
If modified value is valid, it will be applied to the order.
If a parameter is not sent with the request, its value will not be changed.
If a parameter is sent with
null
value, corresponding value will be removed from the order.
When editing a point, always send its ID along with changed values, otherwise a new point will be added to the order. Also, any points with IDs not mentioned in the request will be deleted.
When editing a package, always send its ID along with changed values, otherwise a new package will be added to the point. Also, any packages with IDs not mentioned in the request will be deleted.
See
order editing examples
to avoid pitfalls.
Response parameters
is_successful
boolean
Whether the request was successful or not.
order
object
Modified order data.
Order parameters
order_id
integer
Full order ID.
type
string
Order type.
Order types
matter
string
Delivery contents.
order_name
string
Order name (short order ID).
vehicle_type_id
integer
Vehicle type.
Vehicle types
created_datetime
timestamp
Order creation date and time.
finish_datetime
timestamp
/
null
Order completion date and time.
status
string
Order status.
Order statuses
status_description
string
Order status description.
total_weight_kg
integer
Total weight in kilograms.
is_client_notification_enabled
boolean
Whether to send SMS notifications to the client.
is_contact_person_notification_enabled
boolean
Whether to send SMS notifications to recipients on addresses.
loaders_count
integer
Number of necessary loaders to move the delivered goods, including the driver.
points
list
List of addresses (points) for the courier to visit.
Point parameters
point_id
integer
Point ID.
delivery_id
integer
/
null
Delivery ID.
address
string
Street address.
contact_person
object
Contact person on the address.
Contact person parameters
phone
phone
Phone number of the person at the address.
name
string
/
null
Name of the person on the address.
client_order_id
string
/
null
Your eshop's order ID. It will be sent in notifications instead of our delivery order ID.
latitude
coordinate
Latitude of the location.
longitude
coordinate
Longitude of the location.
required_start_datetime
timestamp
/
null
How early the courier may arrive at the address.
required_finish_datetime
timestamp
/
null
How late the courier may arrive at the address.
arrival_start_datetime
timestamp
/
null
Estimated courier arrival time, upper bound.
arrival_finish_datetime
timestamp
/
null
Estimated courier arrival time, lower bound.
courier_visit_datetime
timestamp
/
null
Actual courier arrival time.
taking_amount
money
Backpayment sum to receive from the contact person at the address.
buyout_amount
money
Buyout sum the courier pays to the contact person at the address.
note
string
/
null
Additional information for the courier: office or appartment number, company name, whether any documents are required to enter the building.
packages
list
List of packages at the point.
Package parameters
order_package_id
integer
Package ID.
ware_code
string
Vendor code.
description
string
Description.
items_count
float
Amount.
item_payment_amount
string
Price per item.
nomenclature_code
string
Nomenclature code.
is_cod_cash_voucher_required
boolean
Whether to issue a cashier's check to the recipient at the address.
is_order_payment_here
boolean
Money will be paid to the courier at the address.
building_number
string
/
null
Building number.
entrance_number
string
/
null
Entrance number.
intercom_code
string
/
null
Intercom code.
floor_number
string
/
null
Floor number.
apartment_number
string
/
null
Apartment/office number.
invisible_mile_navigation_instructions
string
/
null
Instruction to courier how to get to recipient at the address.
place_photo_url
string
/
null
Place photo when closing a point at the address.
sign_photo_url
string
/
null
Recipients signature photo when closing a point at the address.
checkin_code
string
/
null
Courier's arrival pin code at the point.
checkin
object
/
null
Checkin information when closing a point at the address.
Checkin parameters
recipient_full_name
string
/
null
Full name of the recipient who met the courier.
recipient_position
string
/
null
Position of the recipient who met the courier.
is_return_point
boolean
Return point (same as first or hub).
tracking_url
string
/
null
Recipient's tracking link.
delivery
object
/
null
Delivery.
Delivery parameters
status
string
Delivery status.
payment_amount
money
/
null
Order price.
delivery_fee_amount
money
/
null
Delivery fee.
Part of order price (
payment_amount
).
weight_fee_amount
money
/
null
Large weight fee.
Part of order price (
payment_amount
).
insurance_amount
money
/
null
Insured amount.
insurance_fee_amount
money
/
null
Insurance fee.
Part of order price (
payment_amount
).
loading_fee_amount
money
/
null
Loading / heavy lifting fee.
Part of order price (
payment_amount
).
money_transfer_fee_amount
money
/
null
Money handling fee: backpayment transfer, buyout operations.
Part of order price (
payment_amount
).
cod_fee_amount
money
/
null
Extra fee for issuing a cashier's check.
Part of order price (
payment_amount
).
return_fee_amount
money
/
null
Extra fee for return to first point.
Part of order price (
payment_amount
).
waiting_fee_amount
money
/
null
Extra fee for paid waiting at designated points.
Part of order price (
payment_amount
).
backpayment_details
string
/
null
Details of the money transfer for backpayment. A credit card number or other payment system information.
backpayment_photo_url
string
/
null
URL of backpayment photo (receipt or other payment verification).
waybill_document_url
string
/
null
URL of waybill document.
courier
object
/
null
Courier parameters.
Courier parameters
courier_id
integer
Courier ID.
surname
string
Surname of the courier.
name
string
Name of the courier.
middlename
string
Middlename of the courier.
phone
phone
Phone of the courier.
photo_url
string
/
null
URL of the courier's photo.
latitude
coordinate
/
null
Latitude of the location.
Only for active orders, if the courier is on the way.
longitude
coordinate
/
null
Longitude of the location.
Only for active orders, if the courier is on the way.
is_motobox_required
boolean
Is motobox required.
is_thermobox_required
boolean
Is thermobox required.
payment_method
string
Payment method.
Payment methods
bank_card_id
integer
/
null
Bank card ID for bank_card payment method.
applied_promo_code
string
/
null
Applied promo code.
is_return_required
boolean
Order has return.
promo_code_discount_amount
money
Discount amount by promo code.
Part of order price (
payment_amount
).
Request example
Example 1.
Changing delivery details (
matter
) and removing backpayment details (
backpayment_details
).
CURL
curl --include --header 'X-DV-Auth-Token: SECRET_AUTH_TOKEN' --data '{"order_id":1250032,"matter":"Flowers","backpayment_details":null}' 'https://robotapitest-in.borzodelivery.com/api/business/1.8/edit-order'
HTTP/1.1 200 OK
Date: Tue, 27 Oct 2026 14:49:39 GMT
Content-Type: application/json; charset=utf-8
{
"is_successful": true,
"order": {
"type": "standard",
"order_id": 1250032,
"order_name": "50032",
"vehicle_type_id": 8,
"created_datetime": "2026-10-27T20:19:39+05:30",
"finish_datetime": null,
"status": "available",
"status_description": "available",
"matter": "Flowers",
"total_weight_kg": 0,
"is_client_notification_enabled": false,
"is_contact_person_notification_enabled": false,
"loaders_count": 0,
"backpayment_details": null,
"points": [{
"point_id": 202685,
"delivery_id": null,
"client_order_id": null,
"address": "Saket, New Delhi, Delhi",
"latitude": "28.5235479",
"longitude": "77.2045073",
"required_start_datetime": "2026-10-27T20:49:39+05:30",
"required_finish_datetime": "2026-10-27T21:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"estimated_arrival_datetime": null,
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": "918880000001"
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [],
"is_cod_cash_voucher_required": false,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": null
}, {
"point_id": 202686,
"delivery_id": null,
"client_order_id": null,
"address": "Janakpuri, New Delhi, Delhi",
"latitude": "28.6210537",
"longitude": "77.0817532",
"required_start_datetime": "2026-10-27T21:49:39+05:30",
"required_finish_datetime": "2026-10-27T22:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"estimated_arrival_datetime": null,
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": "918880000001"
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [],
"is_cod_cash_voucher_required": false,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": {
"status": "planned"
}
}],
"payment_amount": "170.00",
"delivery_fee_amount": "170.00",
"weight_fee_amount": "0.00",
"insurance_amount": "0.00",
"insurance_fee_amount": "0.00",
"loading_fee_amount": "0.00",
"money_transfer_fee_amount": "0.00",
"promo_code_discount_amount": "40.00",
"backpayment_amount": "0.00",
"cod_fee_amount": "0.00",
"return_fee_amount": "0.00",
"waiting_fee_amount": "0.00",
"backpayment_photo_url": null,
"waybill_document_url": null,
"courier": null,
"is_motobox_required": false,
"payment_method": "cash",
"bank_card_id": null,
"applied_promo_code": "FIRST_ORDER",
"is_return_required": false
}
PHP
<?php
$curl = curl_init();
curl_setopt($curl, CURLOPT_URL, 'https://robotapitest-in.borzodelivery.com/api/business/1.8/edit-order');
curl_setopt($curl, CURLOPT_CUSTOMREQUEST, 'POST');
curl_setopt($curl, CURLOPT_HTTPHEADER, ['X-DV-Auth-Token: SECRET_AUTH_TOKEN']);
curl_setopt($curl, CURLOPT_RETURNTRANSFER, true);
$data = [
'order_id'            => 1250032,
'matter'              => 'Flowers',
'backpayment_details' => null,
];
$json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
curl_setopt($curl, CURLOPT_POSTFIELDS, $json);
$result = curl_exec($curl);
if ($result === false) {
throw new Exception(curl_error($curl), curl_errno($curl));
}
echo $result;
{
"is_successful": true,
"order": {
"type": "standard",
"order_id": 1250032,
"order_name": "50032",
"vehicle_type_id": 8,
"created_datetime": "2026-10-27T20:19:39+05:30",
"finish_datetime": null,
"status": "available",
"status_description": "available",
"matter": "Flowers",
"total_weight_kg": 0,
"is_client_notification_enabled": false,
"is_contact_person_notification_enabled": false,
"loaders_count": 0,
"backpayment_details": null,
"points": [{
"point_id": 202685,
"delivery_id": null,
"client_order_id": null,
"address": "Saket, New Delhi, Delhi",
"latitude": "28.5235479",
"longitude": "77.2045073",
"required_start_datetime": "2026-10-27T20:49:39+05:30",
"required_finish_datetime": "2026-10-27T21:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"estimated_arrival_datetime": null,
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": "918880000001"
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [],
"is_cod_cash_voucher_required": false,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": null
}, {
"point_id": 202686,
"delivery_id": null,
"client_order_id": null,
"address": "Janakpuri, New Delhi, Delhi",
"latitude": "28.6210537",
"longitude": "77.0817532",
"required_start_datetime": "2026-10-27T21:49:39+05:30",
"required_finish_datetime": "2026-10-27T22:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"estimated_arrival_datetime": null,
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": "918880000001"
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [],
"is_cod_cash_voucher_required": false,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": {
"status": "planned"
}
}],
"payment_amount": "170.00",
"delivery_fee_amount": "170.00",
"weight_fee_amount": "0.00",
"insurance_amount": "0.00",
"insurance_fee_amount": "0.00",
"loading_fee_amount": "0.00",
"money_transfer_fee_amount": "0.00",
"promo_code_discount_amount": "40.00",
"backpayment_amount": "0.00",
"cod_fee_amount": "0.00",
"return_fee_amount": "0.00",
"waiting_fee_amount": "0.00",
"backpayment_photo_url": null,
"waybill_document_url": null,
"courier": null,
"is_motobox_required": false,
"payment_method": "cash",
"bank_card_id": null,
"applied_promo_code": "FIRST_ORDER",
"is_return_required": false
}
Example 2.
Modifying times on a point and adding a new point. First point should be kept as it was.
CURL
curl --include --header 'X-DV-Auth-Token: SECRET_AUTH_TOKEN' --data '{"order_id":1250032,"points":[{"point_id":202685},{"point_id":202686,"required_start_datetime":"2026-10-27T21:49:39+05:30","required_finish_datetime":"2026-10-27T22:19:39+05:30"},{"address":"Saket, New Delhi, Delhi","contact_person":{"phone":"918880000001"}}]}' 'https://robotapitest-in.borzodelivery.com/api/business/1.8/edit-order'
HTTP/1.1 200 OK
Date: Tue, 27 Oct 2026 14:49:39 GMT
Content-Type: application/json; charset=utf-8
{
"is_successful": true,
"order": {
"type": "standard",
"order_id": 1250032,
"order_name": "50032",
"vehicle_type_id": 8,
"created_datetime": "2026-10-27T20:19:39+05:30",
"finish_datetime": null,
"status": "available",
"status_description": "available",
"matter": "Flowers",
"total_weight_kg": 0,
"is_client_notification_enabled": false,
"is_contact_person_notification_enabled": false,
"loaders_count": 0,
"backpayment_details": null,
"points": [{
"point_id": 202685,
"delivery_id": null,
"client_order_id": null,
"address": "Saket, New Delhi, Delhi",
"latitude": "28.5235479",
"longitude": "77.2045073",
"required_start_datetime": "2026-10-27T20:49:39+05:30",
"required_finish_datetime": "2026-10-27T21:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"estimated_arrival_datetime": null,
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": "918880000001"
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [],
"is_cod_cash_voucher_required": false,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": null
}, {
"point_id": 202686,
"delivery_id": null,
"client_order_id": null,
"address": "Janakpuri, New Delhi, Delhi",
"latitude": "28.6210537",
"longitude": "77.0817532",
"required_start_datetime": "2026-10-27T21:49:39+05:30",
"required_finish_datetime": "2026-10-27T22:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"estimated_arrival_datetime": null,
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": "918880000001"
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [],
"is_cod_cash_voucher_required": false,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": {
"status": "planned"
}
}, {
"point_id": 202687,
"delivery_id": null,
"client_order_id": null,
"address": "Saket, New Delhi, Delhi",
"latitude": "28.5235479",
"longitude": "77.2045073",
"required_start_datetime": "2026-10-27T22:49:39+05:30",
"required_finish_datetime": "2026-10-27T23:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": "918880000001"
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [],
"is_cod_cash_voucher_required": false,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": {
"status": "planned"
}
}],
"payment_amount": "170.00",
"delivery_fee_amount": "170.00",
"weight_fee_amount": "0.00",
"insurance_amount": "0.00",
"insurance_fee_amount": "0.00",
"loading_fee_amount": "0.00",
"money_transfer_fee_amount": "0.00",
"promo_code_discount_amount": "40.00",
"backpayment_amount": "0.00",
"cod_fee_amount": "0.00",
"return_fee_amount": "0.00",
"waiting_fee_amount": "0.00",
"backpayment_photo_url": null,
"waybill_document_url": null,
"courier": null,
"is_motobox_required": false,
"payment_method": "cash",
"bank_card_id": null,
"applied_promo_code": "FIRST_ORDER",
"is_return_required": false
}
PHP
<?php
$curl = curl_init();
curl_setopt($curl, CURLOPT_URL, 'https://robotapitest-in.borzodelivery.com/api/business/1.8/edit-order');
curl_setopt($curl, CURLOPT_CUSTOMREQUEST, 'POST');
curl_setopt($curl, CURLOPT_HTTPHEADER, ['X-DV-Auth-Token: SECRET_AUTH_TOKEN']);
curl_setopt($curl, CURLOPT_RETURNTRANSFER, true);
$data = [
'order_id' => 1250032,
'points'   => [
[
'point_id' => 202685,
],
[
'point_id'                 => 202686,
'required_start_datetime'  => '2026-10-27T21:49:39+05:30',
'required_finish_datetime' => '2026-10-27T22:19:39+05:30',
],
[
'address' => 'Saket, New Delhi, Delhi',
'contact_person' => [
'phone' => '918880000001',
],
],
],
];
$json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
curl_setopt($curl, CURLOPT_POSTFIELDS, $json);
$result = curl_exec($curl);
if ($result === false) {
throw new Exception(curl_error($curl), curl_errno($curl));
}
echo $result;
{
"is_successful": true,
"order": {
"type": "standard",
"order_id": 1250032,
"order_name": "50032",
"vehicle_type_id": 8,
"created_datetime": "2026-10-27T20:19:39+05:30",
"finish_datetime": null,
"status": "available",
"status_description": "available",
"matter": "Flowers",
"total_weight_kg": 0,
"is_client_notification_enabled": false,
"is_contact_person_notification_enabled": false,
"loaders_count": 0,
"backpayment_details": null,
"points": [{
"point_id": 202685,
"delivery_id": null,
"client_order_id": null,
"address": "Saket, New Delhi, Delhi",
"latitude": "28.5235479",
"longitude": "77.2045073",
"required_start_datetime": "2026-10-27T20:49:39+05:30",
"required_finish_datetime": "2026-10-27T21:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"estimated_arrival_datetime": null,
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": "918880000001"
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [],
"is_cod_cash_voucher_required": false,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": null
}, {
"point_id": 202686,
"delivery_id": null,
"client_order_id": null,
"address": "Janakpuri, New Delhi, Delhi",
"latitude": "28.6210537",
"longitude": "77.0817532",
"required_start_datetime": "2026-10-27T21:49:39+05:30",
"required_finish_datetime": "2026-10-27T22:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"estimated_arrival_datetime": null,
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": "918880000001"
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [],
"is_cod_cash_voucher_required": false,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": {
"status": "planned"
}
}, {
"point_id": 202687,
"delivery_id": null,
"client_order_id": null,
"address": "Saket, New Delhi, Delhi",
"latitude": "28.5235479",
"longitude": "77.2045073",
"required_start_datetime": "2026-10-27T22:49:39+05:30",
"required_finish_datetime": "2026-10-27T23:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": "918880000001"
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [],
"is_cod_cash_voucher_required": false,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": {
"status": "planned"
}
}],
"payment_amount": "170.00",
"delivery_fee_amount": "170.00",
"weight_fee_amount": "0.00",
"insurance_amount": "0.00",
"insurance_fee_amount": "0.00",
"loading_fee_amount": "0.00",
"money_transfer_fee_amount": "0.00",
"promo_code_discount_amount": "40.00",
"backpayment_amount": "0.00",
"cod_fee_amount": "0.00",
"return_fee_amount": "0.00",
"waiting_fee_amount": "0.00",
"backpayment_photo_url": null,
"waybill_document_url": null,
"courier": null,
"is_motobox_required": false,
"payment_method": "cash",
"bank_card_id": null,
"applied_promo_code": "FIRST_ORDER",
"is_return_required": false
}
Example 3.
Removing third point from the order.
CURL
curl --include --header 'X-DV-Auth-Token: SECRET_AUTH_TOKEN' --data '{"order_id":1250032,"points":[{"point_id":202685},{"point_id":202686}]}' 'https://robotapitest-in.borzodelivery.com/api/business/1.8/edit-order'
HTTP/1.1 200 OK
Date: Tue, 27 Oct 2026 14:49:39 GMT
Content-Type: application/json; charset=utf-8
{
"is_successful": true,
"order": {
"type": "standard",
"order_id": 1250032,
"order_name": "50032",
"vehicle_type_id": 8,
"created_datetime": "2026-10-27T20:19:39+05:30",
"finish_datetime": null,
"status": "available",
"status_description": "available",
"matter": "Flowers",
"total_weight_kg": 0,
"is_client_notification_enabled": false,
"is_contact_person_notification_enabled": false,
"loaders_count": 0,
"backpayment_details": null,
"points": [{
"point_id": 202685,
"delivery_id": null,
"client_order_id": null,
"address": "Saket, New Delhi, Delhi",
"latitude": "28.5235479",
"longitude": "77.2045073",
"required_start_datetime": "2026-10-27T20:49:39+05:30",
"required_finish_datetime": "2026-10-27T21:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"estimated_arrival_datetime": null,
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": "918880000001"
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [],
"is_cod_cash_voucher_required": false,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": null
}, {
"point_id": 202686,
"delivery_id": null,
"client_order_id": null,
"address": "Janakpuri, New Delhi, Delhi",
"latitude": "28.6210537",
"longitude": "77.0817532",
"required_start_datetime": "2026-10-27T21:49:39+05:30",
"required_finish_datetime": "2026-10-27T22:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"estimated_arrival_datetime": null,
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": "918880000001"
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [],
"is_cod_cash_voucher_required": false,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": {
"status": "planned"
}
}],
"payment_amount": "170.00",
"delivery_fee_amount": "170.00",
"weight_fee_amount": "0.00",
"insurance_amount": "0.00",
"insurance_fee_amount": "0.00",
"loading_fee_amount": "0.00",
"money_transfer_fee_amount": "0.00",
"promo_code_discount_amount": "40.00",
"backpayment_amount": "0.00",
"cod_fee_amount": "0.00",
"return_fee_amount": "0.00",
"waiting_fee_amount": "0.00",
"backpayment_photo_url": null,
"waybill_document_url": null,
"courier": null,
"is_motobox_required": false,
"payment_method": "cash",
"bank_card_id": null,
"applied_promo_code": "FIRST_ORDER",
"is_return_required": false
}
PHP
<?php
$curl = curl_init();
curl_setopt($curl, CURLOPT_URL, 'https://robotapitest-in.borzodelivery.com/api/business/1.8/edit-order');
curl_setopt($curl, CURLOPT_CUSTOMREQUEST, 'POST');
curl_setopt($curl, CURLOPT_HTTPHEADER, ['X-DV-Auth-Token: SECRET_AUTH_TOKEN']);
curl_setopt($curl, CURLOPT_RETURNTRANSFER, true);
$data = [
'order_id' => 1250032,
'points'   => [
[
'point_id' => 202685,
],
[
'point_id' => 202686,
],
],
];
$json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
curl_setopt($curl, CURLOPT_POSTFIELDS, $json);
$result = curl_exec($curl);
if ($result === false) {
throw new Exception(curl_error($curl), curl_errno($curl));
}
echo $result;
{
"is_successful": true,
"order": {
"type": "standard",
"order_id": 1250032,
"order_name": "50032",
"vehicle_type_id": 8,
"created_datetime": "2026-10-27T20:19:39+05:30",
"finish_datetime": null,
"status": "available",
"status_description": "available",
"matter": "Flowers",
"total_weight_kg": 0,
"is_client_notification_enabled": false,
"is_contact_person_notification_enabled": false,
"loaders_count": 0,
"backpayment_details": null,
"points": [{
"point_id": 202685,
"delivery_id": null,
"client_order_id": null,
"address": "Saket, New Delhi, Delhi",
"latitude": "28.5235479",
"longitude": "77.2045073",
"required_start_datetime": "2026-10-27T20:49:39+05:30",
"required_finish_datetime": "2026-10-27T21:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"estimated_arrival_datetime": null,
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": "918880000001"
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [],
"is_cod_cash_voucher_required": false,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": null
}, {
"point_id": 202686,
"delivery_id": null,
"client_order_id": null,
"address": "Janakpuri, New Delhi, Delhi",
"latitude": "28.6210537",
"longitude": "77.0817532",
"required_start_datetime": "2026-10-27T21:49:39+05:30",
"required_finish_datetime": "2026-10-27T22:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"estimated_arrival_datetime": null,
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": "918880000001"
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [],
"is_cod_cash_voucher_required": false,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": {
"status": "planned"
}
}],
"payment_amount": "170.00",
"delivery_fee_amount": "170.00",
"weight_fee_amount": "0.00",
"insurance_amount": "0.00",
"insurance_fee_amount": "0.00",
"loading_fee_amount": "0.00",
"money_transfer_fee_amount": "0.00",
"promo_code_discount_amount": "40.00",
"backpayment_amount": "0.00",
"cod_fee_amount": "0.00",
"return_fee_amount": "0.00",
"waiting_fee_amount": "0.00",
"backpayment_photo_url": null,
"waybill_document_url": null,
"courier": null,
"is_motobox_required": false,
"payment_method": "cash",
"bank_card_id": null,
"applied_promo_code": "FIRST_ORDER",
"is_return_required": false
}
Example 4.
Modifying attributes of a package on second point, remove package on third point, and keep package on first point.
CURL
curl --include --header 'X-DV-Auth-Token: SECRET_AUTH_TOKEN' --data '{"order_id":1250032,"points":[{"point_id":202685, "packages": [{"order_package_id": 3632252}]},{"point_id":202686, "packages": [{"order_package_id": 3632253, "items_count": 3}]},{"point_id": 202687}]}' 'https://robotapitest-in.borzodelivery.com/api/business/1.8/edit-order'
HTTP/1.1 200 OK
Date: Tue, 27 Oct 2026 14:49:39 GMT
Content-Type: application/json; charset=utf-8
{
"is_successful": true,
"order": {
"type": "standard",
"order_id": 1250032,
"order_name": "50032",
"vehicle_type_id": 8,
"created_datetime": "2026-10-27T20:19:39+05:30",
"finish_datetime": null,
"status": "available",
"status_description": "available",
"matter": "Flowers",
"total_weight_kg": 0,
"is_client_notification_enabled": false,
"is_contact_person_notification_enabled": false,
"loaders_count": 0,
"backpayment_details": null,
"points": [{
"point_id": 202685,
"delivery_id": null,
"client_order_id": null,
"address": "Saket, New Delhi, Delhi",
"latitude": "28.5235479",
"longitude": "77.2045073",
"required_start_datetime": "2026-10-27T20:49:39+05:30",
"required_finish_datetime": "2026-10-27T21:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"estimated_arrival_datetime": null,
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": "918880000001"
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [{
"order_package_id": 3632252,
"ware_code": "140012",
"description": "Umbrella",
"items_count": 1,
"item_payment_amount": 350.00
}],
"is_cod_cash_voucher_required": false,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": null
}, {
"point_id": 202686,
"delivery_id": null,
"client_order_id": null,
"address": "Janakpuri, New Delhi, Delhi",
"latitude": "28.6210537",
"longitude": "77.0817532",
"required_start_datetime": "2026-10-27T21:49:39+05:30",
"required_finish_datetime": "2026-10-27T22:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"estimated_arrival_datetime": null,
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": "918880000001"
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [{
"order_package_id": 3632253,
"ware_code": "100112",
"description": "Cap",
"items_count": 3,
"item_payment_amount": 500.00
}],
"is_cod_cash_voucher_required": true,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": {
"status": "planned"
}
}, {
"point_id": 202687,
"delivery_id": null,
"client_order_id": null,
"address": "Saket, New Delhi, Delhi",
"latitude": "28.5235479",
"longitude": "77.2045073",
"required_start_datetime": "2026-10-27T22:49:39+05:30",
"required_finish_datetime": "2026-10-27T23:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": "918880000001"
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [],
"is_cod_cash_voucher_required": false,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": {
"status": "planned"
}
}],
"payment_amount": "170.00",
"delivery_fee_amount": "170.00",
"weight_fee_amount": "0.00",
"insurance_amount": "0.00",
"insurance_fee_amount": "0.00",
"loading_fee_amount": "0.00",
"money_transfer_fee_amount": "0.00",
"promo_code_discount_amount": "40.00",
"backpayment_amount": "0.00",
"cod_fee_amount": "42.50",
"return_fee_amount": "0.00",
"waiting_fee_amount": "0.00",
"backpayment_photo_url": null,
"waybill_document_url": null,
"courier": null,
"is_motobox_required": false,
"payment_method": "cash",
"bank_card_id": null,
"applied_promo_code": "FIRST_ORDER",
"is_return_required": false
}
PHP
<?php
$curl = curl_init();
curl_setopt($curl, CURLOPT_URL, 'https://robotapitest-in.borzodelivery.com/api/business/1.8/edit-order');
curl_setopt($curl, CURLOPT_CUSTOMREQUEST, 'POST');
curl_setopt($curl, CURLOPT_HTTPHEADER, ['X-DV-Auth-Token: SECRET_AUTH_TOKEN']);
curl_setopt($curl, CURLOPT_RETURNTRANSFER, true);
$data = [
'order_id' => 1250032,
'points'   => [
[
'point_id' => 202685,
'packages' => [
[
'order_package_id' => 3632252,
]
],
],
[
'point_id' => 202686,
'packages' => [
[
'order_package_id' => 3632253,
'items_count'      => 3,
]
],
],
[
'point_id' => 202687,
],
],
];
$json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
curl_setopt($curl, CURLOPT_POSTFIELDS, $json);
$result = curl_exec($curl);
if ($result === false) {
throw new Exception(curl_error($curl), curl_errno($curl));
}
echo $result;
{
"is_successful": true,
"order": {
"type": "standard",
"order_id": 1250032,
"order_name": "50032",
"vehicle_type_id": 8,
"created_datetime": "2026-10-27T20:19:39+05:30",
"finish_datetime": null,
"status": "available",
"status_description": "available",
"matter": "Flowers",
"total_weight_kg": 0,
"is_client_notification_enabled": false,
"is_contact_person_notification_enabled": false,
"loaders_count": 0,
"backpayment_details": null,
"points": [{
"point_id": 202685,
"delivery_id": null,
"client_order_id": null,
"address": "Saket, New Delhi, Delhi",
"latitude": "28.5235479",
"longitude": "77.2045073",
"required_start_datetime": "2026-10-27T20:49:39+05:30",
"required_finish_datetime": "2026-10-27T21:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"estimated_arrival_datetime": null,
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": "918880000001"
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [{
"order_package_id": 3632252,
"ware_code": "140012",
"description": "Umbrella",
"items_count": 1,
"item_payment_amount": 350.00
}],
"is_cod_cash_voucher_required": false,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": null
}, {
"point_id": 202686,
"delivery_id": null,
"client_order_id": null,
"address": "Janakpuri, New Delhi, Delhi",
"latitude": "28.6210537",
"longitude": "77.0817532",
"required_start_datetime": "2026-10-27T21:49:39+05:30",
"required_finish_datetime": "2026-10-27T22:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"estimated_arrival_datetime": null,
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": "918880000001"
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [{
"order_package_id": 3632253,
"ware_code": "100112",
"description": "Cap",
"items_count": 3,
"item_payment_amount": 500.00
}],
"is_cod_cash_voucher_required": true,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": {
"status": "planned"
}
}, {
"point_id": 202687,
"delivery_id": null,
"client_order_id": null,
"address": "Saket, New Delhi, Delhi",
"latitude": "28.5235479",
"longitude": "77.2045073",
"required_start_datetime": "2026-10-27T22:49:39+05:30",
"required_finish_datetime": "2026-10-27T23:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": "918880000001"
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [],
"is_cod_cash_voucher_required": false,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": {
"status": "planned"
}
}],
"payment_amount": "170.00",
"delivery_fee_amount": "170.00",
"weight_fee_amount": "0.00",
"insurance_amount": "0.00",
"insurance_fee_amount": "0.00",
"loading_fee_amount": "0.00",
"money_transfer_fee_amount": "0.00",
"promo_code_discount_amount": "40.00",
"backpayment_amount": "0.00",
"cod_fee_amount": "42.50",
"return_fee_amount": "0.00",
"waiting_fee_amount": "0.00",
"backpayment_photo_url": null,
"waybill_document_url": null,
"courier": null,
"is_motobox_required": false,
"payment_method": "cash",
"bank_card_id": null,
"applied_promo_code": "FIRST_ORDER",
"is_return_required": false
}
Example 5.
Setting COD payment attributes. Set the voucher requirement and COD payment amount received at the second point, and remove COD payment and voucher requirement for the third point.
CURL
curl --include --header 'X-DV-Auth-Token: SECRET_AUTH_TOKEN' --data '{"order_id":1250032,"points":[{"point_id":202685},{"point_id":202686, "is_cod_cash_voucher_required": true, "taking_amount": 500.00},{"point_id": 202687, "is_cod_cash_voucher_required": false, "taking_amount": 0.00}]}' 'https://robotapitest-in.borzodelivery.com/api/business/1.8/edit-order'
PHP
<?php
$curl = curl_init();
curl_setopt($curl, CURLOPT_URL, 'https://robotapitest-in.borzodelivery.com/api/business/1.8/edit-order');
curl_setopt($curl, CURLOPT_CUSTOMREQUEST, 'POST');
curl_setopt($curl, CURLOPT_HTTPHEADER, ['X-DV-Auth-Token: SECRET_AUTH_TOKEN']);
curl_setopt($curl, CURLOPT_RETURNTRANSFER, true);
$data = [
'order_id' => 1250032,
'points'   => [
[
'point_id' => 202685,
],
[
'point_id'                     => 202686,
'is_cod_cash_voucher_required' => true,
'taking_amount'                => 500.00,
],
[
'point_id'                     => 202687,
'is_cod_cash_voucher_required' => false,
'taking_amount'                => 0.00,
],
],
];
$json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
curl_setopt($curl, CURLOPT_POSTFIELDS, $json);
$result = curl_exec($curl);
if ($result === false) {
throw new Exception(curl_error($curl), curl_errno($curl));
}
echo $result;
{
"is_successful": true,
"order": {
"type": "standard",
"order_id": 1250032,
"order_name": "50032",
"vehicle_type_id": 8,
"created_datetime": "2026-10-27T20:19:39+05:30",
"finish_datetime": null,
"status": "available",
"status_description": "available",
"matter": "Flowers",
"total_weight_kg": 0,
"is_client_notification_enabled": false,
"is_contact_person_notification_enabled": false,
"loaders_count": 0,
"backpayment_details": null,
"points": [{
"point_id": 202685,
"delivery_id": null,
"client_order_id": null,
"address": "Saket, New Delhi, Delhi",
"latitude": "28.5235479",
"longitude": "77.2045073",
"required_start_datetime": "2026-10-27T20:49:39+05:30",
"required_finish_datetime": "2026-10-27T21:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"estimated_arrival_datetime": null,
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": "918880000001"
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [],
"is_cod_cash_voucher_required": false,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": null
}, {
"point_id": 202686,
"delivery_id": null,
"client_order_id": null,
"address": "Janakpuri, New Delhi, Delhi",
"latitude": "28.6210537",
"longitude": "77.0817532",
"required_start_datetime": "2026-10-27T21:49:39+05:30",
"required_finish_datetime": "2026-10-27T22:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"estimated_arrival_datetime": null,
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": "918880000001"
},
"taking_amount": "500.00",
"buyout_amount": "0.00",
"note": null,
"packages": [],
"is_cod_cash_voucher_required": true,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": {
"status": "planned"
}
}, {
"point_id": 202687,
"delivery_id": null,
"client_order_id": null,
"address": "Saket, New Delhi, Delhi",
"latitude": "28.5235479",
"longitude": "77.2045073",
"required_start_datetime": "2026-10-27T22:49:39+05:30",
"required_finish_datetime": "2026-10-27T23:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": "918880000001"
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [],
"is_cod_cash_voucher_required": false,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": {
"status": "planned"
}
}],
"payment_amount": "170.00",
"delivery_fee_amount": "170.00",
"weight_fee_amount": "0.00",
"insurance_amount": "0.00",
"insurance_fee_amount": "0.00",
"loading_fee_amount": "0.00",
"money_transfer_fee_amount": "0.00",
"backpayment_amount": "0.00",
"cod_fee_amount": "42.50",
"return_fee_amount": "0.00",
"waiting_fee_amount": "0.00",
"backpayment_photo_url": null,
"waybill_document_url": null,
"courier": null,
"is_motobox_required": false,
"payment_method": "cash",
"bank_card_id": null
}
}
Canceling an order
POST
https://robotapitest-in.borzodelivery.com/api/business/1.8/cancel-order
You may cancel an order in statuses:
new
,
available
,
active
or
delayed
(
Order statuses
). If a courier has visited any addresses, the order cannot be canceled.
Request parameters
Response parameters
Examples
Request parameters
order_id
integer
Required
Full order ID to cancel.
Response parameters
is_successful
boolean
Whether the request was successful or not.
order
object
Canceled order data.
Order parameters
order_id
integer
Full order ID.
type
string
Order type.
Order types
matter
string
Delivery contents.
order_name
string
Order name (short order ID).
vehicle_type_id
integer
Vehicle type.
Vehicle types
created_datetime
timestamp
Order creation date and time.
finish_datetime
timestamp
/
null
Order completion date and time.
status
string
Order status.
Order statuses
status_description
string
Order status description.
total_weight_kg
integer
Total weight in kilograms.
is_client_notification_enabled
boolean
Whether to send SMS notifications to the client.
is_contact_person_notification_enabled
boolean
Whether to send SMS notifications to recipients on addresses.
loaders_count
integer
Number of necessary loaders to move the delivered goods, including the driver.
points
list
List of addresses (points) for the courier to visit.
Point parameters
point_id
integer
Point ID.
delivery_id
integer
/
null
Delivery ID.
address
string
Street address.
contact_person
object
Contact person on the address.
Contact person parameters
phone
phone
Phone number of the person at the address.
name
string
/
null
Name of the person on the address.
client_order_id
string
/
null
Your eshop's order ID. It will be sent in notifications instead of our delivery order ID.
latitude
coordinate
Latitude of the location.
longitude
coordinate
Longitude of the location.
required_start_datetime
timestamp
/
null
How early the courier may arrive at the address.
required_finish_datetime
timestamp
/
null
How late the courier may arrive at the address.
arrival_start_datetime
timestamp
/
null
Estimated courier arrival time, upper bound.
arrival_finish_datetime
timestamp
/
null
Estimated courier arrival time, lower bound.
courier_visit_datetime
timestamp
/
null
Actual courier arrival time.
taking_amount
money
Backpayment sum to receive from the contact person at the address.
buyout_amount
money
Buyout sum the courier pays to the contact person at the address.
note
string
/
null
Additional information for the courier: office or appartment number, company name, whether any documents are required to enter the building.
packages
list
List of packages at the point.
Package parameters
order_package_id
integer
Package ID.
ware_code
string
Vendor code.
description
string
Description.
items_count
float
Amount.
item_payment_amount
string
Price per item.
nomenclature_code
string
Nomenclature code.
is_cod_cash_voucher_required
boolean
Whether to issue a cashier's check to the recipient at the address.
is_order_payment_here
boolean
Money will be paid to the courier at the address.
building_number
string
/
null
Building number.
entrance_number
string
/
null
Entrance number.
intercom_code
string
/
null
Intercom code.
floor_number
string
/
null
Floor number.
apartment_number
string
/
null
Apartment/office number.
invisible_mile_navigation_instructions
string
/
null
Instruction to courier how to get to recipient at the address.
place_photo_url
string
/
null
Place photo when closing a point at the address.
sign_photo_url
string
/
null
Recipients signature photo when closing a point at the address.
checkin_code
string
/
null
Courier's arrival pin code at the point.
checkin
object
/
null
Checkin information when closing a point at the address.
Checkin parameters
recipient_full_name
string
/
null
Full name of the recipient who met the courier.
recipient_position
string
/
null
Position of the recipient who met the courier.
is_return_point
boolean
Return point (same as first or hub).
tracking_url
string
/
null
Recipient's tracking link.
delivery
object
/
null
Delivery.
Delivery parameters
status
string
Delivery status.
payment_amount
money
/
null
Order price.
delivery_fee_amount
money
/
null
Delivery fee.
Part of order price (
payment_amount
).
weight_fee_amount
money
/
null
Large weight fee.
Part of order price (
payment_amount
).
insurance_amount
money
/
null
Insured amount.
insurance_fee_amount
money
/
null
Insurance fee.
Part of order price (
payment_amount
).
loading_fee_amount
money
/
null
Loading / heavy lifting fee.
Part of order price (
payment_amount
).
money_transfer_fee_amount
money
/
null
Money handling fee: backpayment transfer, buyout operations.
Part of order price (
payment_amount
).
cod_fee_amount
money
/
null
Extra fee for issuing a cashier's check.
Part of order price (
payment_amount
).
return_fee_amount
money
/
null
Extra fee for return to first point.
Part of order price (
payment_amount
).
waiting_fee_amount
money
/
null
Extra fee for paid waiting at designated points.
Part of order price (
payment_amount
).
backpayment_details
string
/
null
Details of the money transfer for backpayment. A credit card number or other payment system information.
backpayment_photo_url
string
/
null
URL of backpayment photo (receipt or other payment verification).
waybill_document_url
string
/
null
URL of waybill document.
courier
object
/
null
Courier parameters.
Courier parameters
courier_id
integer
Courier ID.
surname
string
Surname of the courier.
name
string
Name of the courier.
middlename
string
Middlename of the courier.
phone
phone
Phone of the courier.
photo_url
string
/
null
URL of the courier's photo.
latitude
coordinate
/
null
Latitude of the location.
Only for active orders, if the courier is on the way.
longitude
coordinate
/
null
Longitude of the location.
Only for active orders, if the courier is on the way.
is_motobox_required
boolean
Is motobox required.
is_thermobox_required
boolean
Is thermobox required.
payment_method
string
Payment method.
Payment methods
bank_card_id
integer
/
null
Bank card ID for bank_card payment method.
applied_promo_code
string
/
null
Applied promo code.
is_return_required
boolean
Order has return.
promo_code_discount_amount
money
Discount amount by promo code.
Part of order price (
payment_amount
).
Request example
CURL
curl --include --header 'X-DV-Auth-Token: SECRET_AUTH_TOKEN' --data '{"order_id":1250032}' 'https://robotapitest-in.borzodelivery.com/api/business/1.8/cancel-order'
HTTP/1.1 200 OK
Date: Tue, 27 Oct 2026 14:49:39 GMT
Content-Type: application/json; charset=utf-8
{
"is_successful": true,
"order": {
"type": "standard",
"order_id": 1250032,
"order_name": "50032",
"vehicle_type_id": 8,
"created_datetime": "2026-10-27T20:19:39+05:30",
"finish_datetime": null,
"status": "canceled",
"status_description": "Customer is not responding",
"matter": "Documents",
"total_weight_kg": 0,
"is_client_notification_enabled": false,
"is_contact_person_notification_enabled": false,
"loaders_count": 0,
"backpayment_details": null,
"points": [{
"point_id": 202685,
"delivery_id": null,
"client_order_id": null,
"address": "Saket, New Delhi, Delhi",
"latitude": "28.5235479",
"longitude": "77.2045073",
"required_start_datetime": "2026-10-27T20:49:39+05:30",
"required_finish_datetime": "2026-10-27T21:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"estimated_arrival_datetime": null,
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": "918880000001"
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [],
"is_cod_cash_voucher_required": false,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": null
}, {
"point_id": 202686,
"delivery_id": null,
"client_order_id": null,
"address": "Janakpuri, New Delhi, Delhi",
"latitude": "28.6210537",
"longitude": "77.0817532",
"required_start_datetime": "2026-10-27T21:49:39+05:30",
"required_finish_datetime": "2026-10-27T22:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"estimated_arrival_datetime": null,
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": "918880000001"
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [],
"is_cod_cash_voucher_required": false,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": {
"status": "planned"
}
}],
"payment_amount": "170.00",
"delivery_fee_amount": "170.00",
"weight_fee_amount": "0.00",
"insurance_amount": "0.00",
"insurance_fee_amount": "0.00",
"loading_fee_amount": "0.00",
"money_transfer_fee_amount": "0.00",
"promo_code_discount_amount": "40.00",
"backpayment_amount": "0.00",
"cod_fee_amount": "0.00",
"return_fee_amount": "0.00",
"waiting_fee_amount": "0.00",
"backpayment_photo_url": null,
"waybill_document_url": null,
"courier": null,
"is_motobox_required": false,
"payment_method": "cash",
"bank_card_id": null,
"applied_promo_code": "FIRST_ORDER",
"is_return_required": false
}
}
PHP
<?php
$curl = curl_init();
curl_setopt($curl, CURLOPT_URL, 'https://robotapitest-in.borzodelivery.com/api/business/1.8/cancel-order');
curl_setopt($curl, CURLOPT_CUSTOMREQUEST, 'POST');
curl_setopt($curl, CURLOPT_HTTPHEADER, ['X-DV-Auth-Token: SECRET_AUTH_TOKEN']);
curl_setopt($curl, CURLOPT_RETURNTRANSFER, true);
$data = [
'order_id' => 1250032,
];
$json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
curl_setopt($curl, CURLOPT_POSTFIELDS, $json);
$result = curl_exec($curl);
if ($result === false) {
throw new Exception(curl_error($curl), curl_errno($curl));
}
echo $result;
{
"is_successful": true,
"order": {
"type": "standard",
"order_id": 1250032,
"order_name": "50032",
"vehicle_type_id": 8,
"created_datetime": "2026-10-27T20:19:39+05:30",
"finish_datetime": null,
"status": "canceled",
"status_description": "Customer is not responding",
"matter": "Documents",
"total_weight_kg": 0,
"is_client_notification_enabled": false,
"is_contact_person_notification_enabled": false,
"loaders_count": 0,
"backpayment_details": null,
"points": [{
"point_id": 202685,
"delivery_id": null,
"client_order_id": null,
"address": "Saket, New Delhi, Delhi",
"latitude": "28.5235479",
"longitude": "77.2045073",
"required_start_datetime": "2026-10-27T20:49:39+05:30",
"required_finish_datetime": "2026-10-27T21:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"estimated_arrival_datetime": null,
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": "918880000001"
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [],
"is_cod_cash_voucher_required": false,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": null
}, {
"point_id": 202686,
"delivery_id": null,
"client_order_id": null,
"address": "Janakpuri, New Delhi, Delhi",
"latitude": "28.6210537",
"longitude": "77.0817532",
"required_start_datetime": "2026-10-27T21:49:39+05:30",
"required_finish_datetime": "2026-10-27T22:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"estimated_arrival_datetime": null,
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": "918880000001"
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [],
"is_cod_cash_voucher_required": false,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": {
"status": "planned"
}
}],
"payment_amount": "170.00",
"delivery_fee_amount": "170.00",
"weight_fee_amount": "0.00",
"insurance_amount": "0.00",
"insurance_fee_amount": "0.00",
"loading_fee_amount": "0.00",
"money_transfer_fee_amount": "0.00",
"promo_code_discount_amount": "40.00",
"backpayment_amount": "0.00",
"cod_fee_amount": "0.00",
"return_fee_amount": "0.00",
"waiting_fee_amount": "0.00",
"backpayment_photo_url": null,
"waybill_document_url": null,
"courier": null,
"is_motobox_required": false,
"payment_method": "cash",
"bank_card_id": null,
"applied_promo_code": "FIRST_ORDER",
"is_return_required": false
}
}
List of orders
GET
https://robotapitest-in.borzodelivery.com/api/business/1.8/orders
Use this API method to retrieve a list of your orders. The list is sorted by
order_id
, descending.
Request parameters
Response parameters
Examples
Request parameters
order_id
integer
/
list
Full order ID or order IDs list to search for.
Default value:
null
.
status
string
Order statuses to search for.
Default value:
null
.
Order statuses
offset
integer
Number of orders to skip for paginaton.
Default value:
0
.
count
integer
Maximum number of orders to be returned. Cannot be higher than 50.
Default value:
10
.
Response parameters
is_successful
boolean
Whether the request was successful or not.
orders
list
List of orders.
Order parameters
order_id
integer
Full order ID.
type
string
Order type.
Order types
matter
string
Delivery contents.
order_name
string
Order name (short order ID).
vehicle_type_id
integer
Vehicle type.
Vehicle types
created_datetime
timestamp
Order creation date and time.
finish_datetime
timestamp
/
null
Order completion date and time.
status
string
Order status.
Order statuses
status_description
string
Order status description.
total_weight_kg
integer
Total weight in kilograms.
is_client_notification_enabled
boolean
Whether to send SMS notifications to the client.
is_contact_person_notification_enabled
boolean
Whether to send SMS notifications to recipients on addresses.
loaders_count
integer
Number of necessary loaders to move the delivered goods, including the driver.
points
list
List of addresses (points) for the courier to visit.
Point parameters
point_id
integer
Point ID.
delivery_id
integer
/
null
Delivery ID.
address
string
Street address.
contact_person
object
Contact person on the address.
Contact person parameters
phone
phone
Phone number of the person at the address.
name
string
/
null
Name of the person on the address.
client_order_id
string
/
null
Your eshop's order ID. It will be sent in notifications instead of our delivery order ID.
latitude
coordinate
Latitude of the location.
longitude
coordinate
Longitude of the location.
required_start_datetime
timestamp
/
null
How early the courier may arrive at the address.
required_finish_datetime
timestamp
/
null
How late the courier may arrive at the address.
arrival_start_datetime
timestamp
/
null
Estimated courier arrival time, upper bound.
arrival_finish_datetime
timestamp
/
null
Estimated courier arrival time, lower bound.
courier_visit_datetime
timestamp
/
null
Actual courier arrival time.
taking_amount
money
Backpayment sum to receive from the contact person at the address.
buyout_amount
money
Buyout sum the courier pays to the contact person at the address.
note
string
/
null
Additional information for the courier: office or appartment number, company name, whether any documents are required to enter the building.
packages
list
List of packages at the point.
Package parameters
order_package_id
integer
Package ID.
ware_code
string
Vendor code.
description
string
Description.
items_count
float
Amount.
item_payment_amount
string
Price per item.
nomenclature_code
string
Nomenclature code.
is_cod_cash_voucher_required
boolean
Whether to issue a cashier's check to the recipient at the address.
is_order_payment_here
boolean
Money will be paid to the courier at the address.
building_number
string
/
null
Building number.
entrance_number
string
/
null
Entrance number.
intercom_code
string
/
null
Intercom code.
floor_number
string
/
null
Floor number.
apartment_number
string
/
null
Apartment/office number.
invisible_mile_navigation_instructions
string
/
null
Instruction to courier how to get to recipient at the address.
place_photo_url
string
/
null
Place photo when closing a point at the address.
sign_photo_url
string
/
null
Recipients signature photo when closing a point at the address.
checkin_code
string
/
null
Courier's arrival pin code at the point.
checkin
object
/
null
Checkin information when closing a point at the address.
Checkin parameters
recipient_full_name
string
/
null
Full name of the recipient who met the courier.
recipient_position
string
/
null
Position of the recipient who met the courier.
is_return_point
boolean
Return point (same as first or hub).
tracking_url
string
/
null
Recipient's tracking link.
delivery
object
/
null
Delivery.
Delivery parameters
status
string
Delivery status.
payment_amount
money
/
null
Order price.
delivery_fee_amount
money
/
null
Delivery fee.
Part of order price (
payment_amount
).
weight_fee_amount
money
/
null
Large weight fee.
Part of order price (
payment_amount
).
insurance_amount
money
/
null
Insured amount.
insurance_fee_amount
money
/
null
Insurance fee.
Part of order price (
payment_amount
).
loading_fee_amount
money
/
null
Loading / heavy lifting fee.
Part of order price (
payment_amount
).
money_transfer_fee_amount
money
/
null
Money handling fee: backpayment transfer, buyout operations.
Part of order price (
payment_amount
).
cod_fee_amount
money
/
null
Extra fee for issuing a cashier's check.
Part of order price (
payment_amount
).
return_fee_amount
money
/
null
Extra fee for return to first point.
Part of order price (
payment_amount
).
waiting_fee_amount
money
/
null
Extra fee for paid waiting at designated points.
Part of order price (
payment_amount
).
backpayment_details
string
/
null
Details of the money transfer for backpayment. A credit card number or other payment system information.
backpayment_photo_url
string
/
null
URL of backpayment photo (receipt or other payment verification).
waybill_document_url
string
/
null
URL of waybill document.
courier
object
/
null
Courier parameters.
Courier parameters
courier_id
integer
Courier ID.
surname
string
Surname of the courier.
name
string
Name of the courier.
middlename
string
Middlename of the courier.
phone
phone
Phone of the courier.
photo_url
string
/
null
URL of the courier's photo.
latitude
coordinate
/
null
Latitude of the location.
Only for active orders, if the courier is on the way.
longitude
coordinate
/
null
Longitude of the location.
Only for active orders, if the courier is on the way.
is_motobox_required
boolean
Is motobox required.
is_thermobox_required
boolean
Is thermobox required.
payment_method
string
Payment method.
Payment methods
bank_card_id
integer
/
null
Bank card ID for bank_card payment method.
applied_promo_code
string
/
null
Applied promo code.
is_return_required
boolean
Order has return.
promo_code_discount_amount
money
Discount amount by promo code.
Part of order price (
payment_amount
).
orders_count
integer
Total number of found orders for pagination.
Request example
CURL
curl --include --header 'X-DV-Auth-Token: SECRET_AUTH_TOKEN' 'https://robotapitest-in.borzodelivery.com/api/business/1.8/orders?status=available'
HTTP/1.1 200 OK
Date: Tue, 27 Oct 2026 14:49:39 GMT
Content-Type: application/json; charset=utf-8
{
"is_successful": true,
"orders": [{
"order_id": 1250032,
"order_name": "50032",
"vehicle_type_id": 8,
"created_datetime": "2026-10-27T20:19:39+05:30",
"finish_datetime": null,
"status": "available",
"status_description": "available",
"matter": "Flowers",
"total_weight_kg": 0,
"is_client_notification_enabled": false,
"is_contact_person_notification_enabled": false,
"loaders_count": 0,
"backpayment_details": null,
"points": [{
"point_id": 202685,
"delivery_id": null,
"client_order_id": null,
"address": "Saket, New Delhi, Delhi",
"latitude": "28.5235479",
"longitude": "77.2045073",
"required_start_datetime": "2026-10-27T20:49:39+05:30",
"required_finish_datetime": "2026-10-27T21:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"estimated_arrival_datetime": null,
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": "918880000001"
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [],
"is_cod_cash_voucher_required": false,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": null
}, {
"point_id": 202686,
"delivery_id": null,
"client_order_id": null,
"address": "Janakpuri, New Delhi, Delhi",
"latitude": "28.6210537",
"longitude": "77.0817532",
"required_start_datetime": "2026-10-27T21:49:39+05:30",
"required_finish_datetime": "2026-10-27T22:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"estimated_arrival_datetime": null,
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": "918880000001"
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [],
"is_cod_cash_voucher_required": false,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": {
"status": "planned"
}
}],
"payment_amount": "170.00",
"delivery_fee_amount": "170.00",
"weight_fee_amount": "0.00",
"insurance_amount": "0.00",
"insurance_fee_amount": "0.00",
"loading_fee_amount": "0.00",
"money_transfer_fee_amount": "0.00",
"promo_code_discount_amount": "40.00",
"backpayment_amount": "0.00",
"cod_fee_amount": "0.00",
"return_fee_amount": "0.00",
"waiting_fee_amount": "0.00",
"backpayment_photo_url": null,
"waybill_document_url": null,
"courier": null,
"is_motobox_required": false,
"payment_method": "cash",
"bank_card_id": null,
"applied_promo_code": "FIRST_ORDER",
"is_return_required": false
}, {
"order_id": 1250035,
"order_name": "50035",
"vehicle_type_id": 8,
"created_datetime": "2026-10-27T20:19:39+05:30",
"finish_datetime": null,
"status": "available",
"status_description": "available",
"matter": "Flowers",
"total_weight_kg": 0,
"is_client_notification_enabled": false,
"is_contact_person_notification_enabled": false,
"loaders_count": 0,
"backpayment_details": null,
"points": [{
"point_id": 202694,
"delivery_id": null,
"client_order_id": null,
"address": "Saket, New Delhi, Delhi",
"latitude": "28.5235479",
"longitude": "77.2045073",
"required_start_datetime": "2026-10-27T20:49:39+05:30",
"required_finish_datetime": "2026-10-27T21:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": "918880000001"
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [],
"is_cod_cash_voucher_required": false,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": null
}, {
"point_id": 202695,
"delivery_id": null,
"client_order_id": null,
"address": "Janakpuri, New Delhi, Delhi",
"latitude": "28.6210537",
"longitude": "77.0817532",
"required_start_datetime": "2026-10-27T21:49:39+05:30",
"required_finish_datetime": "2026-10-27T22:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": "918880000001"
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [],
"is_cod_cash_voucher_required": false,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": {
"status": "planned"
}
}],
"payment_amount": "170.00",
"delivery_fee_amount": "170.00",
"weight_fee_amount": "0.00",
"insurance_amount": "0.00",
"insurance_fee_amount": "0.00",
"loading_fee_amount": "0.00",
"money_transfer_fee_amount": "0.00",
"promo_code_discount_amount": "40.00",
"backpayment_amount": "0.00",
"cod_fee_amount": "0.00",
"return_fee_amount": "0.00",
"waiting_fee_amount": "0.00",
"backpayment_photo_url": null,
"waybill_document_url": null,
"courier": null,
"is_motobox_required": false,
"payment_method": "cash",
"bank_card_id": null,
"applied_promo_code": "FIRST_ORDER",
"is_return_required": false
}],
"orders_count": 2
}
PHP
<?php
$curl = curl_init();
curl_setopt($curl, CURLOPT_URL, 'https://robotapitest-in.borzodelivery.com/api/business/1.8/orders?status=available');
curl_setopt($curl, CURLOPT_HTTPHEADER, ['X-DV-Auth-Token: SECRET_AUTH_TOKEN']);
curl_setopt($curl, CURLOPT_RETURNTRANSFER, true);
$result = curl_exec($curl);
if ($result === false) {
throw new Exception(curl_error($curl), curl_errno($curl));
}
echo $result;
{
"is_successful": true,
"orders": [{
"order_id": 1250032,
"order_name": "50032",
"vehicle_type_id": 8,
"created_datetime": "2026-10-27T20:19:39+05:30",
"finish_datetime": null,
"status": "available",
"status_description": "available",
"matter": "Flowers",
"total_weight_kg": 0,
"is_client_notification_enabled": false,
"is_contact_person_notification_enabled": false,
"loaders_count": 0,
"backpayment_details": null,
"points": [{
"point_id": 202685,
"delivery_id": null,
"client_order_id": null,
"address": "Saket, New Delhi, Delhi",
"latitude": "28.5235479",
"longitude": "77.2045073",
"required_start_datetime": "2026-10-27T20:49:39+05:30",
"required_finish_datetime": "2026-10-27T21:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"estimated_arrival_datetime": null,
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": "918880000001"
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [],
"is_cod_cash_voucher_required": false,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": null
}, {
"point_id": 202686,
"delivery_id": null,
"client_order_id": null,
"address": "Janakpuri, New Delhi, Delhi",
"latitude": "28.6210537",
"longitude": "77.0817532",
"required_start_datetime": "2026-10-27T21:49:39+05:30",
"required_finish_datetime": "2026-10-27T22:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"estimated_arrival_datetime": null,
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": "918880000001"
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [],
"is_cod_cash_voucher_required": false,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": {
"status": "planned"
}
}],
"payment_amount": "170.00",
"delivery_fee_amount": "170.00",
"weight_fee_amount": "0.00",
"insurance_amount": "0.00",
"insurance_fee_amount": "0.00",
"loading_fee_amount": "0.00",
"money_transfer_fee_amount": "0.00",
"promo_code_discount_amount": "40.00",
"backpayment_amount": "0.00",
"cod_fee_amount": "0.00",
"return_fee_amount": "0.00",
"waiting_fee_amount": "0.00",
"backpayment_photo_url": null,
"waybill_document_url": null,
"courier": null,
"is_motobox_required": false,
"payment_method": "cash",
"bank_card_id": null,
"applied_promo_code": "FIRST_ORDER",
"is_return_required": false
}, {
"order_id": 1250035,
"order_name": "50035",
"vehicle_type_id": 8,
"created_datetime": "2026-10-27T20:19:39+05:30",
"finish_datetime": null,
"status": "available",
"status_description": "available",
"matter": "Flowers",
"total_weight_kg": 0,
"is_client_notification_enabled": false,
"is_contact_person_notification_enabled": false,
"loaders_count": 0,
"backpayment_details": null,
"points": [{
"point_id": 202694,
"delivery_id": null,
"client_order_id": null,
"address": "Saket, New Delhi, Delhi",
"latitude": "28.5235479",
"longitude": "77.2045073",
"required_start_datetime": "2026-10-27T20:49:39+05:30",
"required_finish_datetime": "2026-10-27T21:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"estimated_arrival_datetime": null,
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": "918880000001"
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [],
"is_cod_cash_voucher_required": false,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": null
}, {
"point_id": 202695,
"delivery_id": null,
"client_order_id": null,
"address": "Janakpuri, New Delhi, Delhi",
"latitude": "28.6210537",
"longitude": "77.0817532",
"required_start_datetime": "2026-10-27T21:49:39+05:30",
"required_finish_datetime": "2026-10-27T22:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"estimated_arrival_datetime": null,
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": "918880000001"
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [],
"is_cod_cash_voucher_required": false,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": {
"status": "planned"
}
}],
"payment_amount": "170.00",
"delivery_fee_amount": "170.00",
"weight_fee_amount": "0.00",
"insurance_amount": "0.00",
"insurance_fee_amount": "0.00",
"loading_fee_amount": "0.00",
"money_transfer_fee_amount": "0.00",
"promo_code_discount_amount": "40.00",
"backpayment_amount": "0.00",
"cod_fee_amount": "0.00",
"return_fee_amount": "0.00",
"waiting_fee_amount": "0.00",
"backpayment_photo_url": null,
"waybill_document_url": null,
"courier": null,
"is_motobox_required": false,
"payment_method": "cash",
"bank_card_id": null,
"applied_promo_code": "FIRST_ORDER",
"is_return_required": false
}],
"orders_count": 2
}
Courier info and courier location
GET
https://robotapitest-in.borzodelivery.com/api/business/1.8/courier
Use this API method to retrieve a courier info for your order.
If order has status
active
(
Order statuses
) and the courier is on the way, courier location will be returned.
Request parameters
Response parameters
Examples
Request parameters
order_id
integer
Required
Full order ID to search courier for.
Response parameters
is_successful
boolean
Whether the request was successful or not.
courier
object
/
null
Courier parameters.
Courier parameters
courier_id
integer
Courier ID.
surname
string
Surname of the courier.
name
string
Name of the courier.
middlename
string
Middlename of the courier.
phone
phone
Phone of the courier.
photo_url
string
/
null
URL of the courier's photo.
latitude
coordinate
/
null
Latitude of the location.
Only for active orders, if the courier is on the way.
longitude
coordinate
/
null
Longitude of the location.
Only for active orders, if the courier is on the way.
Request example
CURL
curl --include --header 'X-DV-Auth-Token: SECRET_AUTH_TOKEN' 'https://robotapitest-in.borzodelivery.com/api/business/1.8/courier?order_id=1250032'
HTTP/1.1 200 OK
Date: Tue, 27 Oct 2026 14:49:39 GMT
Content-Type: application/json; charset=utf-8
{
"is_successful": true,
"courier": {
"courier_id": 72384,
"surname": "Surname",
"name": "Name",
"middlename": null,
"phone": "918880000001",
"photo_url": null,
"latitude": "28.6210537",
"longitude": "77.0817532"
}
}
PHP
<?php
$curl = curl_init();
curl_setopt($curl, CURLOPT_URL, 'https://robotapitest-in.borzodelivery.com/api/business/1.8/courier?order_id=1250032');
curl_setopt($curl, CURLOPT_HTTPHEADER, ['X-DV-Auth-Token: SECRET_AUTH_TOKEN']);
curl_setopt($curl, CURLOPT_RETURNTRANSFER, true);
$result = curl_exec($curl);
if ($result === false) {
throw new Exception(curl_error($curl), curl_errno($curl));
}
echo $result;
{
"is_successful": true,
"courier": {
"courier_id": 72384,
"surname": "Surname",
"name": "Name",
"middlename": null,
"phone": "918880000001",
"photo_url": null,
"latitude": "28.6210537",
"longitude": "77.0817532"
}
}
Client profile info
GET
https://robotapitest-in.borzodelivery.com/api/business/1.8/client
Use this API method to retrieve a client info with allowed payment methods.
Response parameters
Examples
Response parameters
is_successful
boolean
Whether the request was successful or not.
client
object
Client parameters.
Client parameters
name
string
/
null
Full name.
phone
phone
/
null
Phone.
email
string
/
null
Email.
legal_type
string
Legal type.
allowed_payment_methods
list
Allowed payment methods.
Payment methods
Request example
CURL
curl --include --header 'X-DV-Auth-Token: SECRET_AUTH_TOKEN' 'https://robotapitest-in.borzodelivery.com/api/business/1.8/client'
HTTP/1.1 200 OK
Date: Tue, 27 Oct 2026 14:49:39 GMT
Content-Type: application/json; charset=utf-8
{
"is_successful": true,
"client": {
"name": "Name",
"phone": "918880000001",
"email": "
[email protected]
",
"legal_type": "individual_person",
"allowed_payment_methods": [
"cash",
"bank_card"
]
}
}
PHP
<?php
$curl = curl_init();
curl_setopt($curl, CURLOPT_URL, 'https://robotapitest-in.borzodelivery.com/api/business/1.8/client');
curl_setopt($curl, CURLOPT_HTTPHEADER, ['X-DV-Auth-Token: SECRET_AUTH_TOKEN']);
curl_setopt($curl, CURLOPT_RETURNTRANSFER, true);
$result = curl_exec($curl);
if ($result === false) {
throw new Exception(curl_error($curl), curl_errno($curl));
}
echo $result;
{
"is_successful": true,
"client": {
"name": "Name",
"phone": "918880000001",
"email": "
[email protected]
",
"legal_type": "individual_person",
"allowed_payment_methods": [
"cash",
"bank_card"
]
}
}
Available bank cards
GET
https://robotapitest-in.borzodelivery.com/api/business/1.8/bank-cards
Use this API method to retrieve available bank cards to use them in order creation.
Response parameters
Examples
Response parameters
is_successful
boolean
Whether the request was successful or not.
bank_cards
list
List of available bank cards
Bank card parameters
bank_card_id
integer
Bank card ID.
bank_card_number_mask
string
/
null
Masked bank card number.
expiration_date
string
/
null
Expiration date.
card_type
string
/
null
Card type.
Request example
CURL
curl --include --header 'X-DV-Auth-Token: SECRET_AUTH_TOKEN' 'https://robotapitest-in.borzodelivery.com/api/business/1.8/bank-cards'
HTTP/1.1 200 OK
Date: Tue, 27 Oct 2026 14:49:39 GMT
Content-Type: application/json; charset=utf-8
{
"is_successful": true,
"bank_cards": [
{
"bank_card_id": 80,
"bank_card_number_mask": "411111XXXXXX1111",
"expiration_date": "2029-01-31",
"card_type": "visa"
}
]
}
PHP
<?php
$curl = curl_init();
curl_setopt($curl, CURLOPT_URL, 'https://robotapitest-in.borzodelivery.com/api/business/1.8/bank-cards');
curl_setopt($curl, CURLOPT_HTTPHEADER, ['X-DV-Auth-Token: SECRET_AUTH_TOKEN']);
curl_setopt($curl, CURLOPT_RETURNTRANSFER, true);
$result = curl_exec($curl);
if ($result === false) {
throw new Exception(curl_error($curl), curl_errno($curl));
}
echo $result;
{
"is_successful": true,
"bank_cards": [
{
"bank_card_id": 80,
"bank_card_number_mask": "411111XXXXXX1111",
"expiration_date": "2029-01-31",
"card_type": "visa"
}
]
}
List of labels
GET
https://robotapitest-in.borzodelivery.com/api/business/1.8/labels
Use this API method to retrieve a list of labels for boxes in ZPL and PDF formats.
Request parameters
Response parameters
Examples
Request parameters
type
string
Label type.
Label types
order_id
integer
/
list
Order ID or order IDs list.
point_id
integer
/
list
Point ID or points IDs list.
delivery_id
integer
/
list
Delivery ID or deliveries IDs list.
Response parameters
is_successful
boolean
Whether the request was successful or not.
labels
list
Labels list.
Label parameters
Label in ZPL (Zebra) format.
type
string
Label type.
order_id
integer
Full order ID.
point_id
integer
Unique point ID.
delivery_id
integer
Unique delivery ID.
content
string
Label content.
Label in PDF format.
type
string
Label type.
order_id
integer
Full order ID.
point_id
integer
Unique point ID.
delivery_id
integer
Unique delivery ID.
content_base64
string
Base-64 encoded label content.
Request example
CURL
curl --include --header 'X-DV-Auth-Token: SECRET_AUTH_TOKEN' 'https://robotapitest-in.borzodelivery.com/api/business/1.8/labels?type=zpl&order_id[]=1250032&order_id[]=1250033'
HTTP/1.1 200 OK
Date: Tue, 27 Oct 2026 14:49:39 GMT
Content-Type: application/json; charset=utf-8
{
"is_successful": true,
"labels": [
{
"type": "zpl",
"order_id": 1250032,
"point_id": 2783321,
"delivery_id": null,
"content": "^XA\n\n^FO600,40^GFA,779,779,19,,3FC,7FE,:IF,:::::IF0FFCI03IFI0F..."
},
{
"type": "zpl",
"order_id": 1250032,
"point_id": 2783322,
"delivery_id": null,
"content": "^XA\n\n^FO600,40^GFA,779,779,19,,3FC,7FE,:IF,:::::IF0FFCI03IFI0F..."
},
{
"type": "zpl",
"order_id": 1250032,
"point_id": 2783323,
"delivery_id": null,
"content": "^XA\n\n^FO600,40^GFA,779,779,19,,3FC,7FE,:IF,:::::IF0FFCI03IFI0F..."
},
{
"type": "zpl",
"order_id": 1250033,
"point_id": 2783375,
"delivery_id": null,
"content": "^XA\n\n^FO600,40^GFA,779,779,19,,3FC,7FE,:IF,:::::IF0FFCI03IFI0F..."
},
{
"type": "zpl",
"order_id": 1250033,
"point_id": 2783376,
"delivery_id": null,
"content": "^XA\n\n^FO600,40^GFA,779,779,19,,3FC,7FE,:IF,:::::IF0FFCI03IFI0F..."
}
]
}
PHP
<?php
$curl = curl_init();
curl_setopt($curl, CURLOPT_URL, 'https://robotapitest-in.borzodelivery.com/api/business/1.8/labels?type=pdf&order_id[]=1250032&order_id[]=1250033');
curl_setopt($curl, CURLOPT_HTTPHEADER, ['X-DV-Auth-Token: SECRET_AUTH_TOKEN']);
curl_setopt($curl, CURLOPT_RETURNTRANSFER, true);
$result = curl_exec($curl);
if ($result === false) {
throw new Exception(curl_error($curl), curl_errno($curl));
}
echo $result;
{
"is_successful": true,
"labels": [
{
"type": "pdf",
"order_id": 1250032,
"point_id": 2783321,
"delivery_id": null,
"content_base64": "JVBERi0xLjQKMSAwIG9iago8PAovVGl0bGUgKP7/AGwAYQBiAGUAbAAuAHAAZABm..."
},
{
"type": "pdf",
"order_id": 1250032,
"point_id": 2783322,
"delivery_id": null,
"content_base64": "JVBERi0xLjQKMSAwIG9iago8PAovVGl0bGUgKP7/AGwAYQBiAGUAbAAuAHAAZABm..."
},
{
"type": "pdf",
"order_id": 1250032,
"point_id": 2783323,
"delivery_id": null,
"content_base64": "JVBERi0xLjQKMSAwIG9iago8PAovVGl0bGUgKP7/AGwAYQBiAGUAbAAuAHAAZABm..."
},
{
"type": "pdf",
"order_id": 1250033,
"point_id": 2783375,
"delivery_id": null,
"content_base64": "JVBERi0xLjQKMSAwIG9iago8PAovVGl0bGUgKP7/AGwAYQBiAGUAbAAuAHAAZABm..."
},
{
"type": "pdf",
"order_id": 1250033,
"point_id": 2783376,
"delivery_id": null,
"content_base64": "JVBERi0xLjQKMSAwIG9iago8PAovVGl0bGUgKP7/AGwAYQBiAGUAbAAuAHAAZABm..."
}
]
}
Orders & Deliveries
Order
is a general entity that contains all delivery points. You can track order statuses in your personal account or through requests.
Delivery
is the entity of a specific order point, only one. Deliveries are created automatically when order is created and have more detailed statuses.
Status model
Order statuses
new
Newly created order, waiting for verification from our dispatchers.
available
Order was verified and is available for couriers.
active
A courier was assigned and is working on the order.
completed
Order is completed.
reactivated
Order was reactivated and is again available for couriers.
draft
The order is a draft and will not be delivered as such. You can create an actual order out of the draft in your
Personal cabinet
.
canceled
Order was canceled.
delayed
Order execution was delayed by a dispatcher.
Delivery statuses
invalid
Invalid draft delivery
draft
Draft delivery
planned
Planned delivery (No courier assigned)
active
Delivery in process (Courier on the way)
finished
Delivery finished (Courier delivered the parcel)
canceled
Delivery canceled
delayed
Delivery delayed
courier_assigned
Courier assigned, but still not departed
courier_departed
Courier departed to the pick-up point
courier_at_pickup
Courier at the pick-up point
parcel_picked_up
Courier took parcel at the pick-up point
courier_arrived
Courier has arrived and is waiting for a customer
deleted
Delivery deleted
return_planned
Return planned
return_courier_assigned
Courier assigned to return delivery
return_courier_departed
Courier departed for return delivery
return_courier_picked_up
Courier picked up return delivery
return_finished
Delivery is returned
reattempt_planned
Reattempt planned
reattempt_courier_assigned
Courier assigned to reattempt delivery
reattempt_courier_departed
Courier departed for reattempt delivery
reattempt_courier_picked_up
Courier picked up reattempt delivery
reattempt_finished
Reattempt is finished (delivery finished)
Order types
standard
Standard delivery. The courier will be at the addresses at your convenience.
endofday
We will deliver the parcel within a day.
Vehicle types
1
— Mini 3-Wheeler (up to 100 kg).
Forbidden to use when placing a new order.
2
— Tata Ace 8ft truck (up to 1000 kg).
Forbidden to use when placing a new order.
3
— Tata Ace 7ft truck (up to 750 kg).
Forbidden to use when placing a new order.
5
— Tempo truck (up to 200 kg).
Forbidden to use when placing a new order.
8
— Motorbike (up to 20 kg).
Payment methods
cash
— Cash payment.
balance
— Payment from balance.
bank_card
— Payment from binded bank card.
Label types
zpl
Label in ZPL (Zebra) format.
pdf
Label in PDF format.
Notification about order changes
You may enter a Callback URL in your
Personal cabinet
and we will send notifications about order changes to that URL.
Data will be sent via HTTP method POST in JSON format and UTF-8 encoding.
If your URL responds with any HTTP status other than 2XX (OK), our server will treat it as an error. We will then retry to send the request with increasing intervals between attempts for 24 hours until we get HTTP status 2XX in response.
If a successful response was not received after 24 hours, we will stop retrying. In this case an email notification will be sent to your address.
Request parameters
X-DV-Signature
string
Signature of the request data. Use it to verify that the request actually came from our servers.
The signature will be sent as a HTTP header.
To verify the signature, calculate a HMAC hash using SHA256 and Callback Secret Key, which can be found in your
Personal cabinet
.
event_datetime
timestamp
Event date and time.
event_type
string
Event type:
order_created
- if order created,
order_changed
- if order params changed.
order
object
Order data.
Order parameters
order_id
integer
Full order ID.
type
string
Order type.
Order types
matter
string
Delivery contents.
order_name
string
Order name (short order ID).
vehicle_type_id
integer
Vehicle type.
Vehicle types
created_datetime
timestamp
Order creation date and time.
finish_datetime
timestamp
/
null
Order completion date and time.
status
string
Order status.
Order statuses
status_description
string
Order status description.
total_weight_kg
integer
Total weight in kilograms.
is_client_notification_enabled
boolean
Whether to send SMS notifications to the client.
is_contact_person_notification_enabled
boolean
Whether to send SMS notifications to recipients on addresses.
loaders_count
integer
Number of necessary loaders to move the delivered goods, including the driver.
points
list
List of addresses (points) for the courier to visit.
Point parameters
point_id
integer
Point ID.
delivery_id
integer
/
null
Delivery ID.
address
string
Street address.
contact_person
object
Contact person on the address.
Contact person parameters
phone
phone
Phone number of the person at the address.
name
string
/
null
Name of the person on the address.
client_order_id
string
/
null
Your eshop's order ID. It will be sent in notifications instead of our delivery order ID.
latitude
coordinate
Latitude of the location.
longitude
coordinate
Longitude of the location.
required_start_datetime
timestamp
/
null
How early the courier may arrive at the address.
required_finish_datetime
timestamp
/
null
How late the courier may arrive at the address.
arrival_start_datetime
timestamp
/
null
Estimated courier arrival time, upper bound.
arrival_finish_datetime
timestamp
/
null
Estimated courier arrival time, lower bound.
courier_visit_datetime
timestamp
/
null
Actual courier arrival time.
taking_amount
money
Backpayment sum to receive from the contact person at the address.
buyout_amount
money
Buyout sum the courier pays to the contact person at the address.
note
string
/
null
Additional information for the courier: office or appartment number, company name, whether any documents are required to enter the building.
packages
list
List of packages at the point.
Package parameters
order_package_id
integer
Package ID.
ware_code
string
Vendor code.
description
string
Description.
items_count
float
Amount.
item_payment_amount
string
Price per item.
nomenclature_code
string
Nomenclature code.
is_cod_cash_voucher_required
boolean
Whether to issue a cashier's check to the recipient at the address.
is_order_payment_here
boolean
Money will be paid to the courier at the address.
building_number
string
/
null
Building number.
entrance_number
string
/
null
Entrance number.
intercom_code
string
/
null
Intercom code.
floor_number
string
/
null
Floor number.
apartment_number
string
/
null
Apartment/office number.
invisible_mile_navigation_instructions
string
/
null
Instruction to courier how to get to recipient at the address.
place_photo_url
string
/
null
Place photo when closing a point at the address.
sign_photo_url
string
/
null
Recipients signature photo when closing a point at the address.
checkin_code
string
/
null
Courier's arrival pin code at the point.
checkin
object
/
null
Checkin information when closing a point at the address.
Checkin parameters
recipient_full_name
string
/
null
Full name of the recipient who met the courier.
recipient_position
string
/
null
Position of the recipient who met the courier.
is_return_point
boolean
Return point (same as first or hub).
tracking_url
string
/
null
Recipient's tracking link.
delivery
object
/
null
Delivery.
Delivery parameters
status
string
Delivery status.
payment_amount
money
/
null
Order price.
delivery_fee_amount
money
/
null
Delivery fee.
Part of order price (
payment_amount
).
weight_fee_amount
money
/
null
Large weight fee.
Part of order price (
payment_amount
).
insurance_amount
money
/
null
Insured amount.
insurance_fee_amount
money
/
null
Insurance fee.
Part of order price (
payment_amount
).
loading_fee_amount
money
/
null
Loading / heavy lifting fee.
Part of order price (
payment_amount
).
money_transfer_fee_amount
money
/
null
Money handling fee: backpayment transfer, buyout operations.
Part of order price (
payment_amount
).
cod_fee_amount
money
/
null
Extra fee for issuing a cashier's check.
Part of order price (
payment_amount
).
return_fee_amount
money
/
null
Extra fee for return to first point.
Part of order price (
payment_amount
).
waiting_fee_amount
money
/
null
Extra fee for paid waiting at designated points.
Part of order price (
payment_amount
).
backpayment_details
string
/
null
Details of the money transfer for backpayment. A credit card number or other payment system information.
backpayment_photo_url
string
/
null
URL of backpayment photo (receipt or other payment verification).
waybill_document_url
string
/
null
URL of waybill document.
courier
object
/
null
Courier parameters.
Courier parameters
courier_id
integer
Courier ID.
surname
string
Surname of the courier.
name
string
Name of the courier.
middlename
string
Middlename of the courier.
phone
phone
Phone of the courier.
photo_url
string
/
null
URL of the courier's photo.
latitude
coordinate
/
null
Latitude of the location.
Only for active orders, if the courier is on the way.
longitude
coordinate
/
null
Longitude of the location.
Only for active orders, if the courier is on the way.
is_motobox_required
boolean
Is motobox required.
is_thermobox_required
boolean
Is thermobox required.
payment_method
string
Payment method.
Payment methods
bank_card_id
integer
/
null
Bank card ID for bank_card payment method.
applied_promo_code
string
/
null
Applied promo code.
is_return_required
boolean
Order has return.
promo_code_discount_amount
money
Discount amount by promo code.
Part of order price (
payment_amount
).
Example of a callback handler
PHP
<?php
if (!isset($_SERVER['HTTP_X_DV_SIGNATURE'])) {
echo 'Error: Signature not found';
exit;
}
$data = file_get_contents('php://input');
$signature = hash_hmac('sha256', $data, 'CALLBACK_SECRET_KEY');
if ($signature != $_SERVER['HTTP_X_DV_SIGNATURE']) {
echo 'Error: Signature is not valid';
exit;
}
echo $data;
{
"event_datetime": "2026-10-27T20:19:39+05:30",
"event_type": "order_created",
"order": {
"type": "standard",
"order_id": 1250032,
"order_name": "50032",
"vehicle_type_id": 8,
"created_datetime": "2026-10-27T20:19:39+05:30",
"finish_datetime": null,
"status": "available",
"status_description": "available",
"matter": "Documents",
"total_weight_kg": 0,
"is_client_notification_enabled": false,
"is_contact_person_notification_enabled": false,
"loaders_count": 0,
"backpayment_details": null,
"points": [{
"point_id": 202685,
"delivery_id": null,
"client_order_id": null,
"address": "Saket, New Delhi, Delhi",
"latitude": "28.5235479",
"longitude": "77.2045073",
"required_start_datetime": "2026-10-27T20:49:39+05:30",
"required_finish_datetime": "2026-10-27T21:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": "918880000001"
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [],
"is_cod_cash_voucher_required": false,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": {
"recipient_full_name": "Anupam Pathak",
"recipient_position": null
},
"is_return_point": false,
"tracking_url": null,
"delivery": null
}, {
"point_id": 202686,
"delivery_id": null,
"client_order_id": null,
"address": "Janakpuri, New Delhi, Delhi",
"latitude": "28.6210537",
"longitude": "77.0817532",
"required_start_datetime": "2026-10-27T21:49:39+05:30",
"required_finish_datetime": "2026-10-27T22:19:39+05:30",
"arrival_start_datetime": null,
"arrival_finish_datetime": null,
"courier_visit_datetime": null,
"contact_person": {
"name": null,
"phone": "918880000001"
},
"taking_amount": "0.00",
"buyout_amount": "0.00",
"note": null,
"packages": [],
"is_cod_cash_voucher_required": false,
"is_order_payment_here": false,
"building_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"apartment_number": null,
"invisible_mile_navigation_instructions": null,
"place_photo_url": null,
"sign_photo_url": null,
"checkin_code": null,
"checkin": null,
"is_return_point": false,
"tracking_url": null,
"delivery": {
"status": "planned"
}
}],
"payment_amount": "170.00",
"delivery_fee_amount": "170.00",
"weight_fee_amount": "0.00",
"insurance_amount": "0.00",
"insurance_fee_amount": "0.00",
"loading_fee_amount": "0.00",
"money_transfer_fee_amount": "0.00",
"promo_code_discount_amount": "40.00",
"backpayment_amount": "0.00",
"cod_fee_amount": "0.00",
"return_fee_amount": "0.00",
"waiting_fee_amount": "0.00",
"backpayment_photo_url": null,
"waybill_document_url": null,
"courier": null,
"is_motobox_required": false,
"payment_method": "cash",
"bank_card_id": null,
"applied_promo_code": "FIRST_ORDER",
"is_return_required": false
}
}
Notification about delivery changes
You may enter a Callback URL and enable delivery callback in your
Personal cabinet
and we will send notifications about delivery changes to that URL.
Data will be sent via HTTP method POST in JSON format and UTF-8 encoding.
If your URL responds with any HTTP status other than 2XX (OK), our server will treat it as an error. We will then retry to send the request with increasing intervals between attempts for 24 hours until we get HTTP status 2XX in response.
If a successful response was not received after 24 hours, we will stop retrying. In this case an email notification will be sent to your address.
Request parameters
X-DV-Signature
string
Signature of the request data. Use it to verify that the request actually came from our servers.
The signature will be sent as a HTTP header.
To verify the signature, calculate a HMAC hash using SHA256 and Callback Secret Key, which can be found in your
Personal cabinet
.
event_datetime
timestamp
Event date and time.
event_type
string
Event type:
delivery_created
- if delivery created,
delivery_changed
- if delivery params changed.
delivery
object
Delivery data.
Delivery parameters
delivery_id
integer
Unique delivery ID.
delivery_type
string
Delivery type (for now its only
plain
supported).
order_id
integer
/
null
Full order ID (for draft delivery it always
null
).
client_id
integer
Client ID.
client_order_id
string
/
null
Your eshop's order ID
address
string
Street address.
latitude
coordinate
/
null
Delivery point coordinates (latitude).
longitude
coordinate
/
null
Delivery point coordinates (longitude).
status
string
Delivery status.
Delivery statuses
status_description
string
Delivery status description.
status_datetime
timestamp
Delivery status change date and time.
created_datetime
timestamp
Delivery creation date and time.
order_name
string
/
null
Order name (short order ID).
order_payment_amount
money
/
null
Full order price.
delivery_price_amount
money
/
null
Average delivery price (we calculate price only for order).
point_id
integer
/
null
Point ID.
contact_person
object
Contact person on the address.
Contact person parameters
phone
phone
/
null
Phone number of the person at the address.
name
string
/
null
Name of the person on the address.
note
string
/
null
Additional information for the courier: office or appartment number, company name, whether any documents are required to enter the building.
building_number
string
/
null
Building number.
apartment_number
string
/
null
Apartment/office number.
entrance_number
string
/
null
Entrance number.
intercom_code
string
/
null
Intercom code.
floor_number
string
/
null
Floor number.
invisible_mile_navigation_instructions
string
/
null
Instruction to courier how to get to recipient at the address.
required_start_datetime
timestamp
How early the courier may arrive at the address.
required_finish_datetime
timestamp
How late the courier may arrive at the address.
taking_amount
money
Backpayment sum to receive from the contact person at the address.
buyout_amount
money
Buyout sum the courier pays to the contact person at the address.
is_cod_cash_voucher_required
boolean
Whether to issue a cashier's check to the recipient at the address.
is_motobox_required
boolean
Is motobox required (only for draft).
is_thermobox_required
boolean
Is thermobox required (only for draft).
is_return_to_first_point_required
boolean
Is return to pick-up point required (only for draft).
matter
string
/
null
Delivery contents (only for draft).
insurance_amount
money
Insured amount (only for draft).
weight_kg
integer
Weight, in kilograms (only for draft).
checkin_issue_name
string
/
null
Checkin issue name.
tracking_url
string
/
null
Recipient's tracking link
pickup_checkin_code
string
/
null
Courier's arrival pin code at the pickup point.
checkin_code
string
/
null
Courier's arrival pin code at the point.
courier
object
/
null
Courier parameters.
Courier parameters
courier_id
integer
Courier ID.
surname
string
Surname of the courier.
name
string
Name of the courier.
middlename
string
Middlename of the courier.
phone
phone
Phone of the courier.
photo_url
string
/
null
URL of the courier's photo.
latitude
coordinate
/
null
Latitude of the location.
Only for active orders, if the courier is on the way.
longitude
coordinate
/
null
Longitude of the location.
Only for active orders, if the courier is on the way.
packages
list
List of packages at the delivery point.
Package parameters
delivery_package_id
integer
/
null
response.common.params.delivery.packages.order_package_id
ware_code
string
Vendor code.
description
string
/
null
Description.
items_count_units
string
Unit of measurement (pieces, kilograms).
items_count
float
Amount.
item_payment_amount
money
Price per item.
Example of a callback handler
PHP
<?php
if (!isset($_SERVER['HTTP_X_DV_SIGNATURE'])) {
echo 'Error: Signature not found';
exit;
}
$data = file_get_contents('php://input');
$signature = hash_hmac('sha256', $data, 'CALLBACK_SECRET_KEY');
if ($signature != $_SERVER['HTTP_X_DV_SIGNATURE']) {
echo 'Error: Signature is not valid';
exit;
}
echo $data;
{
"event_datetime": "2026-10-27T20:19:39+05:30",
"event_type": "delivery_created",
"delivery": {
"delivery_id": 11712,
"delivery_type": "plain",
"order_id": 1250032,
"client_id": 180198,
"client_order_id": null,
"address": "Janakpuri, New Delhi, Delhi",
"latitude": null,
"longitude": null,
"status": "active",
"status_description": "active",
"status_datetime": "2026-10-27T20:19:39+05:30",
"created_datetime": "2026-10-27T20:19:39+05:30",
"order_name": "50032",
"order_payment_amount": "170.00",
"delivery_price_amount": "170.00",
"point_id": 203902,
"contact_person": {
"name": null,
"phone": "918880000001"
},
"note": null,
"building_number": null,
"apartment_number": null,
"entrance_number": null,
"intercom_code": null,
"floor_number": null,
"invisible_mile_navigation_instructions": null,
"required_start_datetime": "2026-10-27T20:49:39+05:30",
"required_finish_datetime": "2026-10-27T21:19:39+05:30",
"taking_amount": "0.00",
"buyout_amount": "0.00",
"is_cod_cash_voucher_required": false,
"is_motobox_required": false,
"is_return_to_first_point_required": false,
"matter": null,
"insurance_amount": "0.00",
"weight_kg": 0,
"packages": [],
"checkin_issue_name": null,
"tracking_url": null
}
}
Use cases
How to place an order
The creation scheme for the standard order type consists of 2 stages:
Delivery cost calculation and displaying the result to the user.
To do this, use the
/calculate-order
method with the same data that will be used when creating the order. At this stage, only recipient's contact data could be missed(data within the fields of the
contact_person
object) and will not affect the calculation result. The shipping cost will be returned in the
payment_amount
field.
The resulting errors will be shown in the
warnings
block, but the price will be returned even if there are critical errors.
Placing an order for delivery.
To create an order, use the
/create-order
method, specifying the data in all parameters designated as mandatory. Please note that in the list of
points
it is impossible to pass less than 2 points, since the first point must be the pick-up point.
At this stage, all errors are critical and prevent the creation of an order. The list of errors is returned in the
errors
block. After successfully placing an order, it will be displayed in your personal Borzo account.
How to place an endofday order
To create a endofday order please follow the steps below:
Delivery cost calculation and displaying the result to the user.
To do this, use the
/calculate-order
method, similar to the standard scheme. EndOfDay order can only have 2 points. It is also necessary to pass the
type
parameter with the endofday value. Please note that in this case the
required_start_datetime
and
required_finish_datetime
parameters at the points are not allowed.
The shipping cost will be returned in the
payment_amount
field.
The resulting errors will be shown in the
warnings
block, but the price will be returned even if there are critical errors.
Placing an order for delivery.
Use the
/create-order
method to create a endofday order and specify the data in all mandatory parameters. Any errors when creating an order are critical and prevent its placement. The list of errors is returned in the
errors
block.
After successfully placing an order, you will be able to see it in your personal Borzo account.
How to track order/delivery
There are two options for tracking order/delivery changes. Automatic via callbacks and manual via request.
Automatic method
We have different callbacks for deliveries and orders for more detailed tracking and completeness of information. In case of any changes in these entities, the system automatically sends callbacks with the necessary information to the Callback URL specified in the personal account on the "Integration" tab. The callback token that is used to calculate signatures is also the same for both types of callbacks. However, the format of
callbacks on orders
and
delivery callbacks
varies, which is important to consider when receiving information via this method. If it is impossible to deliver a callback to the specified URL (HTTP code 4xx-5xx), then callbacks are re-sent at an increasing interval until a positive response is received (HTTP code 2xx), or until 24 hours have passed from the first failed attempt.
Manual method
Manual method allows you to get updated information anytime upon request. You can find detailed description about sending status request on
orders
and on
deliveries
.
Cash on delivery (COD) service
To enable COD feature, you should pass the following parameters during order placement:
is_cod_cash_voucher_required
. Belongs to delivery points. Should be set as true to enable the option.
taking_amount
. Belongs to delivery points. Cash amount that should be taken from customers should be passed in this parameter.
Example of order with COD option creation:
curl --include --header 'X-DV-Auth-Token: SECRET_AUTH_TOKEN' --data '{"matter":"Documents","points":[{"address":"Saket, New Delhi, Delhi","contact_person":{"phone":"918880000001"}},{"address":"Janakpuri, New Delhi, Delhi","is_cod_cash_voucher_required":true,"taking_amount":100.00,"contact_person":{"phone":"918880000001"}}]}' 'https://robotapitest-in.borzodelivery.com/api/business/1.8/create-order'
Error codes
Request error codes
unexpected_error
Unexpected error. Please let us know at
[email protected]
.
invalid_api_version
Unknown API version. Available versions are 1.0, 1.1 and 1.2.
required_api_upgrade
Requested API version was discontinued. You should use the latest version instead.
requests_limit_exceeded
You have reached an API usage limit.
Limits are: 100 requests per minute, 5 000 requests per 24 hours.
required_auth_token
X-DV-Auth-Token
header is missing from the request.
invalid_auth_token
X-DV-Auth-Token
you are sending is invalid.
required_method_get
HTTP method GET is required.
required_method_post
HTTP method POST is required.
invalid_post_json
POST request body must be in JSON format.
invalid_parameters
Request parameters contain errors. Look at
parameter_errors
response field for details.
Parameter error codes
unapproved_contract
Your agreement is not approved yet (for legal entities).
service_unavailable
Our service is temporarily unavailable. Please try again later.
invalid_api_method
Unknown API method was requested.
buyout_not_allowed
You do not have access to buyout feature.
insufficient_balance_for_buyout
You do not have enough money for buyout.
order_cannot_be_edited
Order cannot be edited.
order_cannot_be_canceled
Order cannot be canceled.
insufficient_balance
Your balance is too low (for legal entities).
buyout_amount_limit_exceeded
Total buyout amount in your active orders is too large. You do not have sufficient balance / credit limit to place the new order.
route_not_found
Route not found.
total_payment_amount_limit_exceeded
Exceeded maximum order price.
order_is_duplicate
Duplicate order rejected
insufficient_funds
Insufficient funds on your bank card
card_payment_failed
Bank card payment failed
impossible_delivery_fee_calculation
Can't calculate delivery price. Please let tech support know at
[email protected]
.
tax_retension_limit
The order must be paid by balance
Request example
CURL
curl --include --header 'X-DV-Auth-Token: SECRET_AUTH_TOKEN' 'https://robotapitest-in.borzodelivery.com/api/business/1.8/unknown'
HTTP/1.1 400 Bad Request
Date: Tue, 27 Oct 2026 14:49:39 GMT
Content-Type: application/json; charset=utf-8
{
"is_successful": false,
"errors": ["invalid_api_method"],
"parameter_errors": null
}
Parameter error codes
required
Required parameter was not provided.
unknown
Unknown parameter was encountered.
invalid_list
Invalid JSON list.
invalid_object
Invalid JSON object.
invalid_boolean
Invalid boolean.
invalid_date
Invalid date or time.
invalid_date_format
Invalid date and time format.
invalid_float
Invalid floating point number.
invalid_integer
Invalid integer number.
invalid_string
Invalid string.
invalid_order
Order ID was not found.
invalid_point
Point ID was not found.
invalid_order_status
Invalid order status.
invalid_vehicle_type
Invalid vehicle type.
invalid_phone
Invalid phone number.
invalid_region
Address is out of the delivery area for the region.
invalid_order_package
Package was not found.
invalid_delivery_id
Delivery ID was not found.
invalid_delivery_package
Package ID for delivery was not found.
invalid_delivery_status
Invalid delivery status.
invalid_bank_card
Bank card ID was not found.
invalid_url
Invalid url.
invalid_enum_value
Invalid enum value.
invalid_postal_code
Invalid enum value.
invalid_delivery_interval
Invalid postal code.
different_regions
Addresses from different regions are not allowed.
address_not_found
Address geocoding failed. Check your address with
Google Maps
service.
min_length
String value is too short.
max_length
String value is too long.
min_date
Date and time is older than possible.
max_date
Date and time is later than possible.
min_size
List size is too small.
max_size
List size is too large.
min_value
Value is too small.
max_value
Value is too large.
cannot_be_past
Date and time cannot be in the past.
start_after_end
Incorrect time interval. Start time should be earlier than the end.
earlier_than_previous_point
Incorrect time interval. Time cannot be earlier than previous point time.
coordinates_out_of_bounds
Point coordinates are outside acceptable delivery areas.
not_editable
Parameter value is not allowed to edit..
not_nullable
Parameter value can not be null.
not_allowed
Parameter value is not allowed.
order_payment_only_one_point
Order payment can be specified only for one point.
cod_agreement_required
COD agreement required.
cod_is_not_allowed_with_buyout
COD is not allowed with buyout.
sameday_pickup_interval_too_short
Same day pickup interval is too short.
invalid_value
Invalid promo code.
promo_code_already_used
Promo code has already been used.
promo_code_not_available
Promo code not available for selected address.
Request example
CURL
curl --include --header 'X-DV-Auth-Token: SECRET_AUTH_TOKEN' --data '{"points":[{"address":"Saket, New Delhi, Delhi","contact_person":{"phone":"918880000001"}},{}]}' 'https://robotapitest-in.borzodelivery.com/api/business/1.8/create-order'
HTTP/1.1 400 Bad Request
Date: Tue, 27 Oct 2026 14:49:39 GMT
Content-Type: application/json; charset=utf-8
{
"is_successful": false,
"errors": ["invalid_parameters"],
"parameter_errors": {
"matter": ["required"],
"points": [
null,
{
"address": ["required"],
"contact_person": {
"phone": ["required"]
}
}
]
}
}
Changelog
Version 1.0
23.11.2017
New error codes:
route_not_found
,
invalid_region
,
different_regions
.
31.05.2018
Allowed to send order IDs list for
orders
API method.
20.07.2018
New API method
courier
to get courier info.
23.10.2018
New error code
earlier_than_previous_point
.
Version 1.1
18.04.2019
Field
receipt_document_url
is always null.
Field
receipt_document_url
is no longer available in order info.
29.11.2019
New error codes:
coordinates_out_of_bounds
,
total_payment_amount_limit_exceeded
.
14.01.2020
Added new field to order parameters:
is_motobox_required
.
11.03.2020
Added methods to manage deliveries:
Create draft deliveries
,
Edit draft deliveries
,
Delete draft deliveries
,
List of deliveries
.
Added callbacks to deliveries (
Notification about delivery changes
).
New error codes:
invalid_delivery_id
,
invalid_delivery_package
,
invalid_delivery_status
08.07.2020
Added methods to pay with bank card (for some countries):
Available bank cards
,
Client profile info
(helps get allowed payment methods)
Added
payment_method
parameter (
Placing an order
).
New error codes:
invalid_bank_card
,
insufficient_funds
,
card_payment_failed
22.09.2020
Added ability to create order from draft deliveries (see example 3):
Placing an order
Added method to calculate routes from draft deliveries:
Make routes from deliveries
18.05.2021
Added
type
parameter (
Order types
).
Added method to get delivery intervals for «Same day» orders:
List of delivery intervals
New error codes:
invalid_delivery_interval
,
sameday_pickup_interval_too_short
.
01.10.2021
New error code
insufficient_balance_for_buyout
19.10.2021
Added the ability to create a COD orders without detailing by goods
10.01.2022
Added
promo_code
parameter to order calculation and creation requests.
Added
applied_promo_code
,
promo_code_discount_amount
fields to order calculation and creation responses.
Added new error codes:
invalid_value
;
promo_code_already_used
;
promo_code_not_available
.
24.01.2022
Point's parameter
is_door_to_door
is set to true by default (
Create draft deliveries
)
20.04.2022
Added method to retrieve a list of labels for boxes:
List of labels
01.06.2022
Allow to create order with return.
Send flag
is_return_required
in order creation payload.
Version 1.2
02.06.2022
Removed obsolete order parameters
suburban_delivery_fee_amount
and
discount_amount
.
01.11.2022
New parameters
latitude
and
longitude
were added into
Create draft deliveries
,
Edit draft deliveries
methods.
09.01.2023
The notification about delivery changes no longer contains the
pickup_point
and
dropoff_point
fields.
Version 1.3
27.01.2023
Added new statuses to delivery:
courier_at_pickup
;
return_planned
;
return_courier_assigned
;
return_courier_departed
;
return_courier_picked_up
;
reattempt_planned
;
reattempt_courier_assigned
;
reattempt_courier_departed
;
reattempt_courier_picked_up
;
reattempt_finished
;
Removed delivery status
return_active
.
13.10.2023
Added new order parameters:
return_fee_amount
and
waiting_fee_amount
Version 1.4
21.03.2023
Order payment method has been renamed from
non_cash
to
balance
. The renaming affected the input and output parameters of the following methods
Order price calculation
,
Placing an order
and
Order editing
, output parameters of the following methods
Client profile info
,
Canceling an order
and
List of orders
, as well as the order model in
order_created
and
order_changed
event callbacks.
21.03.2023
Added a new type of order named hyperlocal. The corresponding
type
parameter new value is accepted by the methods
Order price calculation
and
Placing an order
.
Version 1.5
10.04.2024
Parameter
overnight_fee_amount
removed from
order
section.
Version 1.6
28.05.2024
Parameters below became nullable in
order
section:
payment_amount
;
delivery_fee_amount
;
weight_fee_amount
;
insurance_fee_amount
;
loading_fee_amount
;
money_transfer_fee_amount
;
promo_code_discount_amount
;
cod_fee_amount
;
return_fee_amount
;
waiting_fee_amount
;
14.01.2020
Added new field to order parameters:
is_thermobox_required
.
05.06.2025
Added new field
return_point
to order parameters.
Added new field
checkin_code
to point parameters.
Added new fields
pickup_checkin_code
and
checkin_code
to delivery model.
Version 1.8
04.06.2026
Added a new type of order named
vip_delivery
. The corresponding
type
parameter new value is accepted by the methods
Order price calculation
and
Placing an order
. For orders of the
vip_delivery
type, it is forbidden to fill in
required_start_datetime
and
required_finish_datetime
fields for points
