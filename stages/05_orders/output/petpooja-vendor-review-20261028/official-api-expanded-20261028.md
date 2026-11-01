# Petpooja Apiary V2.1.0 ? expanded public data structures

Source: https://onlineorderingapisv210.docs.apiary.io/
SSR source: https://jsapi.apiary.io/apis/onlineorderingapisv210/ssr/68ef7e4dd63150f067a43496/0.38.0/Apiary.renderApiaryUI
Extracted: 2026-10-28T04:10:25.056301+00:00
Method: static literal decoding of the page state, not execution of remote JavaScript.
Coverage: all resource prose and schema member descriptions/types, including collapsed child attributes. Public examples are stored separately with credential/contact fields redacted. This is documentation, not provider test evidence.

Petpooja Integration Platform API enables restaurant partner to manage store, menus and orders received/placed from online order aggregator. Integrating with a restaurant partner’s PoS system will improves efficiency for menu management and order management of online orders.
Below are the list of APIs which are connected to the Point of Sale system for Online Ordering.
Method used to use all APIs is POST.

Access to developer account of staging/production : https://developerapi.petpooja.com/

Credentials for both staging and production environment will be provided by petpooja team.

# Changelog

+ 28-06-2022 - Added "nutrition" data to item object in the menu push/fetch API

+ 01-12-2022 - Added "min_prep_time" key in Save order API

+ 02-01-2023 - Added "cuisine" tag key to item details in Menu API

+ 01-04-2023 - Added "turn_on_time" key to update store status API

+ 26-05-2023 - Added "gst_type" key to item details in Menu API

+ 26-05-2023 - Added "ondc_bap" key to save order API

+ 29-12-2023 - Added "otp" key to save order API

+ 29-12-2023 - Added "collect_cash" key to save order API

+ 12-08-2024 - Added "tax_inclusive" key to menu push/fetch API

+ 12-09-2024 - Added "minimum_prep_time" key to menu push/fetch API

+ 23-10-2024 - Added "markup_price", "is_recommend", "item_tags", "item_info" keys/objects to items object within the menu push/fetch API.

+ 10-02-2025 - Added "urgent_order" and "urgent_time" key in Save order API.

+ 21-04-2025 - Added feasibility to push combo items created in petpooja menu management in push & fetch menu APIs

+ 21-04-2025 - Added "group_categories"object to menu push and fetch APIs.

+ 17-09-2025 - Added "dc_tax_percentage" and "pc_tax_percentage" keys to oder.details object in the 'Save Order' API

+ 17-09-2025 - Added "tax_inclusive" key to oderItem.details object in the 'Save Order' API

+ 17-09-2025 - Added "tax_percentage" key to orderItem.details.item_tax object in the 'Save Order' API

+ 15-10-2025 - Introduced BOGO, BXGY and Freebie discounts to menu APIs.

## Push Menu

Documented route: `/pushmenu_endpoint`

This API will help online order aggregator to get a brand's menu items, choices and availability.

We require an endpoint from the integrator on which petpooja will push the menu after every change. 
In this method, whenever the merchant make changes in menu then the updated menu will be pushed to integrator provided endpoint.

### Push Menu ? schema
- `restaurants` (array): Contains all information about restaurant for which you are fetching/receiving menu petpooja.
  - `active` (string): Status of restaurant [values will be boolean]
  - `restaurantname` (string): Restaurant name
  - `menusharingcode` (string): Unique mapped Id for third party restaurant.
  - `address` (string): Address of restaurant.
  - `contact` (string): Contact of restaurant.
  - `latitude` (string): Latitude of restaurant.
  - `longitude` (string): Longitude of restaurant.
  - `landmark` (string): Landmark of restaurant.
  - `images` (string): Images URL of restaurant.
  - `city` (string): Name of the City in which restaurant belongs to.
  - `state` (string): Name of the State in which restaurant belongs to.
  - `minimumorderamount` (string): Minimum order amount of restaurant.
  - `minimumdeliverytime` (string): Minimum delivery amount of restaurant.
  - `minimum_prep_time` (string): Minimum preparation time of restaurant in minutes.
  - `deliverycharge` (string): Delivery charge of restaurant.
  - `deliveryhoursfrom1` (string): Delivery hours From time.
  - `deliveryhoursto1` (string): Delivery hours To time.
  - `deliveryhoursfrom2` (string): Delivery hour From seconds slot.
  - `deliveryhoursto2` (string): Delivery hour To seconds slot.
  - `sc_applicable_on` (string): Service charge applicable on DineIn,Parcel & Home Delivery orders (Allowed values D,P,H)
  - `sc_type` (string): Service charge Percentage OR Fixed value (Allowed values 1-Fixed or 2-Percentage).
  - `sc_calculate_on` (string): Service charge calculated on core amount or total amount(Allowed values 1-CORE or 2-TOTAL).Note: If sc_type is 1, then sc_calculate_on will be blank.
  - `sc_value` (string): Service charge value applied
  - `tax_on_sc` (string): Is tax applicable on service charge? (Allowed values 1 - Applicable, 0 - Not Applicable)
  - `calculatetaxonpacking` (number): Tax amount calculate on packing [values can be 0 or 1].
  - `pc_taxes_id` (string): We will be passing the tax ids in this object to identify the applicable taxes on packing charges in case of order level packing charges. For item level packing charges, the taxes will be same as item taxes.
  - `calculatetaxondelivery` (number): Tax amount on delivery [values can be 0 or 1].
  - `dc_taxes_id` (string): We will be passing the tax ids in this object to identify the applicable taxes on delivery charge at order level.
  - `packaging_applicable_on` (string): Packing charge applicable on Value : NONE, ITEM, ORDER
  - `packaging_charge` (string): Packing charge value.
  - `packaging_charge_type` (string): Packing charge type Value : PERCENTAGE, FIXED.
- `ordertypes` (object): Contains list of order types for which the menu is application.
  - `ordertypeid` (number): Ordertype id
  - `ordertype` (string): Order type name such as Delivery,Pick Up or Dine In
- `categories` (object): Contains list of categories available in the menu
  - `categoryid` (string): Category id
  - `parent_category_id` (string): Parent category id to which the category belong to.
  - `active` (string): Category status [values will be boolean]
  - `categoryrank` (string): Category rank for ordering/stacking
  - `categoryname` (string): Category name
  - `categorytimings` (string): Active Schedule days and time slot of category
  - `category_image_url` (string): Category image url
- `parentcategories` (object): Contains information for parent categories served
  - `name` (string): Name of the parent category
  - `rank` (string): Parent category rank for ordering/Stacking
  - `image_url` (string): Image url of parent category
  - `status` (string): Status of parent category [values will be boolean]
  - `id` (string): Parent category id
- `group_categories` (object, optional): Contains groups created at menu category level. This will help identify the categories that are clubbed as a different menus configured in the restaurant menu management.
  - `id` (string): Unique id of a group category
  - `name` (string): Name of the group category
  - `status` (string): Status of group category [values will be boolean]
  - `rank` (string): Group category rank for ordering/Stacking
- `items` (object): Contains information for items
  - `itemid` (string): Item id
  - `itemallowvariation` (string): Flag for item allowing variations or not [1 - Item with varaition , 0 - Item without variation]
  - `itemrank` (string): Item rank for ordering/Stacking
  - `item_categoryid` (string): Item category id from category object
  - `item_ordertype` (string): Order type in which the item is available [1 = Home Delivery,2 = Parcel, 3 = Dine In]
  - `item_tags` (array, optional): Possible list of tags. [vegan, chef-special, new]
  - `item_info` (object): 
    - `spice_level` (string): Defined the spice level of the item. Possible values [not-applicable, nonspicy, mediumspicy, veryspicy]. Default value is 'not-applicable'
  - `item_packingcharges` (string): Packing charge applied on item [If packing charge configured Itemwise]
  - `itemallowaddon` (string): Flag for item allowing addon or not [1 - Item with addon , 0 - Item without addon].
  - `itemaddonbasedon` (string): Flag addon based on item or variations [values will be boolean]. 0 = Addon group applied on item, 1 = Addon group applied variation wise
  - `item_favorite` (string): Flag of Item is favourite or not [values will be boolean]
  - `ignore_taxes` (string): 0 - consider item for tax calculation, 1 - ignore item for tax calculation
  - `cuisine` (array, optional): Item cuisine tag (can be multiple)
  - `ignore_discounts` (string): 0 - consider item for discount calculation, 1 - ignore item for discount calculation
  - `variation` (string): Different variations available under item.
  - `is_combo` (string): 1 represent that the item is a combo item.
  - `combo_details` (object): Details will be recieved only if the item is configured as combo.
    - `item_id` (string): Item added to this combo
    - `is_variation` (string): 1 represents that the item is a variation.
    - `variation_item_id` (string): To identify the exact variation from the item
    - `name` (string): item or variation item name
    - `quantity` (string): quantity included in this combo.
  - `addon` (string): Different addongroup(s) applied on items/variations. Object contains the group id, min and max selection of addon items from the group. (Doesn't represents the quantity of addon items)
  - `is_recommend` (string): Restaurant recommended item [1 - Recommended]
  - `itemname` (string): Item name
  - `item_attributeid` (string): Item attribute id [1- Veg, 2- Non-Veg, 5- Other, 24- Egg]
  - `itemdescription` (string): Item description (If any)
  - `minimumpreparationtime` (string): Minimum preparation time of item. Optional
  - `price` (string): Price of the item
  - `markup_price` (string, optional): The markup price is the strike price that can be displayed on the customer interface.
  - `active` (string): Status of Item [values will be boolean]
  - `item_image_url` (string): Item image url. The URL will expire 24 hours after the menu is shared with the aggregator.
  - `item_tax` (string): Tax master ids which represents tax applied on the specific item
  - `tax_inclusive` (boolean): 'true' or 'false'. 'true' means the item price is inclusive of taxes. Default will be 'false'
  - `gst_type` (string): This explains the gst liability. "services" - Integrator collects the gst from the customer and pays to Gov. "goods" - Integrator collects the gst and settles to restaurant.
  - `nutrition` (object, optional): Different nutrition(s) applied on items/variations. Object contains multiple nutrition parameters. This is optional.
    - `foodAmount` (object, optional): optional object. Amount of food. Merchant needs to provide these information in g, kg, ml or l
      - `amount` (number): 
      - `unit` (string): 
    - `calories` (object, optional): Amount of calories present in food. Unit is kcal.
      - `amount` (number): 
      - `unit` (string): 
    - `protien` (object, optional): Amount of protein present in food. Unit is g.
      - `amount` (number): 
      - `unit` (string): 
    - `minerals` (object, optional): Amount of all the mineral present in food. Possible Unit will be g or mg.
      - `name` (string): 
      - `amount` (number): 
      - `unit` (string): 
    - `sodium` (object, optional): Amount of sodium present in food. Merchant need to provide these details in mg.
      - `amount` (number): 
      - `unit` (string): 
    - `carbohydrate` (object, optional): Amount of carbohydrate present in food. Possible Unit will be g or mg.
      - `amount` (number): 
      - `unit` (string): 
    - `totalSugar` (object, optional): Amount of total sugar present in food. Possible Unit will be g or mg.
      - `amount` (number): 
      - `unit` (string): 
    - `addedSugar` (object, optional): Amount of addedSugar present in food. Possible Unit will be g or mg.
      - `amount` (number): 
      - `unit` (string): 
    - `totalFat` (object, optional): Amount of Total Fat present in food. Possible Unit will be g or mg.
      - `amount` (number): 
      - `unit` (string): 
    - `saturatedFat` (object, optional): Amount of Saturated Fat present in food. Possible Unit will be g or mg.
      - `amount` (number): 
      - `unit` (string): 
    - `transFat` (object, optional): Amount of Trans Fat present in food. Possible Unit will be g or mg.
      - `amount` (number): 
      - `unit` (string): 
    - `cholesterol` (object, optional): Amount of Cholesterol present in food. Possible Unit will be g or mg.
      - `amount` (number): 
      - `unit` (string): 
    - `vitamins` (object, optional): Amount of all vitamins present in food. Possible Unit will be g or mg.
      - `name` (string): 
      - `amount` (number): 
      - `unit` (string): 
    - `additionalInfo` (object, optional): This is additional declaration from restaurant.
      - `info` (string): 
      - `remark` (string): 
    - `fiber` (object, optional): Amount of all the mineral present in food. Possible Unit will be g or mg.
      - `amount` (number): 
      - `unit` (string): 
    - `servingInfo` (string, optional): Possbile value is 1to2people OR 2to3people OR 3to4people OR 4to5people OR 5to6people
    - `additiveMap` (object, optional): Amount of Polyols, Polydextrose, Artificial Sweetener, MonoSodiumGlutamate. Supported key values are: Polyols, Polydextrose, Caffeine, ArtificialSweetener, MSG. Supported unit for each map is g or mg.
      - `Polyols` (object): 
        - `amount` (number): 
        - `unit` (string): 
    - `allergens` (object, optional): Name of allergen present in food and a one line description
      - `allergen` (string): 
      - `allergenDesc` (string): 
- `attributes` (object): Contains information for attributes served
  - `attributeid` (string): Attribute id
  - `attribute` (string): Attribute name
  - `active` (string): Status of attribute [values will be boolean]
- `taxes` (object): Contains information for Taxes
  - `taxid` (string): Tax id
  - `taxname` (string): Tax name
  - `tax` (string): Tax amount
  - `taxtype` (string): Tax type [1= Percentage , 2 = Fixed]
  - `tax_ordertype` (string): Order type of tax [1=Delivery,2=Pick Up,3=Dine In]
  - `active` (string): Status of Tax [values will be boolean]
  - `tax_coreortotal` (string): Tax apply on [1 = Add on Total, 2 = Add on Core]
  - `tax_taxtype` (string): Tax type [1 = forward tax, 2 = backward tax]
  - `description` (string): Tax description
  - `rank` (string): Tax ranking
- `discounts` (object): Contains information for Discounts
  - `discountid` (string): Discount id
  - `discountname` (string): Discount name
  - `discounttype` (string): Discount type [1=Percentage,2=Fixed,3=BOGO OR BXGY,7=Freebie]
  - `bogobuyqty` (string): Bogo offer item purchase qty [If both BUY and GET quatity is 1 then it is a BOGO and for rest of the values it is BXGY]
  - `bogogetqty` (string): Bogo offer discount apply on qty [If both buy and get quatity is 1 then it is a BOGO and for rest of the values it is BXGY]
  - `bogotype` (string): Default is 1 = percentage for BOGO and BXGY
  - `discount` (string): Discount Value for all types of discounts. Default is 100 (%)  for BOGO and BXGY. Not applicable for 'discounttype' = 7
  - `bogoapplicableonpurchase` (string): Bogo BUY applicable on : All,Items
  - `bogoapplicableonpurchaseitemids` (string): Comma separated item ids which defines BUY items on which BOGO or BXGY offer can be applied. It will be blank in case of 'All' items
  - `bogoapplicableon` (string): Bogo GET applicable on : All,Items
  - `bogoapplicableonitemids` (string): Comma separated item ids which defines GET items on which BOGO or BXGY offer can be applied. It will be blank in case of 'All' items
  - `bogoapplicableonitem` (string): Pricing criteria for GET items. Allowed value 0 = Lower Price [Default set as 0 for BOGO and BXGY]
  - `bogoitemamountlimit` (string): Will be deprecated soon
  - `bogopurchasediscount` (string): Will be deprecated soon
  - `bogoapplicableonpurchaseitem` (string): Will be deprecated soon
  - `discountordertype` (string): Discount order type. Default 1,2,3 (Applicable to all types of orders)
  - `discountapplicableon` (string): Discount applicable on Value : Allowed values: All,Categories,Items. Not applicable for the 'discounttype' = 3 and 7
  - `discountdays` (string): Days on which discount will be valid. Allowed values: Sun,Mon,Tue,Wed,Thu,Fri,Sat OR All = For all days of week
  - `discountontotal` (string): Discount apply on 1=Add on Total,0=Add on Core. Not applicable for the 'discounttype' = 3 and 7
  - `discountstarts` (string): Discount validity start date/time. If blank then no discount validity
  - `discountends` (string): Discount validity end date/time. If blank then no discount validity
  - `discounttimefrom` (string): Discount applicable time of the day (Start). Blank in case of whole day
  - `discounttimeto` (string): Discount applicable time of the day (End). Blank in case of whole day
  - `discountminamount` (string): Discount apply on min amount. Not applicable for the 'discounttype' = 3
  - `discountmaxamount` (string): Discount max amount. Not applicable for the 'discounttype' = 3 and 7
  - `freebie_item_count` (string): Number of items in discounttype = 7,
  - `freebie_item_ids` (string): Item ids comma separated on which the freebie discount is applicable.
  - `discounthascoupon` (string): Discount flag if coupon.
  - `discountcategoryitemids` (string): Category OR item ids comma separated which defines categories on which discount can be applied. Not applicable for the 'discounttype' = 3
  - `active` (string): Active status [values will be boolean]
  - `discountmaxlimit` (string): Discount max limit. Not applicable for 'discounttype' = 3 and 7
  - `rank` (string): Discount rank
- `addongroups` (object): Contains information for addongroups items served
  - `addongroupid` (string): Addon group id
  - `addongroup_name` (string): Addon group name
  - `addongroup_rank` (string): Add on group rank
  - `active` (string): Addon group active status [values will be boolean]
- `addongroupitems` (object): Contains information regarding add on items belongs to addon groups
  - `addonitemid` (string): Addon group item id
  - `addonitem_name` (string): Addon group item name
  - `addonitem_price` (string): Addon group item price
  - `active` (string): Addon group active status [values will be boolean]
  - `attributes` (string): Addon item attribute such as veg,non- veg or egg
  - `addonitem_rank` (string): Addon item rank/order
- `variations` (object): Do not consume this object. This object has been deprecated as the item object has a child object for the variations available in that particular item.
  - `variationid` (string): Variation id (Deprecated)
  - `name` (string): Variation Name (Deprecated)
  - `groupname` (string): Variation group belongs to like Size,Quantity,Volume Etc. (Deprecated)
  - `status` (string): Variation Status is Active or Not [values will be boolean] (Deprecated)
- `success` (boolean): Indicates that request is served successfully or not.
- `message` (string): API response message

Examples: `examples-push-menu.md` (4 unique bodies).

## Fetch Menu

Documented route: `/fetchmenu`

In this method every time the integrator has to fetch the menu from the endpoint provided by Petpooja Team.

Dev URL: https://qle1yy2ydc.execute-api.ap-southeast-1.amazonaws.com/V1/mapped_restaurant_menus

### Fetch Menu ? schema
- `restID` (string, required): Unique restaurant mapping id

Examples: `examples-fetch-menu.md` (4 unique bodies).

## Save Order

Documented route: `/saveorder`

Once a new order is placed by the end user, you can push the order to the Petpooja PoS application by calling the below APIs. On arrival, the order will be in Pending State untill the restaurant partner respond (Accept/Reject) on the particular order.

Dev URL: https://47pfzh5sf2.execute-api.ap-southeast-1.amazonaws.com/V1/save_order

### Save Order ? schema
- `app_key` (string, required): Unique code which allows you to track and identify application.[32 characters]
- `app_secret` (string, required): Unique code for transfer secret data.[40 characters]
- `access_token` (string, required): Unique Code.[40 characters]
- `res_name` (string): Name of third party restaurant.
- `address` (string): Address of a third party restaurant.
- `Contact_information` (string): Contact details of a third party restaurant.
- `restID` (string, required): Unique Petpooja RestaurantID/MappingID to place the order on PoS.
- `OrderInfo / Customer` (object): 
  - `email` (string): Mail address of third party customers.
  - `name` (string): Name of third party customer.
  - `address` (string): Address of third party customer.
  - `phone` (string): 10 digit mobile no of third party customer.
  - `latitude` (string): latitude of third party customer.
  - `longitude` (string): longitude of third party customer.
- `OrderInfo / Order` (object): 
  - `orderID` (string, required): Unique thirdparty order id. OR Cleint order id.
  - `preorder_date` (string, required): Order creation date on aggregator platform. Value contains Date. Format:yyyy-mm-dd. For advance order the pre order date and time must be greater than or equal to current date and time of the system.
  - `preorder_time` (string, required): Order creation time on aggregator platform. Value is Time. Format : HH:mm:ss
  - `delivery_charges` (string): Delivery charge for placed order.
  - `order_type` (string, required): Type of placed order.H = Home Delivery, P = Parcel,D = Dine In
  - `ondc_bap` (string, optional): An identifier to indicate if the order is from ONDC by passing the buyer app name.
  - `advanced_order` (string): Flag which says that placed order is advance or not.Value is Boolean either Y or N.
  - `urgent_order` (boolean): Indicates whether the order is urgent (true/false)
  - `urgent_time` (number): If it is an urgent order. Need to pass the urgent order time (for UI) in minutes.
  - `payment_type` (string, required): Payment type of placed order.COD = Cash On Delivery,CARD = Card,CREDIT = Credit ,ONLINE= Online,OTHER = Any Wallet/NetBanking or Other Type
  - `table_no` (string): Table no of placed order, case of order type = D.[Paas the object blank in case of undefined]
  - `no_of_persons` (string): Number of persons involved for Dine In/Table Order.[Paas the object blank in case of undefined]
  - `discount_total` (string): In case of discountType is "F" [fixed] then discountTotal would be the same as discount.In case of discountType is P [percentage] then discountTotal would be the calculated value of discount. [discountTotal = [itemPriceTotal * discount]/100].
  - `discount` (string): If discount_type is P then it would be percentage value or else fixed amount in case of F (fixed).
  - `discount_type` (string): General discount type either Percentage or Fixed.Value is in Boolean either P or F.P = Percentage, F = Fixed
  - `total` (string): Order total amount including GST to be paid by merchant to govt. (Exclude the GST retained by aggregator). Value is in Decimal.
  - `tax_total` (string): Total tax calculated on order. Value is in Decimal.
  - `description` (string): Any special instructions provided for order.
  - `created_on` (string, required): Order creation date/time. Format:yyyy-mm-dd H:i:s
  - `packing_charges` (string): Total Packing charge amount for placed order.
  - `min_prep_time` (number, optional): order level Kitchen preparation time defined by the order platform
  - `callback_url` (string): ThirdParty Callback URL on which PetPooja will send the respons and further status (Accept/Reject/FoodReady etc.) of the Order. For callbackURL field third party client needs to pass URL [For Example: http://clientdomain.extension/{callbackURL}/].
  - `collect_cash` (string, optional): This can be used only if the order payment type is 'COD' and self-delivery (Merchant delivery).
  - `otp` (string, optional): Integrator can generate a pickup otp and share with merchant so that the order can be verified during the pickup.
  - `enable_delivery` (number): Values can be 0 or 1 where 0 means Rider from thirdparty side will come and 1 means Rider from Restaurant i.e. self delivery order.
  - `service_charge` (string, required): Service charge applicable at order level.
  - `sc_tax_amount` (string, required): Tax calculated on service charge
  - `dc_tax_percentage` (string, required): Tax percentage applied on the delivery charges.
  - `dc_tax_amount` (string, required): Tax amount calculated on delivery charge
  - `dc_gst_details` (object, optional): Delivery Charge GST liability with amount. It will be there in Order object (Required for Ecomm platform)
    - `gst_liable` (string): Allowed values are vendor OR restaurant
    - `amount` (string): liable amount
  - `pc_tax_percentage` (string, required): Tax percentage applied on the packing charge
  - `pc_tax_amount` (string, required): Tax amount calculated on packing charge
  - `pc_gst_details` (object, optional): Packing Charge GST liability with amount. It will be there in Order object (Required for Ecomm platform)
    - `gst_liable` (string): Allowed values are vendor OR restaurant
    - `amount` (string): liable amount
- `OrderInfo/ OrderItem` (object): 
  - `id` (string): Unique PetPooja item id. Variation item id in case of variation.
  - `name` (string, required): Name of item.
  - `tax_inclusive` (boolean): true/false. This is required in case the item amount is inclusive of tax.
  - `gst_liability` (string): Required for Ecomm platform and Optional for others.GST liability ownership. It will be there in the item object (vendor/restaurant)
  - `item_tax` (object, required): Tax calculated at item level after discount
    - `id` (string): Tax id applied on item
    - `name` (string): Tax name applied on item
    - `tax_percentage` (string): Percentage tax applied on the item.
    - `amount` (string): Tax amount calculated on item
  - `item_discount` (string, required): Discount amount at item level (If any)
  - `final_price` (string, required): Item price after discount. If there is no discount, Price and finalPrice objects will have the same value.
  - `price` (string, required): Unit price of item.(This price includes addonitems price and if variations then includes variation price.)
  - `quantity` (string, required): Value is in Numeric.
  - `description` (string): Special instruction for item.
  - `variation_name` (string): Variation name from Variation master (Required when Item having Variation)
  - `variation_id` (string): Variation ID from Variation master (Required when Item having Variation).
- `OrderInfo/ OrderItem / AddonItem` (object): 
  - `id` (string, required): AddonItem ID from AddonGroup -> AddonGroupItem master
  - `name` (string, required): AddonItem name from AddonGroup -> AddonGroupItem master
  - `group_name` (string, required): AddonGroup name from AddonGroup master
  - `price` (string, required): Price of addon group item.
  - `group_id` (string, required): AddonGroup ID from AddonGroup master
  - `quantity` (string): Value is in Numeric.
- `OrderInfo/Tax` (object): 
  - `id` (string, required): Unique PetPooja tax id..
  - `title` (string, required): Title of Tax.
  - `type` (string): Flag which says that Tax is Percentage or Fixed, Default is percentage.Value is in Boolean either P or F.P = Percentage, F = Fixed
  - `price` (string, required): Percentage rate of tax
  - `tax` (string): Total tax amount
  - `restaurant_liable_amt` (string, optional): Tax amount which restaurant is liable to pay from the particular tax calculated (CGST or SGST). Required for Ecomm Platforms.
- `OrderInfo/ Discount` (object): 
  - `id` (string): Unique PetPooja discount id which is sent by a third party.
  - `title` (string, required): Title of Discount.
  - `type` (string): Flag which says that Discount is Percentage or Fixed, Default is percentage.Value is in Boolean either P or F.P = Percentage, F = Fixed.
  - `price` (string, required): Discount amount.
- `udid` (string): Unique device number in case of order placed from Mobile.
- `device_type` (string, required): Type of device through which order is placed.Default is Web(case sensitive)

Examples: `examples-save-order.md` (5 unique bodies).

## Order Callback Request/Response

Documented route: `/callback`

Online order integration partner must implement this endpoint to allow PoS patner to notify about order status updates post successfull order relay.

Integration partner has to pass this endpoint URL in every save order request. [Ex: "callback_url": xxxxxxxxxxxxxxxx]

### Callback Request ? schema
- `restID` (string): Unique Petpooja Restaurant ID which was used to relay order or get menu data.
- `orderID` (string): Unique client order id which is used to update order status at client side.
- `status` (string): Current status of order.[-1 = Cancelled, 1/2/3 = Accepted, 4 = Dispatch, 5 = Food Ready,10 = Delivered].
- `cancel_reason` (string): This will explain the reason for cancelling the order by the Restaurant.
- `minimum_prep_time` (string): Kitchen preparation time conveyed by the restaurant.
- `minimum_delivery_time` (string): Delivery time mentioned by restaurant. Online partner with logistics service can ignore this object .
- `rider_name` (string): Incase of self-delivery, restaurant will share the rider details along with order status 4 (Dispactched).
- `rider_phone_number` (string): Incase of self-delivery, restaurant will share the rider details along with order status 4 (Dispactched).
- `is_modified` (boolean): Order is modified at the restaurant or not.

Examples: `examples-order-callback-request-response.md` (1 unique bodies).

## Update Order Status

Documented route: `/orderstatus`

Integration partner can send updated order status to PoS partner by calling this endpoint. As of now, this endpoint can be used to send only cancel order (-1) status.

DEV URL: https://qle1yy2ydc.execute-api.ap-southeast-1.amazonaws.com/V1/update_order_status

### Update Order Status ? schema
- `app_key` (string, required): Unique code which allow you to track and identify application.[32 characters]
- `app_secret` (string, required): Unique code for transfer secret data.[40 characters]
- `access_token` (string, required): Unique code for third party API user/consumer.[40 characters]
- `restID` (string, required): Unique Petpooja Restaurant ID which was used to relay order or get menu data.
- `orderID` (string, optional): Unique PetPooja order id which is used to cancel pending order. Pass it blank, since the object will be deprecated soon.
- `clientorderID` (string, required): Unique integrator partner order id.
- `cancelReason` (string, required): Reason for canceling order.
- `status` (string, required): [-1=Cancelled]
- `errorCode` (string): Error code.
- `validation_errors` (object): It contains various errors which can be arised while placing order.

Examples: `examples-update-order-status.md` (3 unique bodies).

## Rider Information - Webhook

Documented route: `/rider_info_webhook`

This is the webhook to update the rider information for Petpooja POS in order to update the order delivery status at our end without continuously polling with check order status. This has to be provided by third party.

DEV URL: https://qle1yy2ydc.execute-api.ap-southeast-1.amazonaws.com/V1/rider_status_update

### Rider Info ? schema
- `app_key` (string, required): Unique code which allow you to track and identify application.[32 characters]
- `app_secret` (string, required): Unique code for transfer secret data.[40 characters]
- `access_token` (string, required): Unique code for third party API user/consumer.[40 characters]
- `status` (string, required): Status of the rider for respective orders [Values as rider-assigned/rider-arrived/pickedup/delivered]
- `order_id` (string, required): Unique thirdparty order id / Client Order ID
- `external_order_id` (string): PetPooja Order Id [Pass this blank]
- `rider_data` (object): It contains rider Information
  - `rider_name` (string, required): Delivery executive name
  - `rider_phone_number` (string, required): Delivery executive phone number

Examples: `examples-rider-information-webhook.md` (3 unique bodies).

## Update Item/addon In_Stock

Documented route: `/item_stock`

This API Endpoint has to be provided by integrator. Petpooja will call this endpoint for toggling the item stock status in the menu on integrator platform for the items already synced via menu sync APIs.
Based on this API, integrator has to maintain the stock status on end customer app.

### Update Item/addon In_Stock/Item On ? schema
- `restID` (string, required): The restID which is mapped to the restaurant for which the item stock is being toggled.
- `inStock` (boolean, required): Stock status of the item, either true or false for in-stock or out-of-stock respectively.
- `type` (string, required): The type of request. Item or addon
- `itemID` (object, required): The list of Item OR AddonItem Ids that are to be toggled in/out of stock.
- `code` (string): API response success denotes 200 and 400 for failure.
- `status` (string): API response flag success means success and failed means failed
- `message` (string): API response message

Examples: `examples-update-item-addon-in-stock.md` (3 unique bodies).

## Update Item/addon out of Stock

Documented route: `/item_stock_off`

Note : For Update Item Stock off API, we suggest you to keep the same endpoint as item stock on.

### Update Item/addon Out Of Stock/Item Off ? schema
(No transition-level schema in this source.)

Examples: `examples-update-item-addon-out-of-stock.md` (3 unique bodies).

## Get Store Status

Documented route: `/get_store_status`

This API Endpoint has to provided by Integration partner. Based on this API, merchant at restaurant can check the current status of the store at integrater platform end.

### Get Store Status ? schema
- `restID` (string, required): Unique mapped Id for third party restaurant.
- `status` (string, required): API response flag success means success and failed means failed
- `store_status` (string, required): store status can be 1 or 0 where 1 means Open and 0 means Closed.
- `http_code` (string): API response status. For success, it would be 200 and for failure it can be 201,400 etc.
- `message` (string): API response message

Examples: `examples-get-store-status.md` (2 unique bodies).

## Update Store Status

Documented route: `/update_store_status`

This API Endpoint has to provided by Integration Partner. This API is used by merchant to tell integration partner to on/off the store for online orders within their set working hours.

### Update Store Status ? schema
- `restID` (string, required): Unique mapped Id for third party restaurant.
- `status` (string, required): API response flag success means success and failed means failed
- `store_status` (string, required): store status can be 1 or 0 where 1 means Open and 0 means Closed.
- `turn_on_time` (string, required): Next opening time. This key will be used only while turning off the store.
- `reason` (string): Required when store_status is 0 (Store off).
- `message` (string): API response message

Examples: `examples-update-store-status.md` (2 unique bodies).
