# Lane 11 — Android and iOS native, both apps

Mission: both apps build and package correctly for Android now, and are genuinely
ready for iOS when a Mac is available. No invented builds or signing.

Owned:
- Customer and partner repos: `android/**`, `ios/**`, `capacitor.config.*`,
  `vite.mobile.config.ts`, mobile manifest/store-readiness docs.
- Native build evidence under the run evidence dir.

Do not touch: JS/TS app source, Functions, other lanes' files. Native config changes
that affect app code require a written handoff.

First actions:
1. Read CONTRACT/BASELINE/LANES; inspect both apps' Capacitor config, Android
   manifests/gradle, iOS project, and existing release docs.
2. Android positive gate in an isolated scratch tree per repo: `build:mobile` ->
   `cap sync android` -> `assembleDebug` with existing JDK/SDK. Negative gate:
   `assembleRelease` without keystore must fail closed, not silently use debug signing.
   Document tool versions and exact commands.
3. Fix one real native gap you can prove locally (permission, deep link, manifest,
   plugin config, cleartext, target SDK) with a build check. Then DS review, GLM
   verification, and a local commit.
4. iOS: static readiness only — inspect project/platform config and list exact
   blockers. Native build/TestFlight requires macOS/Xcode and signing: mark BLOCKED.

Known: customer app has Vite mobile build + Capacitor; partner likewise. Existing
keystores must never be copied/generated/printed. No store publishing. No emulator
claim unless an APK actually installed and launched on a named emulator/device.
