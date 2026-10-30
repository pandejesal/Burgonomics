# Final owner UI trim — 30 October 2026

Remove only the Cart price-lock pill and Upcoming Branches' explanatory subtitle
and entire left/pause/right control strip (the owner explicitly confirmed the
whole strip, not merely its divider). Remove the trailing divider with that row.

Keep every branch announcement, horizontal swiping, keyboard arrows, automatic
rotation, touch/focus pause, reduced-motion/background/offscreen handling and
non-orderable behaviour. No new visible controls. The Cart's underlying price
lock state, calculation and checkout protections remain unchanged; only its
display/countdown is removed. Everything else, including Menu/Home sizing and
the current real phone basket, stays as-is.

## Verified source and preview

- Typecheck passed. Focused regression gate: **4 files / 28 tests passed**.
- Full unit gate: **148 files / 1,278 tests passed**, excluding `tests/rules/**`.
  No deployed-rules/Firebase acceptance follows from this unit scope.
- Regression coverage retains future/expired stored price locks, totals reads,
  automatic branch rotation, keyboard browsing and touch/focus/visibility pauses
  while checking that the requested UI is absent.
- Independent bounded read-only review reported no substantiated issue.
- `source-scope.json`: only the two product components and their two existing
  tests changed from the preceding source capture. All other captured inputs
  stayed unchanged; **627 captured inputs** remained identical through full tests,
  builds and final artifact staging.
- Light/dark inert actual-DOM exports pass `browser-results.json`: no Cart pill,
  branch subtitle, buttons or trailing divider; all eight branch announcements
  remain horizontally scrollable. Filled-Cart notes remain; no page errors or
  horizontal page overflow were found. Browser sample state is not phone state.
- [Private preview](http://127.0.0.1:48244/followup/index.html) responds correctly.
  `preview-availability.json` also confirms private logs, scripts and directory
  listing requests are rejected. No public/LAN preview was opened.

## Verified final-trim artifact

Web/mobile builds, Capacitor sync and offline debug assembly passed. The first
assembly attempt failed because this process lacked an SDK path; setting only
process-local `ANDROID_HOME` to the verified installed SDK resolved it. Both
attempts are preserved in `build-gates.json` and their separate logs; no source,
dependency, persistent environment or release configuration was changed.

Staged APK: `burgonomics-delivery-final-trim-debug.apk`, SHA-256:

```text
78fcda40841eb6ddb778af05f910a0aeeb065e31e0529a51f77333c9b1b9ae66
```

`apk-compatibility.json` verifies `com.burgonomics`, debug version code **1** /
version **1.0.0**, the original verified signer, **179 byte-identical bundled web
files**, local bundled startup and the unchanged QA-only Firebase autostart opt-out.
Removed copy/control labels are absent from all 73 compiled mobile JS files.
The staged bytes match the verified build. This is **local artifact verification**,
not a fresh-phone compatibility check or native UI acceptance.

`preview-staged-artifact-privacy.json` confirms the preview remains reachable and
rejects requests for this existing APK and its private compatibility report.

## Installed phone result — 30 October 2026

Freshly pulled `035f6596…` matched the expected baseline. Package/signer/version
and 179 bundled-file checks passed against the staged candidate before installing
with **`adb install -r` only** on `RZCX51TXRKB`. Pulled installed bytes match
`78fcda40841eb6ddb778af05f910a0aeeb065e31e0529a51f77333c9b1b9ae66`.
Update time is **30 October 05:15:20**; first install remains **27 October 11:32:45**.
See `installed-update.json` and `phone-compatibility-before.json`.

The native Cart pill is absent; a real one-item basket was present during the
capture. Upcoming Branches has no subtitle, visible control strip or trailing
divider. Evidence: `phone-cart-final-trim.png` (address redacted) and
`phone-branches-auto-a.png` (branch-only crop). Captures exclude system chrome;
the new helper crops/redacts in memory and never writes raw screenshots.

**Native rotation/swipe acceptance remains incomplete:** the second rotation
capture shows Menu, not the same branch screen, and cannot prove rotation. A
later swipe was refused by the device. No pass is inferred from those attempts.
The owner then stated they had performed their own checks and asked to add the
missing Home merchandising sections. Phone control stopped for that new task.
Unit rotation/swipe-related coverage is not presented as native acceptance.

No uninstall, data clear, downgrade, basket/favourite/note/account/Grill Coins/Reelo
mutation or restoration was performed. The owner may change their basket during
use; do not restore the earlier captured count. USB preview routing was not retested.

No production, backend/rules/Partner, account, provider, payment, GPS or basket
operations. Work remains uncommitted, unmerged, unpushed and undeployed. These
bounded checks do not establish design approval, provider or production readiness;
the limitations in `../../integration-readiness.md` remain applicable.
