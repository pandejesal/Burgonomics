# BURGONOMICS — Production-Ready UI/UX Specification (Layer 3 Reference)

> **La Pino'z-Inspired QSR Mobile App Experience (Delivery • Takeaway • Dine-In)**  
> **Version:** 2.0 (Production Release)  
> **Methodology:** Interpretable Context Methodology (ICM — arXiv:2603.16021v2)  
> **Authoritative Backend Alignment:** `references/backend_upgrade_spec.md`, `references/order_flow.md`  
> **Design System Constraints:** Strict 60-30-10 Palette (`_config/design_system.md`), WCAG 2.2 AA Accessibility  

---

## 1. 🎯 Executive Overview & Product Vision

Burgonomics is a 100% Pure Vegetarian QSR (Quick Service Restaurant) mobile application inspired by the clean, high-conversion, food-first interface of **La Pino'z Pizza**, adapted into Burgonomics' signature **Forest Green & Vibrant Orange** visual identity.

The application serves three distinct fulfillment modes:
1. **🛵 Delivery**: Real-time address validation, nearest outlet auto-routing, dynamic delivery fee & free delivery threshold (>₹499), Porter dispatch integration, live driver status tracking.
2. **🛍️ Takeaway**: Store pickup with dynamic counter ETA, outlet directions, 4-digit pickup security PIN, and ready-for-pickup notifications.
3. **🍽️ Dine-In**: Frictionless in-store ordering with zero table selection complexity, routing orders directly to the store POS/KOT with an in-store order token.

### 🔒 Core Architectural & Backend Principles
- **No Item-Level Modifier Customization**: All burgers, sides, and beverages are pre-configured. Combos and special promotional bundles originate directly from **Petpooja POS** or are created via the **Burgonomics Partner app** (Branch Owner = branch-specific; Brand Owner/Support/Dev = brand-wide). Clicking "ADD +" immediately adds the item with 1-tap speed.
- **Single Source of Truth**: Single Firestore database (`orders`, `branches`, `products`, `users`, `support_tickets`, `coupons`).
- **Petpooja POS Bridge**: Hourly menu sync, authoritative MRP at checkout, order push upon verified payment.
- **FCM Push Notifications**: Order lifecycle topic subscriptions (`order_{orderId}`, `branch_{branchId}`).
- **Strict 60-30-10 Rule**: 60% canvas background, 30% Forest Green surfaces/brand headers, 10% Vibrant Orange accent CTAs. Zero raw hex or un-tokenized Tailwind color classes.

---

## 2. 🎨 Design System & Visual Tokens

### 2.1 Color Tokens (Strict 60-30-10 Invariant)

```css
/* Light Mode (:root) */
:root {
  --background: #F5F5F5;         /* 60% Canvas — clean light grey */
  --surface: #FFFFFF;            /* Cards, modals, sheets */
  --surface-elevated: #FFFFFF;   /* Dropdowns, tooltips, popovers */
  --bg-secondary: #F0F3F1;       /* Secondary card background / input fill */
  
  --primary: #0E4825;            /* 30% Brand — Forest Green */
  --primary-hover: #0A371C;
  --primary-foreground: #FFFFFF; /* Crisp white text on green */
  --primary-text: #0E4825;       /* Green text on light surface */
  
  --accent: #FF6600;             /* 10% Accent — Vibrant Orange */
  --accent-hover: #E55C00;
  --accent-foreground: #FFFFFF;  /* White text on accent */
  
  --text-primary: #16281D;       /* High-contrast charcoal text */
  --text-secondary: #586B60;     /* Muted sage secondary text */
  --border: #E5EDE7;             /* Subtle dividers and card borders */
  --divider: #E5EDE7;
  --ring: #FF6600;               /* Focus ring */
  
  --success: #16A34A;            /* 100% Pure Veg badge / status */
  --warning: #F59E0B;            /* Price lock timer / warnings */
  --error: #DC2626;              /* Critical errors / cancellations */
}

/* Dark Mode (.dark) */
.dark {
  --background: #0A0A0A;         /* 60% Canvas — Deep black */
  --surface: #1A1A1A;            /* Dark cards and containers */
  --surface-elevated: #222222;   /* Elevated sheets / modals */
  --bg-secondary: #141414;       /* Dark input fill */
  
  --primary: #0E4825;            /* 30% Brand Forest Green anchor */
  --primary-hover: #145830;
  --primary-foreground: #FFFFFF;
  --primary-text: #4ADE80;       /* WCAG AAA Emerald text on dark surface */
  
  --accent: #CC5200;             /* 10% Accent — Deep Orange for dark bg */
  --accent-hover: #B34700;
  --accent-foreground: #FFFFFF;
  
  --text-primary: #F3F5F4;       /* High-contrast near-white text */
  --text-secondary: #A0A0A0;     /* Muted grey secondary text */
  --border: #262626;
  --divider: #262626;
  --ring: #CC5200;
  
  --success: #22C55E;
  --warning: #FBBF24;
  --error: #EF4444;
}
```

### 2.2 Typography Hierarchy

| Class | Font Family | Size | Weight | Line Height | Usage |
|---|---|---|---|---|---|
| `.type-hero` | MonstroSolid / Outfit | 32px | 800 | 1.2 | Hero promo titles |
| `.type-display` | MonstroSolid / Outfit | 26px | 800 | 1.25 | Major page headlines |
| `.type-headline-large` | MonstroSolid / Outfit | 22px | 700 | 1.3 | Section headers |
| `.type-headline-medium`| MonstroSolid / Outfit | 18px | 700 | 1.35 | Card group headers |
| `.type-title-large` | Montserrat / Inter | 17px | 700 | 1.4 | Product & combo card titles |
| `.type-title-medium`| Montserrat / Inter | 15px | 600 | 1.4 | Category tab labels |
| `.type-body-large` | Montserrat / Inter | 15px | 500 | 1.45 | Lead text / descriptions |
| `.type-body` | Montserrat / Inter | 14px | 400 | 1.45 | Body text & card subtitles |
| `.type-label-large` | Montserrat / Inter | 14px | 700 | 1.4 | Buttons & action pills |
| `.type-caption` | Montserrat / Inter | 12px | 500 | 1.4 | ETA, badges, footnotes |

---

## 3. 📱 Screen-by-Screen UX & UI Architecture

```
+-------------------------------------------------------------------------+
|                               APP FLOW                                  |
|                                                                         |
|  [ Home Screen ] ───► [ Menu & Combos ] ───► [ Cart Screen ]            |
|        │                     │                       │                  |
|        ├─ Mode Switcher      └─ 1-Tap Quick Add      └─ Price Lock      |
|        ├─ Hero Banners       (Sticky Cart Bar)       (Notes / Loyalty)  |
|        ├─ 3-Col Explore                              │                  |
|        ├─ Bestseller Rail                            ▼                  |
|        └─ Franchise/Awards                 [ 1-Page Checkout ]          |
|                                                      │                  |
|                                             (Razorpay / COD)            |
|                                                      ▼                  |
|                                            [ Live Order Tracker ]       |
+-------------------------------------------------------------------------+
```

---

### 3.1 🏠 Screen 1: Home Screen (`src/routes/home.tsx`)

#### A. La Pino'z Full-Bleed Brand Header (`LaPinozHeader.tsx`)
- **Visuals**: Rich Forest Green (`#0E4825`) header with curved bottom (`rounded-b-3xl`), safe-area inset support, and subtle elevation shadow.
- **Top Brand Row**:
  - Left: Burgonomics Burger Logo + "100% Pure Veg" gold badge.
  - Center: Outlet Location pill (e.g., `📍 Prahlad Nagar, Ahmedabad ▼`) with tap-to-change store drawer.
  - Right: Loyalty Points Coin Badge (`🪙 120 pts`) + Profile Avatar with notification badge.
- **Segmented Fulfillment Mode Switcher** (Embedded inside header):
  ```
  [ 🛵 Delivery ]  [ 🛍️ Takeaway ]  [ 🍽️ Dine-In ]
  ```
  - Active tab: Pure White pill with Forest Green bold text + smooth slide indicator.
  - Inactive tabs: Semi-transparent white text (`text-white/80`).
  - Switching behavior:
    - **Delivery**: Opens Address Selector Sheet if no active address is set. Displays ETA (e.g., `25-30 min`).
    - **Takeaway**: Opens Store Picker Sheet. Displays Pickup ETA (e.g., `Ready in 12 min`).
    - **Dine-In**: Auto-confirms current outlet with status chip (`🍽️ Dine-In at Outlet`).
- **Search Pill**:
  - Full-width white rounded search bar (`rounded-full bg-white px-4 py-2.5 shadow-md`).
  - Left: Green search magnifier icon.
  - Placeholder: `"Search delicious burgers, combos, wraps..."`.
  - Right: Pure veg filter indicator (No mic icon).

#### B. Hero Carousel & Promo Banners (`BannerCarousel.tsx`)
- **Slide 1 (Hero Promo)**: Dark green radial gradient card (`radial-gradient(120% 80% at 50% 0%, #1B5934 0%, #0E4825 100%)`), bold headline `"FLAT 50% OFF"`, transparent burger cutout image, and black coupon pill `"Use Code: BURG50"`.
- **Slides 2–4**: Curated combo deals, weekend specials, and student discounts with direct "Order Now" action links.

#### C. Explore Menu — 3-Column Visual Grid (`CategoryGrid.tsx`)
- High-converting 3-column card grid replacing old horizontal text rails.
- Each Card:
  - White surface (`bg-surface`), `rounded-2xl`, `p-3`, `shadow-low`.
  - Circular category food thumbnail (`64px x 64px`) with 2px Forest Green border ring.
  - Bold category name (e.g., `"Smash Burgers"`, `"Loaded Combos"`, `"Cheesy Sides"`, `"Thick Shakes"`, `"Wrap & Rolls"`).
  - Item count subtitle (e.g., `"14 items"`).
  - Tap navigates to `/menu` with that category auto-selected and scrolled into view.

#### D. Quick Reorder Rail (`QuickReorderRail.tsx`)
- Visible for authenticated returning users with past orders.
- 1-tap re-order button to re-add entire past basket to current cart in 1 click.

#### E. Bestsellers & Curated Combos Rails (`HorizontalRail.tsx` + `BestSellerCard.tsx`)
- Horizontal snap-scroll rail of top-selling items and pre-configured value combos.
- **Card Specifications**:
  - `w-[210px]`, `rounded-2xl`, `bg-surface`, `border border-border`, `shadow-low`, `overflow-hidden`.
  - Full-width food photo with `100% Pure Veg` green square-dot badge at top-left.
  - Title (1-line clamp, bold `type-title-large`).
  - Short appetizing description (1-line clamp).
  - Bottom row: Bold Price (`₹149`) on left, Outlined Green `"ADD +"` pill button on right.
  - Tapping `"ADD +"` instantly adds item to cart with haptic feedback, updates floating cart bar, and renders a `+ 1 -` quantity stepper.

#### F. Brand Trust & Franchise Banner (`FranchiseBanner.tsx` + `TrustSection.tsx`)
- **100% Pure Veg Trust Guarantee**: Highlighting zero cross-contamination, fresh farm buns, and chef-crafted patties.
- **Franchise Opportunity Banner**:
  - Forest green card: `"Own a Burgonomics Outlet — 16+ Outlets Across Gujarat & Growing"`.
  - Action button: White pill `"Enquire Now"` opening the in-app franchise inquiry modal.

---

### 3.2 🍔 Screen 2: Menu & Combos Screen (`src/routes/menu.index.tsx`)

- **Sticky Top Bar**: Outlet status, fulfillment mode badge, search trigger, and Veg filter toggle.
- **Sticky Horizontal Category Pills Bar** (`CategoryTabs.tsx`):
  - Categories: `All`, `🔥 Combos`, `🍔 Smash Burgers`, `🍟 Fries & Sides`, `🥤 Shakes & Drinks`, `🌯 Wraps`, `🍨 Desserts`.
  - Active pill: Solid Forest Green (`bg-primary text-white font-bold rounded-full shadow-sm`).
  - Inactive pill: Subdued surface pill with subtle border.
  - Smooth programmatic scroll-to-section on tab click.
- **Product Card Layout (`MenuProductCard.tsx`)**:
  - Clean two-column card: Left side contains Veg badge, product title, item description, and price; Right side contains rounded food photo (`110px x 110px`) with `"ADD +"` button overlapping the bottom of the image.
  - Direct 1-tap add (No complex customization sheet; items are pre-configured Petpooja products and partner-created combos).

---

### 3.3 🛒 Sticky Mini-Cart Bar (`FloatingCartBar.tsx`)

- **Placement**: Fixed floating pill directly above the 4-tab bottom navigation bar on both Home and Menu screens.
- **Visibility**: Automatically slides up whenever `cart.itemCount > 0`.
- **Content**:
  - Left: Item count badge (`2 Items`) + Total Price (`₹388`) + `"Taxes extra"`.
  - Right: Forest green button with white text `"View Cart →"` with subtle pulse indicator.
  - Tap navigates directly to `/cart`.

---

### 3.4 🛍️ Screen 3: Full Cart Screen (`src/routes/cart.tsx`)

- **Fulfillment Banner**: Shows current mode (`🛵 Delivering to: Home (32, Silver Oak...)` / `🛍️ Takeaway from: Prahlad Nagar`) with a `"Change"` action link.
- **10-Minute Price Lock Timer Banner**:
  - Live amber countdown badge (`⏳ Price locked for 08:45`).
- **Cart Line Items Card**:
  - Product thumbnail, veg badge, item name, unit price.
  - Inline `[-] [Qty] [+]` stepper.
  - Item total with instant recalculation.
- **Special Cooking & Packaging Notes**:
  - Quick chips: `"Less Spicy"`, `"Extra Napkins"`, `"No Onion/Garlic"`, `"Contactless Delivery"`.
  - Freeform text input.
- **Complete Value Transparency Bill Breakdown**:
  - Item Total
  - 5% GST (CGST 2.5% + SGST 2.5%)
  - Restaurant Packaging Charge (₹5)
  - Delivery Fee (₹29 or `FREE` if order > ₹499 for Delivery; ₹0 for Takeaway/Dine-In)
  - Discounts / Promo applied
  - Loyalty Points redeemed
  - **Grand Total Payable**
- **Bottom Fixed CTA**: `"Proceed to Checkout (₹XXX) →"`

---

### 3.5 💳 Screen 4: Single-Page Production Checkout (`src/routes/checkout.tsx`)

Clean, structured, single-page accordion/card checkout flow:

```
+-------------------------------------------------------------+
| 1. Fulfillment & Address / Outlet Card                      |
|    - Delivery: Selected Address + Change Address link       |
|    - Takeaway: Store Address + Pickup ETA                   |
|    - Dine-In: Store Name + Dine-In Counter Service          |
+-------------------------------------------------------------+
| 2. Order Review & Cooking Notes                             |
|    - Compact item list (x2 Smash Burger, x1 Peri Peri Fries)|
|    - Active special notes                                   |
+-------------------------------------------------------------+
| 3. Coupons & Loyalty Rewards                                |
|    - [ BURG50 ] [ Apply ]                                   |
|    - Redeem Grill Coins (Available: 120 pts = ₹120 OFF)     |
+-------------------------------------------------------------+
| 4. Bill Summary                                             |
|    - Item Total: ₹380 | GST (5%): ₹19 | Packing: ₹5        |
|    - Delivery Fee: FREE | Coupon Discount: -₹50             |
|    - To Pay: ₹354                                           |
+-------------------------------------------------------------+
| 5. Payment Method Selector                                  |
|    - 🟢 Razorpay (UPI: GPay/PhonePe/Paytm, Cards, Netbank)  |
|    - ⚪ Cash on Delivery / Pay at Counter                   |
+-------------------------------------------------------------+
| [ PAY ₹354 SECURELY / PLACE ORDER ]  (Sticky Bottom Button) |
+-------------------------------------------------------------+
```

---

### 3.6 📍 Screen 5: Live Order Confirmation & Real-Time Tracking (`src/routes/orders.$orderId.track.tsx`)

- **Header**: Order ID (`#BURG-8921`) + Live Status Badge (`Cooking in Kitchen`).
- **Visual Animated Progress Stepper**:
  - Step 1: `Order Placed & Confirmed` (POS Acknowledged)
  - Step 2: `Grilling in Kitchen` (Animated burger flame illustration)
  - Step 3:
    - *For Delivery*: `Out for Delivery with Porter` (Driver name, phone icon, vehicle number)
    - *For Takeaway*: `Ready for Pickup at Counter` (Prominent 4-Digit Pickup PIN: `7 4 1 9`)
    - *For Dine-In*: `Order Ready at Counter / Dine-In Table`
  - Step 4: `Delivered / Order Enjoyed`
- **Dynamic ETA Countdown**: Large prominent circular countdown timer (`14 Mins Remaining`).
- **Support & Actions**:
  - `📞 Call Restaurant` (Direct phone call to outlet manager).
  - `💬 Chat with Support` (Opens instant support ticket).
  - `🧾 View Detailed Receipt` (Expandable itemized tax invoice).

---

### 3.7 👤 Screen 6: Profile, Loyalty & Support (`src/routes/profile.index.tsx`)

- **Profile Card**: Customer Name, Phone, VIP Tier ("Grill Master").
- **Grill Club Loyalty Pass**:
  - Gold-gradient loyalty balance card showing available coins, redemption history, and benefits.
- **Navigation Menu List**:
  - 📦 `My Orders & Reorder`
  - 📍 `Saved Addresses` (Home, Work, Other with GPS tag)
  - 🎟️ `My Coupons & Offers`
  - 🏢 `Franchise Enquiry` (Interactive lead submission)
  - 🎧 `Help & Support Tickets` (24h SLA ticket creation & status)
  - ⚙️ `App Settings & Dark Mode Toggle`
  - 🚪 `Logout`

---

## 4. 🧭 Bottom Tab Bar Navigation (`BottomTabBar.tsx`)

Fixed 4-tab bar (La Pino'z style):

```
+---------------------------------------------------------------+
|   [ 🏠 Home ]    [ 🍔 Menu ]    [ 🛍️ Cart (2) ]   [ 👤 Profile ] |
+---------------------------------------------------------------+
```
- Active tab: Forest Green icon & label + emerald active top indicator line.
- Inactive tabs: Muted charcoal/grey.
- Cart badge: Vibrant Orange counter pill (`bg-accent text-white`).

---

## 5. 🧪 Verification & Acceptance Quality Gates

Before any UI/UX milestone is marked complete, all of the following commands must execute cleanly with zero errors:

```bash
# 1. Type check
npx tsc --noEmit

# 2. Unit & Integration test suite
npx vitest run

# 3. Web build
npm run build

# 4. Mobile Capacitor build
npm run build:mobile
```
