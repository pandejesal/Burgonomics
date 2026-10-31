# Owner review — Cart-only approval for a small visual cleanup

## Latest direction (supersedes the original full-overhaul brief)

Keep the current app design and make small, targeted refactors only.

| Area | Owner decision |
|---|---|
| Cart | Approved for a bounded visual cleanup; existing logic/pricing stay intact |
| Home, from “On the menu” downward | Liked as a direction; not yet approved to apply |
| Home header/hero | Not approved for replacement; preserve the current top section |
| Menu | Not approved; preserve current design |
| Partner | Not approved; no full visual/IA redo |

The Cart approval does not approve the adjacent Menu comp or the entire UI
candidate. Mockup totals remain illustrative. No app edits have been made in
response to this approval/clarification yet.

## Proposed screen exports

- `01-delivery-home-proposed.png` — 430px-wide full-length Home comp.
- `02-delivery-menu-cart-proposed.png` — two 430px comps, Menu excerpt + Cart.
- `03-partner-kds-proposed.png` — 1360px desktop operational view.
- Interactive review: `http://127.0.0.1:48240/index.html` while the owned local
  static server is running. Light/Dark and Kitchen/All orders switches are local
  proposal controls, not app features or real operational actions.

## Bounded artifact checks, not app acceptance

- `node --check proposal.js`: exit 0.
- Three browser renders: no page errors, console errors, broken image loads or
  external requests were observed. All fonts/images/icons are local.
- Home: exactly four shortcuts, one bestseller rail, one combo rail, three award
  entries, eight non-orderable announced locations. Dark canvas observed black.
- Menu: adjacent sections remain in the DOM; section chips jump, not replace.
- Cart: one cooking-note textarea, 240-code-unit ceiling, illustrative bill/CTA.
- Partner All orders: five explicitly synthetic rows; no production customers,
  phone numbers, addresses, tickets, financial actions or provider operations.

These checks do not establish full accessibility, final responsiveness, live
availability, application auth, note persistence, pricing or any integration.
No application typecheck/unit/build gate was rerun for these isolated HTML comps.

## Preserved boundaries

After the reset, no app implementation, native installation, merge, commit,
deployment, backend or rules edits were performed. The rejected-candidate preview
on port 48176 was stopped by its exact owned PID; the new proposal server is a
separate static, loopback-only process on 48240. Previous source and evidence are
preserved, not restored or discarded.

**Only the bounded Cart cleanup is implementation-approved.** Approval of a
visual direction does not authorise installation, merge, deployment, store
submission or live provider work.
