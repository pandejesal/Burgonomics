# Burgonomics — Owner / Ops Info Needed

One file for everything the Burgonomics team must supply before production.
Fill in the values (or confirm the existing ones) and hand it back — every
item lists the exact code location it unblocks. Items marked **[BLOCKING]**
hold up store submission or legal compliance; the rest can follow.

> How to use: replace each `___` with the real value, tick the box, return.
> Nothing here is a secret — but production keys (section E) must be set in
> the hosting dashboard / `functions/.env`, NEVER pasted into chat or docs.

---

## A. Legal & company identity **[BLOCKING]**

- [ ] **A1. CIN** — now `UXXXXXGJ2024PTCXXXXXX`
  `burgonomics-foundation-core/src/routes/terms.tsx:66`, `src/routes/privacy.tsx:46`
  Real value: ___
- [ ] **A2. GSTIN** — now `24XXXXXXXXXX1Z5` in terms/privacy but `24XXXXXXXXX1Z5`
  (one X fewer) in app constants. Confirm the canonical number (fixes the mismatch too)
  `src/routes/terms.tsx:66`, `src/routes/privacy.tsx:46`, `src/core/constants/app.ts:13-14`
  Real value: ___
- [ ] **A3. FSSAI license no.** — now `1072XXXXXXXXXX`. **One per outlet**
  (terms promises per-store display on menu & checkout)
  `src/routes/terms.tsx:66`, `src/core/constants/app.ts:13`
  Akshar Chowk: ___ | Motera: ___ | others: ___
- [ ] **A4. Customer helpline** — now `+91-7XXXXXXXXX` (Mon–Sun 10am–11pm IST).
  Confirm number AND hours
  `src/routes/terms.tsx:67`, `src/routes/privacy.tsx:140`
  Real value: ___
- [ ] **A5. Legal entity + registered address** — now
  `Burgonomics Foods Pvt Ltd, Glassdoors Studio, Ahmedabad, Gujarat – 380015, India`
  `src/routes/terms.tsx:34,65`, `src/routes/privacy.tsx:46`
  Confirmed / corrected: ___
- [ ] **A6. Foods vs Foodworks** — invoice footer says `Burgonomics Foodworks
  Pvt. Ltd.` Everything else says Foods. Confirm one. Also confirm: is a GST
  tax invoice (GSTIN + FSSAI printed) required, or is the current order-receipt
  wording acceptable?
  `src/features/orders/components/InvoiceDownloadButton.tsx:97-98`
  Decision: ___

## B. Support & grievance contacts

- [ ] **B1. Canonical support inbox** — `support@burgonomics.com` (terms, about,
  app constants) vs `support@burgonomics.in` (invoice footer). Pick one
  `src/routes/terms.tsx:67,91`, `src/routes/about.tsx:60`,
  `src/core/constants/app.ts:8`,
  `src/features/orders/components/InvoiceDownloadButton.tsx:151`
  Decision: ___
- [ ] **B2. Grievance Officer name** — now `[Name], Manager — Legal`
  `src/routes/privacy.tsx:136`
  Real value: ___
- [ ] **B3. Grievance street address** — now `Glassdoors Studio, [Building/Street],
  Ahmedabad, Gujarat – 380015, India`
  `src/routes/privacy.tsx:140`
  Real value: ___
- [ ] **B4. Grievance phone** — now `+91-7XXXXXXXXX` (same as A4? confirm same or separate)
  `src/routes/privacy.tsx:140`
  Real value: ___
- [ ] **B5. Privacy inboxes** — confirm `privacy@burgonomics.com` (grievance),
  `nodal@burgonomics.com` (nodal), `dpo@burgonomics.com` (DPO) + nodal officer
  name ("Same as Grievance Officer"?)
  `src/routes/privacy.tsx:138,142,144`, `src/core/constants/app.ts:9-10`
  Confirmed: ___
- [ ] **B6. Support channels (backend-driven, empty without backend)** — supply
  call number, email, WhatsApp URL, chat/form availability for `GET /v1/support/channels`
  `src/features/support/services/supportService.ts:203-218`, `src/routes/support.tsx:156-176`
  Values: ___
- [ ] **B7. FAQs + issue categories (backend-driven)** — supply FAQ Q/A set and
  ticket categories (fallback today is honest "No FAQs")
  `src/features/support/services/supportService.ts:184-234`, `src/routes/support.tsx:196-234`
  Values: ___
- [ ] **B8. SLA + ticket backend** — privacy promises acknowledgement in 24h,
  resolution in 15 days (IT Rules). Support screen is on-device drafts until the
  ticket backend lands. Confirm SLA + ticket API ownership
  `src/routes/privacy.tsx:146`, `src/routes/support.tsx:119-131`
  Confirmed: ___
- [ ] **B9. Retention promises** — GST invoices 8 yrs, addresses until erasure,
  OTP logs 180 days, tickets 3 yrs, storage in Mumbai (asia-south1) only. Confirm
  `src/routes/privacy.tsx:118,127`
  Confirmed: ___
- [ ] **B10. About → restaurant info wording** — `Burgonomics Foods Pvt. Ltd. /
  FSSAI-licensed & regularly audited kitchens`. Confirm
  `src/routes/about.tsx:53-63`
  Confirmed: ___

## C. Social links

- [ ] **C1. Real URLs for Instagram, X, YouTube, LinkedIn** — currently dead chips
  with "launching alongside our next store"
  `src/routes/about.tsx:66-80`
  URLs: ___

## D. Brand copy sign-off

- [ ] **D1. Our story** (2 paras, about page) `src/routes/about.tsx:39-50`
  Approved / edits: ___
- [ ] **D2. "100% Pure Veg" promise** + zero-cross-contamination claim
  `src/core/constants/app.ts:7`, `src/routes/terms.tsx:68`
  Approved / edits: ___
- [ ] **D3. Home trust guarantees** ("Mascot Approved" etc.)
  `src/features/home/components/TrustSection.tsx:10-55`
  Approved / edits: ___
- [ ] **D4. Tagline + SEO** — "The House of DAMN GOOD BURGERS!!"
  `src/core/constants/app.ts:2,6`
  Approved / edits: ___

## E. Production integration keys **[BLOCKING]** (set in dashboards, never here)

- [ ] **E1. Firebase project** — confirm canonical (`burgonomics-7faa8` vs
  `snappy-splice-9pt51` in applet config) + supply the 7 `VITE_FIREBASE_*` values
  `.env.example:17-23`
  Done: ___
- [ ] **E2. Razorpay live key** — `rzp_live_*` + server key/secret/webhook secret;
  confirm real payments API base (now `/.netlify/functions/payments`)
  `.env.example:49-51`
  Done: ___
- [ ] **E3. Petpooja merchant keys** — app key/secret/access token (server `.env`
  only) + per-store `petpoojaRestId` + `VITE_PETPOOJA_ENABLED=true`
  `.env.example:54-58,70-80`
  Done: ___
- [ ] **E4. Porter keys** — API key / customer ID / webhook secret (server only)
  `.env.example:71`
  Done: ___
- [ ] **E5. Push/FCM** — VAPID public key + enable flag (in scope?)
  `.env.example:43-46`
  Done: ___
- [ ] **E6. reCAPTCHA / App Check** — site key (web), Play Integrity / App Attest (native)
  `.env.example:60-62`
  Done: ___
- [ ] **E7. Maps + API base** — Maps key; confirm API base URL
  `.env.example:25-31,52-53`
  Done: ___
- [ ] **E8. Server/admin misc** — OTP HMAC secret, Firebase service account,
  analytics key, seed RBAC admins (`brand_owner` Yash, branch operators)
  `.env.example:40-41,65-86`
  Done: ___

## F. Stores & ops data **[BLOCKING for menu/orders]**

- [ ] **F1. Real outlet list** — name, address, city/state/pincode, phone,
  lat/lng, `petpoojaRestId`, hours, fulfillment modes, ETA, delivery fee/radius,
  pricing overrides. (17 outlets referenced; seed source file missing)
  `scripts/seed.ts:23,94-120`, `src/features/stores/models/Store.ts:24-69`
  Values: ___
- [ ] **F2. Confirm fallback values** — Ahmedabad defaults, +91 79 4000 0000,
  11:00–23:00, ₹40 delivery, 7 km radius
  `src/features/stores/services/storesService.ts:12-36`
  Confirmed: ___
- [ ] **F3. Confirm ops economics** — 5% GST, ₹5/item packing, ₹40 delivery,
  free ≥₹499, Porter ≈₹40 + ₹10/km
  `scripts/seed.ts:84-91`, `src/routes/terms.tsx:56`
  Confirmed: ___
- [ ] **F4. Per-store FSSAI field** — terms promises per-store display but the
  Store model has no license field. Approve adding it (then supply per A3)
  `src/features/stores/models/Store.ts:24-69`
  Approved: ___
- [ ] **F5. Demo leftovers to remove** — default `storeId str_ahmedabad_01` for
  payments, mock Bandra GPS-fallback toast. Confirm removal approved
  `src/core/integrations/razorpay/index.ts:49`, `src/routes/stores.tsx:187`
  Approved: ___

## G. Placeholders & inconsistencies to resolve

- [ ] **G1.** Confirm synthetic profile email domain (`.in` vs `.com`)
  `src/features/profile/state/profileStore.ts:44,55`
  Decision: ___
- [ ] **G2.** Petpooja fallback customer email + address — require real data instead?
  `src/core/integrations/petpooja/mapper.ts:98,152`
  Decision: ___
- [ ] **G3.** Support email guard sample (`support@burgonomics.example`) — fine as-is?
  `src/shared/utils/urlSafety.ts:32,39`
  Confirmed: ___
