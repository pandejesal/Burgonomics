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
- **Strict 60-30-10 Token Usage**: Always use semantic Tailwind classes (`bg-primary`, `bg-surface`, `text-accent`, `text-text-primary`). No hardcoded hex or raw Tailwind colors.
- **Accessibility (WCAG 2.2 AA)**:
  - All interactive elements must have a minimum touch target of `44px x 44px`.
  - Color contrast ratio must meet or exceed 4.5:1 for normal text (Dark mode text uses `--primary-text: #4ADE80` on dark surfaces).
  - All icon buttons must provide `aria-label` or `sr-only` descriptive text.

---

## 4. Backend Cloud Functions v2 Standards
- Cloud Functions located in root `/functions`.
- Functions must be idempotent: Use `orderId` or `event.id` as deduplication keys.
- Secret management: Never commit private API keys. Use Firebase Secret Manager (`defineSecret`).
- Error handling: Graceful error snapshots written to `dev_error_snapshots/{id}` with technical stack traces for developer inspection.
