# Partner UX and operational requirements

Status: focused polish approved; both native store targets remain in scope. No Partner screen was inspected on the phone during this task.

## Scope

- Publicly downloadable app with invite-only staff access, least-privilege roles and branch scoping. No self-service privilege assignment.
- Improve readable typography, spacing, navigation, primary actions, order/KDS visibility, stock controls, dispatch and failure states. Avoid a full workflow restructuring during this release.
- Use the same white/light, black/dark, System / Light / Dark preference and self-hosted Inter direction as Delivery, while preserving the density needed for operations.
- Do not unify apps into a new component library or replace the routing architecture merely for visual consistency. They currently use separate implementations and token namespaces.

## Behaviours that must remain real

- Incoming orders arrive from the real authorised branch stream, not a demo queue.
- New-order audio/visual alerts work within platform restrictions, with clear muted/permission/network states. Test foreground/background/resume behaviour; no guarantee that a background web audio loop works on every OS.
- KDS reconnects without losing, duplicating or misattributing tickets. State transitions respect terminal orders and server-authoritative payment/POS state.
- Stock/86 changes affect the correct branch and genuinely reach customer availability. No client-only toggle presented as a completed server update.
- Staff can identify paid-but-POS-pending orders and act on 2-minute alerts and 5-minute escalations. Failure visibility must not invite blind duplicate pushes.
- Dispatch shows the true provider/manual-delivery state, fees, ambiguity and failures. Missing provider contracts/credentials must not generate simulated riders or revive a retired provider.
- Brand-owner and branch-owner roles do not justify trusting client-authored financial truth; see the backend findings.

## Source leads — partner repo relative

Verified paths, inspected by the reconnaissance worker unless stated otherwise:

- `src/index.css` — separate `--color-*` token namespace; existing file already dirty.
- `src/components/layout/Header.tsx` and `src/components/layout/Sidebar.tsx` — navigation/layout; already dirty.
- `src/features/kds/hooks/useKDSRealtimeStream.ts` — stream lifecycle; already dirty.
- `src/utils/kdsAudio.ts` — audio behaviour.
- `src/features/kds/components/KDSQuick86Drawer.tsx` — stock control.
- `package.json` — directly read; `react-router-dom`, independent build/test scripts, not the customer's TanStack Router.

The worker reported that some Partner tests load jsdom through the customer repo's `node_modules`. Revalidate this coupling before isolating test worktrees or changing installs. Do not delete or reinstall a sibling app to make tests pass.

## Required acceptance coverage

- Uninvited user, unauthenticated user, each supported staff role and cross-branch denial.
- Empty, loading, permission-denied, disconnected, reconnecting and stale-data states.
- Small phone, large text, light/dark mode, keyboard/focus access and device safe areas.
- Actual order arrival, alert acknowledgement, progression, duplicate events, terminal guards, stock propagation and pending-POS escalation.
- Signed Android and iOS test builds tied to the changed source. No inherited approval from the October 17 artifacts.

Proposed operational screens must be approved by Burgonomics via the user's screenshots. Visual approval is separate from restaurant/operator acceptance and store submission approval.
