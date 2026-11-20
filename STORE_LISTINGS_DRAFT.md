# STORE LISTINGS — launch copy (2026-11-20)

Owner of this file: the `customer-polish` package of fix wave 2026-11-20.
Supersedes `DRAFT 1 (2026-10-17)` — the draft archive is kept at the bottom
(§10) because it holds build/asset history that still matters.

**Who this is for:** the person filling the Google Play Console and App Store
Connect forms. Every sentence below is either (a) something the app does today
and a test or a run record backs, or (b) marked `[NEEDS: …]` because a human has
to supply it. Nothing in between. The owner is not a developer; a line of
listing copy that sounds good and is false is what triggers a rejection or, worse,
a refund fight after launch.

## 0. The owner's launch decisions this file obeys

| Decision (2026-11-20) | Consequence for listing copy |
|---|---|
| Launch on **web, Android and iPhone** | Both stores get a listing; iPhone is in scope, so the App Store section is not optional. |
| **Online payment, cash on delivery (COD), counter (walk-in) cash** | All three may be named. Nothing about wallets, EMI, Pay-Later, or "save a card". |
| **Offers (coupons) yes** | Coupons/offers may be named. |
| **Loyalty no — hide coins, tiers and points everywhere** | **No** "Grill Coins", no points, no tiers, no rewards, no "earn on every order" anywhere in either listing. The draft's coin line is deleted, not softened. |
| Franchise money: flat ₹2,000/branch/month | Internal commercial term. **Never** in a store listing, and no per-order split or Razorpay Route is promised. |
| `burgonomics.com` **out of scope** | No listing field points at `burgonomics.com`. Legal URLs use the Customer app's own hosting (§4). |
| Petpooja owns open/closed while an outlet is linked | No claim that the app is the source of truth for a store's opening state. |
| Unproven: courier coverage, live rider GPS, real-time stock, POS in production | Not claimed. See §7 for the exact list of removed claims. |

---

## 1. Customer app — `com.burgonomics` — "BURGONOMICS"

### 1.1 Google Play

- **App name:** `Burgonomics` (10/30)
- **Short description (≤80):**
  `Order pure-veg burgers from your nearest Burgonomics branch.` (56)

- **Full description (≤4000).** Copy this verbatim; each bold line is followed by
  the reason it is safe to say.

  ```
  Burgonomics is the official ordering app for Burgonomics — a 100% pure
  vegetarian kitchen. Order from your nearest branch, pay how you like, and
  follow your order's status from the kitchen to your door.

  WHAT YOU CAN DO
  • Browse each branch's live menu and add items to your cart
  • Apply an available coupon or offer at checkout
  • Choose delivery, takeaway, or dine-in
  • Pay online, pay cash on delivery, or pay at the counter
  • Track your order's status as the kitchen and the rider update it
  • Save addresses and reorder what you had last time
  • Reach the store or our support team from the order screen

  PAYING
  Online payments go through Razorpay's secure checkout. Cash on delivery is
  paid to the rider. Takeaway and dine-in orders can be paid at the counter.
  Prices are in Indian Rupees and include GST at 5%.

  CANCELLATIONS AND REFUNDS
  You can cancel from the app while your order is being prepared or earlier,
  and before a rider is assigned. Online payments are refunded to the method
  you paid with. The full policy is at the URL in the app's Privacy & Legal
  screens and in the store listing's policy fields.

  Questions? Use Help & Support inside the app.
  ```

  **Why each claim holds**

  | Claim | Backed by |
  |---|---|
  | "live menu" of a branch | `src/features/stores/services/storesService.ts` reads the public `stores` directory; the menu reads the branch's catalogue. |
  | "coupon or offer at checkout" | Offers/coupons are in launch scope by owner decision; the offers feature and checkout promo field exist. |
  | delivery / takeaway / dine-in | `FulfillmentPanel` branches on `order.fulfillment`; `stores` service restricts pickup by distance. |
  | online / COD / counter cash | Razorpay hosted checkout, the cash path in `payment.tsx`, and the staff walk-in creation route. |
  | "track your order's status" | The tracker renders the order's own status code from Firestore. Deliberately says **status**, not "live GPS" — rider telemetry depends on webhook coverage that is unproven. |
  | "save addresses and reorder" | Address store + `useReorderItems`. |
  | "reach the store or support from the order screen" | `RiderContactCard` "Call store" and the support ticket path (this package fixed the dead Call-store button). |
  | cancellation window | `functions/src/modules/orders/customerCancel.ts` — PREPARING or earlier, no rider assigned. Copy matches the server, not the old FAQ. |
  | "refunded to the method you paid with" | `cancelRefundObligation.ts` queues one human-approved refund, then Razorpay returns to the original method. |
  | "GST at 5%" | Pricing config + the terms page; CGST 2.5% + SGST 2.5%. |

- **Category:** Food & Drink. **Tags:** Food & Drink, Shopping.
- **Graphics:** `[NEEDS: app icon 512×512, feature graphic 1024×500, ≥4 phone screenshots]`
  Screenshot set to capture (must contain no fake numbers, no loyalty screen, no
  invented ETA): home → menu → item detail → cart → checkout (payment sheet,
  test-mode note removed) → order status → profile.
  **Do not** capture an offers screenshot unless a real coupon is active in the
  capture environment.
- **Content rating:** no user-generated content, no user-to-user chat, no
  gambling → complete the questionnaire as such. `[NEEDS: reviewer confirm]`
- **Data safety:** §5.

### 1.2 Apple App Store

- **Title:** `Burgonomics` (10/30)
- **Subtitle (≤30):** `Pure-veg burgers, ordered direct` (32 — trim to
  `Pure-veg burgers, direct` at 25)
- **Keywords (≤100):**
  `burger,food,delivery,takeaway,pure veg,menu,order,track,coupon,offer` (66)
  (No `coins`, no `rewards`, no `points` — those features are not shipping.)
- **Promotional text (≤170):** `Order from your nearest Burgonomics branch —
  pure-veg burgers, coupons, delivery or pickup, and cash or online payment.`
- **Description:** identical to §1.1 full description.
- **Screenshots:** 6.9" set required; capture on the Mac/simulator at submit
  time. `[NEEDS: device capture]`
- **App Privacy labels:** §6.
- **Review notes:** a working reviewer account plus OTP instructions —
  `[NEEDS: demo phone number + how the reviewer receives the OTP]`. Test-mode
  payments must be disclosed in the notes; never claim live charging.
- **Export compliance:** standard HTTPS only → "no non-exempt encryption".

---

## 2. Partner app — `com.burgonomics.partner` — "Burgonomics Partner"

Internal operations app. The listing may describe what the console does; it may
**not** promise live courier coverage, live POS sync, or franchise billing.

- **Play name:** `Burgonomics Partner` (20/30)
- **Play short description (≤80):**
  `Order console for Burgonomics branches: kitchen tickets, dispatch, refunds.` (76)
- **Full description:**

  ```
  Burgonomics Partner is the operations console our branches run the day on.
  It is for Burgonomics staff, not for customers.

  WHAT IT DOES
  • Live kitchen tickets (KDS) for orders placed in the customer app
  • Accept, prepare and complete an order, with the customer seeing the same
    status
  • Mark an item out of stock for the branch
  • Send a delivery to a courier integration or assign an in-house rider
  • Review and approve refunds for cancelled paid orders
  • Manage offers and combos for the branch
  • Ticket queue for customer issues, with escalation

  Access requires a Burgonomics staff account. Sign-in is role-based: branch,
  regional, support and brand-owner scopes see different screens.
  ```

  **Why each claim holds** — KDS/order state transitions, item 86ing, courier
  dispatch (`dispatch.router.ts`), the refunds console (`cancelRefundObligation`
  → partner approval), offers/combos, and the 3-tier ticket queue all exist in
  `burgonomics-partner`. **No claim** is made about Shadowfax as a backup
  carrier, about production POS parity, or about per-order franchise money.

- **Category:** Business. **Tags:** Business, Productivity.
- **Screenshots:** KDS, live orders, dispatch queue, refunds, tickets. Redact
  real customer names and phone numbers before upload — `[NEEDS: redacted captures]`
- **Reviewer access:** `[NEEDS: one working branch-manager account in a demo
  branch]`. A password-only demo account on a real branch is not acceptable; use
  a demo branch with fake data.
- **Data safety / App Privacy:** staff account identifiers, order data, no
  advertising SDKs. §5/§6.

---

## 3. App identity and build facts

| Item | Value |
|---|---|
| Customer application id / bundle id | `com.burgonomics` |
| Partner application id / bundle id | `com.burgonomics.partner` |
| Customer display name | `BURGONOMICS` |
| Partner display name | `Burgonomics Partner` |
| Platforms shipping | Web (Customer app), Android, iPhone |
| Customer hosting target | `burgonomics-app` → `burgonomics-foundation-core/dist/mobile` |
| Partner hosting target | `burgonomics-partner` → `burgonomics-partner/dist` |
| versionCode / versionName | `android/version.properties` in each app — bump before every upload. `[NEEDS: confirm the next value at submit time; never reuse an uploaded code]` |

Build candidates from 2026-10-17 are **not** the binaries to submit: the code
has changed since (privacy hardening, this wave's tracker/legal fixes). Rebuild
from the release branch before uploading, and record the SHA-256 of the artifact
you upload.

---

## 4. Legal and policy URLs — the Customer app's own hosting

`burgonomics.com` is out of scope for this wave, so **no store field points at it**.
The four documents ship as static HTML inside the Customer app bundle
(`public/legal/<slug>/index.html`) and are served ahead of the SPA catch-all, so
they work on both hosting targets and at the same path inside the iOS/Android
shells.

| Store field | URL |
|---|---|
| Privacy policy URL (both apps) | `/legal/privacy` |
| Terms of use / EULA | `/legal/terms` |
| Refund & cancellation policy | `/legal/refund-policy` |
| Grievance / support contact page | `/legal/grievance` |
| Index of all four | `/legal/` |

Hosting base today — **staging only** (`burgonomics-7faa8`, target
`burgonomics-app`, site `burgonomics-7faa8.web.app`), so the full staging URLs are
e.g. `https://burgonomics-7faa8.web.app/legal/privacy`.

`[NEEDS: the production hosting base URL once `burgonomics-prod` hosting is
deployed]` — fill this in before typing a URL into either console. Do **not**
paste a `web.app` staging URL into a production store form.

In-app, the same four documents are at `/privacy`, `/terms`, `/refund-policy`
and `/grievance`, linked from the sign-in screen (terms + privacy) and from
**Profile → More** for all four. The copy is one module
(`src/features/legal/content/legalContent.ts`), so the app and the public URLs
cannot drift.

> **Hard gate:** three of the four pages currently render a visible
> `[TO BE SUPPLIED: …]` mark and a "not publishable yet" banner. The missing
> facts and the unverified ones are listed in
> `burgonomics-foundation-core/LEGAL-FACTS-NEEDED.md` and repeated as a blocking
> section in `client-handover/STORE_SUBMISSION_CHECKLIST.md`. **Do not submit
> either app while that list is non-empty.** Apple and Google both read the
> privacy URL, and Indian law reads the grievance page.

---

## 5. Google Play — Data safety answers

- **Collects personal data?** Yes. Phone number (OTP sign-in), name, delivery
  addresses, order history, payment reference, device/push token.
- **Purpose:** app functionality (order fulfilment), fraud prevention, and
  customer support. **Not** advertising — no ad SDK is bundled.
- **Shared with third parties?** Yes, as processors: Razorpay (payments/refunds),
  Google Firebase (auth, database, notifications), Petpooja (kitchen ticket at
  the outlet), and the courier that accepts the delivery (drop address, hand-over
  contact, order value).
- **Data encrypted in transit?** Yes (HTTPS only).
- **Deletion:** in-app **Profile → Settings → Delete account**, plus the email
  route on the grievance page. Order invoices are retained 8 years per GST law,
  then anonymised — say so, exactly as the privacy page does.
- **Location:** optional, only while using the app, for nearest-outlet and
  drop-off. Typing an address works without it. `[NEEDS: confirm the final
  manifest declares "while in use" only]`

## 6. Apple — App Privacy labels

Identifiers (user id, device/push token), Contact info (name, phone, email if
given), Physical address (delivery), Purchase history, Coarse location (optional,
app functionality), Diagnostics (crash/error reports).
**Not** used for advertising or tracking; no "data used to track you" category.
`[NEEDS: whoever holds the Apple account confirms these labels before submission]`

---

## 7. Claims removed from this listing, and why

| Draft-1 claim | Why it is gone |
|---|---|
| "Collect Grill-Coins on every order and redeem them" | Loyalty is out of launch scope by owner decision. |
| "Members-only offers, combos and coupons" | "Members-only" implied a loyalty tier. Coupons and offers are named plainly instead. |
| "real-time availability" (live menu stock) | 86ing → customer-visible stock is coded but unproven end to end; the listing says "live menu", which is a catalogue read. |
| "Track your order from kitchen to doorstep, with live status updates" | Replaced with status tracking. Live rider GPS depends on courier webhooks (`DISPATCH_REQUIRE_LIVE` gating, test-host Borzo) that have never run against a real rider. |
| Partner: "Porter dispatch" as a named capability | Porter is legacy-only in the order data; the live adapters are Borzo (test host) and Shadowfax (disabled). Copy says "a courier integration" without naming a brand as the working path. |
| Partner: "POS billing & Porter dispatch" in the short description | POS billing is not a claim this app can make; it is an operations console over the customer app's orders. |
| Any reference to `burgonomics.com/privacy` | Domain is out of scope and its legal pages 404. All four URLs are on the Customer app's own hosting (§4). |
| "New branches are added regularly" | No evidence of a branch pipeline; drop it rather than promise growth. |
| Screenshots of a coins wallet | Feature is not shipping. |

---

## 8. Submission sequence

1. **Owner supplies** the facts in `LEGAL-FACTS-NEEDED.md` (FSSAI per outlet,
   Grievance Officer name + phone, the CIN question) and confirms the printed
   values (registered address, GSTIN, mailboxes). Re-run `npm run legal:facts
   -- --check`, `npm run legal:html`, and `npm test -- tests/legal-pages.test.ts`
   in the Customer app; all four pages must show zero marks.
2. **Rebuild** both apps from the release branch (not the 2026-10-17 AABs), bump
   `versionCode`/`versionName`, verify signatures, record artifact SHA-256.
3. **Deploy hosting** for the Customer app so the `/legal/*` URLs resolve on the
   environment the store form points at. Fetch each of the four URLs and confirm
   HTTP 200 **and** that the page body contains no `[TO BE SUPPLIED:`.
4. **Capture screenshots** per §1.1/§2, with no loyalty screen and no fabricated
   numbers.
5. **Fill the console forms** using §1/§2/§5/§6. Reviewer credentials are
   mandatory for both apps.
6. **Internal/closed testing first**, then production. Do not describe test-mode
   payments as live charging.

## 9. Open items only a human can close

- [ ] Every item in `LEGAL-FACTS-NEEDED.md` (see §4).
- [ ] Production hosting base URL for the legal pages.
- [ ] Reviewer account for the Customer app (phone + OTP delivery method).
- [ ] Reviewer account for the Partner app (demo branch, fake data).
- [ ] App icon 512 (Play) / 1024 (App Store), feature graphic 1024×500.
- [ ] Screenshot sets for both apps at current required sizes.
- [ ] Apple Team ID for the AASA association file (pre-existing blocker, unchanged).
- [ ] `ios/App/App/GoogleService-Info.plist` for both apps.
- [ ] Confirmation of the App Privacy / Data safety answers in §5/§6.

---

## 10. Archive — draft 1 status, kept for build history

The 2026-10-17/18 status table is retained because it records artifact hashes and
what was verified then. **It is not a statement about the current code**: the
privacy-hardening work and this wave's tracker/legal fixes changed both apps
after it was written.

| Item | State as of 2026-10-18 ~01:00 |
|---|---|
| Signed AABs (v1.0.0, versionCode 1) | BUILT + signature-verified. `burgonomics-partner-v1.0.0-20261017.aab` SHA-256 `B86291AD4BF39AF5FA4DA886FCA0F4DC3199D0ADB168400C4CA26410AAA01120`; `burgonomics-customer-v1.0.0-20261017.aab` SHA-256 `60D1B11CA673B4D14439F6D06A38E5ABCB341CD9837864FBF17609CAEB01CE4B`. targetSdk 36. |
| Full-tree validation then | `vitest run`: 53 files passed / 1 skipped; 591 passed / 2 skipped / 0 failed; `tsc` exit 0. |
| assetlinks fingerprints | core `15:3F:30:0D:…CD54`, partner `25:C9:63:BC:…CF:D7`; propagated to publish dirs. |
| Root hosting preflight | PASS 25 / FAIL 2 — both FAILs were the `TEAMID.` App Store placeholder. |
| App identity | Exactly two Capacitor apps; `com.burgonomics` is the Customer app. |
| Play upload | No upload API in any workflow → uploads are manual console work. |
