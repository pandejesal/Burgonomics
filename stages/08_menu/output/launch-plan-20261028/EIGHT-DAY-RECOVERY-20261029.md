# Eight-day completion checkpoint — 29 October 2026

This supplements the [existing implementation plan](README.md); it does not replace approved decisions, select a release baseline, grant design approval or authorise provider operations, deployment or store submission. The user confirmed that completion in eight days means **tested/signed apps and store submissions**, not guaranteed public availability. Mac/Xcode, iPhone and account/signing access are expected **by Day 3**, not verified available today. Confirm the exact calendar deadline: if 29 October is Day 1, Day 8 is 5 November; eight full days after 29 October ends 6 November. Earlier 3 November RC / 8 November public targets are historical targets, not silently revised commitments.

## Current evidence takes precedence over older status summaries

- Both Delivery and Partner target Android and iOS: **four release lanes**, one shared backend. They are React/Vite/Capacitor apps, not React Native projects.
- Read the [29 October implementation continuation](../implementation-checks-20261028/README.md) before the older planning-only handoffs. It records accepted scoped candidates; do not repeat the old assertion that no implementation has started or that every baseline is still unselected.
- That record reports the isolated `backend-integration-20261028` candidate passed typecheck/build and **1,073 unit tests, 2 skipped**. These checks were not rerun by this context/MCP task. Candidate hashes, scope and writer handover must be rechecked before editing.
- Final POS emulator verification stopped before application cases on listener verification. Dispatch bounded replay used a Firestore double. Neither is final native-emulator/provider acceptance.
- Delivery rules passed 108 emulator tests on the recorded rules bytes, **not the dirty root deployment rules**. Deployment authority and financial-field protections still need exact-source evidence.
- Delivery Home/banner/hydration repairs exist in `delivery-launch-ui-20261028`; fresh compiled-bundle and physical gesture proof remain required. Continuous Menu, empty-Cart reorder, consolidated notes and theme/typography work remain listed as outstanding.
- [v2-r1 proposed designs](proposals/v2/README.md) now exist: 76 state images plus 13 layout studies. The older claim that only v0 exists is stale. These are proposals, not implemented screens or design-team approval.
- Current signed iOS/Android artifacts, owner account eligibility, iOS signing/Mac/device access, production merchant readiness and real outlet/KOT acceptance are not established by these records.

## Eight-day recovery sequence — proposed, dependency-gated

Days are working checkpoints, not a promise that external approvals will arrive. Existing work-package owners and acceptance criteria remain in documents 03–06 and 09. Assign named people and bounded file ownership before execution; no implicit parallel-agent authorisation follows from this table.

| Day | Critical work | Exit evidence |
|---|---|---|
| 1 | Obtain current candidate/writer handovers; confirm remaining UI approval; owner verifies all four store/account/signing lanes and Mac/iPhone access; ratify tax/refund/rewards and merchant contract gaps | Exact source manifest and bounded remaining backlog; account/provider blockers have owners and response times. Do not restart reviewed repairs |
| 2 | Finish financial authority, root-rules emulator authority, pricing/capture/refund identity and staff authorisation; unblock actual POS/dispatch emulator harness | Current-source typecheck/unit/build plus executed authoritative rules and transaction tests; no skipped critical gate counted as pass |
| 3 | Finish POS ambiguity/reconciliation and courier cancel/ready/location paths; complete approved Delivery Menu/Cart/theme work and Partner critical operational states | No duplicate charge/KOT/rider after timeout; honest pending-POS status; branch-isolated stock/access; reviewed exact diffs |
| 4 | Complete approved provider sandbox flows once offline gates pass; produce first fresh native candidates; test each fulfillment mode separately | Sandbox receipts distinct from KOT printing; initial Android and iOS build logs tied to exact source. Missing iOS signing remains an explicit blocker |
| 5 | Signed builds for ready app/platform lanes; native auth, permissions, push, keyboard, deep links, lifecycle, KDS reconnect/audio, banner scrolling | Four-lane native evidence matrix; artifact hashes/signing identities and remaining defects. Browser viewport tests do not replace iOS/Android runs |
| 6 | Integrated regression and supervised outlet acceptance only with separately approved order/payment/dispatch/refund scope | Correct real outlet, bill, options/instructions, acceptance and printed/displayed KOT; no fake receipt or automatic refund; supported modes/tenders independently accepted |
| 7 | Fix/rebuild/retest; final privacy/deletion/reviewer access, metadata and actual-build screenshots; independent safety review | No unresolved release-blocking defect; current source/build/provider/operator evidence and owner-approved declarations |
| 8 | Per-lane go/no-go, signed candidate handover; upload/submit only on explicit owner approval | Record built, tested, submitted, approved and publicly live separately. Blocked lanes remain blocked, even at the deadline |

Run scoped gates daily, not only on Day 7. UI and native preparation can proceed alongside backend work where scope and ownership are approved, but no client lane is accepted against an unsafe shared backend. Reserve repair/retest time; do not spend the entire window adding features. Optional motion polish and Reelo implementation stay off the critical path; required features are not silently dropped.

## Provider intake and corrections

| Input | What was established in this context pass | Remaining boundary |
|---|---|---|
| Desktop `PETPOOJA API Docs.txt` | V2.1.0; exact save-order sample uses `orderinfo.OrderInfo.*.details`, body credentials, callback URL and tax/option mapping. Status 1/2/3 means accepted; HTTP ACK is not physical KOT | Account-approved production host/mappings, callback trust and ambiguous-send reconciliation. Older flat-payload prose must not override the exact sample/current vendor contract |
| Desktop `Borzo API Docs.txt` | India Business API 1.8; quote/create/cancel are distinct; cancellation unavailable after courier visit. PHP callback sample at lines 6401–6404 reads `php://input` and calls `hash_hmac('sha256', $data, ...)` | This sample supports raw-body HMAC and PHP's default hexadecimal output; older notes saying no sample settles encoding are incomplete. Real sandbox callbacks and merchant entitlement still need verification; no API was called |
| Desktop `Shadowfax - Official Rider Booking API Docs.txt` | Hyperlocal Marketplace: serviceability, booking, status, cancel, dispatch-ready and separate location callbacks; optional custom callback headers; separate staging/production | No vendor-native HMAC is documented. Confirm merchant authentication arrangement, client code, production IP whitelist and approved no-real-rider sandbox scope before bookings |
| Desktop `Firebase Docs.txt` | Apple/Android/Flutter package/module index, including deprecated-module notes | Not a Firebase deployment/security/native-setup guide. Use current service-specific documentation and inspect actual app configuration; index existence proves no registration or runtime behaviour |
| Desktop `Razorpay Docs.txt` | Empty | Use official documentation; requested docs MCP is now connected. Merchant credentials were neither read nor requested |

Petpooja remains POS. Borzo/Shadowfax are the intended courier providers; Porter stays retired. Preserve Grill Coins balances/history, no launch loyalty balance/redemption UI, no duplicate bill upload to Reelo. New Grill Coins earning remains the recorded unresolved finance decision unless newer explicit approval settles it.

## Razorpay MCP completed

Project `opencode.jsonc` now includes `razorpay-docs`, remote URL `https://razorpay.com/docs/mcp`, added using the documented OpenCode CLI. `opencode mcp list` returned **connected**; an actual `search_razorpay` query returned official webhook/idempotency documentation. No sign-in or payment credentials were needed.

This is the public **documentation MCP**, not merchant operations at `https://mcp.razorpay.com/mcp`. No merchant server, payment, refund, transfer or webhook configuration was enabled or operated. Unrelated MCP registrations were preserved. GitHub MCP still reports that it needs authentication; that is separate from Razorpay.

## Reading and verification limits

Read: workspace entrypoints, all 12 stage contracts and summaries, all six `_config` documents, current planning/decision/release/security and implementation handoffs, package manifests, relevant payment/POS/delivery references, full supplied Firebase/Shadowfax text and targeted Petpooja/Borzo contract sections. Large vendor samples/schemas and older archives were not all read line by line. Dependencies, generated artifacts, third-party checkouts, secret files and every application source file were not exhaustively audited. Do not describe this as reading or validating every file in the directory.

This task changed only project MCP registration and added this planning supplement. No app/backend/rules/native/environment edits, candidate adoption/merge, new app tests/builds, provider calls, deployments or store actions were performed. Historical and sibling-task results above retain their original provenance. The `vera overview` shell attempt timed out; it supplies no current index evidence.

## Confirmed schedule inputs and remaining dependencies

The user confirmed tested/signed builds **and store submissions by Day 8**, with Mac/Xcode, iPhone and account access **by Day 3**. Do not re-ask these settled questions. Access, signing usability and actual account eligibility still require verification when available; exact calendar deadline remains to be recorded.

Public availability cannot be guaranteed: store review/account eligibility and provider onboarding are external dependencies. Existing scoped implementation approvals remain valid only for their actual files/candidates; unrelated source work and live operations require their own scope. Do not paste credentials, private keys, profiles or `.env` files into chat.

## Petpooja email evidence supplied in this session

Source: `C:\Users\DELL\Desktop\ALL PETPOOJA EMAILS.txt`, 282 lines, reviewed through a credential/contact-redacted view. The plain-text export contains login credentials; none are reproduced here. Attachments are mentioned but their contents are not embedded in this file. Sender identity and delivery have not been independently authenticated.

- **5 October:** Petpooja supplies staging portal access and the outlet mapping code; requires five scenarios (items, add-ons, variations, discount, add-on plus variation, each with tax), vendor review, then production details. Sandbox whitelisting is confirmed in the later 13 October response; that is dated evidence, not current connectivity.
- **24 October:** our outbound message reports five successful relays and claims callback readiness. These are our claims, not Petpooja's approval.
- **26 October:** Petpooja identifies structural payload problems and supplies an attached sample, requesting five corrected orders. HTTP success did not establish vendor acceptance.
- **28 October, 13:48:** our outbound reply reports resubmission and Order Listing visibility, explicitly **Waiting For Acceptance**. The listed restaurant totals/GST are 350/17.50, 320/16, 580/29, 300/15 and 580/29. This email alone is not independently verified dashboard evidence.
- **28 October, 16:01 — latest vendor response in this export:** `total` must include `tax_total` (vendor example: **350 + 17.50 = 367.50**); COD `collect_Cash` must equal the order total; **restaurant GST liability** applies to item tax and delivery/packing GST when present.

This resolves the vendor instruction for the submitted test cases; it does not authorise blanket GST addition to already-tax-inclusive catalog prices or a universal rate. Use the approved source pricing basis and integer-paise reconciliation so tax is included exactly once. If the five outbound base totals exclude their separately listed GST, the corresponding expected totals are **367.50, 336.00, 609.00, 315.00 and 609.00**. These are derived check expectations, not new submitted orders or accepted receipts.

Verify exact wire spelling of `collect_cash` versus the email's `collect_Cash` against the attached current sample/vendor confirmation; do not rename a production field based on prose casing alone. Apply restaurant liability consistently to each contract-defined liability field, not by inventing a universal field/value name.

No later approval, production credentials/host, physical KOT proof, callback-auth agreement or final five-scenario sign-off is present in this export. The next bounded task is compare the current owned candidate and the 26 October attachment against these corrections, add exact-total/COD/liability regressions where needed, and only then obtain scoped approval for any sandbox resubmission. Do not repeat old orders or send email merely because the vendor requested resubmission in historical correspondence.
