# Connected-phone comparison — Delivery first

**28 October 2026. Observations and proposed direction only; no app changes.** Completed work was reused across server restarts. These images show existing installed apps, not the proposed v2 mockups or a build from an approved source baseline.

## Evidence and limits

One local Samsung SM-S921B / Android 16 was used. REA inventoried the four requested packages and captured the consumer surfaces; Mobile MCP supplied hierarchy and bounded navigation/scroll gestures. No APK was pulled, decoded or bound to a checkout. No iOS/device-matrix/accessibility-conformance or production/provider acceptance is established.

| Retained observation | What it supports |
|---|---|
| [Delivery Home](delivery-home.png) | Existing category strip, three-column cards, decorative heading and large orange hero |
| [Delivery after outside-banner control](delivery-banner-after.png) | Scrollable page outside the banner; this is the control, not an image of the failed inside-banner swipe |
| [Martinoz Home reference](martinoz-home.png) | Large two-column photographic entrances and explicit fulfilment navigation on this screen |
| [La Pino'z Home reference](lapinoz-home.png) | Visible mode selection, dominant promotion and bottom destinations; not a recommendation to copy every mode/promotion |
| [La Pino'z Menu reference](lapinoz-menu.png) | Filters, a featured-product rail, a clear product name/price/Add relationship; full category continuity was not proven |

[Image manifest](image-manifest.json) binds the REA evidence IDs, raw hashes, exact privacy crop rectangles and labelled derivative PNG hashes. [Preparation helper](prepare-images.py) refuses replacement. Raw frames remain in the approved temporary directory; retained crops remove status bars, personal location/greeting and the personalised favourites area. All five retained crops were visually inspected. Competitor screenshots/assets are internal references only, never app assets, mockup ingredients or approved store creative.

**Excluded black frame:** the user explained they had closed Delivery by mistake and that it opens normally. It is not a confirmed startup defect. No blocked-capture frame is used to judge the UI.

## Delivery findings

**2 Serious, 1 Polish; no confirmed Blocking finding in this bounded sample.** The phone still presents the earlier dense Home, while the reported banner gesture obstruction is reproducible in one paired observation. This is not a complete accessibility audit or a declaration that no other blockers exist.

### Serious 1 — vertical intent starting on the banner is lost

- **Problem:** A customer starting a vertical swipe over the banner cannot move down Home in the observed case, despite the same page scrolling from outside it.
- **Direction:** Preserve native vertical scrolling from any banner surface. Only intentional horizontal interaction should engage the carousel. Keep safe taps, keyboard access, cancellation and reduced-motion behaviour; the approved D2 proposal uses about 10 px travel with horizontal dominance before any custom drag decision.
- **Rationale:** Retain the banner's useful promotion/navigation rather than removing it or capturing every pointer immediately; horizontal dragging must not claim vertical intent.
- **States:** Inside-banner upward swipe `(850,1000)`, distance 600 device pixels: Explore Menu stayed at `y=1476`, banner top `705`. Outside-banner control `(1050,1900)`, distance 600: heading moved to `864`, banner top to `93`—612 pixels of displacement. These are physical screenshot/hierarchy coordinates, not CSS target sizes. Diagonal, horizontal, tap, cancel, screen-reader, reduced-motion and iOS cases remain unexecuted.
- **Constraints:** Do not change checkout, catalog IDs or unrelated swipes. The existing Delivery contract names `BannerCarousel.tsx` and its tests as touchpoints; this observation does not prove the current source-level cause or authorise editing a dirty checkout.
- **Open questions:** Which exact approved source/build will reproduce the installed behaviour? Which existing pointer/touch handler consumes vertical intent? Close with targeted source review and genuine gesture regressions after baseline handover, not a new screenshot alone.

### Serious 2 — Home still exposes the dense full category set

- **Problem:** Home repeats category entrances in a horizontal strip and a three-column grid; labels such as the larger burger category are truncated, and the four requested food shortcuts are not the primary choice.
- **Direction:** Use exactly four large 2×2 shortcuts—Burgers, Wraps, Sides, Shakes & Drinks—with readable stationary labels, approved imagery and one-tap category navigation. Keep every real category in the full continuous Menu. Remove the redundant Home strip, not a shared menu component without caller review.
- **Rationale:** Use larger food-led choices instead of compressing the whole taxonomy into Home. Do not reduce the actual POS catalog to four categories or silently select a similarly named category.
- **States:** Default observed Home and its outside-banner scroll control. The current hierarchy reports roughly 309–312 by 396 device-pixel cards across three columns. Missing mapping/photo, 320 CSS px, enlarged text and reduced motion are proposed in [v2-r1](../../proposals/v2/README.md), not verified in this installed app.
- **Constraints:** Preserve search, outlet/mode context, Home/Menu/Cart/Profile and legitimate product selections. Required mappings must be explicit. The Wraps photo is still unverified; never relabel another food image. Hide Awards & Recognition / Upcoming Stores until approved content exists.
- **Open questions:** Team approval of exact v2 Delivery IDs, category mapping/aliases and a verified Wraps photo remain missing. Data-loading, category boundaries and late prior-outlet responses still need D3/B4 acceptance; four attractive tiles do not close those gates.

### Polish 1 — the observed visual hierarchy has not adopted the settled system

- **Problem:** A large orange promotional surface and decorative uppercase display headings compete with food discovery on a grey/neutral canvas, rather than the agreed readable white/green interface.
- **Direction:** Use self-hosted Inter for interface text: body/input 16/24, metadata 14/20, sections 20/28 and page titles 24/32 at default scale. White light canvas, black dark canvas, green primary and sparse orange highlighting; verify actual surface/text/control/focus contrast and 44 CSS px touch aims. Keep the genuine brand lettering in the logo.
- **Rationale:** Establish one readable hierarchy instead of borrowing promotional typography for controls and headings or replacing Burgonomics with a competitor's theme. Keep genuine food imagery; do not infer a font family or a WCAG failure solely from pixels.
- **States:** Only the current foreground Home surfaces were visually inspected. Actual System/Light/Dark persistence, first paint, native status/keyboard surfaces, OS font scaling, 200% reflow, focus and screen readers remain open. The earlier mockup samples are not those tests.
- **Constraints:** Do not recolour error states into ambiguity, install a new UI stack, clear user/cart/auth preferences or change typography globally without owning the relevant files. Token/Inter implementation remains D1/P1 under the existing plan.
- **Open questions:** Exact source/build binding, design-team approval, actual rendered contrast and native appearance acceptance are still required. No new rendered accessibility score is claimed here.

## What to borrow, and what not to copy

| Reference | Useful principle | Deliberately not adopted |
|---|---|---|
| Martinoz Home | Larger image-led category entrances and space between two-wide choices | Its promotional lettering, prices, offers, artwork, complete taxonomy or navigation labels |
| La Pino'z Home | Explicit fulfilment choices and stable destination hierarchy | In-Car as a new Burgonomics mode, price guarantees, promotional claims, reward programme or existing account data |
| La Pino'z Menu | Separate discovery filters from readable product name/price/Add grouping | Assuming a featured rail proves continuous category loading, copying discounts, loyalty authority or a new modifier flow |
| Partner entry | A fresh hierarchy contains store/outlet/orders/kitchen/menu-related text | Operational records and identities were suppressed; no Partner screenshot, login, role/access assertion, order/KDS action or operator acceptance is claimed |

La Pino'z itself displayed a nearest-outlet-change notice on launch; only its informational OK was dismissed. No GPS grant/change or manual outlet selection was performed. Do not imitate automatic outlet changes without basket/price/mode revalidation. No items were added, removed or paid for in any app. Partner was returned to Delivery by opening Delivery after the bounded reads; no Partner operation was performed.

## Requested MCP results

| Tool | Actual result / remaining limit |
|---|---|
| REA | Four package matches, five successful consumer frames, focused-window observation. No binary target opened, APK extraction, runtime instrumentation or native/iOS acceptance |
| Mobile | Local device inventory, hierarchies, app launches, two Delivery vertical swipes, one informational OK and one Menu navigation. No credentials, OTP, permission grants, Add/checkout/payment or operations |
| Firebase | Environment metadata succeeded; configured project is billing-enabled. No collection/query/write/deploy. Connectivity is not backend/Petpooja correctness |
| Vera | Root index returned, with 6,905 added / 3 modified warning; Delivery-specific overview reported no index. No automatic reindex; source absence cannot be inferred |
| Context7 | Current shadcn disclosure references fetched. Reelo lookup had no matching library; unrelated results rejected. Reference API variants are not an approved app migration |
| shadcn | Public accordion registry references found; no install/add command or dependency change |
| Code Review | Local diff failed on the ambiguous `origin/HEAD -> origin/main..ui-sweep` revision. No reviewer verdict; no PR creation, posting or branch adoption |

## Reelo answer

**Reelo can be investigated alongside retained Petpooja POS.** Reelo's official [Petpooja integration page](https://reelo.io/petpooja) and [2026 restaurant tools guide](https://reelo.io/blog/best-restaurant-tech-tools-your-complete-guide) publicly advertise that compatibility. This is public product material, not a Burgonomics API/merchant contract.

The app's existing Firebase Grill Coins ledger is not simply Petpooja CRM. Do not silently replace its spendable balances or import them into Reelo. Confirm merchant/outlet entitlement, which system sends each bill, direct app API/consent/OTP access, idempotency, refunds/reversals, historical migration, reconciliation and rollback before implementing anything. [The retained Reelo investigation](../../../launch-handoff-20261028/05-REELO-INVESTIGATION.md) remains investigation-only, off the launch critical path.

## Next gate — no duplicate plan

Keep the [Delivery work packages](../../03-DELIVERY-DESIGN.md), [Partner contracts](../../04-PARTNER-DESIGN.md), [backend/security gates](../../05-BACKEND-SECURITY.md) and [v2-r1 review packet](../../proposals/v2/README.md). This comparison reinforces their direction; it does not approve their implementation.

Before a Delivery implementation lane: exact team-approved screenshot IDs/revision, a named custodian and accepted base/dirty-overlay handover, and explicit bounded change approval. A sensible first UI lane is D1 appearance/Inter then D2 Home/banner; D3 continuous Menu and D4 Cart still depend on their catalog/financial/POS contracts. Backend/payment/POS acceptance cannot be replaced by polish or MCP connectivity.

Original **3 November RC / 8 November public targets stay unchanged**, not guaranteed. No store submission, signed build, app tests/builds, backend/rules/native/dependency source edits, production financial/provider action, commit or push occurred. [The continuation checkpoint](../ORIGINAL-BRIEF-RESUMPTION-20261028.md) retains the restart history; [artifact validation](validation.json) is only local document/image identity, not an application gate.
