# Stage 08: Menu Management, Combos & Petpooja Catalog Sync

> **Layer 2 Stage Contract**: Category hierarchies, pre-made items & combos (no item modifiers), Petpooja menu ingestion, branch-level and brand-wide combo creation, and instant 86ing.

> Read the approved launch overlay in section 5 before executing this historical
> contract. Backend paths below may predate the current `modules/petpooja/`
> layout; verify actual locations before reading or editing them.

---

## 1. Inputs
- **Layer 3 (Reference)**: `../../references/petpooja_pos.md`
- **Layer 3 (Reference)**: `../../references/image_storage.md`
- **Layer 3 (Reference)**: `../../_config/design_system.md`
- **Authoritative Backend Spec**: `../../references/backend_upgrade_spec.md`
- **Authoritative UI/UX Spec**: `../../references/ui_ux_spec.md`
- **Layer 4 (Working)**: `../07_tickets/output/stage_summary.md`

---

## 2. Process
1. Build Menu Management UI with category filtering (Smash Burgers, Loaded Combos, Sides, Drinks, Desserts).
2. Connect hourly Petpooja menu ingestion Cloud Function (`functions/src/petpooja/syncMenu.ts`).
3. Implement **Combo & Offer Creation Tool** in Partner POS:
   - **Branch Manager**: Creates branch-specific value combos (`branchSpecificId = branchId`).
   - **Brand Owner & Developers**: Creates brand-wide promotional combos available at all branches.
4. Support instant 86ing stock webhook (`functions/src/petpooja/stockWebhook.ts`) to disable out-of-stock items in real-time.
5. In Customer App, ensure 1-tap `ADD +` adds pre-configured products and combos immediately to cart without modifier modals.

---

## 3. Outputs
- `src/features/menu/components/MenuItemCard.tsx`
- `src/features/menu/components/CreateComboModal.tsx`
- `src/features/menu/components/SyncMenuButton.tsx`
- `functions/src/petpooja/syncMenu.ts`
- `functions/src/petpooja/stockWebhook.ts`
- `output/stage_summary.md` -> Stage verification summary

---

## 4. Verify
```bash
npx tsc --noEmit && npx vitest run
```
- Verify menu schema compatibility between Petpooja ingestion, Firestore, and client 1-tap cart additions.

## 5. Approved launch-requirements overlay — 2026-10-28

The [launch handoff](output/launch-handoff-20261028/README.md) records the user's
new Delivery/Partner requirements and evidence for a fresh planning session.
It is not an implementation plan or a new completion verdict.

For this launch, the approved customer-facing direction is four featured square
Home shortcuts (Burgers, Wraps, Sides, Shakes & Drinks) with brief automatic flips,
an all-category continuous vertical menu with section jumps, reorder in empty
Cart instead of Home, and one expandable order-level cooking-instructions field.
The four shortcuts do not redefine the full POS category taxonomy or its IDs.
Both apps use white/light and black/dark themes with a System / Light / Dark
override and readable Inter interface typography; Burgonomics' team must approve
proposed design screenshots before implementation. Existing conflicting visual
specs and tests must be reconciled through an approved implementation task, not
treated as evidence that these requirements already ship.

Awards & Recognition then Upcoming Stores close Home. Each hides when it has no
owner-approved entry; an announced store never becomes orderable. Awards use the
owner's franchise deck as a visual field (deep green, ceremony photography, one
MonstroSolid display heading, gold rule) with white body copy at ≥ 8:1, while the
app canvas stays white/black. Upcoming Stores stays on the normal canvas. Petpooja
item images come from `item_image_url`; an empty vendor value falls back to curated
local photography rather than an invented URL. Evidence and transcription:
[brand-provider-evidence-20261029](output/brand-provider-evidence-20261029/README.md).

Read the packet's [decision record](output/launch-handoff-20261028/01-APPROVED-DECISIONS.md)
and [source/evidence caveats](output/launch-handoff-20261028/07-EVIDENCE-AND-WORKSPACE.md).
Keep the verification obligations above, not literal Bash shell syntax: on this
PowerShell 5.1 host run `npx tsc --noEmit` and `npx vitest run` separately, inspect
each exit code and stop on failure; do not paste the historical `&&` expression.
The historical backend paths in Process/Outputs are not current file-location
proof. Historical PASS summaries likewise do not prove the current dirty source
or a newly built native artifact works.

## 6. Proposed cross-stage launch plan — 2026-10-28

The fresh planning session produced
[launch-plan-20261028/README.md](output/launch-plan-20261028/README.md).
It preserves the approved requirements above, adds exact-source work packages,
four app/platform acceptance gates and a conditional schedule, and stops before
application implementation. The original handoff remains requirements evidence.
The plan is not team design approval, permission to edit/deploy/submit, a passing
security/native test result or completion of this stage. Read its approval ledger
and current evidence before selecting any dirty baseline or old worktree.

## 7. Limited Phase A authorised — 2026-10-28

The user approved only proposed mockup screenshots, baseline ownership
reconciliation and owner-led read-only account/signing checks. Outputs are indexed
in [launch-plan-20261028/phase-a/README.md](output/launch-plan-20261028/phase-a/README.md).
The initial v0 is a design-review checkpoint, not complete A1 coverage or approval
to implement. Store/signing evidence is missing; the generic WhatsApp draft was
rejected as not the current message and was not sent. A later user-requested
cross-session context transfer is separate from external correspondence.
No app/backend/native source or rules were changed, no existing worktree was
adopted, and no app tests/builds/deployments/submissions were run. Source inventory
and mockup artifact checks are not the implementation verification gate above.

## 8. Fresh new-session prompt review — 2026-10-28

The user repeated the original planning prompt; its explicit five-model roster
was executed with scoped read-only assignments. Three reports returned and two
routes failed. Accepted Delivery/backend/dependency corrections were applied only
to planning documents. [Review evidence and next approvals](output/launch-plan-review-20261028/README.md)
record the independent documentary recheck, final parent-only clarifications and
artifact verification. No application implementation or stage-completion verdict
follows; B–G, source ownership, signing and provider gates remain unchanged.

## 9. Owner design reset — 2026-10-29

> Historical request. The owner's later scope clarification in section 10
> supersedes the full-overhaul direction and approval status in this section.

The owner rejected the current Delivery design and requested a full Partner
visual/information-architecture redo. Earlier UI candidates and their passing
technical checks are **not design approval**. Preserve the dirty candidates;
do not merge, install, reapply old patches or continue polishing them as final.

The active deliverable is three **proposed, unapproved screens**:
[Home, Menu + Cart, Partner Kitchen/Orders](output/design-reset-proposals-20261029-v1/README.md).
These isolated mockups use local brand assets and self-hosted Inter. They do not
connect to production services or replace application data/state logic.

**Approval gate:** no final UI implementation until the owner approves the screens.
Delivery has white/light and black/dark canvases, forest green primary, sparse
orange, a real hero, four square shortcuts, one bestseller and one combo rail,
then Awards & Recognition and Upcoming Stores. Menu remains continuous with
sticky section chips and two-column cards. Cart has one order-level note.
Partner is task-first with large tickets, separate paid/POS states and obvious
failure handling; server-side invite-only access and existing workflows remain.

The backend is now owned by another session. Do not edit `functions/**` or
`firestore.rules` for this design task. The owner-referenced
`developer-resources/provider-toolkit-20261029/MASTER-REFERENCE.md` is public
provider documentation, not live integration acceptance or deployment authority.

## 10. Current owner clarification — small refactors, Cart-only approval

Keep the current application design. **Do not undertake a complete Delivery or
Partner refactor/redesign.** Home, Menu and Partner proposals are not approved
for implementation. Cart alone is approved for a bounded visual cleanup; retain
its working data/state, pricing, validation, note persistence and checkout flow.
Illustrative figures in the mockup must never replace application pricing.

The owner liked the Home proposal **from “On the menu” downward**: the category
area, rails and announcements. Record that as the preferred lower-Home direction,
not automatic permission to implement it or replace the current header/hero.
Any future change outside Cart needs a separately bounded approval. Preserve
existing work; do not merge an entire old dirty UI candidate to land Cart changes.

Backend ownership remains with the other session: no edits to `functions/**` or
`firestore.rules`. Design approval is not install, merge, deployment or live
provider-operation approval.

## 11. Latest Delivery scope — phone defects, fonts and branch strip

The owner explicitly authorised bounded lower-Home changes and the three phone
defects: reset the first banner to its readable leading edge, hide shortcuts
without a real destination/approved photograph, and keep the lower category row
clear of bottom navigation. Preserve the existing header/hero structure and saved
Cart. Recheck **Dine-in and Delivery on `RZCX51TXRKB`**, package `com.burgonomics`;
browser/unit checks alone are not phone acceptance or design approval.

Keep the **old Menu design and continuous catalogue**; the two-column proposal
is not approved. Upcoming Branches becomes a horizontal rotating strip with
pause/manual controls, reduced-motion support and no ordering/store-selection
actions. The latest font roles supersede section 5's Inter-only requirement:
MonstroSolid brand/headings, bold Montserrat subheads, regular Montserrat content.
See the updated [_config/design_system.md](../../_config/design_system.md).

Continue only the existing isolated Delivery candidate and preserve unrelated
dirty changes. Compatible debug updates preserving app data are authorised; no
uninstall/data-clear/downgrade, Partner replacement, commits, pushes or deploys.
`functions/**`, Firestore rules and all Partner repos remain hands-off.

Multiple subagents may perform read-only configuration/source checks and bounded
hermetic provider tests. Environment presence, mocked tests and public provider
docs are not live payment/POS/courier/Firebase acceptance. No payment operations,
POS tickets, courier bookings/cancellations, SMS/push or production writes.
Keep Grill Coins balances/history and Reelo exports untouched. Current evidence:
[approved-small-ui-20261029](output/approved-small-ui-20261029/README.md).

## 12. Owner follow-up — restore large Home and truthful store discovery

The viewport-fitting shortcut shrink was rejected. Restore large full-width
square Home cards and enlarge the top promo and BURGONOMICS wordmark. Natural
vertical scrolling supersedes fitting both category rows into the first viewport;
retain safe bottom clearance when scrolling, real photos and the old Menu layout.

Compact Awards/Recognition vertically, remove Upcoming Branches' numeric
index/total, show Home favourites only when there are actual saved entries, and
remove the empty-Cart note editor without deleting saved notes or replacing real
authenticated past orders with fixtures. Filled-Cart notes/pricing stay intact.
The search field's focus boundary must follow its rounded wrapper and remain
visible for keyboard users.

Fix false first-load "no stores" and filter every store list, including recents,
nearby and search, to the existing reachability policy (per-store Delivery radius;
existing 25 km pickup ceiling). No usable position means ask for location/a saved
address, not list distant stores or invent GPS. Keep real read failures distinct
from successful empty results. Never automatically switch a saved store or clear
Cart to make a screenshot look right. All backend/Partner/provider boundaries
above remain. New evidence is separate from the previous APK's passing gates:
[follow-up work](output/approved-small-ui-20261029/followup/README.md).

## 13. Latest owner steering — compact Menu product grid

The owner now requests smaller **Menu items in grid view** to show four products
on one phone screen (two rows of two). This supersedes the Menu-file freeze only
for bounded grid-density and supporting regression checks. Preserve the continuous
category flow, unchanged list view and large Home category cards; do not revive a
whole-Menu replacement. Keep real prices, availability, favourites, customisation,
detail links and 44px Add/quantity targets. Reduce imagery/padding and visual
summary density, not tap usability. At larger text sizes allow natural growth.

Use the existing compact floating Cart variant in Menu grid view so a filled
basket does not cover an entire product row. Preserve the current real phone
basket; it may change while the owner is using the device. No fake phone data,
account operations, payments, provider actions or backend/Partner edits.
Fresh gates and exact-build phone evidence belong in
[Menu-grid evidence](output/approved-small-ui-20261029/followup/menu-grid/README.md).

## 14. Final owner trim — leave everything else unchanged

Remove Cart's visible price-lock pill/countdown, without changing stored locks,
totals or checkout protections. Remove Upcoming Branches' explanatory subtitle and
the whole previous/pause/next control strip (explicitly confirmed by the owner),
including its trailing divider. Keep announcements, automatic rotation, touch
swiping/keyboard browsing and touch/focus/reduced-motion visibility pauses.
Do not add replacement visible controls or change other layouts/content/data.
The compact Menu grid and large Home cards are accepted as-is. Preserve the real
phone basket; all prior backend/rules/Partner/provider and no-write boundaries
still apply. Evidence: [final trim](output/approved-small-ui-20261029/followup/final-trim/README.md).

## 15. Owner requires the promised lower-Home sections — 30 October 2026

After checking installed final-trim `78fcda40…`, the owner explicitly asked to add
the promised Home sections from “On the menu” downward, including **Best sellers**
and **Make it a meal**, before backend/integration work. Fix the existing rails'
real data path; do not merely populate a preview or add duplicate headings.
Use the verified selected outlet's canonical Menu products for categories and
both rails, with real IDs/prices/images/stock and genuine compare-at savings only.
Proposal picks are editorial selections, not verified sales rankings; do not
invent badges, products or a phone basket. Real meal cards open their canonical
product regardless of ID prefix. Keep the accepted header/hero, large shortcuts,
compact Menu, fonts, conditional favourites, announcements and final trim.

All prior phone-data, no-backend/rules/Partner/provider, no-commit/push/deploy
boundaries remain. “Then backend” does not authorise integration operations now.
Evidence: [Home sections](output/approved-small-ui-20261029/followup/home-sections/README.md).
