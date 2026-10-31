# Approved small UI changes — code + HTML preview

Owner scope: bounded Cart/lower-Home changes, the three phone defects, latest
font roles and Upcoming Branches strip, then an actual-code HTML preview. This
is not a whole-app redesign or provider acceptance.

Latest owner-requested Home/Cart/store fixes and exact-build evidence are tracked
in [the follow-up report](followup/README.md), which supersedes the earlier sizing
and verification notes here. Final review corrections are being gated separately.

- Preserve current Home header/hero, Menu, Partner, shared shell/navigation and
  all auth, data/state, pricing, stock, note/reorder and checkout behaviour.
  Typography changes across Delivery; Menu layout/catalogue logic stays intact.
- Work only in the existing isolated Delivery candidate; preserve its other
  uncommitted work. No root app overwrite, merge, deploy or commit. A compatible
  Delivery debug update preserving data is authorised, subject to identity gates;
  no uninstall, data-clear, downgrade or Partner replacement.
- No `functions/**` or Firestore rules edits; the backend belongs to another session.
- Use existing photos/content, square shortcut/flip behaviour, one bestsellers
  rail and one combos rail. Hide unphotographed/unavailable primary shortcuts;
  no invented Wraps art/category. Preserve the saved Cart, rendered inline on Home.
- MonstroSolid brand/headings, Montserrat bold subheads, Montserrat regular body.
  Official Montserrat is self-hosted with unchanged OFL; original fonts stay intact.
- All eight approved branch announcements stay non-orderable in a horizontal
  rotating strip with manual/pause controls and reduced-motion support. In inert
  HTML exports the strip remains manually scrollable but cannot auto-rotate.
- The HTML preview will be a static export of the actual updated UI, with local
  assets and an explicitly labelled sample Cart. It will not execute app/provider
  actions or replace pricing with the earlier mockup's illustrative numbers.

Baseline: `../integration-acceptance-20261029/delivery-source-approved-small-pre.json`.
Protected-file fingerprints and exact focused/full gate results will be recorded
after the changes. Technical checks are not provider or launch acceptance.

## Current evidence

- [Integration readiness and corrected subagent conclusions](integration-readiness.md)
- [Montserrat provenance](montserrat-provenance.json)
- `native-qa/browser-home-fonts-branches-results.json`: first banner, shortcut/nav
  clearance in Dine-in/Delivery at 320/360px; font loading/roles; horizontal strip
  geometry at 320/390px in both themes; actual rotation observed; no page errors.
- Preserve the earlier full-suite failure and isolated recovery logs. They are
  historical, not a single clean full run. New frozen-source gate results are
  recorded separately; phone acceptance must identify the installed APK hash.
