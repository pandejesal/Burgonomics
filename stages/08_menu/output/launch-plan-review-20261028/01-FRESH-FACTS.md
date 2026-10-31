# Fresh observations and evidence limits

Read-only observations for the renewed execution of `08-NEW-SESSION-PROMPT.md`. Exact timestamps and machine-readable details: [fresh-observations.json](fresh-observations.json), [public-native-inputs.json](public-native-inputs.json), [pre-correction document fingerprints](review-inputs.json). These are not a source baseline selection, deployed audit or application acceptance.

## Source/worktree identity

| Independent repository | HEAD / branch | Tracked dirty / staged | Worktrees |
|---|---|---|---:|
| Root | `31e82c3c415757064e3b33010ade4d2b0d8ebd6f` / `ui-sweep` | 99 / 0 | 28 |
| Delivery | `7affdf698576110a64e008a492f2d8380abe2d58` / `ui-sweep` | 9 / 0 | 26 |
| Partner | `7374d3e183f7272b91c19749fc192eaddee9e3ae` / `ui-sweep` | 11 / 0 | 15 |

All **118/118 selected source hashes still matched** the original planning manifest. This covers partial inspected inputs, not all source, ignored environment, dependencies, generated native/web assets or release inputs. Root untracked count changes as documents are added; it is not a cleanliness gate. No old worktree, dirty overlay or release base was adopted. Human custodians and explicit handovers remain unresolved; the [Phase A ownership register](../launch-plan-20261028/phase-a/BASELINE-REGISTER.md) still applies.

Four newly inspected, read-only inputs are separately hashed: Delivery `src/features/home/state/homeStore.ts`, `src/features/home/repositories/HomeRepository.ts`, `src/features/home/index.ts`, `src/features/menu/components/CategoryPills.tsx`. These complete an ownership lead, not permission to edit those files.

## Toolchain and native metadata

- Host Node **24.18.0**, while `functions/package.json` declares **22**. PATH Java **1.8.0_401**; Git **2.55.0.windows.3**. No install/upgrade occurred. This does not prove no other compatible JDK exists; approved toolchain selection remains R1 work.
- Both app manifests declare Capacitor **`^8.5.0`**. A declared range is not an installed-lock/native-plugin verification. Actual package gate scripts are captured in `fresh-observations.json`; no script was executed.
- Both Android source configurations state **min/compile/target 24/36/36**, and local version properties **1.0.0 / code 1**. Neither code 1 nor local signing-file existence establishes the highest uploaded version or the expected store signing certificate.
- Literal source app IDs remain Delivery **`com.burgonomics`**, Partner **`com.burgonomics.partner`**. Do not rename Delivery to match obsolete `com.burgonomics.app` prose.
- Delivery's Xcode project contains deployment values **15.0 and 16.0**, with Manual signing style; Partner contains **15.0**, with Automatic style. This static scan does not resolve every project/target/configuration or prove usable signing. The prior app-target observation of 16 is not a universal resolved build minimum.
- Both AASA source files still contain a **TEAMID placeholder**. App-scoped native iOS discovery found no `GoogleService-Info.plist`; no account-side registration absence is inferred from that local search. No private signing file was read or hashed.
- Store records, production eligibility, account agreements, certificates/profiles, signing custody and Mac/iOS test capacity remain unverified. No store/Firebase account changes or private-data queries occurred.

## Device re-discovery and bounded inspection

The local Samsung **SM-S921B / Android 16**, device `RZCX51TXRKB`, was online again. No local iOS device was returned; no paid cloud device was allocated. The four previously approved app packages were launched and their hierarchies read, then the phone was returned to Home. No tap/login/update/install/order/payment/refund/stock/dispatch/permission action was issued.

At **2026-10-28 05:03:58 UTC**, the privacy-filtered observations retained only fixed markers:

| App | Fixed markers observed in returned hierarchy data | Limit |
|---|---|---|
| Delivery | Burgonomics, Update | Not enough to classify the complete screen or prove a feature |
| Partner | Menu, Dashboard, UNKNOWN, Update, Burgonomics | No record-level operational data retained or action tested |
| Martinoz | Martinoz, Update | No full menu/cart/animation comparison inferred |
| La Pino'z | Update | A generic marker alone is not proof of a fresh forced-update gate |

Raw hierarchies, personal locations/order data and new screenshots were not added to this packet. The older cropped/redacted screenshots in document 02 remain **dated observations**, not new builds. This new keyword-only pass is not visual acceptance, a complete competitor comparison or source provenance. App SDK startup traffic was not instrumented; no guarantee of zero background telemetry/registration writes is made.

## Models and authentication

All five exact requested IDs were rediscovered as catalog-active. `opencode auth list` reported stored registrations without reading credential values. Stored/catalog-active does not establish usable route access or quota; Phoenix-specific quota failure and NVIDIA's generic request failure are recorded in [02](02-MODEL-REVIEWS.md). The local cost tool's configured $100 remaining/zero measured-spend output is not an authenticated provider balance. No authentication/quota configuration was changed or repeated funding retry attempted.

The current review used three successful bounded document/source reports, not five implementation workers. Previous credential exposure in another session was not copied into worker prompts or these artifacts. The generic WhatsApp draft stays rejected; no external correspondence was sent.
