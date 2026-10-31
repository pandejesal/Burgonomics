# Official Orders API documentation

Source: https://razorpay.com/docs/api/orders
Retrieved UTC: 2026-10-29T11:18:54.295433+00:00
Retrieval method: static

Public webpage text snapshot for local development reference. Not an API conformance or vendor-approval verdict; copyright remains with the publisher. Scripts/styles were not retained or executed.

---

On this page
Back to top
Related Guides
Orders
Orders
Copy page
Copy page
Create, view and update an Order using Razorpay APIs.
Copy page
Copy page
Available in
🇮🇳 India
You can create
Orders
and link them to payments. Orders APIs are used to create, update and retrieve details of Orders. Also, you can retrieve details of payments made towards these Orders.
Fork the Razorpay Postman Public Workspace and try the Orders APIs using your
Test API Keys
.
Create an Order
POST
/v1/orders
Creates an order by providing basic details such as amount and currency.
Fetch All Orders
GET
/v1/orders
Retrieves details of all the orders.
Fetch All Orders (Example 1)
GET
/v1/orders?expand[]=payments
Retrieves details of all the orders and expands the payments object.
Fetch All Orders (Example 2)
GET
/v1/orders?expand[]=payments.card
Retrieves details of all the orders and expands cards parameter in the payments object.
Fetch Order With ID
GET
/v1/orders/:id
Retrieves details of a particular order.
Fetch All Payments for an Order
GET
/v1/orders/:id/payments
Retrieves all the payments made for an order.
Update an Order
PATCH
/v1/orders/:id
Modifies an existing order.
​
Related Guides
About Orders
Set Up Webhooks
Webhook Payloads
Was this page helpful?
Yes
No
Payments
Orders Entity
