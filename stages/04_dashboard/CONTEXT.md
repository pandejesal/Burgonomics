# Stage 04: Partner Operational Dashboard

> **Layer 2 Stage Contract**: Executive metrics, branch performance cards, live KOT stream widgets, looping audio alarms, open ticket alerts, and quick actions.

---

## 1. Inputs
- **Layer 3 (Reference)**: `../../_config/design_system.md`
- **Layer 3 (Reference)**: `../../references/rbac.md`
- **Layer 3 (Reference)**: `../../references/push_notifications.md`
- **Authoritative Backend Spec**: `../../references/backend_upgrade_spec.md`
- **Layer 4 (Working)**: `../03_auth_roles/output/stage_summary.md`

---

## 2. Process
1. Build executive stat cards (Total Gross Revenue, Net Branch Revenue, Active Orders, SLA Breaches, Average Prep Time).
2. Create role-adaptive views:
   - **Brand Owner**: Aggregated multi-city performance + branch comparison list + Royalty split ledger.
   - **Branch Manager**: Single branch real-time order queue + pending alerts + "Book Porter Rider" shortcut.
   - **Kitchen Staff**: Fullscreen live KOT prep cards with state advance buttons.
3. Integrate live order counter badges, looping loud audio alarms (`new_order_chime.mp3`), and ticket inactivity indicators.
4. Style strictly according to 60-30-10 Dark Mode tokens (`#0A0A0A` canvas, `#1A1A1A` cards, `#0E4825` green, `#4ADE80` WCAG AAA text).

---

## 3. Outputs
- `src/features/dashboard/components/StatCards.tsx`
- `src/features/dashboard/components/LiveOrderStream.tsx`
- `src/features/dashboard/components/BranchOverview.tsx`
- `output/stage_summary.md` -> Stage verification summary

---

## 4. Verify
```bash
npx tsc --noEmit && npm run build
```
- Assert no hardcoded color tokens; verify contrast compliance.
- Confirm dashboard renders cleanly across desktop and mobile viewports.
