# Stage 01: Project Setup & Core Infrastructure

> **Layer 2 Stage Contract**: Tooling, monorepo configurations, environment setup, Capacitor mobile initialization, and Firebase Functions v2 setup.

---

## 1. Inputs
- **Layer 3 (Reference)**: `../../_config/architecture_overview.md`
- **Layer 3 (Reference)**: `../../_config/deployment_strategy.md`
- **Layer 3 (Reference)**: `../../_config/coding_standards.md`
- **Authoritative Backend Spec**: `../../references/backend_upgrade_spec.md`
- **Authoritative UI/UX Spec**: `../../references/ui_ux_spec.md`

---

## 2. Process
1. Initialize/verify Vite + React + TypeScript configuration in both `burgonomics-foundation-core/` and `burgonomics-partner/`.
2. Configure path aliases (`@/*` -> `src/*`) in `tsconfig.json` and `vite.config.ts`.
3. Set up root `/functions` Firebase Cloud Functions v2 package (TypeScript, `firebase-admin`, `firebase-functions/v2`).
4. Set up Capacitor core (`@capacitor/core`, `@capacitor/android`, `@capacitor/ios`, `@capacitor/push-notifications`, `@capacitor/geolocation`, `@capacitor/haptics`) with unique app IDs:
   - Customer App: `com.burgonomics.app`
   - Partner App: `com.burgonomics.partner`
5. Establish environment variable templates (`.env.example`) for Firebase, Razorpay, Petpooja, and Porter.
6. Configure design token imports linked to `_config/design_system.md`.

---

## 3. Outputs
- `burgonomics-foundation-core/capacitor.config.ts`
- `burgonomics-partner/capacitor.config.ts`
- `functions/package.json` & `functions/tsconfig.json`
- `output/stage_summary.md` -> Stage completion summary and verification record

---

## 4. Verify
Run the following verification gate:
```bash
npx tsc --noEmit && npm run build
```
- Assert zero TypeScript compiler errors.
- Assert successful production bundle generation in `dist/`.
