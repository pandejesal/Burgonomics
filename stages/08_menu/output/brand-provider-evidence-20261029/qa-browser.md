# Browser QA — awards, upcoming stores and brand balance

Date: 29 October 2026. Local dev source in
`.swarm-worktrees/delivery-launch-ui-20261028`, isolated Chromium context, public
catalogue reads only. No order, payment, OTP, POS or rider action.

## What was checked

| Check | Result |
|---|---|
| Awards section renders 3 owner-supplied awards | Pass |
| Six award images load (3 ceremony photos + 3 certificates) | Pass — all `naturalWidth > 0` |
| Display face applied to the awards heading | `MonstroSolid, Inter, …`, 28px |
| Awards field colour | `rgb(11, 46, 29)` light, `rgb(8, 36, 21)` dark |
| Heading colour on field | `rgb(255, 255, 255)` (≈14:1) |
| Upcoming Stores heading | 22px semibold, Inter |
| Upcoming rows | 8, one per `status: "upcoming"` record |
| Horizontal overflow at 390px and 320px | none (`scrollWidth === innerWidth`) |
| Overflowing descendants inside the two sections | 0 |
| Dark canvas | `rgb(0, 0, 0)` with the deeper green field |
| Page errors in console | none |

## Layout decisions verified

- Dates sit on their own line under the location on phones (`flex-col`), and move
  to the right only from `sm:` upward, so store names never wrap to 3–4 words.
- The award year sits inline after the title in gold. The earlier right-aligned
  chip squeezed long award names at 320px and was replaced.
- Certificates are 56×72 thumbnails, ceremony photos are 3-up at 4:3. Both keep
  rounded corners and a hairline, matching the deck without turning the app into
  a card grid.

## Screenshots

- `awards-light-final-390.png`
- `awards-dark-390.png`
- `awards-narrow-320.png`
- `upcoming-light-final-390.png`
- `announcements-narrow-320.png`

All under `C:\Users\DELL\AppData\Local\Temp\opencode\delivery-ui-qa-20261029\`.

## Native APK — ready, not installed

The updated UI (awards + upcoming stores) was built into a debug APK but **not
installed**, because the owner disconnected the phone and no local emulator exists.

- Path: `C:\Users\DELL\AppData\Local\Temp\opencode\delivery-native-20261029\candidate-49b8c10953e1c814\app-debug.apk`
- SHA-256: `49b8c10953e1c8141df21bb551902d028d2bd020150bbc6f74c28255ce2c4cc5`
- Size: 25,082,921 bytes
- Preflight: compatible with the installed debug signer; 176 bundled web files
  match `dist/mobile`; no remote server URL; WebView debugging off; QA manifest
  overlay applied.
- Install command for when the phone is reconnected (data-preserving):
  `adb install --no-incremental -r <apk>`

Mobile MCP returned no local device. A cloud device was **not** allocated; that
needs the owner's approval.

## Limits

- Chromium desktop-emulation only. No physical phone (disconnected) and no
  emulator (none installed).
- Awards/upcoming content is static and owner-approved; it is not driven by
  Firestore, so an owner edit needs a release.
- The website list said "October 2026" for four stores; today is 29 October 2026,
  so those dates may already be stale. The app says "Planned for", not "opening
  soon".
