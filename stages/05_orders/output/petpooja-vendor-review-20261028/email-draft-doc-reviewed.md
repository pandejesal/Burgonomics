# Revised after full documentation review — draft only, not sent

**To:** Ajaysinh Solanki / Petpooja Integration Team  
**Subject:** Re: Burgonomics DEMO — configuration and five-scenario retest

Hi Ajaysinh,

Thank you for the annotated payload. We have reviewed it alongside the Save Order
and Sandbox guides and the V2.1.0 API documentation. Our offline checks cover the
supplied structure and field types, and we have corrected a one-paise GST
allocation discrepancy in our local code.

The guides confirm that item prices include selected add-ons, `final_price` is
the unit price less item discount, and order discounts use `discount_type` and
`discount_total` without a separate discount object. We are also reconciling the
restaurant-only order total, GST ownership and delivery/COD fields before the rerun.
We have **not yet resubmitted** the five orders.

For **5439 — Burgonomics DEMO [135148]**, mapping code **31z58ciw0h**, please help
with these remaining points:

1. Our last recorded menu push has no usable add-on groups or item-level variation
   definitions. Please send a refreshed push with configured test items, their
   add-on/group mappings, and both variation item IDs and variation-master IDs.
   Please include the applicable `gst_type` and packing/delivery-tax configuration.
2. The Save Order PDF lists the `qle1yy2ydc` API Gateway host, while public V2.1.0
   documentation lists `47pfzh5sf2`, both under `/V1/save_order`. Which endpoint
   should this demo outlet use?
3. Is allocating an odd GST total of ₹13.95 as ₹6.98 and ₹6.97 acceptable, or is
   there a required residual-paise convention for your validator?

Once the mappings are available and our remaining checks are complete, we will
rerun the same five scenarios and share the new client order IDs and
credential-redacted request payloads for your review. We will verify their sandbox
listing and callback actions separately; an API save response is not integration
approval.

Regards,  
Jesal Pande  
Burgonomics
