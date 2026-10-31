# Draft only — not sent

**To:** Ajaysinh Solanki / Petpooja Integration Team  
**Subject:** Re: Burgonomics DEMO — payload structure and sandbox retest

Hi Ajaysinh,

Thank you for sharing the annotated sample. We have checked both our sandbox and
app-order payload builders against its nesting, field names and field types for
the five requested scenarios. We also identified and corrected a one-paise GST
allocation discrepancy in our local code.

We have not yet resubmitted the orders. Before the rerun for **5439 — Burgonomics
DEMO [135148]**, mapping code **31z58ciw0h**, could you please help with the following?

1. Our last recorded menu push contains no add-on groups or variation definitions.
   Please send a refreshed menu push with configured test items, or share the
   item IDs, add-on IDs, numeric add-on group IDs, variation IDs and prices we
   should use for the add-on, variation and combined scenarios.
2. Should item `price` / `final_price` include the selected add-on prices, or
   should the POS add those prices separately from `AddonItem.details`?
3. When item-level discounts are present, is `discount_total` an additional
   order-level discount, or the combined discount including those item discounts?
4. For an odd-paise GST total such as ₹13.95, is a split of ₹6.98 and ₹6.97
   acceptable? Please confirm if you require a different rounding convention.

For production configuration, please also confirm the applicable GST liability
(`vendor` or `restaurant`) and the treatment of delivery/packing charges and their
taxes in `total` and `tax_total`. We have not changed these policies merely to
copy the illustrative amounts in the sample.

Once the sandbox mappings and conventions are confirmed, we will rerun the same
five scenarios and send the new client order IDs and credential-redacted request
payloads for your review. We understand that an API save response is not the
same as Petpooja's integration approval.

Regards,  
Jesal Pande  
Burgonomics
