# OpenCode Stream 2: Burgonomics Partner App "Clean Cut" for App Store

You are working in `burgonomics-partner`. Implement the "Clean Cut" launch requirements:

## 1. Eliminate Mock / Unintegrated Routes
In `src/pages/admin/AdminRoutes.tsx`:
- Redirect unintegrated mock routes (`marketing`, `automation`, `campaigns`, `create-campaign`, `templates`, `notifications-hub`, `customers/loyalty`) directly to `/admin/orders` or `/admin` via `<Navigate to="/admin/orders" replace />`.
- This ensures Apple App Store and Google Play reviewers never see mock marketing dashboards or simulated push campaigns.

## 2. Operational Screens Polish
Ensure all core store-operation views are 100% stable, responsive, and functional:
- **KDS (Kitchen Display System)**: Bump bar, order preparation status transitions (Received -> Preparing -> Ready -> Dispatched).
- **Orders Management**: Live order list, customer contact, address view, payment status (Paid vs Cash on Delivery/Counter).
- **86ing / Inventory**: Ability for kitchen staff to toggle menu items In-Stock or Out-of-Stock instantly.
- **Store Status**: Store Online / Offline toggle with visual indicator.

## 3. Verify Clean Build
Run `npm run build` in `burgonomics-partner` to ensure 0 TypeScript errors and a clean production bundle.
