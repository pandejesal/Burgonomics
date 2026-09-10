# Antigravity Audit Prompt — Burgonomics

## Task
Perform deep codebase audit of both Burgonomics apps focusing on:
1. Third-party integration implementations (Firebase, Razorpay, Petpooja, Porter, FCM)
2. Security patterns (Firestore rules, API keys, secrets, authentication flows)
3. Build configurations (Capacitor, Vite, Android Gradle, iOS Xcode)
4. Store readiness gaps (Play Store + App Store requirements)

## Context
- Project root: C:\Users\DELL\Desktop\Burgonomics
- Two apps: burgonomics-foundation-core (customer), burgonomics-partner (partner)
- Shared backend: functions/ (Firebase Functions v2)

## Instructions
1. **Search & analyze** all integration files:
   - Firebase: `src/core/config/firebase.ts`, `src/core/integrations/firebase/`
   - Razorpay: `src/core/integrations/razorpay/`, `functions/src/modules/payments/`
   - Petpooja: `src/core/integrations/petpooja/`, `functions/src/modules/petpooja/`
   - Porter: `functions/src/modules/porter/`
   - FCM: `functions/src/modules/notifications/fcm.service.ts`

2. **Security audit**:
   - Firestore rules: both apps' `firestore.rules`
   - API keys/secrets: `.env`, `.env.example`, keystore handling
   - Authentication flows: middleware, custom claims, role-based access

3. **Build config audit**:
   - Android: `android/app/build.gradle`, `AndroidManifest.xml`, `variables.gradle`
   - iOS: `Info.plist`, `PrivacyInfo.xcprivacy`, `App.entitlements`, `project.pbxproj`
   - Capacitor: `capacitor.config.ts`, `vite.config.ts`, `vite.mobile.config.ts`

4. **Run verification**:
   - All tests: `npm run test` in each app
   - TypeScript: `npx tsc --noEmit` / `npm run typecheck`
   - Builds: `npm run build` / `npm run build:mobile`

5. **Output**: Write detailed markdown report to:
   `C:\Users\DELL\Desktop\Burgonomics\AUDIT_REPORT_ANTIGRAVITY_YYYY-MM-DD.md`

## Report Format
```markdown
# Burgonomics Dual-App Audit Report (Antigravity)
Date: YYYY-MM-DD

## Executive Summary
[Per-app PASS/FAIL/WARNING matrix]

## burgonomics-foundation-core
### Architecture & Code Quality
[Details]

### Third-Party Integrations
#### Firebase (Auth/Firestore/Functions/Storage)
[Config analysis, usage patterns, security]

#### Razorpay Payments
[Client stub, server functions, webhook handling]

#### Petpooja POS
[Client stub, server sync/KOT/webhook]

#### FCM Push Notifications
[Client plugin, server dispatch, token management]

### API Layer (via Functions)
[Endpoints, auth middleware, rate limiting, error handling]

### Security
[Firestore rules analysis, secrets management, auth flows]

### Build Configurations
[Capacitor, Vite, Android Gradle, iOS Xcode]

### Store Readiness
[Play Store: signing, permissions, targetSDK, bundle]
[App Store: entitlements, PrivacyInfo, ATS, usage strings]

### Testing & CI/CD
[Coverage, workflows, gates]

### Issues Found
| Category | Severity | File | Line | Description | Remediation |

## burgonomics-partner
[Same structure]

## Functions Backend
[API endpoints, middleware, schedulers, webhooks, security]

## Cross-Cutting Issues
[P0/P1/P2 prioritized list]

## Verification Evidence
[Command outputs, test results, build logs]
```

## Key Files to Read
- `burgonomics-foundation-core/package.json`
- `burgonomics-foundation-core/capacitor.config.ts`
- `burgonomics-foundation-core/src/core/config/firebase.ts`
- `burgonomics-foundation-core/src/core/integrations/` (all)
- `burgonomics-foundation-core/firestore.rules`
- `burgonomics-foundation-core/android/app/build.gradle`
- `burgonomics-foundation-core/ios/App/App/Info.plist`
- `burgonomics-foundation-core/ios/App/App/PrivacyInfo.xcprivacy`
- `burgonomics-foundation-core/ios/App/App/App.entitlements`
- `burgonomics-partner/` (same pattern)
- `functions/src/index.ts`
- `functions/src/modules/` (all)
- `functions/package.json`

## Output
Write complete markdown report to output file. Include file:line references for every finding.