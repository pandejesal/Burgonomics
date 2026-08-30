# BURGONOMICS — Project Context & Product Domain (Layer 3 Constraint)

> **Factory Configuration**: Product background, business logic, customer ordering journeys, partner operations, and core tech stack.

---

## 1. Brand Background & Proposition
- **Brand**: Burgonomics — 100% Pure Vegetarian QSR Gourmet Burger Chain.
- **Outlets**: 16+ active and upcoming franchise outlets across Gujarat (Ahmedabad, Surat, Vadodara, Rajkot, etc.).
- **Fulfillment Modes**:
  1. **🛵 Delivery**: Doorstep delivery with Porter logistics API integration and live courier tracking.
  2. **🛍️ Takeaway**: Store pickup with counter ETA, pickup notifications, and 4-digit security PIN.
  3. **🍽️ Dine-In**: Seamless in-store dining order routed to kitchen POS without table selection friction.

---

## 2. Two-App Strategy
1. **Customer App (`burgonomics-foundation-core`)**:
   - Built with React, Vite, TanStack Router, Tailwind CSS, and Capacitor for iOS/Android.
   - Food-first, La Pino'z inspired visual design with strict 60-30-10 palette.
   - 1-tap quick add for burgers and combos; global loyalty points ("Grill Coins"); transparent billing.
2. **Partner POS & Operations App (`burgonomics-partner`)**:
   - Built for Branch Managers, Kitchen Staff, Brand Owners, Support, and Developers.
   - Live order stream & KOT dispatch; dedicated "Book Porter Rider" screen.
   - Outlet-specific combo creation (Branch Managers); Brand-wide combos (Brand Owners/Dev).
   - 3-tier support ticket resolution and auto-escalator.

---

## 3. Technology Stack & Integrations
- **Database**: Google Cloud Firestore (Single source of truth in `asia-south1`).
- **Serverless Backend**: Firebase Cloud Functions v2 (TypeScript in `/functions`).
- **POS Bridge**: Petpooja API (Hourly menu ingestion & payment-confirmed KOT push).
- **Payment Gateway**: Razorpay PG + Razorpay Route (Automated brand royalty splits & auto-refunds).
- **Logistics**: Porter API (Real-time bike courier quotes & dispatch).
- **Push Notifications**: Firebase Cloud Messaging (FCM) + Loud POS Audio alarms.
