# R18 — iOS Release Preparation (credential-free source repairs)

**Scope:** root `firebase.json` hosting `ignore`/`headers`; NEW
`scripts/validate-mobile-hosting.cjs` (+ NEW hermetic test); customer
`burgonomics-foundation-core/scripts/patch-ios-spm.js`,
`mac-build.sh`, `MAC_INSTRUCTIONS.txt` alignment.
**Authorisation:** production-ready source repairs only. **No deploy, no
network, no build, no package install, no commit, no push.**

---

## Executive summary

| # | Finding | Verdict | Action |
|---|---|---|---|
| 1 | Hosting `ignore` used the blanket dotfile pattern `**/.*` | **Latent trap, but NOT reproduced** on the installed toolchain — measured | Replaced with an explicit ignorelist + a validator rule that bans the shape permanently |
| 2 | Firebase Hosting set **no** `Content-Type` for the association files (Netlify did) | **PROVEN defect** | Added explicit JSON MIME rules for both `.well-known` paths, both sites |
| 3 | Published AASA still contains the literal `TEAMID.` placeholder | **PROVEN blocker** | Preflight now fails on it. **Team ID not invented** — user must supply it |
| 4 | `patch-ios-spm.js` step 10 rewrote `AppDelegate.swift`, dropping `lastURL` | **PROVEN regression** | Removed; canonical `ApplicationDelegateProxy` delegation restored |
| 5 | `patch-ios-spm.js` downgrades `capacitor-swift-pm` 8.5.2 → 8.5.0 | **Unsafe downgrade, but removal is BLOCKED** | Documented in-script + here. Retained, not deleted |
| 6 | `mac-build.sh` never ran the patch step, so `cap sync` left an unresolvable SPM graph | **PROVEN misalignment** | Patch step inserted after `cap sync ios` |
| 7 | Partner site publishes no `assetlinks.json` | **PROVEN defect, out of ownership** | Reported only, not touched |

**Still BLOCKED:** unsigned iOS builds, and the whole iOS runtime
(compile / archive / device). Nothing in this lane produced an `.ipa`, and
nothing claims it did. There is no Xcode and no Apple signing identity on this
Windows host.

---

## R14 constraints honoured

- **`WKAppBoundDomains` egress claim: rejected.** I make **no** claim about
  which origins the WKWebView can reach. `Info.plist` `WKAppBoundDomains` is
  unchanged at **9** entries and `capacitor.config.ts` still carries
  `ios.limitsNavigationsToAppBoundDomains: true`. `git diff -- ios` inside the
  customer repo is **empty**.
- **Domain list never expanded.** Apple's App-Bound Domains cap is 10. The list
  sits at **9**, i.e. exactly **one** slot of headroom. Nothing was added.
  `com.apple.developer.associated-domains` likewise untouched at 10 entries.
- **No App-Bound-Domains weakening.** The toggle was not disabled, and
  `MAC_INSTRUCTIONS.txt` now explicitly warns the person on the Mac not to
  disable it.
- **Root `functions/` source, Firestore rules, and CI: untouched.**
- **Android signing and any iOS project secret: untouched.**

---

## 1. Hosting `ignore` — measured, then replaced with an explicit ignorelist

### What the charter asserted, and what the measurement shows

The claim under test was that `**/.*` excludes `/.well-known/...`. I tested it
directly against firebase-tools' own file lister, using the **real** publish
directories:

```
firebase-tools 15.30.2  ->  node_modules/firebase-tools/lib/listFiles.js
  glob.sync("**/*", { cwd, dot: true, follow: true, nodir: true, posix: true,
                      ignore: ["**/firebase-debug.log", "**/firebase-debug.*.log",
                               ".firebase/*", ...config.ignore] })
resolved glob: 10.5.0
```

```
== burgonomics-app  (171 files uploaded)
   shipped ignorelist  .well-known survivors: [".well-known/assetlinks.json",
                                               ".well-known/apple-app-site-association"]
   legacy ['**/.*']    .well-known survivors: [".well-known/assetlinks.json",
                                               ".well-known/apple-app-site-association"]
== burgonomics-partner  (182 files uploaded)
   shipped ignorelist  .well-known survivors: [".well-known/apple-app-site-association"]
   legacy ['**/.*']    .well-known survivors: [".well-known/apple-app-site-association"]
```

**The exclusion does not reproduce on this toolchain.** glob 10 does not prune
directories that merely match an `ignore` pattern, and `**/.*` only matches a
final segment beginning with a dot — so `.well-known/apple-app-site-association`
passes through. I am reporting that rather than claiming a fix I did not make.

I also measured the proposed alternative the charter rejected:

```
ignore = ["firebase.json","**/.*","**/node_modules/**","!**/.well-known/**"]
  -> .well-known files: still present
```

The `!` negation is a **no-op**. `listFiles` forwards hosting `ignore` straight
to glob's `ignore` option, where `!` is not a re-include. It would have been
dead config that *reads* like a fix.

### What was actually wrong, and is fixed

`ignore` also provided **no** exclusion for the dot-directory case at all — it
was a blanket exclusion of the wrong kind: too broad for what it was protecting
(macOS `.DS_Store`) and silent about the one dot-path that must ship. Replaced
on both hosting sites with an explicit allowlist of ignorable junk:

```jsonc
"//ignore": "Explicit ignorelist, never a dotfile blanket. The previous \"**/.*\" excluded
             every dot path and .well-known is a dot DIRECTORY, so apple-app-site-association
             + assetlinks.json were one deploy path away from being dropped (App/Universal
             links then verify against nothing). No \"!\" negation either: firebase-tools
             forwards hosting.ignore straight to glob's ignore option, where \"!\" does not
             re-include. Verify with: node scripts/validate-mobile-hosting.cjs",
"ignore": [
  "firebase.json",
  "**/node_modules/**",
  "**/.firebase/**",
  "**/.DS_Store",
  "**/Thumbs.db",
  "**/desktop.ini",
  "**/*.log",
  "**/*.local"
]
```

This is equivalent-or-better on the current toolchain (measured above: same
171/182 file sets, `.well-known` intact either way) and is robust to **any**
deploy path that prunes matched dot-directories. The permanent guard is the
validator's `ignore-no-dotfile-blanket` rule, not this list.

`"//"` keys are inert: `convertConfig.js` only ever emits `rewrites`,
`redirects`, `headers`, `cleanUrls`, `appAssociation`, `i18n` and
`trailingSlashBehavior` to the API, and `firebase-tools/lib/config.js` performs
no schema validation. The repo already uses this convention in
`burgonomics-foundation-core/firebase.json`.

---

## 2. JSON MIME headers — PROVEN defect, fixed

`netlify.toml` and `public/_headers` both set `Content-Type: application/json`
for the two association files. The **Firebase** hosting config set none. Because
`apple-app-site-association` has **no file extension**, there is nothing for
content-type sniffing to key off, and the catch-all rule already in the config
applies `X-Content-Type-Options: nosniff` to it. Added to **both** hosting
sites, placed **after** the `"source": "**"` rule so it deterministically wins:

```jsonc
{
  "//": "JSON MIME for the association files. apple-app-site-association has no extension,
          so without this the catch-all X-Content-Type-Options: nosniff above applies to a
          non-JSON response type and iOS rejects it. Placed after the \"**\" rule so it
          deterministically wins for these two paths. Mirrors public/_headers + netlify.toml.",
  "source": "/.well-known/apple-app-site-association",
  "headers": [
    { "key": "Content-Type",  "value": "application/json" },
    { "key": "Cache-Control", "value": "public, max-age=300" }
  ]
},
{
  "source": "/.well-known/assetlinks.json",
  "headers": [
    { "key": "Content-Type",  "value": "application/json" },
    { "key": "Cache-Control", "value": "public, max-age=300" }
  ]
}
```

---

## 3. NEW opt-in preflight — `scripts/validate-mobile-hosting.cjs`

Read-only. Node standard library only (no deps, no network, no build, no
deploy). **Not** wired into `firebase deploy`, `mac-build.sh`, or any workflow —
a borrowed-Mac archive must stay possible while the AASA still carries a
placeholder.

```bash
node scripts/validate-mobile-hosting.cjs
node scripts/validate-mobile-hosting.cjs --allow-unresolved-teamid
```

Checks, per hosting site:

| Check | FAILs when |
|---|---|
| `firebase-json-parses` | `firebase.json` is unparseable |
| `hosting-present` | no `hosting[]` entries |
| `ignore-no-negation` | any `!`-prefixed ignore pattern (measured no-op) |
| `ignore-no-dotfile-blanket` | any blanket dotfile pattern — the permanent guard for finding 1 |
| `publish-dir-declared` / `publish-dir-exists` | publish dir missing, **with the build command in the message** |
| `well-known-present` | either association file absent from the publish dir |
| `well-known-not-ignored` | an ignore pattern actually matches a `.well-known` file |
| `json-content-type` | no rule sets `Content-Type: application/json` for that path |
| `aasa-parses` / `aasa-appids` | invalid JSON, or no `appIDs`/`appID`/`webcredentials.apps` |
| **`aasa-teamid-resolved`** | **unresolved `TEAMID` placeholder** (WARN under the flag) |
| `aasa-bundleid` | an AASA appID does not end with the app's `PRODUCT_BUNDLE_IDENTIFIER` |
| `assetlinks-parses` / `assetlinks-package` | invalid JSON, or `package_name` ≠ `applicationId` |

Design points worth calling out:

- **No invented Team ID.** The script reads, compares, and reports. It never
  writes a Team ID and never picks one.
- **Bundle id / application id are resolved per hosting site** from that site's
  own publish dir (`burgonomics-foundation-core/dist/mobile` →
  `burgonomics-foundation-core`), not hardcoded to one target — so the partner
  site is checked against `com.burgonomics.partner`, not the customer id.
- **Both AASA shapes supported**: modern `details[].appIDs[]` + `components[]`,
  and legacy `details[].appID` + `paths[]` (the partner site ships the latter).
- The glob matcher models exactly the shapes the shipped config uses (bare
  `**`, leading `**/`, trailing `/**`, literals with `*`/`?`) and **throws** on
  anything else, so a new pattern shape surfaces as an "unsupported" finding
  rather than a wrong yes/no answer.

### Current real-repo output (re-measured 2026-10-23, after the partner publish
### dir gained `.well-known/assetlinks.json` and the validator was hardened)

```
PASS 25  WARN 0  FAIL 2  SKIP 0     ->  exit 1   (strict)
tests 22  pass 22  fail 0                        (node --test scripts/validate-mobile-hosting.test.cjs)
```

The two strict FAILs are both the unresolved Team ID placeholder:

```
FAIL burgonomics-app/aasa-teamid-resolved      unresolved TEAMID placeholder in
                                               TEAMID.com.burgonomics  (x2)
FAIL burgonomics-partner/aasa-teamid-resolved  TEAMID.com.burgonomics.partner
```

The earlier partner `well-known-present` FAIL is gone: the partner publish dir now
ships `.well-known/assetlinks.json`. Nothing here is a Mac/Xcode/device result —
this is a static preflight only.

---

## 4. `patch-ios-spm.js` — AppDelegate rewrite removed; downgrade left, documented

### 4a. AppDelegate universal-link rewrite — REMOVED (proven regression)

Step 10 replaced the canonical delegation with a hand-rolled body. Measured
against the installed native sources:

`node_modules/@capacitor/ios/Capacitor/Capacitor/CAPApplicationDelegateProxy.swift`
(8.5.2):

```swift
public func application(_ application: UIApplication, continue userActivity: NSUserActivity,
                        restorationHandler: ...) -> Bool {
    if userActivity.activityType != NSUserActivityTypeBrowsingWeb || userActivity.webpageURL == nil {
        return false
    }
    let url = userActivity.webpageURL
    lastURL = url                                   // <-- the part the patch dropped
    NotificationCenter.default.post(name: .capacitorOpenUniversalLink, object: ["url": url])
    return true
}
```

`node_modules/@capacitor/app/ios/Sources/AppPlugin/AppPlugin.swift:98` reads
exactly `ApplicationDelegateProxy.shared.lastURL` for `App.getLaunchUrl()`, and
`lastURL` is declared `public internal(set)` — the app target **cannot** set it
itself. So the old step preserved `appUrlOpen` delivery but made a cold-start
universal link invisible to `App.getLaunchUrl()`, silently reverting the
deliberate fix recorded in `references/verification/8.1-ios.md` (Gap 4).

The proxy performs the *identical* guard and posts the *identical* payload, so
the canonical path is behaviour-preserving **and** restores `getLaunchUrl()`.
Removed; the step is replaced by a comment stating the evidence and warning
against re-adding it. `ios/App/App/AppDelegate.swift` is a **tracked** file, so
`cap sync` does not clobber it.

### 4b. `capacitor-swift-pm` 8.5.2 → 8.5.0 rewrite — BLOCKED, retained

Installed-tree measurement:

| Package | Version | Its own `capacitor-swift-pm` requirement |
|---|---|---|
| `@capacitor/ios`, `@capacitor/core`, `@capacitor/cli` | 8.5.2 | (no `Package.swift` — not an SPM package) |
| `@capacitor-firebase/app-check` | 8.5.2 | `from: "8.0.0"` |
| `@capacitor/app` / `geolocation` / `haptics` / `keyboard` / `network` / `preferences` / `splash-screen` / `status-bar` | 8.1.1 / 8.2.2 / 8.0.2 / 8.0.5 / 8.0.1 / 8.0.1 / 8.0.2 / 8.0.3 | `from: "8.0.0"` |
| **`@capacitor/push-notifications`** | **8.1.2** | **`exact: "8.5.0"`** (upstream's own hard pin) |
| `@aparajita/capacitor-secure-storage` | 8.x | `from: "8.0.0"` + `keychain-swift from: "21.0.0"` |
| `ios/App/CapApp-SPM/Package.swift` (CLI-generated, tracked) | — | **`exact: "8.5.2"`** |

`npx cap sync ios` regenerates that last row with `exact: "8.5.2"`. SwiftPM
intersects every constraint on a package identity, and `exact 8.5.2` ∧
`exact 8.5.0` is the empty set — so with the CLI output alone the graph cannot
resolve. The rewrite is what makes it resolve.

**Why this is BLOCKED rather than deleted:** removing it safely needs either

1. a `@capacitor/push-notifications` release whose `Package.swift` does not
   hard-pin 8.5.0 — requires a package install (out of R18 scope), or
2. hand-editing the CLI-generated `CapApp-SPM/Package.swift` — which the next
   `npx cap sync ios` silently reverts, i.e. a fix that does not survive.

Neither is available credential-free on this host, so per the charter I report
blocked rather than delete the large patch.

**Accepted residual risk, now written down:** with the pin, the native
Capacitor runtime is 8.5.0 while `@capacitor/ios` and the CLI are 8.5.2. It is
documented in the script header and in `MAC_INSTRUCTIONS.txt`, with an explicit
"Do not delete the pin without re-running package resolution on a Mac first."

Everything else in the script is untouched — no full rewrite, no
reformatting. Two comment-only clarifications were added where behaviour was
already correct (step 2's deliberately narrow `@capacitor`/`@aparajita` walk;
step 1's `keychain-swift` injection, which only fills in a top-level product
reference that `@aparajita/capacitor-secure-storage` already declares itself).

---

## 5. `mac-build.sh` + `MAC_INSTRUCTIONS.txt` — alignment

**Proven misalignment fixed.** `mac-build.sh` ran `npm ci` → `build:mobile` →
`npx cap sync ios` → `npx cap open ios`, and never ran the patch step. Since
`cap sync` regenerates `Package.swift` with the unresolvable `exact: "8.5.2"`,
the script handed Xcode a project that cannot resolve packages. Inserted after
the sync (order is load-bearing, and the comment says so):

```bash
npx cap sync ios
node scripts/patch-ios-spm.js
```

Also aligned: the CocoaPods/Node preflight that the script already performs is
now described accurately, and a "before you ship to the App Store" block was
added covering the `TEAMID` placeholder, the opt-in preflight command, and an
explicit instruction **not** to disable App-Bound Domains.

**Prerequisite worth knowing (pre-existing, not changed here):** all three
customer files are LF in the working copy, but `core.autocrlf=true` with
`.gitattributes` `* text=auto` will convert them to CRLF on a fresh Windows
checkout. Copying a CRLF `mac-build.sh` to the Mac fails with
`bad interpreter: /bin/sh^M`. Copy the tree as-is (LF) or run
`git config core.autocrlf false` before re-cloning.

---

## Tests

`scripts/validate-mobile-hosting.test.cjs` — `node:test`, zero dependencies,
16 fixtures under `os.tmpdir()`, teardown after every case. Run:

```bash
node --test scripts/validate-mobile-hosting.test.cjs
```

```
✔ glob matcher covers the pattern shapes hosting ignore/header use
✔ glob matcher refuses shapes it cannot model instead of guessing
✔ healthy config produces no FAIL findings
✔ REGRESSION: a blanket dotfile ignore pattern is rejected
✔ REGRESSION: negation re-includes are rejected as dead config
✔ a .well-known file matched by an ignore pattern is reported
✔ missing publish dir FAILs with a build hint
✔ publish dir without .well-known FAILs per file
✔ unresolved TEAMID placeholder FAILs, and --allow-unresolved-teamid downgrades it to WARN
✔ missing JSON content-type headers FAIL for both Apple/Android association files
✔ AASA appID that does not match the shipped bundle id FAILs
✔ assetlinks package_name that does not match applicationId FAILs
✔ legacy AASA shape (details[].appID + paths[]) is accepted, not reported empty
✔ render survives an empty findings list instead of throwing
✔ malformed firebase.json and empty hosting FAIL loudly instead of throwing
✔ the real root firebase.json passes every structural guard

tests 22   pass 22   fail 0
```

Syntax checks: `node --check` passes on
`scripts/validate-mobile-hosting.cjs`,
`scripts/validate-mobile-hosting.test.cjs`, and
`burgonomics-foundation-core/scripts/patch-ios-spm.js`.

**Not run, by constraint:** no `vite build`, no `cap sync`, no
`swift build`/`xcodebuild`, no `firebase deploy`, no `npm install`. The
`dist/mobile` the validator reads was produced by a pre-existing build on this
host (timestamps `2026-10-13 19:23`), not by this lane.

---

## User / Team-ID prerequisites (nothing here can supply these)

1. **Apple Team ID** — required before any store release.
   `public/.well-known/apple-app-site-association` ships the literal
   `TEAMID.com.burgonomics`. Substitute the real 10-character Team ID
   (Xcode ▸ Settings ▸ Accounts, or the Team shown in Signing & Capabilities),
   then `npm run build:mobile` and redeploy hosting. The same applies to
   `burgonomics-partner/public/.well-known/apple-app-site-association`
   (`TEAMID.com.burgonomics.partner`). **Deliberately not guessed here.**
2. **Xcode signing** — `project.pbxproj` sets no `DEVELOPMENT_TEAM`. The person
   on the Mac picks the Team in Signing & Capabilities, as `MAC_INSTRUCTIONS.txt`
   already described.
3. **Asset-links SHA-256 fingerprint** — `public/.well-known/assetlinks.json`
   pins exactly one cert fingerprint. Re-check it against the keystore actually
   used for the upload build (R15 left `android/app/build.gradle` failing closed
   without release signing, so a debug build will not verify).
4. **Mac + package resolution** — the SPM pin in finding 4b can only be
   re-validated on a Mac with Xcode. It must not be changed blind.
5. **Partner `assetlinks.json`** — the partner publish dir has no
   `assetlinks.json` at all, so partner Android App Links cannot verify. Out of
   this lane's ownership; recorded as finding 7.

## Files changed

| Repo | File | Change |
|---|---|---|
| root | `firebase.json` | hosting `ignore` (both sites) + JSON MIME header rules (both sites). Hosting only; `functions`/`firestore` blocks untouched. |
| root | `scripts/validate-mobile-hosting.cjs` | **NEW** — opt-in read-only preflight, zero deps |
| root | `scripts/validate-mobile-hosting.test.cjs` | **NEW** — 22 hermetic `node:test` cases |
| customer | `scripts/patch-ios-spm.js` | AppDelegate rewrite **removed**; downgrade **retained + documented**; two comment-only clarifications |
| customer | `mac-build.sh` | patch step inserted after `cap sync ios`; post-archive prerequisite notes |
| customer | `MAC_INSTRUCTIONS.txt` | accurate script description; patch-step rationale; TEAMID + preflight + App-Bound-Domains prerequisites |

Not touched: root `functions/**`, `firestore.rules`, `.github/**`, any CI file,
`burgonomics-foundation-core/android/**`, any `ios/**` project or secret file,
`capacitor.config.ts`, `Info.plist`, `App.entitlements`, `package.json`.
**No commit, no push, no deploy.**