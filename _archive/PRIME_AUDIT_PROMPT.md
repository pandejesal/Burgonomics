# Prime Agent Audit Prompt — Burgonomics

## Task
Audit both Burgonomics apps for third-party integrations, API functionality, and store readiness. Output structured JSON report to file.

## Context
- Project root: C:\Users\DELL\Desktop\Burgonomics
- Two apps: burgonomics-foundation-core (customer), burgonomics-partner (partner)
- Shared backend: functions/ (Firebase Functions v2)
- Target: Play Store + App Store submission readiness

## Instructions
1. Read all relevant files in both apps (package.json, capacitor.config.ts, build.gradle, Info.plist, PrivacyInfo.xcprivacy, firestore.rules, functions/src/index.ts)
2. Run verification commands (tests, builds, typecheck)
3. Output JSON report to: C:\Users\DELL\Desktop\Burgonomics\AUDIT_REPORT_PRIME_YYYY-MM-DD.json

## Report Schema
{
  "timestamp": "ISO8601",
  "apps": {
    "burgonomics-foundation-core": {
      "architecture": "PASS|FAIL|WARNING",
      "firebase_integration": "PASS|FAIL|WARNING",
      "capacitor_plugins": "PASS|FAIL|WARNING",
      "payment_gateway": "PASS|FAIL|WARNING",
      "pos_integration": "PASS|FAIL|WARNING",
      "push_notifications": "PASS|FAIL|WARNING",
      "api_layer": "PASS|FAIL|WARNING",
      "security_firestore_rules": "PASS|FAIL|WARNING",
      "secrets_management": "PASS|FAIL|WARNING",
      "android_store_ready": "PASS|FAIL|WARNING",
      "ios_store_ready": "PASS|FAIL|WARNING",
      "tests_passing": "PASS|FAIL|WARNING",
      "ci_cd": "PASS|FAIL|WARNING",
      "issues": [{"category": "...", "severity": "P0|P1|P2", "file": "...", "line": N, "description": "...", "fix": "..."}]
    },
    "burgonomics-partner": { ... same structure ... }
  },
  "functions_backend": {
    "api_endpoints": "PASS|FAIL|WARNING",
    "auth_middleware": "PASS|FAIL|WARNING",
    "rate_limiting": "PASS|FAIL|WARNING",
    "schedulers": "PASS|FAIL|WARNING",
    "webhook_verification": "PASS|FAIL|WARNING",
    "issues": [...]
  },
  "summary": {
    "total_p0": N,
    "total_p1": N,
    "total_p2": N,
    "store_ready_foundation_core": "YES|NO|CONDITIONAL",
    "store_ready_partner": "YES|NO|CONDITIONAL"
  }
}

## Verification Commands to Run
```bash
cd C:\Users\DELL\Desktop\Burgonomics\burgonomics-foundation-core
npm run test
npx tsc --noEmit
npm run build

cd C:\Users\DELL\Desktop\Burgonomics\burgonomics-partner
npm run test
npm run typecheck
npm run build

cd C:\Users\DELL\Desktop\Burgonomics\functions
npm run test
npm run build
```

## Output
Write the complete JSON report to the output file. Do not print to stdout (file only).