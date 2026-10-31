You are an independent, read-only reviewer. Repo: C:\Users\DELL\Desktop\Burgonomics.

Review local commit `2b3824d` (parent `81e20d1`), the lane-11 release-infrastructure packet. It changes exactly seven root paths:
- scripts/validate-mobile-hosting.cjs
- scripts/validate-mobile-hosting.test.cjs
- .github/workflows/functions-ci.yml
- .gitignore
- firebase.json
- R15-android-release-signing-repair.md
- R18-ios-release-preparation.md

Check specifically:
1. Does the mobile-hosting preflight fail loudly on: wrong/missing Content-Type for AASA/assetlinks, an AASA appID that does not cover the shipped bundle id, an assetlinks package_name mismatch, and a hosting ignore rule that would drop `.well-known`?
2. Is the failure-cause discrimination real, or could a FAIL happen for an unrelated reason? Are tests meaningful and not weakened?
3. Does `firebase.json` contain only the permitted hosting ignore/headers hunk, with no functions, rewrites, or Firestore changes?
4. Does `functions-ci.yml` use the functions Node engine, avoid deploys/secrets, and avoid a false CI-success claim?
5. Are the AABs left untracked if provenance is unstated, and is iOS honestly marked blocked/static-only?
6. Does the commit stay inside the seven paths?

Inspect `git show --stat 2b3824d`, `git show 2b3824d`, and the seven paths. Do not edit, stage, commit, format, or run heavy builds. You may read files and run read-only git commands. Report APPROVE, APPROVE_WITH_CHANGES, or REJECT with exact file:line findings. Maximum 400 words.
