# BURGONOMICS — Design System (Layer 3 Constraint)

> **Factory Configuration**: Single source of truth for all visual tokens, strict 60-30-10 palette rules, typography scale, spacing, and La Pino'z QSR production mobile patterns.  
> **Master Reference**: [ui_ux_spec.md](../references/ui_ux_spec.md).

## Approved launch override — 28–29 October 2026

The [approved decisions](../stages/08_menu/output/launch-handoff-20261028/01-APPROVED-DECISIONS.md)
supersede conflicting legacy examples below for this release:

- Pure white `#FFFFFF` light canvas; pure black `#000000` dark canvas.
- **Latest Delivery typography (29 Oct, supersedes Inter-only):** self-hosted
  **MonstroSolid** for brand/page/section headings, **Montserrat 700** for
  subheads and **Montserrat 400** for content. Controls remain Montserrat, not
  display lettering. Preserve the original Inter/font licence and MonstroSolid
  assets; ship Montserrat with its unchanged SIL OFL. This is a scoped Delivery
  update, not permission to edit the separately owned Partner rebuild.
- Green primary actions and navigation, sparse accessible orange highlights.
  Do not turn every call to action orange to satisfy an old percentage rule.
- One persisted **System / Light / Dark** authority per app; fresh state follows
  System. Preserve valid existing choices and handle unavailable storage.
- Spacious, wrapping content: 16px body, at least 14px supporting text, 44px touch
  target aim. Keep the contrast/focus/reflow obligations in section 3.
- Delivery: show only Home shortcuts with both real category destinations and
  genuine approved photographs (hide the unphotographed Wraps tile); retain
  square cells, stationary labels and bounded image-only flips. Clear the
  bottom navigation when scrolled into view in Dine-in and Delivery, preserving
  the saved Cart. **Home follow-up:** never shrink the Home shortcut grid to fit the initial
  viewport; retain large full-width squares and natural vertical scrolling with
  the larger promo. Keep the **existing continuous Menu design**; all real
  categories stay in one vertical flow. **Latest Menu request:** make its existing
  product **grid view** compact enough for two rows of two items on the phone,
  using two columns from 320px, reduced image/padding space and the existing compact
  floating Cart. This is not the rejected whole-Menu redesign. List view, full
  accessible item names/details, real prices/stock/customisation and 44px Add/
  quantity targets stay intact. Larger text may grow/scroll rather than clip.
  Do not apply this density change to Home categories. Reorder in
  empty Cart; one expandable Cart cooking-note field, not per-item editors.
- Upcoming Branches is a **horizontal rotating strip**, not a vertical list.
  Preserve all approved announcements and their non-orderable behaviour. The
  latest owner trim removes the explanatory subtitle and entire visible control
  strip/trailing divider. Retain swiping, keyboard arrows, touch/focus pause and
  automatic rotation; stop autoplay for reduced motion and background/offscreen
  state, and allow text to wrap. Do not reintroduce the removed subtitle/buttons.
  Do not display branch index/total counters. Awards/photo/description spacing
  is compact; keep supporting text readable. Home shows favourites only when
  there is at least one actual saved favourite. Empty Cart has no cooking-note
  editor (saved drafts survive; the filled-Cart editor remains).
  Cart has no price-lock pill/countdown; underlying price locks, totals and
  checkout protections stay unchanged.
- **Latest Home correction (30 Oct):** the promised lower-Home sections must use
  real selected-store data, not preview-only rail fixtures. Preserve On the menu,
  then one Best sellers rail and one Make it a meal rail before announcements.
  Prefer genuine bestseller signals and then the proposal's editorial picks when
  actually present/in stock; never insert products, fake badges or sales rankings.
  Meal products lead the combo rail, open their actual IDs, and show savings only
  from real compare-at prices. Existing header, large shortcuts, fonts and compact
  Menu stay unchanged. Catalog failures remain errors rather than empty success.

The tables below describe a historical token baseline, **not proof that the new
source is installed or accepted**. Current candidate/gate evidence is in the
[implementation index](../stages/08_menu/output/implementation-checks-20261028/README.md).

---

## 1. 🎨 Color Palette (Strict 60-30-10 Invariant)

> **Historical token baseline:** values previously recorded from `burgonomics-foundation-core/src/styles.css` (`:root` / `.dark`). The approved launch override above takes precedence. Contrast ratios below apply only to their stated historical pairs; remeasure current candidate tokens and actual component usage.

### Light Mode (`:root`)
| Role | Token | Value | Description / measured contrast |
|---|---|---|---|
| **60% Canvas** | `--background` | `#F5F5F5` | Clean light grey background |
| | `--surface` | `#FFFFFF` | Cards, sheets, modals, containers |
| | `--surface-elevated`| `#FFFFFF` | Dropdowns, popovers, tooltips |
| | `--bg-secondary` | `#F0F3F1` | Secondary surface background / inputs |
| **30% Brand** | `--primary` | `#0E4825` | Forest Green: Primary buttons, active tabs, brand headers (white label **10.65:1**) |
| | `--primary-foreground` | `#FFFFFF` | Crisp white text on primary |
| | `--primary-text` | `#0E4825` | Forest green text on light surface (**10.65:1**) |
| **10% Accent — readable CTA** | `--accent` | `#C2410C` | Vibrant Orange **CTA fill**: white label on it **5.18:1** |
| | `--accent-hover` | `#9A3412` | Hover fill (white label **7.31:1**) — darker, never brighter |
| | `--accent-foreground` | `#FFFFFF` | The **on-accent** label token (**5.18:1** on `--accent`) |
| | `--accent-text` | `#C2410C` | Orange **text on a light surface**: **4.64–5.18:1** |
| | `--ring` | `#C2410C` | Keyboard focus ring (**4.64–5.18:1**, needs 3:1) |
| **Text** | `--text-primary` | `#16281D` | High-contrast charcoal text (**14.21:1** on canvas) |
| | `--text-secondary` | `#586B60` | Muted sage secondary text (**5.10–5.70:1**) |
| **Feedback** | `--success` | `#16A34A` | 100% Pure Veg badge / status |
| | `--warning` | `#F59E0B` | Price lock countdown / alerts |
| | `--error` | `#DC2626` | Error states / cancellations |

### Dark Mode (`.dark`)
| Role | Token | Value | Description / measured contrast |
|---|---|---|---|
| **60% Canvas** | `--background` | `#0A0A0A` | Deep Charcoal/Black canvas |
| | `--surface` | `#1A1A1A` | Dark Card surfaces |
| | `--surface-elevated`| `#222222` | Elevated modals/popovers |
| | `--bg-secondary` | `#141414` | Secondary dark surface |
| **30% Brand** | `--primary` | `#0E4825` | Consistent Forest Green anchor |
| | `--primary-foreground` | `#FFFFFF` | Text on primary (**10.65:1**) |
| | `--primary-text` | `#4ADE80` | High-contrast WCAG AAA Emerald text on dark surface (**9.99:1**) |
| **10% Accent — readable CTA** | `--accent` | `#C2410C` | Same orange identity as light, now as **CTA fill**: white label **5.18:1** (replaces the dark-only `#CC5200`, whose best possible label was **4.40:1** — under AA for every filled orange CTA) |
| | `--accent-hover` | `#B34700` | Hover fill (white label **5.50:1**) |
| | `--accent-foreground` | `#FFFFFF` | The **on-accent** label token (**5.18:1**) |
| | `--accent-text` | `#FF802B` | Orange **text on dark surfaces**: **6.34–7.90:1** (partner's `--color-accent-light` twin) |
| | `--ring` | `#CC5200` | Focus ring, non-text only (**3.62–4.50:1**; 3.96:1 as text on `--surface` is below AA, so it never paints copy) |

### 🚫 Decorative / legacy orange (never text, never a white-label fill)
| Value | Where it still appears | Why it is barred from text |
|---|---|---|
| `#FF6600` | Brand mark, legacy literals, historical audit baseline | **2.94:1** on white and white-on-it **2.94:1** — fails SC 1.4.3 and SC 1.4.11 |
| `#EF6124` | Pre-token spec-era header colour | **3.28:1** on white |
| `#CC5200`, `#B34700`, `#9A3412` | `--gradient-orange` / `bg-orange-gradient` stops | Gradient fills carry no text; as copy `#CC5200` is 3.96:1 on dark `--surface` |

**Role split, and why it cannot be one token.** A hue that a white label can sit on needs a *low* luminance; the same hue read as text on the dark canvas needs a *high* one. With these canvases the two windows are disjoint (`L ≤ 0.1833` vs `L ≥ 0.1887`), so the CTA fill and the orange text are separate tokens by necessity, not style: `--accent` (+`--accent-foreground`) fills, `--accent-text` writes.

---

## 2. 📱 Production QSR UI Components

1. **La Pino'z Brand Header (`LaPinozHeader.tsx`)**:
   - Full-bleed Forest Green header (`#0E4825`) with bottom curve (`rounded-b-3xl`).
   - Integrated Segmented Switch (`[ 🛵 Delivery | 🛍️ Takeaway | 🍽️ Dine-In ]`).
   - Location selector pill, loyalty coins badge, and white search pill (magnifier only, no mic).
2. **Explore Menu 3-Column Grid (`CategoryGrid.tsx`)**:
   - 3-column cards with circular food imagery (`64px`), 2px green ring, bold category name, and item count.
3. **1-Tap Bestseller & Product Cards (`BestSellerCard.tsx`)**:
   - High-res food photo, pure veg dot badge, title, price, and outlined Forest Green `"ADD +"` pill button.
   - No modifier wizard — 1 tap adds to cart immediately.
4. **Floating Mini-Cart Bar (`FloatingCartBar.tsx`)**:
   - Slides up above the 4 bottom tabs whenever `cart.itemCount > 0`.
5. **Single-Page Structured Checkout (`src/routes/checkout.tsx`)**:
   - Top-to-bottom card architecture: Fulfillment details → Review with notes → Coupons & Loyalty points → Itemized bill with 5% GST → Razorpay / Cash → Sticky Place Order CTA.
6. **Animated Live Order Tracker (`VisualOrderTracker.tsx`)**:
   - Preparation milestone animation, dynamic ETA countdown, 4-digit Pickup PIN, Porter live driver card, and 1-tap Call Restaurant button.

---

## 3. 📐 Spacing, Radius & Invariants
- **Radius** (states nesting, not decoration): `--radius-none: 0px`, `--radius-small: 6px`, `--radius-medium: 12px`, `--radius-large: 20px`, `--radius-xlarge: 28px`, `--radius-pill: 9999px`.
- **Spacing**: `--spacing-xxxs: 8px`, `--spacing-xxs: 12px`, `--spacing-xs: 16px`, `--spacing-sm: 20px`, `--spacing-md: 24px`, `--spacing-lg: 32px`, `--spacing-xl: 40px`, `--spacing-xxl: 56px`.
- **Zero Raw Hex / Tailwind Colors**: Always use semantic design tokens. Raw hex survives only for **non-text decoration** (gradient stops, the legacy brand mark) — see the decorative-orange table in §1.
- **Touch targets — two different numbers, do not conflate them**:
  - **24×24 CSS px is the WCAG 2.2 AA floor** (SC 2.5.8), and it carries exceptions: spacing, inline links, an equivalent control, a user-agent control, and essential presentation.
  - **44×44 CSS px is the Burgonomics project aim** (SC 2.5.5, AAA-level best practice) for every primary touch control. It is the aim, not the AA minimum — a 24px control rescued by the spacing exception is still conformant, but it is not this project's standard.
- **Accessibility (WCAG 2.2 AA, measured against the tokens in §1)**:
  - Normal text ≥ **4.5:1** (SC 1.4.3); large text (≥24px, or ≥18.66px bold) ≥ 3:1.
  - Non-text — control borders, icons, and focus indication — ≥ **3:1** (SC 1.4.11).
  - Keyboard focus is visible in **every pointer mode**, including touch devices paired with a hardware keyboard (SC 2.4.7), is never fully obscured by sticky chrome (SC 2.4.11), and cannot be removed by a component-level `outline-none`.
  - Colour is never the only signal for state or meaning (SC 1.4.1).
  - Motion honours `prefers-reduced-motion` by bounding movement while keeping state-change and status feedback (customer: kill-switch + `will-change` cleanup; partner: bounded 120ms cycle with an operational-animation exemption).
