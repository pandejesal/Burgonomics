# OpenCode Stream 1: Burgonomics Customer App Launch Enhancements

You are working in `burgonomics-foundation-core`. Implement the following launch requirements cleanly:

## 1. Store Operating Hours (11:00 AM to 11:00 PM IST)
- Kitchen hours are strictly 11:00 AM to 11:00 PM (11:00 - 23:00 IST).
- When outside operating hours:
  - Menu browsing is enabled.
  - Floating cart bar and Checkout button are disabled.
  - Display a prominent banner at the top of Menu and Checkout:
    "We are currently closed. Kitchen opens at 11:00 AM."

## 2. Order Type Toggle on Checkout Screen
- On Checkout screen, add a prominent segmented control:
  `[ 🛵 Delivery ]` `[ 🛍️ Takeaway ]` `[ 🍽️ Dine-In ]`
- If **Delivery**:
  - Enforce ₹149 minimum basket subtotal. If < ₹149, show: "Minimum order value for delivery is ₹149."
  - Delivery fee = Dynamic quote (default ₹35 sandbox) + ₹20 packaging charge.
  - Payment method restricted strictly to **Prepaid (Razorpay UPI, Cards, Netbanking)**.
- If **Takeaway** or **Dine-In**:
  - No minimum order value.
  - Delivery fee = ₹0. Packaging fee = ₹15 for Takeaway, ₹0 for Dine-In.
  - Payment method allows both **Razorpay Online** and **Pay at Counter / Cash**.

## 3. GST Inclusive Bill Breakdown
- Menu prices are inclusive of 5% GST.
- Order summary displays:
  - Items Subtotal (incl. 5% GST)
  - Taxes (CGST 2.5% + SGST 2.5% - included in price)
  - Packaging Fee
  - Delivery Fee
  - Total To Pay

## 4. Test Phone Bypass in `authService.ts`
- Ensure phone number `9106515036` (or `+919106515036`) allows smooth login with test OTP `123456` or `12356` without getting blocked by reCAPTCHA in WebView.

Run `npm run build:mobile` to verify zero TypeScript errors and a clean build.
