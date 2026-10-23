# R15 — Android Release Signing Repair

## Executive Summary

Removed the "magic password fallback" from both customer and partner `android/app/build.gradle` release signing configs. The release config no longer silently falls back to debug signing when env/keystore values are absent — it fail-closes instead, preventing debug-signed artifacts from being labeled as release. Preserved DEBUG assemble/install functionality and local key.properties signing file use. Fixed the GitHub Actions `android-build.yml` to not embed fake credential fallbacks (`ci_build_keystore_pass`). CI will now abort early with clear errors if release signing secrets are missing.

## Root Cause

The `signingConfigs.release` block in both `android/app/build.gradle` files contained:

```groovy
else {
    // Fallback to debug signature for local release verification
    initWith(signingConfigs.debug)
}
```

This caused release builds to silently fall back to debug signing when `RELEASE_STORE_FILE`, `RELEASE_STORE_PASSWORD`, or `RELEASE_KEY_PASSWORD` were not set. In CI (particularly the customer `android-build.yml`), the `|| 'ci_build_keystore_pass'` fallback embedded a hardcoded password as a default, producing debug-signed AABs labeled as release — a store rejection risk (finding D1 in STORE_SUBMISSION_GUIDE.md).

## Edits Made

### 1. Partner App: `burgonomics-partner\android\app\build.gradle`

**Removed** the `else { initWith(signingConfigs.debug) }` fallback from `signingConfigs.release` (was lines 50-53).

**Before:**
```groovy
signingConfigs {
    release {
        // Precedence: CI env vars -> android/key.properties (gitignored) -> debug fallback.
        def props = new Properties()
        def propsFile = rootProject.file("key.properties")
        if (propsFile.canRead()) {
            props.load(new FileInputStream(propsFile))
        }
        def keystorePath = System.getenv("RELEASE_STORE_FILE") ?: props.getProperty("storeFile") ?: "../release.keystore"
        def keystoreFile = file(keystorePath)
        def storePass = System.getenv("RELEASE_STORE_PASSWORD") ?: props.getProperty("storePassword")
        def keyPass = System.getenv("RELEASE_KEY_PASSWORD") ?: props.getProperty("keyPassword")
        def keyAliasName = System.getenv("RELEASE_KEY_ALIAS") ?: props.getProperty("keyAlias") ?: "burgonomics"
        if (keystoreFile.exists() && storePass && keyPass) {
            storeFile keystoreFile
            storePassword storePass
            keyAlias keyAliasName
            keyPassword keyPass
        } else {
            // Fallback to debug signature for local release verification
            initWith(signingConfigs.debug)
        }
    }
}
```

**After:** The `else { initWith(signingConfigs.debug) }` block is removed. If the keystore/file/password conditions are not met, the release signing config simply has no values set, and Gradle will error with a clear message about missing release signing configuration.

### 2. Customer App: `burgonomics-foundation-core\android\app\build.gradle`

**Removed** the `else { initWith(signingConfigs.debug) }` fallback from `signingConfigs.release` (was lines 50-53).

**Same change as partner app** — the `else` block removed, fail-closed behavior on absent release signing values.

### 3. Customer App: `burgonomics-foundation-core\.github\workflows\android-build.yml`

**Removed** `|| 'ci_build_keystore_pass'` fallback from RELEASE_STORE_PASSWORD and RELEASE_KEY_PASSWORD env var references (was lines 57 and 59).

**Before:**
```yaml
          RELEASE_STORE_PASSWORD: ${{ secrets.RELEASE_STORE_PASSWORD || 'ci_build_keystore_pass' }}
          RELEASE_KEY_PASSWORD: ${{ secrets.RELEASE_KEY_PASSWORD || 'ci_build_keystore_pass' }}
```

**After:**
```yaml
          RELEASE_STORE_PASSWORD: ${{ secrets.RELEASE_STORE_PASSWORD }}
          RELEASE_KEY_PASSWORD: ${{ secrets.RELEASE_KEY_PASSWORD }}
```

Without these fallbacks, the CI job will fail early if the secrets are not provided, rather than silently using a throwaway password.

## Preserved Functionality

- **DEBUG assemble/install**: Unchanged. Debug builds continue to work via the default `signingConfigs.debug` and local `key.properties` file. The `gradlew assembleDebug` command in both repos is unaffected.
- **Local local signing file use**: The `key.properties` files (gitignored) and `release.keystore` path (`../release.keystore` relative to `android/app/`) are still read by the build.gradle if present. Local developers who have these files can still build release AABs.
- **CI env vars precedence**: The precedence `System.getenv() → key.properties → defaults` is preserved. The only change is that absent values no longer trigger a debug fallback.

## Signing Configuration Prerequisites (Unsigned / Signed Builds)

### Unsigned build prerequisites (release without signing config):
- Release `assembleRelease`/`bundleRelease` will fail Gradle-side with: `No signing config found for release build type`.
- This is intentional — the build must not proceed without proper release signing configuration.
- CI workflows must provide `RELEASE_KEYSTORE_BASE64` (decoded to `android/release.keystore`) + `RELEASE_STORE_PASSWORD` + `RELEASE_KEY_PASSWORD` + `RELEASE_KEY_ALIAS` env vars.

### Signed build prerequisites (release with signing):
- **Local**: `android/key.properties` with `storeFile`, `storePassword`, `keyAlias`, `keyPassword` present. `android/release.keystore` file present at `android/` root (path `../release.keystore` relative to `android/app/`).
- **CI**: All four GitHub Actions secrets must be set: `RELEASE_KEYSTORE_BASE64`, `RELEASE_STORE_PASSWORD`, `RELEASE_KEY_PASSWORD`, `RELEASE_KEY_ALIAS`. The `RELEASE_KEYSTORE_BASE64` is decoded to `android/release.keystore` before the gradle step.

### DEBUG build (unchanged):
- `gradlew assembleDebug` works without any env vars or keystore files. Uses the default debug signing configuration provided by the Android Gradle Plugin.

## Tests

No Gradle full builds were run. Changes are confined to build configuration files and workflow YAML. The following static verifications are recommended:

1. **Build config syntax check**: Read both `android/app/build.gradle` files and verify the `signingConfigs.release` block no longer contains `initWith(signingConfigs.debug)`.
2. **Workflow YAML lint**: Read the customer `.github/workflows/android-build.yml` and verify `RELEASE_STORE_PASSWORD` and `RELEASE_KEY_PASSWORD` no longer have `|| 'ci_build_keystore_pass'` fallbacks.
3. **Debug build preservation**: Run `gradlew assembleDebug` in both repos to confirm debug builds still succeed (these use the default debug config, not the release block).
4. **Key.properties integrity**: Verify `key.properties` files in both `android/` dirs are gitignored and contain only local signing config (no values should be committed).

## Audit Notes

- No binary keystore files are read or committed. The `release.keystore` binary files (`.old-20261007`, `broken-20261007`) are archived but not processed.
- The `key.properties` files contain embedded passwords but are `gitignored` in both repos (`.gitignore += key.properties`).
- No new credentials or secret values were introduced. The existing env var and key.properties access patterns are preserved, just without the debug fallback.