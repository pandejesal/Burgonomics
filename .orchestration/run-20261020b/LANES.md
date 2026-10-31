# Lane registry and ownership map — run 2026-10-20b

| # | Lane | Model | Brief |
|---|---|---|---|
| 01 | Customer app frontend (delivery/takeaway) | deepseek-v4.1-flash-free | `lane-01.md` |
| 02 | Partner app frontend (restaurant ops) | glm-5.3-flash-free | `lane-02.md` |
| 03 | Menu, design system, gestures, a11y (both apps) | deepseek-v4.1-flash-free | `lane-03.md` |
| 04 | Backend API, order lifecycle, webhooks | glm-5.3-flash-free | `lane-04.md` |
| 05 | Third-party integrations and API docs | deepseek-v4.1-flash-free | `lane-05.md` |
| 06 | Petpooja POS and CRM | glm-5.3-flash-free | `lane-06.md` |
| 07 | Firebase database, auth, rules, FCM | deepseek-v4.1-flash-free | `lane-07.md` |
| 08 | Razorpay payments | glm-5.3-flash-free | `lane-08.md` |
| 09 | Borzo rider dispatch | deepseek-v4.1-flash-free | `lane-09.md` |
| 10 | Shadowfax rider dispatch | glm-5.3-flash-free | `lane-10.md` |
| 11 | Android and iOS native, both apps | deepseek-v4.1-flash-free | `lane-11.md` |
| 12 | Independent QA and release verification | glm-5.3-flash-free | `lane-12.md` |

Review model order is independent of the worker model: every reviewed change goes
through `opencode/deepseek-v4.1-flash-free` first, then
`opencode/glm-5.3-flash-free`, each in a fresh read-only child session.

## Exact-path ownership
- **01 Customer app** — customer repo `src/routes/**` (except `payment.tsx`), customer
  `src/features/**` and customer-specific services/hooks. No shared components.
- **02 Partner app** — partner repo `src/**` except `src/shared/**` (lane 03),
  `src/features/branches/components/RazorpayRouteAccountCard.tsx` (lane 08), and
  Petpooja sync services (lane 06). Native dirs belong to lane 11.
- **03 Design/menu/a11y** — customer `src/shared/**`, customer `tests/playwright/**`
  and Playwright configs; partner `src/shared/**`, `src/index.css`; cross-app
  browser-based gesture/a11y acceptance evidence.
- **04 Backend** — `functions/src/index.ts`, `functions/src/core/**`,
  `functions/src/modules/orders/**`, `tickets/**`, `customers/**`, `audit/**`,
  `dispatch/dispatch.webhooks.ts`, `dispatch/dispatch.router.ts`,
  `dispatch/index.ts`, `dispatch/readiness.ts`, plus matching tests.
- **05 Docs/contracts** — `references/**`, `docs/**`, `stages/**` documentation,
  `.orchestration/run-20261020b/evidence/**`. No source code.
- **06 Petpooja** — `functions/src/modules/petpooja/**`, `functions/tests/petpooja.*`,
  partner `src/services/petpoojaSync.ts`,
  `src/features/orders/services/petpoojaTestRunnerService*.ts`, Petpooja reference docs.
- **07 Firebase** — `firebase.json`, `firestore.rules`, `firestore.indexes.json`,
  storage rules, `functions/src/modules/auth/**`, `notifications/**`, auth/notification
  tests, customer `tests/rules/**`, `scripts/test-rules.mjs`.
- **08 Razorpay** — `functions/src/modules/payments/**`, `functions/tests/payments.*`,
  customer `src/routes/payment.tsx` + test, partner Razorpay Route card component.
- **09 Borzo** — `functions/src/modules/dispatch/providers/borzo.adapter.ts` and
  `functions/tests/dispatch.borzo*`.
- **10 Shadowfax** — `functions/src/modules/dispatch/providers/shadowfax.adapter.ts`
  and `functions/tests/dispatch.shadowfax*`.
- **11 Native** — both app repos `android/**`, `ios/**`, `capacitor.config.*`,
  `vite.mobile.config.ts`, mobile manifest/store-readiness docs.
- **12 QA** — `.orchestration/run-20261020b/qa/**`; runs gates, allocates review
  slots, writes independent evidence. Owns no product source.

Overlaps require an explicit written handoff on `fresh-run-2-ownership`; the owner
writes, the requester proposes exact hunks.
