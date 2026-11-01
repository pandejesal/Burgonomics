# Physical Android test request

User reports phone connected and requests device testing. This steers the active
production-readiness work; it does not authorize orders, payments or rider writes.

## Current connection state

- Windows enumerates Samsung USB connectivity/composite/modem devices normally.
- ADB now reports one authorized USB device: Samsung SM-S921B (Android 16 / API 36, 1080x2340, density 480). Serial is intentionally not recorded.
- No phone tests, app installs, screenshots, authentication or provider activity
  have been performed. User must unlock the phone, enable USB debugging and accept
  the computer's RSA authorization prompt. File-transfer USB mode/data cable may
  be needed. Never bypass the lock screen or ask for the phone PIN.
- An interactive authorization question was cancelled by server restart; no answer
  or authorization is inferred from that cancellation.

## Existing preparation worker — do not duplicate

Nexus tester `ses_e9854c4b1fferdVQ0jdd4ipqfp`, model
`google/antigravity-gemini-3.8-flash-low`, prepares existing web bundles as isolated
debug APKs. It may change only generated native files in the isolated app checkouts.
It must not install, uninstall, clear app data, open release keys, or rebuild the
already completed web bundles. Gradle offline first; missing caches are a blocker.

Requested debug package suffix: `.devicetest`, using an external Gradle init
script, not changes to committed release build settings. Verify APK package IDs
before any install. Existing `com.burgonomics` and `com.burgonomics.partner` apps
and their data must remain untouched.

## Once ADB reports one authorized USB device

1. Record Android version/model (no serial/IMEI export); verify QA APK identities.
2. Install only the separate debug QA packages. Never uninstall an existing app or
   bypass signature mismatch by clearing its data.
3. Verify cold launch, visible first render, navigation, touch/back behavior,
   keyboard/layout and foreground-only logs. Test only anonymous/local safe flows.
4. Capture only the fresh QA app screen, never lock/home/private notifications or
   signed-in account/order data. Redact logs before retaining evidence.
5. Do not submit address/order/payment forms, request OTP SMS, send FCM, mutate
   live stock, or book riders. Runtime configuration is UNKNOWN; debug compilation
   and visible UI are not provider integration proof.
6. Mark each scenario PASS/FAIL/BLOCKED with APK SHA-256 and source commit identity.
   Real payment/Petpooja/KOT/dispatch/FCM tests require separate approved staging
   prerequisites; do not relabel an error screen or mock as live success.

Other source worker remains `ses_e98649b9dffev90kfGAlMHigjT` (Petpooja review fixes).
Dispatch source is frozen and independently approved, awaiting combined full gate.


## First customer launch ? FAIL (startup)

QA APK `com.burgonomics.devicetest` (debug, versionName `1.0.0-device-test`) installed successfully; existing `com.burgonomics` and `com.burgonomics.partner` installs and data were not replaced. APK SHA-256: `5A0532847C1CAAE3E75723940C354874DF8F02C3350DFA0F98F963C3B3462A8C`.

`am start -W` timed out (10.4 s) and the native splash remained. `topResumedActivity` was the QA app, process alive. Logs showed missing Firebase native default options, Firebase App Check plugin load failure, and early safe-area style errors. This is expected fail-closed behavior for an APK built without production config, but an indefinite splash is not: the entry error path renders the configuration screen without hiding the native splash. Navigation tests are BLOCKED until a reviewed startup fix is built and reinstalled. No order, auth, payment, provider, or rider action was performed.


## First partner launch ? FAIL (startup)

Partner QA APK `com.burgonomics.partner.devicetest` (debug, versionName `1.0.0-device-test`) installed alongside the existing partner app; existing `com.burgonomics.partner` data untouched. APK SHA-256: `D853A492848D6FC207681FB4884DA4E1C2299BD7AA2907B13B48ADC49A1C9E10`. `am start -W` timed out and the native splash remained. Logs showed `FirebaseError: auth/invalid-api-key` during module evaluation; `main.tsx` statically imports Firebase/App before `createRoot`, so neither an error screen nor `initNativeShell()` ran. Navigation is BLOCKED pending the separate partner startup fix. No order, auth, payment, provider, or rider action was performed.


## Customer startup fix ? DEVICE PASS

Rebuilt QA APK SHA-256 `8DF2922CF6B3E636B46AA515F61CFF575E4B0E46ECB7E67306CC4261CD02AA68` (debug `.devicetest`, 2,875-module web bundle). Installed over the QA package only. Cold `am start -W`: `Status: ok`, `LaunchState: COLD`, `TotalTime: 1331 ms`; process alive; screen shows the accessible ?The app could not start? alert with technical details listing the missing Firebase environment variables. No native splash remained. This proves the failure presentation on-device, not production configuration or app functionality; authenticated/navigation/order flows remain BLOCKED without approved staging configuration.

## Partner startup fix ? DEVICE PASS

Rebuilt Partner QA APK SHA-256 `8C4F47DAEE0BDF0D6BA865D500D7FBB7068AC677B668ABA75CA432BA3D2F6104` (debug `.devicetest`, 3,469-module web bundle). Installed over QA package only. Cold `am start -W`: `Status: ok`, `LaunchState: COLD`, `TotalTime: 1300 ms`; process alive (PID 5195); screen shows ?BURGONOMICS PARTNER ? The app could not start? alert with technical details `Firebase: Error (auth/invalid-api-key)`. No native splash remained. This verifies startup failure handling on physical hardware without masking missing config; authenticated POS/KOT flows remain BLOCKED without approved credentials.
