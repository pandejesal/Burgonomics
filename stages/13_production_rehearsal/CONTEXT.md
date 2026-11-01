# Stage 13: Staging & Production Rehearsal Contract

## Purpose & Scope
Final dry-run verification, environment validation, and operational sign-off before production cutover. Stage 13 local preparation may proceed; entrance to staging execution and live production deployment is STRICTLY BLOCKED.

## Strict Operational Boundaries
- **No Deployment / Push**: Remote git, Firebase hosting/functions deploy, and vendor writes are strictly prohibited.
- **No Live Mutation**: Live payments, live rider allocations, real customer notifications, and PII exports are blocked.
- **Remote State Unknown**: Remote Firebase, Secret Manager, third-party portals, and mobile device states are unknown until explicitly evidenced; absence cannot be inferred locally.
- **Role Isolation**: Documentation draft only. Applied exclusively after backend author, reviewer, and final verification gates pass.

## Branch & Base Alignment
- Active worktree branch: `production-readiness-20261023`
- Base commit: `31e82c3` + verified backend commit `4029dee`.

## Verified Verification Gates & Commands
Execute sequentially in Windows PowerShell 5.1 (no `&&` chaining; stop on error):

1. **Backend Service Gate (`functions/`)**:
   ```powershell
   Set-Location functions
   npx tsc --noEmit
   npx vitest run
   npm run build
   Set-Location ..
   ```
   *Gate Status: PASSED (1017 passed, 2 skipped across 84 files, tsc 0, build 0).*

2. **Customer App Baseline Gate (`burgonomics-foundation-core/`)**:
   ```powershell
   Set-Location burgonomics-foundation-core
   npx tsc --noEmit
   npm test
   npm run build:mobile
   Set-Location ..
   ```
   *Gate Status: PASSED (763 unit tests / 100 files passing, 2875 modules built, on-device cold start 1331ms).*

3. **Partner App Baseline Gate (`burgonomics-partner/`)**:
   ```powershell
   Set-Location burgonomics-partner
   npm run typecheck
   npm test -- --maxWorkers=2
   npm run build
   Set-Location ..
   ```
   *Gate Status: PASSED (583 unit tests / 86 files passing, build 0, on-device cold start 1300ms).*

4. **Mobile Hosting & Security Validator (`scripts/validate-mobile-hosting.test.cjs`)**:
   ```powershell
   node --test scripts/validate-mobile-hosting.test.cjs
   ```
   *Status: 22/22 unit tests passed. Strict assembled fixture: 22 PASS / 3 FAIL (Apple Team ID placeholders + partner assetlinks.json). Local override: 22 PASS / 2 WARN / 1 FAIL.*

## Exit Criteria for Staging Entrance
1. Zero TypeScript diagnostics and clean Vitest run across all repositories.
2. Verified fail-closed error screens on physical Android device (Samsung SM-S921B).
3. Explicit production credential provisioning evidenced in target environment.
