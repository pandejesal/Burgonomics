# Stage 07: Unified Support Ticketing & 3-Tier Escalator

> **Layer 2 Stage Contract**: Unified support ticketing for customer issues, 3-tier escalation (Branch Manager -> Brand Owner / Central Support -> Developer Team), 60-minute inactivity reminders, Razorpay auto-refund actions, and developer diagnostics.

---

## 1. Inputs
- **Layer 3 (Reference)**: `../../references/ticketing.md`
- **Layer 3 (Reference)**: `../../references/rbac.md`
- **Layer 3 (Reference)**: `../../_config/design_system.md`
- **Authoritative Backend Spec**: `../../references/backend_upgrade_spec.md`
- **Layer 4 (Working)**: `../06_customers/output/stage_summary.md`

---

## 2. Process
1. Build Support Ticketing queue in Partner App with filter lanes (`open`, `under_review`, `resolved`, `escalated`).
2. Implement **3-Tier Escalator**:
   - Tier 1 (Branch Manager): Instant full/partial refund or compensation coupon code.
   - Tier 2 (Brand Owner & Support): Goodwill vouchers and corporate mediation.
   - Tier 3 (Developer Team): Captures `dev_error_snapshots` (payloads, stack traces, Razorpay/Petpooja IDs).
3. Connect 60-minute inactivity reminder cron (`functions/src/tickets/reminderCron.ts`) pushing alerts to branch managers if tickets remain unattended.
4. Display photo attachments, linked order summary, and real-time resolution logs.

---

## 3. Outputs
- `src/features/tickets/components/TicketQueue.tsx`
- `src/features/tickets/components/TicketDetailModal.tsx`
- `src/features/tickets/components/EscalateTicketModal.tsx`
- `functions/src/tickets/createTicket.ts`
- `functions/src/tickets/resolveTicket.ts`
- `functions/src/tickets/escalateTicket.ts`
- `functions/src/tickets/reminderCron.ts`
- `output/stage_summary.md` -> Stage verification summary

---

## 4. Verify
```bash
npx tsc --noEmit && npx vitest run
```
- Assert that tickets flow smoothly through all 3 escalation tiers.
- Confirm auto-refund actions call `autoRefund` Cloud Function with correct idempotency.
