# Official webhook best practices

Source: https://razorpay.com/docs/webhooks/best-practices
Retrieved UTC: 2026-10-29T11:18:54.307171+00:00
Retrieval method: static

Public webpage text snapshot for local development reference. Not an API conformance or vendor-approval verdict; copyright remains with the publisher. Scripts/styles were not retained or executed.

---

On this page
Back to top
Delivery Attempts and Retries
Disable Logic
Event Handling
Handle Duplicate Events
Order Of Events
Security
Receive events with an HTTPS server
Verify Events are Sent from Razorpay
Webhooks
Best Practices
Copy page
Copy page
Best practices to adhere to when using Razorpay notification webhooks.
Copy page
Copy page
Available in
🇮🇳 India
🇲🇾 Malaysia
🇸🇬 Singapore
🇺🇸 United States
Webhooks provide an effective method to track the state of transactions and to take appropriate actions within your Razorpay account. Take a look at these best practices to ensure your webhooks remain secure and function seamlessly with your integration.
​
Delivery Attempts and Retries
Every event that receives a non-2xx response is considered an event delivery failure by Razorpay’s system. If there is a delivery failure, we retry the delivery in exponential backoff policy for 24 hours after event creation timestamp.
Watch Out!
Webhooks are delivered in near real-time and are asynchronous. For business-critical, synchronous use cases, you may choose to poll our payment APIs as well.
​
Disable Logic
A webhook is retried at progressive intervals of time on failure, defined in the exponential backoff policy, for 24 hours. If the webhooks continue to fail for 24 hours, the webhook is disabled. You need to enable the webhook from the Dashboard after fixing the errors at your end.
Whenever a webhook is disabled, you are notified on your
Alert Email Address
as configured during webhook setup. In case you have not provided an
Alert Email Address
during webhook set up, we send a mail to the email address configured under
Account & Settings
on the Dashboard.
Watch Out!
Please note that Razorpay considers any non-2xx response as an event delivery failure. Please make sure the API responds with 2xx when you successfully consume the event at your end.
You can also manually disable webhooks from the Dashboard. Know more about
Payments Deactivation
and
RazorpayX Deactivation
.
​
Event Handling
Correct handling of webhook events is crucial to ensuring your integration’s business logic works as expected.
​
Handle Duplicate Events
There could be scenarios where your endpoint might receive the same webhook event multiple times. This is an expected behaviour based on the webhook design. In such a scenario, we recommend you to follow
idempotency
.
You could be receiving the same events multiple times as Razorpay follows at-least-once delivery semantics. In this approach, if we do not receive a successful response from your server, we resend the webhook. There could be situations where your server accepts the event but fails to respond in 5 seconds. In such cases, the session is marked timeout. It is assumed that the webhook was not processed and is sent again.
Handy Tips
To prevent an event from being missed:
Ensure you configure your server to handle or receive the same event details multiple times.
Check the value of the
x-razorpay-event-id
in the webhook request header. The value for this header is unique per event and can help you determine the duplicity of a webhook event.
​
Order Of Events
Ideally, you should receive a webhook in the order in which the webhook events occur. However, you may not always receive the webhooks in order. Know more about
Order of Webhooks
.
​
Security
Maintaining your endpoints secure is crucial to protecting your customer’s information. Razorpay provides various methods to verify that events are securely coming from us.
​
Receive events with an HTTPS server
Razorpay Production environment does not support the older versions of TLS 1.0 and 1.1 due to security concerns around these protocols. The TLS protocol is used to encrypt your servers communications with Razorpay, so your integration must use the latest version (TLS 1.2 is much more secure than its predecessors). As an integration checklist, please whitelist all the
Webhook IPs
.
​
Verify Events are Sent from Razorpay
You can
verify webhook signatures
to confirm that received events are sent from Razorpay.
You can also
resolve webhook signature validation errors
.
Was this page helpful?
Yes
No
Payouts
Validate and Test Webhooks
