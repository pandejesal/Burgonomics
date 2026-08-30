# BURGONOMICS — Design System (Layer 3 Constraint)

> **Factory Configuration**: Single source of truth for all visual tokens, strict 60-30-10 palette rules, typography scale, spacing, and La Pino'z QSR production mobile patterns.  
> **Master Reference**: [ui_ux_spec.md](../references/ui_ux_spec.md).

---

## 1. 🎨 Color Palette (Strict 60-30-10 Invariant)

### Light Mode (`:root`)
| Role | Token | Value | Description |
|---|---|---|---|
| **60% Canvas** | `--background` | `#F5F5F5` | Clean light grey background |
| | `--surface` | `#FFFFFF` | Cards, sheets, modals, containers |
| | `--surface-elevated`| `#FFFFFF` | Dropdowns, popovers, tooltips |
| | `--bg-secondary` | `#F0F3F1` | Secondary surface background / inputs |
| **30% Brand** | `--primary` | `#0E4825` | Forest Green: Primary buttons, active tabs, brand headers |
| | `--primary-foreground` | `#FFFFFF` | Crisp white text on primary |
| | `--primary-text` | `#0E4825` | Forest green text on light surface |
| **10% Accent** | `--accent` | `#FF6600` | Vibrant Orange: CTAs, deal badges, highlights |
| | `--accent-foreground` | `#FFFFFF` | White text on accent |
| **Feedback** | `--success` | `#16A34A` | 100% Pure Veg badge / status |
| | `--warning` | `#F59E0B` | Price lock countdown / alerts |
| | `--error` | `#DC2626` | Error states / cancellations |

### Dark Mode (`.dark`)
| Role | Token | Value | Description |
|---|---|---|---|
| **60% Canvas** | `--background` | `#0A0A0A` | Deep Charcoal/Black canvas |
| | `--surface` | `#1A1A1A` | Dark Card surfaces |
| | `--surface-elevated`| `#222222` | Elevated modals/popovers |
| | `--bg-secondary` | `#141414` | Secondary dark surface |
| **30% Brand** | `--primary` | `#0E4825` | Consistent Forest Green anchor |
| | `--primary-foreground` | `#FFFFFF` | Text on primary |
| | `--primary-text` | `#4ADE80` | High-contrast WCAG AAA Emerald text on dark surface |
| **10% Accent** | `--accent` | `#CC5200` | Deep Amber/Dark Orange for dark mode readability |
| | `--accent-foreground` | `#FFFFFF` | Text on accent |

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
- **Radius**: `--radius-small: 6px`, `--radius-medium: 12px`, `--radius-large: 20px`, `--radius-xlarge: 24px`, `--radius-pill: 9999px`.
- **Zero Raw Hex / Tailwind Colors**: Always use semantic design tokens.
- **Touch Targets**: Minimum `44px x 44px` on all interactive touch elements.
- **Accessibility**: Normal text must satisfy WCAG 2.2 AA (≥ 4.5:1 ratio).
