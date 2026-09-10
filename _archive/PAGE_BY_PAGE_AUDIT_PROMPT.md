# BURGONOMICS — Master Page-by-Page Audit & Code Improvement Guide

> **Target Workspace**: `C:\Users\DELL\Desktop\Burgonomics`  
> **Apps Covered**:  
> 1. **Delivery / Customer App**: `burgonomics-foundation-core/` (React, TanStack Router, Tailwind CSS, Capacitor)  
> 2. **Partner / POS Ops App**: `burgonomics-partner/` (React, React Router, Tailwind CSS, Capacitor)

---

## 🎯 Master Prompt (Copy & Paste for any AI Agent)

```markdown
You are an expert full-stack engineer, UI/UX auditor, and mobile app specialist for the Burgonomics ecosystem located at:
C:\Users\DELL\Desktop\Burgonomics

You are conducting a strict, interactive, page-by-page audit and refactoring cycle with me across both applications:
1. Customer / Delivery App (`burgonomics-foundation-core/` - React + TanStack Router + Tailwind CSS + Capacitor)
2. Partner POS & Ops App (`burgonomics-partner/` - React + React Router + Tailwind CSS + Capacitor)

### STRICT OPERATING RULES:
1. WORK STRICTLY ONE PAGE AT A TIME: Never edit random files or jump between screens without my explicit confirmation.
2. INTERACTIVE CYCLE:
   - Always ask: "Which app and page should we inspect or improve next?" (or display the remaining list).
   - I will specify the screen and detail all issues (UI bugs, alignment, color contrast, missing features, broken state, navigation errors, business logic flaws).
   - Locate the exact route and source file in the project.
   - Explain the root cause and your proposed solution.
   - Apply the code changes directly to the codebase.
   - Respect the 60-30-10 Brand Palette:
     * Light: Canvas #F5F5F5 (60%), Forest Green #0E4825 (30%), Vibrant Orange #FF6600 (10%)
     * Dark: Canvas #0A0A0A (60%), Forest Green #0E4825 (30%), Text #4ADE80, Accent #CC5200 (10%)
   - Run verification (`npx tsc --noEmit`) to ensure 0 TypeScript regressions.
   - Prompt me to review the result and ask which page to tackle next.
```

---

## 📋 Comprehensive Screen & Route Inventory

### 1. 🛵 Delivery / Customer App (`burgonomics-foundation-core`)
| Route / Screen | File Path | Description / Key Components |
|---|---|---|
| **`/`** (Splash / Entry) | `src/routes/index.tsx` | Initial bootstrap, splash branding & navigation redirect |
| **`/home`** | `src/routes/home.tsx` | 3-way toggle (Delivery, Takeaway, Dine-In), hero carousel, categories |
| **`/menu`** | `src/routes/menu.index.tsx` | Menu items list, dietary filters, sticky category bar, 1-tap quick add |
| **`/menu/product/:productId`** | `src/routes/menu.product.$productId.tsx` | Product detail customizer (patty options, gourmet sauces, add-on sides, drink upsells) |
| **`/cart`** | `src/routes/cart.tsx` | Mini-cart, delivery notes, cutlery toggle, BOGO promo validator, item bill breakdown |
| **`/checkout`** | `src/routes/checkout.tsx` | Delivery address selector, delivery time slots, tip selection, order summary |
| **`/payment`** | `src/routes/payment.tsx` | Razorpay payment sheet, UPI intent trigger, Card/Netbanking, retry handling |
| **`/order-confirmation/:id`** | `src/routes/order-confirmation.$orderId.tsx` | Order placed confirmation, live preparation estimate, route to live tracking |
| **`/orders/:id/track`** | `src/routes/orders.$orderId.track.tsx` | Live Porter rider GPS tracking, milestone stepper (Placed → Kitchen → Rider Assigned → Delivered) |
| **`/orders`** | `src/routes/orders.index.tsx` | Past order history, re-order button, invoice receipt link |
| **`/stores`** | `src/routes/stores.tsx` | Branch / kitchen outlet picker, distance calculation, operational hours check |
| **`/offers`** | `src/routes/offers.tsx` | Promo coupon list, Grill Coins loyalty redemption, cashback cards |
| **`/search`** | `src/routes/search.tsx` | Live search query, tag filtering, recent searches, zero-result fallbacks |
| **`/auth/login`** | `src/routes/auth.login.tsx` | Mobile number input (+91), terms checkbox, reCAPTCHA trigger |
| **`/auth/otp`** | `src/routes/auth.otp.tsx` | 6-digit OTP verification grid, auto-fill, resend timer |
| **`/profile`** | `src/routes/profile.index.tsx` | Account details, Grill Coins balance, quick navigation links |
| **`/profile/addresses`** | `src/routes/profile.addresses.tsx` | Saved addresses (Home, Work, Other), GPS pin drop, edit/delete |
| **`/profile/favorites`** | `src/routes/profile.favorites.tsx` | Bookmarked favorite burgers and meals |
| **`/profile/settings`** | `src/routes/profile.settings.tsx` | Notification preferences, Dark/Light mode toggle, delete account |
| **`/support`** | `src/routes/support.tsx` | Help desk, order dispute filing, live ticket status |

---

### 2. 🏪 Partner POS & Operations App (`burgonomics-partner`)
| Route / Screen | File Path | Description / Key Components |
|---|---|---|
| **`/login`** | `src/pages/LoginPage.tsx` | Role-based login (Branch Manager, Kitchen Staff, Dispatcher, Admin) |
| **`/kds`** | `src/pages/KDSPage.tsx` | Kitchen Display System: full-screen order tickets, prep timers, item modifier checklists, bump-bar action |
| **`/dashboard`** | `src/pages/DashboardPage.tsx` | Real-time ops summary: today's revenue, active KDS tickets, Porter dispatches, avg prep time |
| **`/orders`** | `src/pages/OrdersPage.tsx` | Master incoming order feed, audio alarm chime, status filtering (New, In Kitchen, Ready, Dispatched) |
| **`/orders/:id`** | `src/pages/OrderDetailPage.tsx` | Detailed order view, Petpooja thermal KOT reprint, customer notes, status override |
| **`/delivery-queue`** | `src/pages/DeliveryQueuePage.tsx` | Porter 3PL courier assignment, rider OTP verification, tracking links, vehicle selection |
| **`/menu`** | `src/pages/MenuPage.tsx` | Live menu item 86-ing (stock toggle), variant price overrides, category grouping |
| **`/tickets`** | `src/pages/TicketsPage.tsx` | Customer support ticket queue, 3-tier severity tags, SLA countdown timer |
| **`/tickets/:id`** | `src/pages/TicketDetailPage.tsx` | Ticket conversation thread, refund issuance, supervisor escalation |
| **`/chat`** | `src/pages/ChatPage.tsx` | Direct real-time chat with ordering customers |
| **`/customers`** | `src/pages/CustomersPage.tsx` | Customer directory, total spend, loyalty points, order frequency |
| **`/customers/:id`** | `src/pages/CustomerDetailPage.tsx` | Individual customer profile, order history, internal staff notes |
| **`/branches`** | `src/pages/BranchesPage.tsx` | Franchise store management, geo-fence radius, operational toggle (Online/Offline) |
| **`/analytics`** | `src/pages/AnalyticsPage.tsx` | Razorpay Route royalty calculations, sales breakdowns, top-selling burgers |
| **`/settings`** | `src/pages/SettingsPage.tsx` | Thermal printer setup (ESC/POS), sound notifications, auto-accept toggle |
| **`/admin/*`** | `src/pages/admin/AdminRoutes.tsx` | Super-admin portal (user RBAC management, global audits, system logs) |

---

## 🛠️ Verification Commands

Before concluding changes on any page, verify there are no compilation or typing issues:

```bash
# Verify Customer App
cd C:\Users\DELL\Desktop\Burgonomics\burgonomics-foundation-core
npx tsc --noEmit

# Verify Partner App
cd C:\Users\DELL\Desktop\Burgonomics\burgonomics-partner
npx tsc --noEmit
```
