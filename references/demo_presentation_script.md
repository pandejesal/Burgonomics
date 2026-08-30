# BURGONOMICS — Executive Demo Script (Slide-by-Slide) (Layer 3 Reference)

> **For office walkthrough and executive presentations.** Companion to `BURGONOMICS_Executive_Demo_Presentation.pptx`.

---

## 📱 Device Setup (Before Walkthrough)

- [ ] Phone connected, debug USB on
- [ ] App launched, on `Home` screen
- [ ] Demo user logged in (seeded `demo_user_001`)
- [ ] Active store: `Burgonomics Mansi Circle` (or current GPS nearest)
- [ ] Dark/Light toggle tested (Settings → Theme)

---

## 🎬 Slide-by-Slide Walkthrough

### Slide 1 — Title
**Action:** Show title, hand phone to reviewer  
**Talk:** "BURGONOMICS — 100% Pure Veg, 16 outlets, zero aggregator cut."

---

### Slide 2 — Executive Summary
**Action:** Tap through 4 value props verbally; no screen taps needed.  
**Key lines:**
- "Zero aggregator cut — save 15-30% per order"
- "Direct customer loyalty — we own the phone number, order history"
- "16 outlets unified — Ahmedabad, Surat, expanding"
- "Instant KOT via Petpooja — zero manual entry"

---

### Slide 3 — Product Highlights (Tap Through App)

| Feature | Tap Path | What to Show |
|---|---|---|
| **Intelligent Store Discovery** | Home → top location | GPS auto-detect, distance km, ETA |
| **Dynamic Rich Menu (63 items)** | Home → Explore Menu grid | 3-col cards, veg dots, item counts |
| **1-Tap Quick Add** | Home → BestSellers | Outlined green ADD button, haptic feedback, mini-cart slide-up |
| **Fulfillment Mode Switcher** | Home → Header | Toggle Delivery / Takeaway / Dine-In |
| **Animated Order Tracker** | Orders → Track Order | Preparation animation, ETA countdown, 4-digit PIN |
| **Brand Trust Section** | Home → scroll down | Pure Veg guarantee, franchise enquiry |

---

### Slide 4 — Technical Architecture
**Talk:** "Clean monorepo structure, single Firestore database, Firebase Functions v2 in `asia-south1`."
- Dual mobile apps: Customer (`burgonomics-foundation-core`) and Partner POS (`burgonomics-partner`)
- Direct integration bridges: Petpooja POS (hourly sync & instant 86ing), Porter logistics, Razorpay Route marketplace splits.

---

### Slide 5 — Design System (Strict 60-30-10)
**Action:** Flip Light/Dark theme live in front of audience.
- Light Mode: `#F5F5F5` Canvas (60%), `#0E4825` Forest Green (30%), `#FF6600` Vibrant Orange (10%).
- Dark Mode: `#0A0A0A` Canvas (60%), `#0E4825` Forest Green (30%), `#4ADE80` High-Contrast Text, `#CC5200` Deep Orange (10%).

---

### Slide 6 — Quality & Verification
**Talk:** "Every commit verified through ICM gates: `tsc --noEmit`, `vitest`, and production mobile builds."
