# 04 — Partner: focused operational polish

**PROPOSED DESIGN / IMPLEMENTATION CONTRACT.** No Partner redesign or operational acceptance is approved by this packet. Repository: `C:\Users\DELL\Desktop\Burgonomics\burgonomics-partner`, fingerprint **G-PARTNER**. Common worktree/owner/gate/recovery rules are in [01](01-DECISIONS-AND-OWNERSHIP.md). Changed tests and additional source must join the manifest before execution; no new-source release artifacts exist.

## Design direction and key paths

Keep the existing operational navigation/routes, specialised full-screen KDS and role-adaptive administration. Do not merge apps/libraries, replace React Router or restructure every admin page. Polish the actual reachable critical surfaces and test unchanged routes for regressions.

1. Invited staff sign in → authorised outlet context → true order queue/KDS → safe next state → verified fulfilment/handover.
2. Stock operator selects one permitted outlet → marks a real item unavailable → sees saved/customer-facing versus POS-sync status separately → customer sees the same outlet's stock change.
3. Paid-but-POS-pending ticket → honest age/status → 2-minute staff alert / 5-minute escalation → reconciliation action appropriate to certainty and permission. No generic “retry send” button for ambiguous sends.

Primary hierarchy: outlet + feed health → urgent unresolved orders → operational action. Financial dashboards are secondary to the kitchen queue. At 320/390 px use one column, 16 px gutters and 16–24 px groups; at 768+ use existing lanes/sidebar with content-fit spacing, not phone-width cards stretched across a desktop. A horizontal KDS lane may have an explicit accessible alternative on small screens; do not hide an offscreen urgent ticket. Row action height ≥44 px; visible text can grow at 200% without hiding amounts/status/actions.

Use Inter 16/24 body, 14/20 metadata, 20/28 ticket/section headings, 24/32 page titles, tabular numerals for ages/amounts. Use the same proposed white/black canvas and semantic role split in document 03, but keep Partner's `--color-*` namespace. Green primary, sparse orange; warnings/errors carry words/icons. Shadows only on drawer/sticky chrome. Do not blanket-paint `text-white`/dark-neutral panels in light mode.

```text
PARTNER QUEUE / KDS                    STOCK / DISPATCH
Outlet (permitted scope)               Explicit outlet context
Live / reconnecting / stale age        Item / actual availability / saved state
Muted / alerts unavailable state       Pending POS sync / sync failed + remedy
Urgent pending-POS item + elapsed age  No success until relevant server result
Ticket / payment fact / POS fact       Provider/manual + booking certainty
Instructions / safe next action        Real fare/ID/status, not simulated rider
```

Public download leads to staff sign-in, not self-registration into any role. Explain “Access is by invitation from Burgonomics” with support route. Provide secure reviewer access separately; never embed a demo PIN, owner account or production credentials in the public app.

## State contract

| State | Required presentation/action |
|---|---|
| Initial/loading | Identify what is loading; no “kitchen clear” or zero revenue asserted from missing data |
| Empty verified feed | Honest no-orders state only after successful authorised feed/query |
| Listener/index failure | “Live updates unavailable”, last-good age and safe reconnect/help; do not call one-shot polling “live” |
| Offline/resume | Stale label; keep last safe snapshot, revalidate server state before replay; never resurrect terminal orders |
| Pending POS | Payment fact separate from restaurant confirmation; elapsed age, 2m alert/5m escalation, certainty-aware reconciliation |
| Muted/permission blocked | Persistent visual alert, mute/unlock/permission explanation; acknowledgement does not accept an order |
| Stock saved, POS pending | Distinct local/backend save versus POS-sync facts with retry/reconciliation ownership |
| Provider uncertain | Manual review, preserve booking identity; no duplicate automatic booking or fabricated tracking |
| Uninvited/revoked/cross-branch | Denied server-side, clear session/access message and no leaked cached records |

No assumption that Web Audio repeats in background or that a foreground browser test proves native push delivery. Current `kdsAudio.ts` acknowledges by **pending count**; test a new order arriving as another leaves (same count), branch/user switch and seen-ID cleanup. Do not treat unchanged count as proof no new order arrived.

## Work packages

### P1 — Global appearance, navigation and readability (10–16 hours)

Owner: Partner engineer / `opencode-go/deepseek-v4.1-flash`; GLM Free reviewer. Stage 01/04/08. Prerequisites: A0, approved A1 comps/B, C; D1 token-role decisions, not shared code. Owned existing files: `src/index.css`, `src/main.tsx`, `src/App.tsx`, `src/admin/theme/ThemeContext.tsx`, `src/pages/admin/AdminRoutes.tsx`, `src/admin/layouts/AdminLayout.tsx`, `src/components/layout/Header.tsx`, `src/components/layout/Sidebar.tsx`, `src/pages/SettingsPage.tsx`. Coordinate explicit handover of `App.tsx`/auth surfaces to B5; one writer at a time. Existing tests: `tests/token-accessibility.test.ts`, `tests/partner-sidebar-navigation.test.tsx`, `src/pages/SettingsPage.test.tsx`; proposed new `tests/launch-theme-system.test.tsx` and licensed Inter assets under verified `public/` (filenames to approve).

Source: `src/App.tsx:74–169` lacks a global theme wrapper, `AdminRoutes.tsx` wraps its admin subtree, `ThemeContext.tsx:14–21` defaults light; main CSS `:31–38,61–70` is dark/system-font-oriented; Settings has many literal dark surfaces. Reuse/extend the existing resolver rather than two providers fighting over document classes. Default System, validated persistence, sync at first paint/OS change/resume, same selection inside/outside admin. Preserve any existing explicit preference.

Acceptance: login/operations/admin/settings all switch correctly in three modes; meaningful status/controls at 320 px/200% text; active nav, drawer keyboard escape/focus restore and safe-area content visible; no decorative critical typography. Commands **P-GATES**, **P-BROWSER** in document 09 and later both native appearance rows. Fingerprint G-PARTNER plus added app/bootstrap/test/asset bytes. Recovery: rollback only owned presentation diff; no clearing auth/outlet caches to hide failures. External blockers: approved comps and native devices.

### P2 — KDS/order/alert states and pending POS (12–20 hours)

Owner: Partner engineer / Go route, backend B3 supplies durable facts; QA NIM route conditional. Stage 04/05. Prerequisites: P1, B3 state/alert schema, B5 role contract, B/C. Owned existing files: `src/features/kds/hooks/useKDSRealtimeStream.ts`, `src/features/kds/components/KDSOrderCard.tsx`, `src/utils/kdsAudio.ts`, `src/pages/KDSPage.tsx`, `src/pages/OrdersPage.tsx`, `src/pages/OrderDetailPage.tsx`, `src/pages/DashboardPage.tsx`, `src/admin/layouts/petpoojaAlerts.ts`. Existing regression surfaces: `tests/kds-stream-degradation.test.ts`, `tests/kds-bump-outbox.test.ts`, `tests/partnerops-order-detail-truth.test.tsx`, `tests/partnerops-order-payment-labels.test.tsx`, `src/pages/KDSPage.test.tsx`. Proposed new `tests/launch-pending-pos-alerts.test.tsx`.

Preserve existing listener degradation helpers, branch filters, dedupe, stale-data age and outbox TTL/expected-state checks (`useKDSRealtimeStream.ts:26–41,93–197`). Do not replace hardening with a demo queue. Show real payment capture, POS transport acceptance and restaurant/operator confirmation separately. Alert dedupe uses durable order/threshold identity from B3; locally reconnecting must not repeat acceptance or mute a newly arriving order with unchanged queue count. Unknown/corrupt records stay visibly quarantined, not counted as clear/live.

Acceptance: authorised initial/duplicate/reordered snapshots, missing-index/permission errors, reconnect, old offline bump, terminal guard, branch/user switch, new ticket with same count, muted/unlock/permission states; 119s/120s/299s/300s alerts with server-time facts; no financial/POS mutation by sound acknowledgement. Commands P-GATES/P-BROWSER; native foreground/background/resume/lock and push tests after scoped approval. G-PARTNER + G-ROOT/B3 fingerprints; operator/new-build evidence absent until run. Recovery: preserve pending outbox/audit facts, revalidate rather than blindly replay; unavailable feed cannot masquerade as empty. External blockers: backend contract, local iOS access and separately approved notification testing.

### P3 — Stock, dispatch and actionable failures (8–12 hours)

Owner: Partner engineer / Go route; provider owner Phoenix route cross-checks. Stage 05/08. Prerequisites: P1, B2/B4/B6 safe server contracts, B/C. Owned existing files: `src/features/kds/components/KDSQuick86Drawer.tsx`, `src/features/menu/hooks/useBranchMenu.ts`, `src/hooks/useMenu.ts`, `src/pages/MenuPage.tsx`, `src/pages/DeliveryQueuePage.tsx`, `src/services/partnerFunctionsApi.ts`. Existing tests: `src/features/kds/components/KDSQuick86Drawer.test.tsx`, `src/hooks/useMenu.test.ts`, `tests/menu-86ing-combo.test.tsx`, `tests/restaurant-dispatch-choice.test.tsx`, `tests/partner-menu-seed-honesty-guard.test.ts`, `tests/partnerops-walkin-payment-truth.test.tsx`.

Expose “saved here / customer availability updated / POS sync pending or failed” distinctly. Current `useBranchMenu.ts:214–243` writes product stock then pushes POS; preserve this uncertainty instead of a single optimistic green toast. Require one selected permitted outlet for a mutation; “All Outlets” is not an inferred mutation scope. Keep legitimate no-POS-ID combos honest as app-only/unavailable to POS until mapped; never invent an item ID. Disabled/unconfigured providers stay unavailable; retired Porter is not restored by UI polishing. A cash/manual tender is external collection, not a Razorpay receipt.

Acceptance: permission failure/network interruption/double tap/concurrent stock restore; correct branch and combos; customer 86 visibility; confirmed provider rejection versus ambiguous booking; real fare/status/manual assignee; no seed-write success in production. Commands P-GATES/P-BROWSER + B4/B6 hermetic/emulator/provider cases. Fingerprint G-PARTNER + relevant G-ROOT; additional tests before edit. Recovery: show last confirmed stock plus pending action; server-authorised reconciliation only, never client overwrite of server financial/POS facts. External blockers: merchant/provider contracts and exact outlet acceptance envelope.

## Auth and scope ownership

B5, not a separate uncoordinated UI worker, owns invite/revocation server logic and the existing Partner `src/core/auth/AuthContext.tsx`, `src/core/auth/ProtectedRoute.tsx`, `src/core/auth/routePolicy.ts`, `src/stores/authStore.ts`, `src/pages/LoginPage.tsx` when fixes are needed. Public download must not widen app roles. Existing invite/claim guards are present, so this is validation/repair, not a claim that invitation needs to be invented.

## ICM edit-source and visual exits

P1 updates design/token/Stage 04 theme guidance through A2. P2 updates Stage 04/05 alert/feed/POS definitions; P3 updates Stage 08 stock and Stage 05 provider behaviour. Tests must reject stale literal-colour/always-live/mock-success assumptions. Existing Partner tests that import customer `node_modules/jsdom` require R1's explicit installation repair; no missing-dependency skip is acceptable proof.

A1 screenshot proposals: staff sign-in/invite denial; orders + paid/POS-pending ticket; KDS live and reconnecting/muted; stock drawer with failed POS sync; dispatch ambiguity; settings three-way theme. Show both light/dark critical screens at phone/tablet widths. These can use clearly marked synthetic design data only, never production-seeming fixtures in the app bundle. Team visual approval, staff/operator acceptance and store review remain separate.
