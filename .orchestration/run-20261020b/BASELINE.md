# Baseline — 2026-10-20 (IST)

Re-check HEAD/status before claiming anything. These values are provenance, not
current proof. The retiring prior team may still land an atomic commit.

## Repos
| Repo | Path | HEAD at pack creation | Dirty entries |
|---|---|---|---|
| Root (Functions/config) | `C:/Users/DELL/Desktop/Burgonomics` | `4be553b` | 34 |
| Customer app | `C:/Users/DELL/Desktop/Burgonomics/burgonomics-foundation-core` | `c946aa1` | 57 |
| Partner app | `C:/Users/DELL/Desktop/Burgonomics/burgonomics-partner` | `09fe39b` | 26 |

Dirty and untracked files include work from earlier teams. They are FOREIGN until
claimed. Never reset, checkout, clean, stash, or reformat them.

## Last known green (historical; must be re-run, not quoted as new)
- Functions: 749 passed / 2 skipped; `tsc --noEmit` 0; build 0.
- Customer: 772 passed / 55 skipped across the committed coherence bundle.
- Partner: 542 passed / 3 skipped.

## Environment
- Windows 10/11, PowerShell 5.1. Use `;` not `&&`; `rg`, `Get-Content`, explicit
  `workdir`. No POSIX tools.
- Node/npm and `bun` available. Android tooling: Android Studio JBR JDK21 and SDK
  under LOCALAPPDATA; local assembleDebug possible. iOS native: needs macOS/Xcode.
- MCP `context7` and `code-review` connected at the root location. code-review needs
  forward-slash paths and a real base branch; files with >1000 changed lines may be
  skipped — review them directly. MCP is read-only.
- Firebase project config and emulators exist; do not deploy.

## Commands
- Root/functions: `npm run typecheck`, `npm test`, `npm run build` (cwd `functions`).
- Customer: `npm test`, `npm run build`, `npm run build:mobile`, `npm run cap:sync:android`,
  `npx playwright test` (cwd customer).
- Partner: `npm test`, `npm run typecheck`, `npm run build`, `npm run cap:sync:android`.
- Rule tests: customer `npm run test:rules` (requires emulator/tooling; verify first).

## Provider/account state
- Free model pair works on the normal Wi-Fi connection (DeepSeek and GLM verified
  with HTTP 200 on 2026-10-20 15:46Z). No VPN rotation; no fallback models.
- Razorpay: test keys present in local env? Verify, never print. Webhook secret
  missing; dashboard error on record. Live/test money operations prohibited.
- Borzo: no webhook secret, no registered callback, no no-real-rider guarantee.
- Shadowfax: no verified contract/credentials; fail-closed posture only.
- Petpooja: sandbox mapping `31z58ciw0h`, outlet 5439; S3 fetch error; no addon
  groups/variations; five client IDs exist. Vendor menu/stock read-only.
- Firebase: rules and indexes local-only; no deploy.
