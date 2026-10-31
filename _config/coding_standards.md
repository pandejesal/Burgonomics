# BURGONOMICS — Coding Standards & Engineering Invariants (Layer 3 Constraint)

> **Factory Configuration**: TypeScript guidelines, Zod validation boundaries, TanStack Query conventions, WCAG 2.2 AA accessibility, and error handling protocols.

---

## 1. TypeScript & Static Typing
- Strict mode enabled (`"strict": true` in `tsconfig.json`).
- Zero `any` types allowed in production code. Use `unknown` with Zod parsing / type guards.
- All Firestore document models and external API payloads must have associated TypeScript types and Zod schemas.

---

## 2. Server State & Data Boundaries
- **Client Data Fetching**: TanStack Query (`useQuery`, `useMutation`) or realtime Firestore listeners (`onSnapshot`) with strict unmount cleanup.
- **Never fetch in raw useEffect**: Avoid unmanaged `useEffect` data fetching loops.
- **Zod Validation at Boundaries**: All API inputs, Cloud Function parameters, and webhook payloads (Razorpay, Petpooja, Porter) must be validated using Zod.

---

## 3. Component Architecture & Design Token Enforcement
- **Strict 60-30-10 Token Usage**: Always use semantic Tailwind classes (`bg-primary`, `bg-surface`, `text-accent-text` for customer orange copy, `text-accent-light` for partner orange copy, `text-text-primary`). CTA fill and readable orange text are separate roles; do not use the fill token as dark-surface text. No hardcoded hex or raw Tailwind colors.
- **Accessibility (WCAG 2.2 AA)**:
  - Project touch-target requirement: `44px x 44px`. WCAG 2.2 AA SC 2.5.8 has a `24px x 24px` floor with specified exceptions; do not mislabel the stronger project target as the AA threshold. Document any compact-control deviation.
  - Color contrast ratio must meet or exceed 4.5:1 for normal text (Dark mode text uses `--primary-text: #4ADE80` on dark surfaces).
  - All icon buttons must provide `aria-label` or `sr-only` descriptive text.

---

## 4. Backend Cloud Functions v2 Standards
- Cloud Functions located in root `/functions`.
- Functions must be idempotent: Use `orderId` or `event.id` as deduplication keys.
- Secret management: Never commit private API keys. Use Firebase Secret Manager (`defineSecret`).
- Error handling: Graceful error snapshots written to `dev_error_snapshots/{id}` with technical stack traces for developer inspection.

## 5. Cross-Account, Payment and Release Invariants
- Every user-owned cache, including module-level maps, must be scoped to the current authenticated user. Capture the scope before asynchronous work and recheck it before committing its result into a store; a landed write for user A must never hydrate user B's session.
- A remote mutation failure must not return ordinary success or silently commit a local-only record. If offline queuing is supported, represent pending sync explicitly and distinguish it from a confirmed server save.
- Payment response tests must use the actual server wire shape. Normalize only authenticated, identifier-bound success; preserve structured pending/reconciliation outcomes and never mark a captured or verification-pending payment failed to satisfy a UI flow.
- Paid-order finalization must consume server truth rather than overwrite an existing confirmed order with client payment/status fields. Security rules remain restrictive; do not broaden customer writes to make checkout pass.
- Payment confirmation must atomically preserve existing delivery OTP hashes and later/terminal order states. Webhook-first and verify-first paths need equivalent safety; suppressed or unmatched captures must not drive new split/KOT/coin effects.
- Concurrency regression fixtures must model shared state, serialized commits or transaction retries. A passthrough transaction mock establishes a guard test, not evidence of race handling under contention.
- Release artifacts must require explicit valid signing configuration and reject default debug signing. Missing release keys must block release artifact tasks without blocking debug development. Test the negative gate; do not assume a tool will fail closed.
- CI workflows belong at each Git repository's root `.github/workflows/`; local YAML inspection is not evidence that a remote workflow ran.
- Report source inspection, local tests, emulator checks, provider-sandbox runs and physical-device acceptance separately. Windows source review cannot establish an iOS/Xcode build or iPhone runtime result. Never fill team IDs, signing fingerprints or provider credentials with invented values to green a release preflight.
- Verification refusal is not evidence of no capture: signature, ownership, amount/currency mismatch, missing capture lookup and unknown exceptions must not invite a new payment. A held authorization also needs reconciliation; display the known reference without promising an automatic refund or confirmation.
- Async search intent must invalidate outstanding result/suggestion tokens when the query or kind changes, is cleared or is reset. An obsolete response must not repopulate cleared results; returning to the same term must not dedupe against an invalidated request.
- Cold-render tests must include skeleton/empty early returns. Effects that synchronize handler refs must reference a binding initialized on every render path, not a later `const` skipped by the early return.
- Browser visual acceptance must first verify that actual application styles are applied and reject error-boundary renders. An unstyled page, local fixture, or viewport emulation is not evidence of production or native-platform acceptance.
