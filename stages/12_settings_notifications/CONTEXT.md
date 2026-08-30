# Stage 12: Settings, FCM Notifications & Direct Messaging (DMs)

> **Layer 2 Stage Contract**: System settings, Firebase Cloud Messaging (FCM) push dispatch, Capacitor native push registration, and 1:1 Branch Manager ↔ Brand Owner Direct Messaging inbox.

---

## 1. Inputs
- **Layer 3 (Reference)**: `../../references/firestore_schema.md`
- **Layer 3 (Reference)**: `../../references/rbac.md`
- **Layer 3 (Reference)**: `../../references/push_notifications.md`
- **Layer 3 (Reference)**: `../../_config/design_system.md`
- **Authoritative Backend Spec**: `../../references/backend_upgrade_spec.md`
- **Layer 4 (Working)**: `../11_users/output/stage_summary.md`

---

## 2. Process
1. **Direct Messaging (1:1 DMs) System**:
   - Host 1:1 communication between Branch Managers and Brand Owners (Yash and Nehh).
   - Maximum 2 chat rooms per branch (`${branchId}_Yash` and `${branchId}_Nehh`).
   - Listen to `chats/{pairId}/messages` via Firestore `onSnapshot`.
   - Dispatch background FCM push to `chat_{pairId}` topic on message send via `functions/src/notifications/dispatchFCM.ts`.
   - Support optional reference chips for linking specific `orderId` or `ticketId`.
   - Lean invariant: Zero typing indicators, zero presence tracking, zero read receipts.
2. **Settings & Preferences**:
   - Theme toggle (Dark Mode / Light Mode with 60-30-10 palette).
   - Audible alert toggle for incoming orders.
   - FCM notification permissions toggle & Capacitor native push registration (`@capacitor/push-notifications`).

---

## 3. Outputs
- `src/features/chat/components/ChatInbox.tsx`
- `src/features/chat/components/ChatThread.tsx`
- `src/features/settings/components/NotificationSettings.tsx`
- `functions/src/notifications/dispatchFCM.ts`
- `output/stage_summary.md` -> Stage verification summary

---

## 4. Verify
```bash
npx tsc --noEmit && npx vitest run
```
- Verify chat queries restrict access strictly to participants of `pairId`.
- Assert no external WebSocket or presence dependencies are introduced.
