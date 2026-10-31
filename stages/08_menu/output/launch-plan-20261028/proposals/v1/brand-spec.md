# Internal v0 brand and asset provenance

User approved existing Burgonomics logo/verified local food photographs for internal mockups on 28 October 2026. No public creative/store-listing approval follows. All copies stay in `proposals/v1/assets/`; originals are unchanged. Hashes are in the generated `asset-manifest.json`.

| Local copy | Existing source under Delivery `public/` | Evidence / use |
|---|---|---|
| `assets/mascot.png` | `burgonomics-logo.png` | Actual existing mascot, visually inspected; not redrawn |
| `assets/burger.jpg` | `images/menu/classic-burgers/hero-burger.jpg` | Visually inspected branded shoot; root `scripts/process-menu-images.ps1:121–122` maps the matching Hero photo |
| `assets/fries.jpg` | `images/menu/fries/salted-fries.jpg` | Visually inspected branded packaging; same script `:142–143` maps Salted fries |
| `assets/shake.jpg` | `images/menu/thick-shakes/oreo-shake.jpg` | Same script `:180–189` maps the matching Oreo photo; broad Shakes & Drinks illustration only |
| No Wraps image | No verified wrap photo located | Explicit placeholder, not a burger relabelled as a wrap |

Some other existing image-processing mappings reuse one shoot across different SKUs. They were **not** accepted as correct SKU imagery merely because filenames exist. This v0 reuses only the selected category-appropriate assets; it does not rewrite the menu or claim the entire library has verified provenance.

Inter and its licence are copied from official `rsms/inter`, commit `353b61b9f4430d5f420d56605a6e7993e0941470`. GitHub contents metadata was retrieved before downloading; the download helper verifies each Git blob SHA-1 and records SHA-256. WOFF2 is served locally; no runtime Google Fonts/CDN requests. No decorative Monstro font is reused without its licence. The actual mascot remains the identity asset; adjacent Inter product-name text is not a replacement wordmark.

Existing observation reference: [Delivery Home](../../evidence/delivery-home.png), [Delivery Menu](../../evidence/delivery-menu.png), [Partner dashboard](../../evidence/partner-dashboard.png). Those observations were already cropped/redacted. They are not composited into the proposed screens and do not establish new-build provenance. No competitor image is reused.

Palette, typography, spacing, radius, elevation and accessibility thresholds are in [DESIGN.md](DESIGN.md). No fabricated live data, prices, awards, opening announcements, payment receipts or operator acceptance appear in these comps. Example history/tickets are design-only and labelled.
