# Petpooja public V2.1.0 API documentation

Source: https://onlineorderingapisv210.docs.apiary.io/
Retrieved UTC: 2026-10-27T15:01:06.609705+00:00

Rendered public webpage text snapshot. Cross-check against the vendor-issued contract; not vendor approval or proof of conformance. Publisher copyright retained.

---

PetpoojaOnlineOrdering APIs - V2.1.0 · Apiary
JavaScript is disabled
Please continue
here
to find out how to
enable it in your browser.
Documentation
Inspector
PetpoojaOnlineOrdering APIs - V2.1.0
Pratik
•
onlineorderingapisv210
Create New API Project
Help
Apiary Powered Documentation
Sign in
with Apiary account.
Introduction
Changelog
Reference
Push Menu
Fetch Menu
Save Order
Order Callback Request/Response
Update Order Status
Rider Information - Webhook
Update Item/addon In_Stock
Update Item/addon out of Stock
Get Store Status
Update Store Status
PetpoojaOnlineOrdering APIs - V2.1.0
Introduction
Petpooja Integration Platform API enables restaurant partner to manage store, menus and orders received/placed from online order aggregator. Integrating with a restaurant partner’s PoS system will improves efficiency for menu management and order management of online orders.
Below are the list of APIs which are connected to the Point of Sale system for Online Ordering.
Method used to use all APIs is POST.
Access to developer account of staging/production :
https://developerapi.petpooja.com/
Credentials for both staging and production environment will be provided by petpooja team.
Changelog
28-06-2022 - Added "nutrition" data to item object in the menu push/fetch API
01-12-2022 - Added "min_prep_time" key in Save order API
02-01-2023 - Added "cuisine" tag key to item details in Menu API
01-04-2023 - Added "turn_on_time" key to update store status API
26-05-2023 - Added "gst_type" key to item details in Menu API
26-05-2023 - Added "ondc_bap" key to save order API
29-12-2023 - Added "otp" key to save order API
29-12-2023 - Added "collect_cash" key to save order API
12-08-2024 - Added "tax_inclusive" key to menu push/fetch API
12-09-2024 - Added "minimum_prep_time" key to menu push/fetch API
23-10-2024 - Added "markup_price", "is_recommend", "item_tags", "item_info" keys/objects to items object within the menu push/fetch API.
10-02-2025 - Added "urgent_order" and "urgent_time" key in Save order API.
21-04-2025 - Added feasibility to push combo items created in petpooja menu management in push & fetch menu APIs
21-04-2025 - Added "group_categories"object to menu push and fetch APIs.
17-09-2025 - Added "dc_tax_percentage" and "pc_tax_percentage" keys to oder.details object in the 'Save Order' API
17-09-2025 - Added "tax_inclusive" key to oderItem.details object in the 'Save Order' API
17-09-2025 - Added "tax_percentage" key to orderItem.details.item_tax object in the 'Save Order' API
15-10-2025 - Introduced BOGO, BXGY and Freebie discounts to menu APIs.
Reference
Push Menu
This API will help online order aggregator to get a brand's menu items, choices and availability.
We require an endpoint from the integrator on which petpooja will push the menu after every change.
In this method, whenever the merchant make changes in menu then the updated menu will be pushed to integrator provided endpoint.
Push Menu
200
Request
object
restaurants
Contains all information about restaurant for which you are fetching/receiving menu petpooja.
array
Show Child Attributes
object
ordertypes
Contains list of order types for which the menu is application.
object
Show Child Attributes
ordertypeid, ordertype
categories
Contains list of categories available in the menu
object
Show Child Attributes
categoryid, ...
parentcategories
Contains information for parent categories served
object
Show Child Attributes
name, rank, image_url, ...
group_categories
Contains groups created at menu category level. This will help identify the categories that are clubbed as a different menus configured in the restaurant menu management.
object, optional
Show Child Attributes
id, name, status, rank
items
Contains information for items
object
Show Child Attributes
itemid, itemallowvariation, ...
attributes
Contains information for attributes served
object
Show Child Attributes
attributeid, attribute, ...
taxes
Contains information for Taxes
object
Show Child Attributes
taxid, taxname, tax, ...
discounts
Contains information for Discounts
object
Show Child Attributes
discountid, discountname, ...
addongroups
Contains information for addongroups items served
object
Show Child Attributes
addongroupid, ...
addongroupitems
Contains information regarding add on items belongs to addon groups
object
Show Child Attributes
addonitemid, addonitem_name, ...
variations
Do not consume this object. This object has been deprecated as the item object has a child object for the variations available in that particular item.
object
Show Child Attributes
variationid, name, ...
success
Indicates that request is served successfully or not.
boolean
message
API response message
string
400
Request
object
restaurants
Contains all information about restaurant for which you are fetching/receiving menu petpooja.
array
Show Child Attributes
object
ordertypes
Contains list of order types for which the menu is application.
object
Show Child Attributes
ordertypeid, ordertype
categories
Contains list of categories available in the menu
object
Show Child Attributes
categoryid, ...
parentcategories
Contains information for parent categories served
object
Show Child Attributes
name, rank, image_url, ...
group_categories
Contains groups created at menu category level. This will help identify the categories that are clubbed as a different menus configured in the restaurant menu management.
object, optional
Show Child Attributes
id, name, status, rank
items
Contains information for items
object
Show Child Attributes
itemid, itemallowvariation, ...
attributes
Contains information for attributes served
object
Show Child Attributes
attributeid, attribute, ...
taxes
Contains information for Taxes
object
Show Child Attributes
taxid, taxname, tax, ...
discounts
Contains information for Discounts
object
Show Child Attributes
discountid, discountname, ...
addongroups
Contains information for addongroups items served
object
Show Child Attributes
addongroupid, ...
addongroupitems
Contains information regarding add on items belongs to addon groups
object
Show Child Attributes
addonitemid, addonitem_name, ...
variations
Do not consume this object. This object has been deprecated as the item object has a child object for the variations available in that particular item.
object
Show Child Attributes
variationid, name, ...
success
Indicates that request is served successfully or not.
boolean
message
API response message
string
Fetch Menu
In this method every time the integrator has to fetch the menu from the endpoint provided by Petpooja Team.
Dev URL:
https://qle1yy2ydc.execute-api.ap-southeast-1.amazonaws.com/V1/mapped_restaurant_menus
Fetch Menu
200
Request
object
restID
Unique restaurant mapping id
string, required
400
Request
object
restID
Unique restaurant mapping id
string, required
Save Order
Once a new order is placed by the end user, you can push the order to the Petpooja PoS application by calling the below APIs. On arrival, the order will be in Pending State untill the restaurant partner respond (Accept/Reject) on the particular order.
Dev URL:
https://47pfzh5sf2.execute-api.ap-southeast-1.amazonaws.com/V1/save_order
Save Order
200 OK
Request
object
app_key
Unique code which allows you to track and identify application.[32 characters]
string, required
app_secret
Unique code for transfer secret data.[40 characters]
string, required
access_token
Unique Code.[40 characters]
string, required
res_name
Name of third party restaurant.
string
address
Address of a third party restaurant.
string
Contact_information
Contact details of a third party restaurant.
string
restID
Unique Petpooja RestaurantID/MappingID to place the order on PoS.
string, required
OrderInfo / Customer
object
Show Child Attributes
email, name, address, phone, ...
OrderInfo / Order
object
Show Child Attributes
orderID, preorder_date, ...
OrderInfo/ OrderItem
object
Show Child Attributes
id, name, tax_inclusive, ...
OrderInfo/ OrderItem / AddonItem
object
Show Child Attributes
id, name, group_name, price, ...
OrderInfo/Tax
object
Show Child Attributes
id, title, type, price, tax, ...
OrderInfo/ Discount
object
Show Child Attributes
id, title, type, price
udid
Unique device number in case of order placed from Mobile.
string
device_type
Type of device through which order is placed.Default is Web(case sensitive)
string, required
400 Bad Request
Request
object
app_key
Unique code which allows you to track and identify application.[32 characters]
string, required
app_secret
Unique code for transfer secret data.[40 characters]
string, required
access_token
Unique Code.[40 characters]
string, required
res_name
Name of third party restaurant.
string
address
Address of a third party restaurant.
string
Contact_information
Contact details of a third party restaurant.
string
restID
Unique Petpooja RestaurantID/MappingID to place the order on PoS.
string, required
OrderInfo / Customer
object
Show Child Attributes
email, name, address, phone, ...
OrderInfo / Order
object
Show Child Attributes
orderID, preorder_date, ...
OrderInfo/ OrderItem
object
Show Child Attributes
id, name, tax_inclusive, ...
OrderInfo/ OrderItem / AddonItem
object
Show Child Attributes
id, name, group_name, price, ...
OrderInfo/Tax
object
Show Child Attributes
id, title, type, price, tax, ...
OrderInfo/ Discount
object
Show Child Attributes
id, title, type, price
udid
Unique device number in case of order placed from Mobile.
string
device_type
Type of device through which order is placed.Default is Web(case sensitive)
string, required
400 Bad Request (2)
Request
object
app_key
Unique code which allows you to track and identify application.[32 characters]
string, required
app_secret
Unique code for transfer secret data.[40 characters]
string, required
access_token
Unique Code.[40 characters]
string, required
res_name
Name of third party restaurant.
string
address
Address of a third party restaurant.
string
Contact_information
Contact details of a third party restaurant.
string
restID
Unique Petpooja RestaurantID/MappingID to place the order on PoS.
string, required
OrderInfo / Customer
object
Show Child Attributes
email, name, address, phone, ...
OrderInfo / Order
object
Show Child Attributes
orderID, preorder_date, ...
OrderInfo/ OrderItem
object
Show Child Attributes
id, name, tax_inclusive, ...
OrderInfo/ OrderItem / AddonItem
object
Show Child Attributes
id, name, group_name, price, ...
OrderInfo/Tax
object
Show Child Attributes
id, title, type, price, tax, ...
OrderInfo/ Discount
object
Show Child Attributes
id, title, type, price
udid
Unique device number in case of order placed from Mobile.
string
device_type
Type of device through which order is placed.Default is Web(case sensitive)
string, required
400 Bad Request (3)
Request
object
app_key
Unique code which allows you to track and identify application.[32 characters]
string, required
app_secret
Unique code for transfer secret data.[40 characters]
string, required
access_token
Unique Code.[40 characters]
string, required
res_name
Name of third party restaurant.
string
address
Address of a third party restaurant.
string
Contact_information
Contact details of a third party restaurant.
string
restID
Unique Petpooja RestaurantID/MappingID to place the order on PoS.
string, required
OrderInfo / Customer
object
Show Child Attributes
email, name, address, phone, ...
OrderInfo / Order
object
Show Child Attributes
orderID, preorder_date, ...
OrderInfo/ OrderItem
object
Show Child Attributes
id, name, tax_inclusive, ...
OrderInfo/ OrderItem / AddonItem
object
Show Child Attributes
id, name, group_name, price, ...
OrderInfo/Tax
object
Show Child Attributes
id, title, type, price, tax, ...
OrderInfo/ Discount
object
Show Child Attributes
id, title, type, price
udid
Unique device number in case of order placed from Mobile.
string
device_type
Type of device through which order is placed.Default is Web(case sensitive)
string, required
Order Callback Request/Response
Online order integration partner must implement this endpoint to allow PoS patner to notify about order status updates post successfull order relay.
Integration partner has to pass this endpoint URL in every save order request. [Ex: "callback_url": xxxxxxxxxxxxxxxx]
Callback Request
200 OK
Request
object
restID
Unique Petpooja Restaurant ID which was used to relay order or get menu data.
string
orderID
Unique client order id which is used to update order status at client side.
string
status
Current status of order.[-1 = Cancelled, 1/2/3 = Accepted, 4 = Dispatch, 5 = Food Ready,10 = Delivered].
string
cancel_reason
This will explain the reason for cancelling the order by the Restaurant.
string
minimum_prep_time
Kitchen preparation time conveyed by the restaurant.
string
minimum_delivery_time
Delivery time mentioned by restaurant. Online partner with logistics service can ignore this object .
string
rider_name
Incase of self-delivery, restaurant will share the rider details along with order status 4 (Dispactched).
string
rider_phone_number
Incase of self-delivery, restaurant will share the rider details along with order status 4 (Dispactched).
string
is_modified
Order is modified at the restaurant or not.
boolean
Update Order Status
Integration partner can send updated order status to PoS partner by calling this endpoint. As of now, this endpoint can be used to send only cancel order (-1) status.
DEV URL:
https://qle1yy2ydc.execute-api.ap-southeast-1.amazonaws.com/V1/update_order_status
Update Order Status
200 OK
Request
object
app_key
Unique code which allow you to track and identify application.[32 characters]
string, required
app_secret
Unique code for transfer secret data.[40 characters]
string, required
access_token
Unique code for third party API user/consumer.[40 characters]
string, required
restID
Unique Petpooja Restaurant ID which was used to relay order or get menu data.
string, required
orderID
Unique PetPooja order id which is used to cancel pending order. Pass it blank, since the object will be deprecated soon.
string, optional
clientorderID
Unique integrator partner order id.
string, required
cancelReason
Reason for canceling order.
string, required
status
[-1=Cancelled]
string, required
errorCode
Error code.
string
validation_errors
It contains various errors which can be arised while placing order.
object
400 Bad Request
Request
object
app_key
Unique code which allow you to track and identify application.[32 characters]
string, required
app_secret
Unique code for transfer secret data.[40 characters]
string, required
access_token
Unique code for third party API user/consumer.[40 characters]
string, required
restID
Unique Petpooja Restaurant ID which was used to relay order or get menu data.
string, required
orderID
Unique PetPooja order id which is used to cancel pending order. Pass it blank, since the object will be deprecated soon.
string, optional
clientorderID
Unique integrator partner order id.
string, required
cancelReason
Reason for canceling order.
string, required
status
[-1=Cancelled]
string, required
errorCode
Error code.
string
validation_errors
It contains various errors which can be arised while placing order.
object
Rider Information - Webhook
This is the webhook to update the rider information for Petpooja POS in order to update the order delivery status at our end without continuously polling with check order status. This has to be provided by third party.
DEV URL:
https://qle1yy2ydc.execute-api.ap-southeast-1.amazonaws.com/V1/rider_status_update
Rider Info
200 OK
Request
object
app_key
Unique code which allow you to track and identify application.[32 characters]
string, required
app_secret
Unique code for transfer secret data.[40 characters]
string, required
access_token
Unique code for third party API user/consumer.[40 characters]
string, required
status
Status of the rider for respective orders [Values as rider-assigned/rider-arrived/pickedup/delivered]
string, required
order_id
Unique thirdparty order id / Client Order ID
string, required
external_order_id
PetPooja Order Id [Pass this blank]
string
rider_data
It contains rider Information
object
Show Child Attributes
rider_name, ...
400 Bad Request
Request
object
app_key
Unique code which allow you to track and identify application.[32 characters]
string, required
app_secret
Unique code for transfer secret data.[40 characters]
string, required
access_token
Unique code for third party API user/consumer.[40 characters]
string, required
status
Status of the rider for respective orders [Values as rider-assigned/rider-arrived/pickedup/delivered]
string, required
order_id
Unique thirdparty order id / Client Order ID
string, required
external_order_id
PetPooja Order Id [Pass this blank]
string
rider_data
It contains rider Information
object
Show Child Attributes
rider_name, ...
Update Item/addon In_Stock
This API Endpoint has to be provided by integrator. Petpooja will call this endpoint for toggling the item stock status in the menu on integrator platform for the items already synced via menu sync APIs.
Based on this API, integrator has to maintain the stock status on end customer app.
Update Item/addon In_Stock/Item On
200 OK
Request
object
restID
The restID which is mapped to the restaurant for which the item stock is being toggled.
string, required
inStock
Stock status of the item, either true or false for in-stock or out-of-stock respectively.
boolean, required
type
The type of request. Item or addon
string, required
itemID
The list of Item OR AddonItem Ids that are to be toggled in/out of stock.
object, required
code
API response success denotes 200 and 400 for failure.
string
status
API response flag success means success and failed means failed
string
message
API response message
string
400 Bad Request
Request
object
restID
The restID which is mapped to the restaurant for which the item stock is being toggled.
string, required
inStock
Stock status of the item, either true or false for in-stock or out-of-stock respectively.
boolean, required
type
The type of request. Item or addon
string, required
itemID
The list of Item OR AddonItem Ids that are to be toggled in/out of stock.
object, required
code
API response success denotes 200 and 400 for failure.
string
status
API response flag success means success and failed means failed
string
message
API response message
string
Update Item/addon out of Stock
Note : For Update Item Stock off API, we suggest you to keep the same endpoint as item stock on.
Update Item/addon Out Of Stock/Item Off
200 OK
{
      "code": 400,
      "status": "failed",
      "message": "Stock status not updated successfully"

}
Response
object
restID
The restID which is mapped to the restaurant for which the item stock is being toggled.
string, required
inStock
Stock status of the item, either true or false for in-stock or out-of-stock respectively.
boolean, required
type
The type of request. Item or addon
string, required
itemID
The list of Item OR AddonItem Ids that are to be toggled in/out of stock.
object, required
autoTurnOnTime
If 'inStock' is being passed in as false , an auto-turn-on time is required. The possible value for the same is :
custom
- items gets turned back on at the timestamp specified by customTurnOnTime.
string, required
customTurnOnTime
This would be the custom timestamp, in the local timezone of the restaurant when the item is to be turned back on.This is required in case of autoTurnOnTime as custom.
string
code
API response success denotes 200 and 400 for failure.
string
status
API response flag success means success and failed means failed
string
message
API response message
string
Get Store Status
This API Endpoint has to provided by Integration partner. Based on this API, merchant at restaurant can check the current status of the store at integrater platform end.
Get Store Status
200 OK
Request
object
restID
Unique mapped Id for third party restaurant.
string, required
status
API response flag success means success and failed means failed
string, required
store_status
store status can be 1 or 0 where 1 means Open and 0 means Closed.
string, required
http_code
API response status. For success, it would be 200 and for failure it can be 201,400 etc.
string
message
API response message
string
Update Store Status
This API Endpoint has to provided by Integration Partner. This API is used by merchant to tell integration partner to on/off the store for online orders within their set working hours.
Update Store Status
200 OK
Request
object
restID
Unique mapped Id for third party restaurant.
string, required
status
API response flag success means success and failed means failed
string, required
store_status
store status can be 1 or 0 where 1 means Open and 0 means Closed.
string, required
turn_on_time
Next opening time. This key will be used only while turning off the store.
string, required
reason
Required when store_status is 0 (Store off).
string
message
API response message
string
{"mock":"https://private-anon-62b33acfff-onlineorderingapisv210.apiary-mock.com/","production":"https://internal_or_external_url_address.com/","proxy":"https://private-anon-62b33acfff-onlineorderingapisv210.apiary-proxy.com/"}
