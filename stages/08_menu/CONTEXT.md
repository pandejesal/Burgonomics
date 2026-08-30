# Stage 08: Menu Management, Combos & Petpooja Catalog Sync

> **Layer 2 Stage Contract**: Category hierarchies, pre-made items & combos (no item modifiers), Petpooja menu ingestion, branch-level and brand-wide combo creation, and instant 86ing.

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
