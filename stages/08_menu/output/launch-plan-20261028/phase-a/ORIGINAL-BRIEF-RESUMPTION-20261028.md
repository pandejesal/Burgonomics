# Original brief — restart-safe continuation

**Read-only Phase A continuation. Not implementation approval.** The user restated the original Delivery-first requirements and requested REA, Firebase, Vera, Context7, Code Review and shadcn. Repeated server restarts interrupted the new MCP calls. Preserve completed work rather than recreating the plan or mockups.

## Completed work retained

- [Approved decisions](../../launch-handoff-20261028/01-APPROVED-DECISIONS.md) remain the interpreted requirements; the restated original wording does not silently remove their later clarifications.
- [Current proposed v2-r1 packet](../proposals/v2/README.md): 38 states in both themes, 89 individual state/sample PNGs, 10 boards and one internal-review ZIP. Its artifact validation passed at the time recorded there. No design-team approval or actual-app/native result follows.
- The previous plan, v0-r1, v2-r0, v2-r1 and their evidence records are not being rebuilt, overwritten or relabelled as fresh results.

## Original problem → retained contract

| Original problem | Retained scope / next proof |
|---|---|
| Too many Home category entrances | Exactly four large 2×2 shortcuts: Burgers, Wraps, Sides, Shakes & Drinks; the full Menu still retains all categories |
| Spinning images | Brief automatic image-only flips, stationary labels, one-tap navigation; reduced motion/offscreen safeguards; static PNGs do not prove this |
| Awards and upcoming stores | Bottom of Home, developer-maintained approved content; hide empty sections; no fabricated awards, dates or locations |
| Cramped UI, colour and unreadable fonts | White/light and black/dark, green primary, sparse orange, self-hosted Inter; System/Light/Dark preference; team approval and actual-device proof still needed |
| Home reorder | Empty Cart only, authenticated eligible history; no guest history query; preserve Order History and validate current outlet/items/options/prices |
| Per-item cooking notes | One expandable order-level kitchen field in Cart; no duplicate Checkout editor or surviving instruction-pill writer; current persisted client ceiling 240 UTF-16 units, strictest vendor limit unresolved |
| Category-by-category menu replacement | Continuous vertical sections with real bounded loading and heading jumps; preserve legitimate selection/URLs and avoid eager full-catalog fetches |
| Banner blocks vertical scroll | Preserve native vertical intent and intentional horizontal gestures, taps, keyboard and reduced motion; needs actual gesture tests |
| Reelo CRM | Keep Petpooja POS; investigate separate marketing/CRM integration. Existing Firebase Grill Coins are not simply Petpooja CRM and must not be silently migrated |
| Backend/Petpooja working | Pricing/auth/rules/payment/POS trust, durable retries and ambiguity-aware reconciliation; 2-minute staff alert / 5-minute escalation, actual operator/KOT proof later |
| Both apps in both stores | Keep original 3 November RC / 8 November public targets, not guaranteed; no automatic deadline reset from the repeated original brief |

Implementation detail remains in [Delivery](../03-DELIVERY-DESIGN.md), [Partner](../04-PARTNER-DESIGN.md) and [backend/security](../05-BACKEND-SECURITY.md), rather than a duplicate plan.

## Successful observations in this continuation

| Check | Actual result |
|---|---|
| REA connected-device inventory | One attached Android device reported ready; evidence `ev_5c6a50d507776dffb3ee8713ac2a84a18a579a82ac7e3d1eb96d245a9933c6b8`; ADB 37.0.0. No app UI inspected by this inventory |
| Mobile connected-device inventory | Same local Samsung SM-S921B, Android 16, reported online/real. No remote/cloud device allocated |
| Delivery Git status | Nine tracked-dirty paths plus existing untracked files; no files modified by this continuation. Existing styles, transition, CI/native and rules-test work is preserved; status is not ownership |
| Vera Delivery overview | Failed: no Delivery index at the requested repository path. Do not call it indexed/healthy or infer source absence; use verified direct-source fallback, not an unapproved bulk reindex |
| Context7 Reelo lookup | No matching Reelo library; returned unrelated products were rejected. This is not current Reelo API or migration evidence |
| Scope/reference reconciliation | Original decisions, Reelo investigation, baseline register and development-tool safety rules read; design/baseline/account/finance/vendor gates remain open |

## Earlier interrupted batch — historical checkpoint

The batched REA requested-app inventory, Firebase environment metadata, shadcn registry reference and root Vera overview calls were interrupted before any result returned. Some read-only operations may have started. At that checkpoint none was claimed successful and no app had been launched or screenshotted. The individually recovered results below supersede that pending state; they do not turn the interrupted batch into a successful run.

Code Review was initially only discovered. Its later execution/result is recorded below. A branch-only diff is not approval of the nine dirty files or an unselected implementation baseline. No PR creation/posting, commit or push is authorised.

## Individually recovered MCP checks

| Check | Actual result / limit |
|---|---|
| REA requested-app inventory | Evidence `ev_6005c39273f2850c012055a273ed239f664d3e9fef3c258702f51b9e6ac0a1e5`; found `app.martinoz.pizza`, `com.app.uengage.lapinoz`, `com.burgonomics` and `com.burgonomics.partner`. Only these matches were returned; no APK pulled or decoded |
| Firebase environment | Read-only environment check succeeded for the configured `burgonomics-7faa8` project; authenticated, billing enabled. **Not a sandbox or functional backend/POS proof.** No collection reads, writes, deploys or account changes; account identity omitted |
| shadcn | Public registry returned accordion and accordion-demo references. No returned add/install command was run and no dependency/component changed |
| Context7 component docs | Official shadcn accordion/collapsible references retrieved. Radix, React Aria and Base UI APIs differ; this does not authorise a component-library migration or establish the app's installed primitive |
| Vera root overview | Root index exists: 571 files / 7,388 chunks; warns 6,905 added and 3 modified. The missing Delivery index remains a separate limitation. No reindex/update performed |
| Code Review MCP | Local-diff call against `HEAD` failed because the command expanded an ambiguous `origin/HEAD -> origin/main..ui-sweep` revision. No diff/review verdict obtained; no PR/posting or source fix. The failure is not silently replaced with a passing review |
| Current Reelo public search | Official `https://reelo.io/petpooja` and Reelo's own 2026 tech-tools material advertise Petpooja integration. This supports investigating CRM beside retained POS, not Burgonomics entitlement, direct app API access, historic Grill Coins migration or exactly-once billing/loyalty semantics |

## Bounded Delivery phone observations

Delivery was launched by its inventoried package. An initial hierarchy showed only navigation/splash, and REA captured a black frame. Android reported awake with Delivery focused (window evidence `ev_532d79d9b8f33d8aa44eac41aef244574413f30b57622ee68148fc6c11f289d1`). **The user clarified they had closed it by mistake and that the app opens normally. Do not report a confirmed startup defect.** The black frame is retained only as excluded/interrupted capture evidence.

After that clarification, a fresh hierarchy contained the Home content. Personal location/status-bar content is omitted from this report and must be cropped/redacted from any retained review image.

| Case | Observed result |
|---|---|
| Home categories | Three-column category cards plus the redundant category-pill strip remain in this installed build; not the proposed four-card 2×2 Home |
| Vertical swipe starting inside banner | Upward swipe from `(850,1000)`, distance 600 device pixels; the Explore Menu heading remained at `y=1476`, with banner bounds still `y=705..1353` |
| Outside-banner control | Upward swipe from `(1050,1900)`, distance 600; Explore Menu moved to `y=864` and banner top to `y=93`: observed 612-pixel content displacement |
| Interpretation | This single paired gesture observation supports the reported banner scroll obstruction on this phone/build. It is not exhaustive vertical/diagonal/tap/cancel/reduced-motion or Android/iOS acceptance, nor proof of the exact current source-level cause |

REA Home frame: `ev_a2ccd1fca0e0675cd735bae92dab108b5714d12c49d4653c21d4577f49d17791`, SHA-256 `b0ffd4e5da2a6468afa4c4e33ab9b59a0b2722633a46e204a0924f6b9fd9b791`. Outside-control frame: `ev_e7c0ad36896fbebf131d4fc1f40ac57c8af5e7414cbdae36a9c1365fc2406989`, SHA-256 `a4a819ee6013185883072e04e8abe5510bc6984b15a4e52c15f84bd3ec76fa25`. Raw frames remain in the unique approved temporary capture directory, not the team mockup ZIP. No APK hash/source binding or current-release acceptance is established.

## Completed competitor capture steps — do not repeat

- Martinoz Home hierarchy and one REA frame are captured: `ev_da1ec1c41defc3f3bb7181240d305aa68c60e3c92613e95247656f7e49a2600d`, raw SHA-256 `acf3ff4bb0dc323c88b97835dc8e16c95e9f9f8b8f3279725cd30b5761dda155`. No call-outlet, offer redemption, cart or account action was taken.
- La Pino'z Home hierarchy and frame are captured: `ev_0218fb866d955996d3e714b50e72d8356271ecd42d06eb032204595dc09b7db4`, SHA-256 `865c8686b2e0053c01d1316b8d166fcf8899bd7f8032f9bac24dff3eab8abb07`. The app itself displayed a nearest-outlet-change notice; only its informational OK was dismissed. No GPS/location permission or manual outlet selection was changed by the agent. A greeting is excluded from retained crops.
- La Pino'z Menu was opened through its existing Menu destination, without tapping Add or Cart. Filters, a featured-item rail and subsequent rows were visible; no full all-category continuity claim is made. REA frame `ev_5e06d75db07ff4d14fc00fbb225bca4d752d07b7d9f67092ea9448763dd240cd`, SHA-256 `748b46141028981579c6ea78d4ef82090eb2bc1d239596d5e2f9cf20e3f82dd2`. The retained crop excludes the personalised favourites section.
- Partner launch completed before the latest server restart and was not repeated to recover. Its entry hierarchy was subsequently read with a privacy filter: 73 elements, 26 non-system text nodes, and store/outlet/orders/kitchen/menu-related keywords. Record/identity text was suppressed. No Partner screenshot, role/auth assertion, order/KDS action or operator verdict is claimed. Delivery was opened again at the end of the bounded comparison.

Five successful raw consumer-app frames exist under the unique approved temporary capture root. [The owned preparation helper](device-review-20261028/prepare-images.py) matched all five hashes and produced five privacy-cropped, explicitly labelled observations, all visually inspected. [The comparison report](device-review-20261028/README.md) separates actual observations, proposed direction and remaining gates. No competitor imagery enters the app or proposed mockups.

## Exact resume point

1. Keep the successful device inventory; do not rediscover devices merely to restart the checklist.
2. Keep the individually recovered checks, five prepared observation images and bounded Partner hierarchy read above; do not repeat them. This comparison wave is complete within its declared scope, not a full competitor-flow or Partner operations audit. Request design/baseline/scope decisions before implementation; deeper Partner inspection requires an explicitly safe test/outlet session.
3. Read UI hierarchy before any screenshot. Restrict phone inspection to approved public/guest/design surfaces; no login/OTP, private account/order extraction, location/notification grants, basket clearing, checkout, payment, POS/stock/dispatch action or installation.
4. If a required MCP remains unavailable or repeatedly disconnects, report the exact blocker; do not rewrite global/project MCP configuration or substitute private profiles/production calls.
5. Before any app changes, obtain exact team design approval, an accepted Delivery base/dirty-overlay handover and bounded implementation approval. Use an isolated implementation worktree only after that decision. No production/provider/signing/store authority is inferred.

## Provider documents and Reelo — 28 October 2026

Petpooja V2.1.0, Borzo 1.8 and the corrected Shadowfax Hyperlocal documents were reviewed through hash-checked redacted views. [The contract review](provider-doc-review-20261028/CONTRACT-REVIEW.md) records endpoints, credential model, status/callback semantics and three dispatch gaps: cancellation is not wired to the documented cancel APIs, the Shadowfax dispatch-ready signal is never sent, and rider-location callbacks are unhandled. The current static-secret Shadowfax header is also not a documented vendor signature. Those are supplied-analysis claims pending source verification.

The outlet owner confirms **Petpooja and Reelo are both in use and Petpooja bills already sync into Reelo**. Because the app also holds Firebase Grill Coins balances, dual reward authority is a present risk. [The Reelo decision](../../07-REELO-FEASIBILITY.md) recommends launching with no app loyalty balance UI until one owner is chosen and evidence exists.

A workspace rollback removed the first contract-review draft, its Shadowfax intake and validation results; the current files were recreated from the source documents and re-validated ([validation-current.json](provider-doc-review-20261028/validation-current.json)). The lost records are not claimed to survive. No credential was read, no provider endpoint called, no order or booking made and no source changed.

This file is a progress checkpoint, not a completed four-app audit, application acceptance result or launch-readiness claim. Device app launch/scroll observations occurred as recorded; no source/rules/environment/native/dependency changes, application tests/builds, financial/provider operations, account mutations, deployments or submissions occurred.
