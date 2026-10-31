# Official Payments API documentation

Source: https://razorpay.com/docs/api/payments
Retrieved UTC: 2026-10-29T11:18:54.338852+00:00
Retrieval method: static

Public webpage text snapshot for local development reference. Not an API conformance or vendor-approval verdict; copyright remains with the publisher. Scripts/styles were not retained or executed.

---

On this page
Back to top
Related Guides
Payments
Payments
Copy page
Copy page
Capture and fetch Payments using Razorpay APIs.
Copy page
Copy page
Available in
🇮🇳 India
🇲🇾 Malaysia
🇸🇬 Singapore
Payments APIs are used to capture and fetch payments. You can also fetch payments based on orders and card details of payment.
Handy Tips
You can use Payments API only to retrieve payment details or change the status from
authorized
to
captured
and
not
to collect payments. You can use our
products
to accept payments.
Fork the Razorpay Postman Public Workspace and try the Payments APIs using your
Test API Keys
.
Capture a Payment
POST
/v1/payments/:id/capture
Captures a payment.
Fetch a Payment With ID
GET
/v1/payments/:id
Retrieves details of a specific payment using id.
Fetch a Payment With ID (Example 1)
GET
/v1/payments/:id/?expand[]=card
Retrieves details of all the payments that is created, with the
card
parameter.
Fetch a Payment With ID (Example 2)
GET
/v1/payments/:id/?expand[]=emi
Retrieves details of all the payments that is created, with the
emi
parameter.
Fetch a Payment With ID (Example 3)
GET
/v1/payments/:id/?expand[]=offers
Retrieves details of all the payments that is created, with the
offers
parameter.
Fetch All Payments
GET
/v1/payments
Retrieves details of all payments.
Fetch All Payments (Example 1)
GET
/v1/payments?expand[]=card
Retrieves expanded card details of a payment.
Fetch All Payments (Example 2)
GET
/v1/payments?expand[]=emi
Retrieves expanded EMI details of a payment.
Fetch Payments Based on Orders
GET
/v1/orders/:id/payments
Retrieves payments linked to an Order.
Fetch Card Details of a Payment
GET
/v1/payments/:id/card
Retrieves card details of a payment.
Update a Payment
PATCH
/v1/payments/:id/
Edits an existing payment.
​
Related Guides
About Payments
Set Up Webhooks
Sample Payloads
Was this page helpful?
Yes
No
Glossary
Orders
