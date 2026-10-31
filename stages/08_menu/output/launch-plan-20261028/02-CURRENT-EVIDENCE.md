# 02 — Current facts, evidence and blockers

Observed 28 October 2026, beginning approximately 08:04 IST (`+05:30`); source/manifest inspection continued through the validation time recorded in document 11. Source inspection is not an executed exploit, deployed-state audit or release acceptance. This directory is separate from the unchanged requirements handoff.

## Repository state

| Independent repository | Current HEAD / branch | Dirty evidence |
|---|---|---|
| `C:\Users\DELL\Desktop\Burgonomics` | `31e82c3c415757064e3b33010ade4d2b0d8ebd6f` / `ui-sweep` | 99 modified tracked paths; extensive untracked files including the handoff, tooling and earlier workers' evidence |
| `...\burgonomics-foundation-core` | `7affdf698576110a64e008a492f2d8380abe2d58` / `ui-sweep` | 9 modified tracked paths, 12 untracked files at census |
| `...\burgonomics-partner` | `7374d3e183f7272b91c19749fc192eaddee9e3ae` / `ui-sweep` | 11 modified tracked paths, 16 untracked files at census |

Commands: `git rev-parse HEAD`, `git branch --show-current`, `git status --short`/`--porcelain=v1 --untracked-files=all`, `git worktree list --porcelain`, each scoped to the actual repository. App HEADs match the handoff; this does not make dirty bytes committed. Root untracked counts change as this packet is added; do not use them as a cleanliness gate. An initial PowerShell wildcard census misclassified tracked paths; corrected `StartsWith('??')` census produced the tracked counts above. An initial hash command had a PowerShell parser error and did not execute; the corrected command produced [10](10-SOURCE-FINGERPRINTS.md).

No implementation worktree is owned by this planning session. Existing candidates have **different** commits, for example:

| Repository | Existing worktree, workspace-relative | HEAD | Treatment |
|---|---|---|---|
| Root | `.swarm-worktrees/polish-backend-20261025` | `c26effe867c662f2008445ee6dae73d176c77bb8` | Not adopted; owner/dirty overlay unresolved |
| Root | `.swarm-worktrees/polish-release-ci-20261027` | `cd0662e8eac0c786fd7ce32ed0e9996ab10f02d3` | Not adopted |
| Delivery | `.swarm-worktrees/polish-core-20261025` | `af66c966cc015ab2ee21b19f769d40445522d221` | Not adopted |
| Delivery | `.swarm-worktrees/polish-customer-ci-20261027` | `fb7db84155d03d1c88f1eeb52e4dff4f1024e80d` | Not adopted |
| Partner | `.swarm-worktrees/polish-partner-20261025` | `0fa8d1b26233f517178cfbe44dbf9e3eb74e2836` | Not adopted |
| Partner | `.swarm-worktrees/polish-partner-data-20261025` | `167f1602381ecf62345f264f056b380f41489df3` | Not adopted |

The inventory also contains temporary/prunable and one “locked initializing” worktree. None was pruned, unlocked, reset or reused. Future owned `.swarm-worktrees/launch-*` names are proposals, not existing baselines. Root/app worktree registries must be handled separately.

## Tools and model executions

- Vera root overview: **571 files / 7,388 chunks**, warning **6,834 added / 3 modified** unindexed. First relevant regex query returned unrelated provider probe scripts, not the audited boundaries. Both app overviews returned **No index found**. Scoped exact glob/grep/read followed these coverage misses; no bulk indexing was performed.
- Mobile discovered local Samsung **SM-S921B / Android 16**, serial `RZCX51TXRKB`; no remote device allocated. Hierarchies were inspected before screenshots/taps. Only safe UI navigation occurred; notification opt-in was declined in Martinoz, no OTP/login/payment/order/stock/dispatch/refund action was initiated. Phone was returned to Home after inspection.
- Firebase environment and app-list metadata were read, not collections. Active project remains billing-enabled `burgonomics-7faa8`; it is not a sandbox. List returned Android `com.burgonomics`, Android `com.burgonomics.partner`, and one web registration; **no iOS registration appeared**. This is current metadata, not proof of all service/plugin behaviour or absent registrations in some other project.
- Host Node: **v24.18.0**. PATH Java: **1.8.0_401**; incompatible with the planned modern emulator/native build gates. The customer rules runner can select Android Studio JBR, but its installed version was not verified here. Backend package declares Node **22**; execution workers must use the approved package toolchain, not assume the host is equivalent.
- GitHub CLI `gh auth status` confirms an active keyring login. No CI runs or repository secrets were fetched and no workflow dispatched. Earlier GitHub MCP OAuth findings are historical; neither CLI login nor YAML proves CI success. No Apple/Play Console connection was established.
- Context7 retrieved current Capacitor 8 environment/migration and Firebase emulator guidance. Official store policy pages were fetched directly. Defuddle CLI was not installed, so no global install was attempted. A read-only Scrapling request to Reelo returned HTTP 403; static Postman fetch provided no usable body. See document 07.

Catalog rediscovery returned every requested exact ID as active (Free DeepSeek required `all: true`). Quota diagnostic reported cached free-pool successes; that is **not** a successful planning worker. Budget tooling showed a local configured $100 remaining budget/zero measured spend, not an authenticated provider balance. No secret or credential values were inspected.

| Requested model | Task/session | Actual result |
|---|---|---|
| `opencode/deepseek-v4.1-flash-free` | Delivery tracing / `ses_e7fa18c91fferxbEaI7MNgX8oQ` | `ConnectionRefused`; no report |
| `opencode-go/deepseek-v4.1-flash` | Backend decomposition / `ses_e7fa18b87ffehQ8HrzVLi5qfV8` | `getaddrinfo ENOTFOUND opencode.ai`; no report |
| `phoenix-grove/deepseek-v4.1-flash-1017` | Reelo/provider feasibility / `ses_e7fa188c8ffeeVlUI7IW6n1w7U` | `getaddrinfo ENOTFOUND api.pgsgrove.com`; no report |
| `opencode/glm-5.3-flash-free` | Independent rules review / `ses_e7fa1825dffeWYXrd5xoCUsPOw` | `ConnectionRefused`; no report |
| `nvidia/minimaxai/minimax-m3.1-flash` | Four-release acceptance audit / `ses_e7fa17fe2ffeO18ZFHKmCedmr7` | `Invalid request`; cause/auth/quota not established; no report |

Each task explicitly set its model, read-only/execute capability and no-edit/no-provider/no-subagent boundaries. No worker result, review, command execution or successful authentication is attributed to these failed sessions. No unchanged retry or substitute worker was launched. Main-agent direct inspection authored the plan. Independent review remains blocked.

## Actual device/build observations

Package versions came from scoped `adb -s RZCX51TXRKB shell dumpsys package <package>`; only version/install fields were retained. Installed app APK hashes were computed on-device for the two Burgonomics base APKs, not extracted/decompiled. Source association and signing/distribution status remain unknown.

| App | Installed version / code / target SDK | Observed screens | Coverage limit |
|---|---|---|---|
| Martinoz `app.martinoz.pizza` | 6.3.12 / 79 / 35 | Notification prompt, then Home/store-closed/menu entrances | Two-column large square imagery observed. No menu/cart flow, contrast measurement or animation mechanics verified |
| La Pino'z `com.app.uengage.lapinoz` | 2.9.0 / 268 / 36 | Play in-app update gate: “To use this app, download the latest version” | Did not update/install; no Home/Menu comparison available |
| Delivery `com.burgonomics` | 1.0.0 / 1 / 36 | Home, Menu, empty Cart | Green header, redundant category entrances, decorative headings, three-column Home grid and empty Cart CTA observed; no note/reorder/payment/gesture/end-to-end acceptance |
| Partner `com.burgonomics.partner` | 1.0.0 / 1 / 36 | Initial dashboard only | Dark operational view, UNKNOWN health indicator, unrecognised-record warning and all-outlet selector observed; no role/KDS/stock/dispatch mutation tested |

Both Burgonomics packages show last update **27 October 2026**. That does not establish who built them, what source they contain, or a release baseline.

| Installed artifact | SHA-256 |
|---|---|
| Delivery `base.apk` | `035690a03f52cd541dbce5c52d8acb38f4309330b6c5f43194f08f04f40ec240` |
| Partner `base.apk` | `99e25dfe17fc34fff2c65f5245fe2c67004578f465cd17321f3952b3e309375f` |

`adb ... shell getconf PAGE_SIZE` returned **4096**. This phone observation is not 16 KB runtime proof. No iOS device/simulator was discovered or operated. None of these images is a proposed design, approved mockup or current-source RC.

### Existing-screen evidence, not mockups

Images below are cropped/redacted derivatives: status/navigation chrome removed; Delivery's location/loyalty area and Partner's order references/aggregate figures masked or cropped out. Raw phone captures remain in the approved temporary directory, not this packet. Do not redistribute competitor screenshots/assets as Burgonomics creative material. These are limited local design-reference evidence only.

- [Martinoz observed Home](evidence/martinoz-home.png)
- [La Pino'z observed update gate](evidence/lapinoz-update-gate.png)
- [Delivery observed Home, redacted](evidence/delivery-home.png)
- [Delivery observed Menu](evidence/delivery-menu.png)
- [Delivery observed empty Cart](evidence/delivery-empty-cart.png)
- [Partner observed dashboard, redacted](evidence/partner-dashboard.png)

## Fresh source findings used by the plan

| Lead | Rechecked evidence | Consequence |
|---|---|---|
| Refund accounting writable | `firestore.rules:272–284`; `razorpay.service.ts:1888–1935` | Branch denylist omits refund accounting; brand arm unrestricted; refund consumer trusts ledger. Fix and emulator regressions required |
| POS/client money fallback | `orderPush.ts:226–231,305,351,610–618`; `shadowfax.adapter.ts:207–217` | Legacy total fallbacks and zero handling remain; zero POS total logs but does not stop the send in this inspected block. Trace enabled-lane reachability and fail closed |
| GST contradiction | Delivery `cart.tsx:282–287` vs `pricing.engine.ts:392–397` | Cart says GST inclusive/display-only while server adds GST; contract/accounting decision and parity tests required |
| Rules drift | Root/Partner same hash, customer different; customer rules test `:24–29` loads cwd copy | Ordinary customer rules run does not prove deployed root bytes |
| False-green runner | `scripts/test-rules.mjs:23–44`; rules test `:33–56` | Null child status maps to 0; local emulator failures skip. Runner/project/ports must be repaired and asserted |
| Untrusted status path | `middleware.ts:374–387`; `functions/src/index.ts:605–614`; `item86ingSync.ts:1006–1045,1117–1186,1204–1265` | Branch/ID checks do not authenticate a sender. Sync-ID/refund injection guards exist, but untrusted resolved events can still update canonical order status; fix/contract-backed verification required |
| Theme not global | Delivery defaults light and exposes binary toggle; Partner theme provider currently wraps admin routes, not the whole app | Both need a default-System, validated persisted resolver and both-theme screen work, not token-only changes |
| Menu window merge | `menuStore.ts:88–139`; `menuService.ts:557–570`; `MenuRepository.ts:77–84` | Store-wide query is sliced before delivery to the store; absent page items are dropped from buckets. This is neither bounded network pagination nor valid deletion evidence |
| Test installation coupling | Partner `tests/restaurant-dispatch-choice.test.tsx:164` imports sibling customer's jsdom | Independent worktrees/CI installs must not accidentally depend on another checkout |
| Native distribution | Both workflows name unsigned archives; customer AASA contains `TEAMID` | No signed App Store readiness. Key-file existence was checked, contents were not read; validity/custody unknown |

## Current external references (retrieved 28 October 2026)

| ID | Official source | Relevant observation, not account-specific clearance |
|---|---|---|
| EXT-PLAY-TEST | [Play personal-account testing](https://support.google.com/googleplay/android-developer/answer/14151465?hl=en) | Personal accounts created after 13 Nov 2023: 12 opted-in testers continuously 14 days per app before production-access application; review usually ≤7 days, sometimes longer |
| EXT-PLAY-API | [Play target API](https://support.google.com/googleplay/android-developer/answer/11926878?hl=en) | New/update phone apps require API 36 since 31 Aug 2026; any stated extension to 1 Nov does not cover the 3 Nov target |
| EXT-APPLE | [Apple requirements](https://developer.apple.com/news/upcoming-requirements/) | Xcode 26+ and iOS 26 SDK+ since 28 Apr 2026; updated age-rating questions; minimum uploaded iOS target 13 since 9 Sep 2026. Capacitor minimum may be higher |
| EXT-PAGES | [Android page sizes](https://developer.android.com/guide/practices/page-sizes) | Page retrieved says API 35+ apps must support 16 KB; update-release enforcement from **1 Feb 2027**. Do not repeat an old universal Nov 2025 deadline or infer console acceptance; inspect native libraries and verify artifact/runtime compatibility |
| EXT-CAP | [Capacitor environment](https://capacitorjs.com/docs/getting-started/environment-setup), [v8 migration](https://capacitorjs.com/docs/updating/8-0) via Context7 | Xcode 26+, Android Studio 2025.2.1+, Android min/compile/target 24/36/36; Capacitor 8 iOS floor 15. Actual projects/builds must still be checked |
| EXT-FB | [Emulator project isolation](https://firebase.google.com/docs/emulator-suite/connect_and_prototype), [configuration](https://firebase.google.com/docs/emulator-suite/install_and_configure) via Context7 | Use `demo-` project IDs, consistent project IDs and explicit rules; real projects can hit non-emulated live resources |

General web searches returned no results; the official policy text above was actually fetched rather than inferred from search absence. Recheck policy/console requirements at submission; they can change. No exact Apple/Play account production status was verified.
