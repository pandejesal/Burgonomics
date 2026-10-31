# Official Shadowfax hyperlocal marketplace callbacks guide

Source: https://developer.shadowfax.in/docs/hyperlocal/marketplace/callbacks
Retrieved UTC: 2026-10-29T11:22:21.092122+00:00
Retrieval method: static

Public webpage text snapshot for local development reference. Not an API conformance or vendor-approval verdict; copyright remains with the publisher. Scripts/styles were not retained or executed.

---

Copy page
Hyperlocal
Callbacks
Shadowfax sends HTTP callbacks to your configured URL when order status changes or rider location updates. Share your callback URL and optional custom headers with the Shadowfax team.
Use this Postman collection to set up and test callbacks:
Callback Sandbox Collection
Callback Behavior
Aspect
Detail
Method
POST
or
PUT
(as configured)
Content-Type
application/json
Timestamps
UTC, format
YYYY-MM-DDTHH:MM:SS.fZ
Expected response
200
or
201
Retry on failure
5-minute intervals, up to 7 attempts
Idempotency
Required
— duplicate callbacks must return success
If your callback endpoint is not idempotent, subsequent status updates may be blocked.
Order Status Callbacks
ALLOTTED
Code
{
"pick_to_drop_distance"
:
2.64
,
"order_status"
:
"ALLOTTED"
,
"sfx_order_id"
:
21030620
,
"rider_name"
:
"Aastha Jain"
,
"rider_contact"
:
"8750879029"
,
"rider_id"
:
2052
,
"rider_latitude"
:
28.588837
,
"rider_longitude"
:
77.063762
,
"pickup_eta"
:
7
,
"drop_eta"
:
null
,
"rider_cod_limit"
:
0
,
"client_order_id"
:
"SHX9004400"
,
"allot_time"
:
"2026-01-30T05:49:06.000000Z"
,
"track_url"
:
"https://order-tracking-hl.staging.shadowfax.in/track/73B614A0215C770722F06B0095F9C503"
,
"rain_mode_flag"
:
false
,
"rain_surge_amount"
:
0
,
"rain_impacted"
:
false
}
ARRIVED
Rider has arrived at the pickup location. This status is callback-only — it may not appear in the Get Order Details pull API response.
Code
{
"pick_to_drop_distance"
:
2.64
,
"order_status"
:
"ARRIVED"
,
"sfx_order_id"
:
21030620
,
"rider_name"
:
"Aastha Jain"
,
"rider_contact"
:
"8750879029"
,
"rider_id"
:
2052
,
"rider_latitude"
:
28.588837
,
"rider_longitude"
:
77.063762
,
"pickup_eta"
:
7
,
"drop_eta"
:
null
,
"rider_cod_limit"
:
0
,
"client_order_id"
:
"SHX9004400"
,
"arrival_time"
:
"2026-01-30T05:56:25.439709Z"
,
"track_url"
:
"https://order-tracking-hl.staging.shadowfax.in/track/73B614A0215C770722F06B0095F9C503"
,
"rain_mode_flag"
:
false
,
"rain_surge_amount"
:
0
,
"rain_impacted"
:
false
}
DISPATCHED
Code
{
"pick_to_drop_distance"
:
0.92
,
"order_status"
:
"DISPATCHED"
,
"sfx_order_id"
:
21043942
,
"rider_name"
:
"Shashank Arya"
,
"rider_contact"
:
"7992362908"
,
"rider_id"
:
139468
,
"rider_latitude"
:
12.937847
,
"rider_longitude"
:
77.624494
,
"pickup_eta"
:
null
,
"drop_eta"
:
46
,
"rider_cod_limit"
:
0
,
"client_order_id"
:
"order_111288"
,
"track"
:
"https://api.shadowfax.in/track/0E53743151A1521DAA9844289AB65CA2/"
,
"dispatch_time"
:
"2026-06-23T11:02:30.000000Z"
,
"track_url"
:
"https://order-tracking-hl.staging.shadowfax.in/track/0E53743151A1521DAA9844289AB65CA2"
,
"rain_mode_flag"
:
false
,
"rain_surge_amount"
:
0
,
"rain_impacted"
:
false
}
Note:
pickup_eta
is
null
after dispatch. Both
track
and
track_url
may be present.
ARRIVED_CUSTOMER_DOORSTEP
Rider has arrived at the customer doorstep. This status is callback-only — it may not appear in the Get Order Details pull API response.
Code
{
"pick_to_drop_distance"
:
2.64
,
"order_status"
:
"ARRIVED_CUSTOMER_DOORSTEP"
,
"sfx_order_id"
:
21030620
,
"rider_name"
:
"Aastha Jain"
,
"rider_contact"
:
"8750879029"
,
"rider_id"
:
2052
,
"rider_latitude"
:
35.595864
,
"rider_longitude"
:
77.665334
,
"pickup_eta"
:
null
,
"drop_eta"
:
4648
,
"rider_cod_limit"
:
0
,
"client_order_id"
:
"SHX9004400"
,
"customer_doorstep_arrival_time"
:
"2026-01-30T06:04:39.340151Z"
,
"track_url"
:
"https://order-tracking-hl.staging.shadowfax.in/track/73B614A0215C770722F06B0095F9C503"
,
"rain_mode_flag"
:
false
,
"rain_surge_amount"
:
0
,
"rain_impacted"
:
false
}
DELIVERED
Code
{
"pick_to_drop_distance"
:
0.92
,
"order_status"
:
"DELIVERED"
,
"sfx_order_id"
:
21043942
,
"rider_name"
:
"Shashank Arya"
,
"rider_contact"
:
"7992362908"
,
"rider_id"
:
139468
,
"rider_latitude"
:
12.935879
,
"rider_longitude"
:
77.624556
,
"pickup_eta"
:
null
,
"drop_eta"
:
null
,
"rider_cod_limit"
:
0
,
"client_order_id"
:
"order_111288"
,
"returns"
: {},
"return_skus"
: [],
"delivery_time"
:
"2026-06-23T11:29:15.000000Z"
,
"drop_image_url"
:
null
,
"rain_mode_flag"
:
false
,
"rain_surge_amount"
:
0
,
"rain_impacted"
:
false
}
CANCELLED
Triggered when cancellation occurs before rider pickup.
cancel_reason
cancel_reason_text
0
Cancelled by Customer
1
Rider Not Available or is Late
2
Customer Not Available
3
Duplicate Order
4
Delivery Address Unserviceable or Incorrect
5
Operational Issue with order
6
Cancelled by Seller
7
Rider not having enough cash for purchase
15
Delivered by seller
16
Item not available
17
Incorrect seller location
19
Customer Not responding / Phone switched off
20
Placed order by mistake
21
Order item is not read
22
Got faster option from other provider
23
Expected a shorter wait time
24
Delivery partner refused pickup
Code
{
"pick_to_drop_distance"
:
0.1
,
"order_status"
:
"CANCELLED"
,
"sfx_order_id"
:
21043979
,
"rider_name"
:
"Shadowfax"
,
"rider_contact"
:
""
,
"rider_id"
:
1
,
"rider_latitude"
:
null
,
"rider_longitude"
:
null
,
"pickup_eta"
:
null
,
"drop_eta"
:
null
,
"rider_cod_limit"
:
0
,
"client_order_id"
:
"bvs_00_MarketplaceOrder_52218866"
,
"cancel_reason"
:
5
,
"cancel_reason_text"
:
"Operational Issue with order"
,
"cancel_time"
:
"2026-06-23T12:45:01.492176Z"
,
"rain_mode_flag"
:
false
,
"rain_surge_amount"
:
0
,
"rain_impacted"
:
false
}
CANCELLED_BY_CUSTOMER
Triggered post-pickup when the rider reaches the customer doorstep but cannot complete delivery.
Reason Code
Reason text
0
Cancelled by Customer
1
Rider Not Available or is Late
2
Customer Not Available
3
Duplicate Order
4
Delivery Address Unserviceable or Incorrect
5
Operational Issue with order / Customer denied order / Customer not at address / Customer causing delay
6
Cancelled by Seller
7
Rider not having enough cash for purchase
15
Delivered by seller
16
Item not available
17
Incorrect seller location
19
Customer Not responding / Phone switched off
20
Placed order by mistake
21
Order item is not read
22
Got faster option from other provider
23
Expected a shorter wait time
24
Delivery partner refused pickup
Code
{
"pick_to_drop_distance"
:
9.35
,
"order_status"
:
"CANCELLED_BY_CUSTOMER"
,
"sfx_order_id"
:
21038705
,
"rider_name"
:
"Shashank Arya"
,
"rider_contact"
:
"7992362908"
,
"rider_id"
:
139468
,
"rider_latitude"
:
12.931749
,
"rider_longitude"
:
77.68556
,
"pickup_eta"
:
null
,
"drop_eta"
:
null
,
"rider_cod_limit"
:
0
,
"client_order_id"
:
"order_24438"
,
"return_time"
:
"2026-05-05T09:47:00.746057Z"
,
"reason"
:
5
,
"reason_text"
:
"Damaged products"
,
"rain_mode_flag"
:
false
,
"rain_surge_amount"
:
0
,
"rain_impacted"
:
false
}
Sent when SKUs or COD must be returned to the store. The
return_types
field indicates what is being returned:
["cod"]
,
["skus"]
, or both.
Code
{
"rts_time"
:
"2017-11-30T09:25:17.000000Z"
,
"rider_name"
:
"Amit Kumar"
,
"sfx_order_id"
:
10189964
,
"client_order_id"
:
"19424482"
,
"order_status"
:
"RETURNED_TO_SELLER"
,
"rider_contact"
:
"9898989898"
,
"rider_latitude"
:
12.343424
,
"rider_longitude"
:
77.987987987
,
"return_types"
: [
"cod"
,
"skus"
]
}
Rider Location Callback
Sent to a separate configured URL for rider location updates:
Code
{
"order_id"
:
"8145671314"
,
"rider_name"
:
"Amit Kumar"
,
"rider_longitude"
:
77.66824096441269
,
"time"
:
"2017-11-30T09:25:17.000000Z"
,
"rider_latitude"
:
12.991595437657885
,
"sfx_rider_id"
:
3419
,
"location_accuracy"
:
"31.0"
,
"pickup_eta"
:
3
,
"drop_eta"
:
18
}
order_id
is the client order ID (COID) passed at order placement.
Best Practices
Return
200
immediately and process asynchronously.
Implement idempotency using
sfx_order_id
+
order_status
as a deduplication key.
Use
Get Order Details
as a reconciliation fallback.
Log raw payloads before processing for debugging.
See
Sandbox Testing
to trigger callbacks in staging.
Last modified on
October 6, 2026
Orders
Client Features
On this page
Callback Behavior
Order Status Callbacks
ALLOTTED
ARRIVED
DISPATCHED
ARRIVED_CUSTOMER_DOORSTEP
DELIVERED
CANCELLED
CANCELLED_BY_CUSTOMER
Rider Location Callback
Best Practices
