# WORKLOG — store-submission operation (coordinator session)

Last updated: 2026-10-17 ~18:30. This file tracks the coordinator's lane.
Other active lanes: ses_ed58c1254ffeZa5rnXEVa7GT15 (audit/repairs: dispatch+payments),
ses_ed03fcd6cffex1u0DNLajjXmn2 (Petpooja). File ownership: functions/** is theirs;
coordinator edits only release-infrastructure + docs.

## DONE (tonight)
1. Review verdicts: 152d834 GOOD-WITH-CAVEATS (no blockers), 9c20c12
   GOOD-WITH-CAVEATS (23/23 tests pass; all prior findings fixed; 2 Low
   residuals posted to the agent bus for the Petpooja lane).
2. Android: both keystores + credentials keytool-verified; two fresh signed
   release AABs built (BUILD SUCCESSFUL) and archived at
   client-handover/release-builds/burgonomics-{partner,customer}-v1.0.0-20261017.aab.
3. assetlinks.json: core fingerprint corrected (stale C8:70:5A:38 replaced by
   the real 15:3F:30:0D:...), partner file created; both copied into publish
   dirs. Root preflight: PASS 25 / FAIL 2 (only the AASA TEAMID placeholders
   fail, team-owned).
4. burgonomics-partner iOS MARKETING_VERSION synced to 1.0.0 (was 1.0).
5. SPM ground truth established: partner graph resolves without any patch
   step (pristine push-notifications declares from:"8.0.0" — R18's core-side
   "upstream hard-pins 8.5.0" was a patched-tree artifact). Partner
   mac-build.sh needs NO patch; burgonomics-partner/MAC_INSTRUCTIONS.txt
   written (its owner repo lacked one).
6. STORE_LISTINGS_DRAFT.md: full Play + App Store package for both apps,
   STATUS table current, submission sequence, anti-rejection checklists.

## PENDING (in order)
1. [DONE 18:40] Dispatch commit 39efc40 reviewed → GOOD-WITH-CAVEATS; all
   fix-claims verified real; verdict + 8 findings posted to the agent bus
   (review-verdict-39efc40). Lane-owned follow-ups: [Medium] Porter still
   fabricates "Porter Driver" and promotes rider_assigned (porter.service.ts:487,
   porter.adapter.ts:148 — return '' like Borzo/Shadowfax); [Low] NaN fallthrough
   in DISPATCH_FARE_CONFIRM_DELTA_INR (env.ts:102); DELIVERED-on-CANCELLED
   webhook exception (webhooks.ts:699-706); parked-event re-alert noise; f13
   test; pickup-contact bridge removal + wire probes (WIRE_BORZO + Shadowfax
   sandbox before production traffic).
   Client-regression check DONE: customer RiderContactCard renders "Assigning
   Courier..." on empty riderName; LiveOrderMap/StepTracker treat falsy name as
   no-courier; partner PorterDispatchCard/usePorterLogistics tolerate '' and
   'pending'/'driver_allocated' correctly (field vocabularies verified on both
   sides). Both clients are deploy-safe for the dispatch change.
3. [CLOSED] Petpooja 3-line ingestion-boundary guard: landed as b26d5e3
   [lane:petpooja]; re-reviewed diff-only — guard in place before
   menuData = incomingMenu, malformed-400 now a documented decision, new
   reject-test bites. GOOD. Follow-on 1627204 (mapper field-names) also
   reviewed: GOOD — empirically bite-checked; one Low (duplicate categoryid
   last-wins name join) + fixture recommendation left on the bus.
4. [CLOSED 19:25] Dispatch 91f487c→8a144f7: follow-up closed ALL open
   findings (Porter fabrication both paths incl. loud failure on missing
   branch phone, env NaN guard×2 with tests, DELIVERED-on-CANCELLED,
   park-noise, f13 test, customerPhone bridge removed, docstrings honest).
   GOOD. Deliberately open: finding 15 (reserialized redeliveries),
   WIRE_BORZO + Shadowfax sandbox probes before production traffic,
   store.phone backfill for pre-snapshot orders. 317b6ea (census/warn)
   reviewed GOOD (additive observability).
   → Petpooja chain 152d834→1627204 / 317b6ea: FULLY reviewed, zero blockers.
   → Dispatch chain 39efc40→8a144f7: FULLY reviewed, zero blockers except
   the wire-probe + backfill owner items above.
2. [lane] Audit lane's payments slice uncommitted (razorpay.service.ts,
   webhookHandler.ts + 3 new test files). When it commits, review diff-only.
   NOTE cross-lane deploy constraint (petpooja lane's warning): any api
   functions deploy ships the WHOLE bundle — dispatch + petpooja + payments
   together; coordinator sign-off happens after items 1-4 are closed.
4. [team-asks, sent to user + bus] Play Console account (longest lead),
   Apple Team ID, App Store Connect invite, privacy-policy domain decision
   (burgonomics.com/privacy 404s), Firebase iOS plists for both apps.
## Post-close-out review additions (coordinator, 2026-10-18 ~01:00)

Two Petpooja test commits landed after the close-out; both reviewed diff-only:

- `147fad6` test(petpooja): outlet-code resolution chain — VERIFIED test-only
  (single test file, `petpooja.service.test.ts`). The precedence it pins
  (`rest_id` > `details.menusharingcode` > `details.menu_sharing_code` >
  `details.restID` > flattened `restaurants[0].menusharingcode`; first yielding
  entry wins; `restaurantid`-only entry skipped) matches
  `menuSyncWebhook.ts:526-548` exactly. GOOD.
- `5d064e7` test(petpooja): LIVE push path + retire pass — VERIFIED test-only
  (single test file, `petpooja.menu-fetch.test.ts`). Closes the HIGH coverage
  finding this lane raised earlier (live branch resolution + retire block had no
  end-to-end test; the previous "live" test was silently taking the unlinked
  branch skip path). Assertions prove live semantics: products under
  `prod_demo_<itemid>`, Menu API not called, branch stamped, not `simulated`;
  retire marks `inStock:false` + `ghostRetired:true` and never deletes. GOOD.

Both are additive test coverage with no production-file change, so no new
regression surface and no client-regression check required.

### Later still: two dispatch commits (reviewed diff-only, ~01:10)

- `f52beb6` fix(dispatch): dedup reserialized redeliveries by canonical body —
  **GOOD-WITH-CAVEATS**. Canonicalisation verified correct and conservative:
  arrays keep order/length (`.map`, never sorted), keys sorted recursively,
  primitives keep their type (`1` ≠ `"1"`), non-JSON keeps raw bytes, and the
  HMAC still verifies over raw bytes so authenticity is untouched. Closes
  finding 15. CAVEAT (Info, docs accuracy — not a code defect): the commit's
  claim "byte-identical bodies hash exactly as before" is inaccurate —
  `JSON.stringify(walk(parsed))` compresses whitespace and sorts keys, so a body
  that was NOT already canonical now yields a NEW dedup id. Consequence, bounded
  and self-healing: an event in flight across the deploy can be processed once
  more (its pre-deploy dedup doc was keyed on the raw-bytes hash). Suggest a
  corrected sentence + one deploy-runbook line ("expect at most one duplicate
  processing per in-flight event at deploy time"). Bite proof is
  stronger than claimed (passes 605 total suite).
- `711df6a` fix(porter): stop inventing the delivery-address locality —
  **GOOD**. The four invented defaults (Ahmedabad / Gujarat / 380015 /
  "Customer Delivery Address") are gone, extracted into a pure exported
  `resolveDropAddress()` as the mirror of `resolvePickupContactPhone()`; real
  orders are unchanged because `OrderAddressSnapshot.city/state/pincode` are
  required client fields; the real lat/lng pin still carries the position; the
  `apartment_address`/`street_address1` chains are preserved. Adds Porter to the
  EXISTING wire-probe owner item (Porter/Shadowfax now both send empty locality
  for malformed or legacy orders — verify vendor tolerance before production
  traffic; real orders are unaffected).

NOTE: `functions/src/modules/dispatch/dispatch.webhooks.ts` is dirty again —
that is the dispatch lane's own in-flight edit, not coordinator work.

### Pre-review: UNCOMMITTED payments slice (read-only, ~01:15; re-verify on commit)

`git diff -- functions/src/modules/payments` = +375 razorpay.service.ts,
+218 webhookHandler.ts, plus 3 new test files (~93 KB total) and 3 modified
tests. Suite green on the tree (591 passed / 2 skipped / 0 failed).

STRENGTHS verified in source (all recorded on the bus):
- **B8/C03** — an order with no stored total no longer confirms blind: the only
  fallback is a SERVER intent bound by gateway-order AND ownership; otherwise
  parks `ump_<eventId>` with `reason: confirm_amount_unknown` + `amountSource`
  and still answers 200 (captured money is never retried). Intent read errors
  fail closed.
- **R06** — the CONFIRMED write is now transactional with a re-read that
  suppresses foreign-capture and later/terminal state instead of regressing;
  `executeRouteSplit` and the KOT push are both gated on `confirmWritten`.
- **B7** — a second distinct capture parks as ONE deterministic
  `payment_discrepancies/dis_<order>_<payment>` doc; no re-confirm, no split.
- **KOT dedupe** now also treats `petpoojaAcceptedNoId` as already-pushed (the
  id-less sandbox ack).

FINDING (Medium — decision needed before launch): **A08 B6 is not addressed in
this slice.** `webhookHandler.ts` contains zero OTP code (no `deliveryOtpHash`,
`randomInt`, or `computeHmacSha256`) and never calls `finishVerifiedPayment`;
the verify-path mint/backfill (`razorpay.service.ts:1439-1497`) only runs if a
verify call happens later. So an app-closed payer's DELIVERY order is CONFIRMED
with no handover OTP and `verifyDeliveryOtp` throws → staff cannot complete
handover. Either implement A08's proposal in the webhook confirm transaction
(mint when eligible and no hash, never overwrite — share the existing helper),
or record it as an explicit accepted launch gap.

VERIFIED ALREADY CLOSED (so nobody re-audits): **B1** (signature codes removed
from the client uncaptured whitelist — `paymentsService.ts:372`) and **B2**
(`markPaymentFailed` server-truth paid guard with `ORDER_ALREADY_PAID` /
`ORDER_TERMINAL` refusals) — both fixed and committed client-side.

NOT verified in this pass, do not read as green: B3 client amount revalidation /
`paidAt` source, B5 customer-visible reconcile marker, B4 vocabulary drift.

## NIGHT GATE (coordinator, close-out 2026-10-18 ~01:00)

Items 1-4 are CLOSED (see above). Item 5's validation was RUN and is green:
functions `vitest run` 591 passed / 2 skipped / 0 failed on the current tree
(including the audit lane's uncommitted payments work), `tsc` exit 0, root
hosting preflight PASS 25 / FAIL 2 (the two FAILs are the team-owned TEAMID
placeholder), and both archived AABs signature-verified (jarsigner exit 0) with
hashes recorded:
- partner  SHA-256 B86291AD4BF39AF5FA4DA886FCA0F4DC3199D0ADB168400C4CA26410AAA01120 (26.4 MB)
- customer SHA-256 60D1B11CA673B4D14439F6D06A38E5ABCB341CD9837864FBF17609CAEB01CE4B (20.9 MB)

REMAINING, ALL HUMAN- OR LANE-BLOCKED — nothing further the coordinator may do
tonight without exceeding its authority (no push, no deploy, no credential or
production changes):
1. [lane] Payments slice still UNCOMMITTED (audit lane owns those files). Its
   tests pass on the current tree; it must be committed + reviewed before any
   deploy, or it can be lost with the worktree.
2. [human] Play Console account + app entries; Apple Team ID (sole preflight
   FAIL); App Store Connect invite; privacy-policy URL decision; Firebase iOS
   plists for both apps.
3. [human/data] Petpooja POS dashboard re-push (rewrites the 166 mis-mapped
   demo docs and settles in_stock "2" via the new census) — needs the mapper
   commits deployed first, which is its own gated decision.
4. [owner] Deliberate open items recorded in NIGHT_DONE.md (§7): price "0" on
   the 81 variation items, active/is_combo/item_ordertype, tax metadata,
   unbounded parking writes, wire probes, store.phone backfill.

## Known-not-blockers
- Partner AASA uses legacy AASA shape (accepted by validator; not a Play issue).
- Two oversized JS chunks + ineffective dynamic imports in both web bundles —
  performance tune later, submission-safe.
- versionCode 1/1.0.0 is correct for the FIRST upload; every later upload is a
  hand-bump in android/version.properties (+ the same numbers appear as
  fallbacks in both android/app/build.gradle files).

## Petpooja lane (ses_ed03fcd6cffex1u0DNLajjXmn2) — end-of-night status

Added by the Petpooja lane; entries above are the coordinator's and untouched.

- PENDING item 3 CLOSED. Three commits, all tagged [lane:petpooja], all
  committed-only and NOT deployed:
  - b26d5e3 — push branch guards its own input (throwIfVendorRefusal before
    accepting the catalog); the malformed-body 400-vs-503 intent DECIDED
    (keep 400) and pinned. 3 petpooja files 52 passed, bite-checked.
  - 1627204 — mapper reads the vendor's OWN field names (item_categoryid /
    itemdescription / item_image_url) plus a guarded categoryid -> categoryname
    join from the top-level categories[]. 57 passed, bite-checked.
    in_stock / price / active / tax untouched.
  - 317b6ea — raw in_stock census on the sync-log row + a warn when a catalogue
    comes out ALL dark. Purely additive. 62 passed, bite-checked.
  - 9407006 — the 1627204 review notes: the categoryid join is now FIRST-wins,
    the doc's categoryId is String()-normalised, and a sanitized 2-item
    vendor-truth fixture (tests/fixtures/petpooja-menupush-sample.json) now
    exercises the real restaurants[0].details.menusharingcode path. 65 passed,
    both bites verified.
  - cc9fc8c — docs only: sections 17.1-17.13 in references/petpooja_save_order_api.md
    (187 insertions, 0 deletions) record the captured payload as ground truth for
    the ingest side, with in_stock recorded as UNRESOLVED rather than guessed. All
    cited source line references were spot-checked against the working tree first.
- All review notes the coordinator has left on this lane are now CLOSED.
- Production re-verified read-only: newest petpooja_sync_logs row is still
  2026-10-17T11:02:53Z with nothing since (no 11:30/12:30/13:30 tick rows), which
  is what the deployed refusal fix predicts; no row carries `inStockValues`,
  which independently proves none of these four commits is deployed.
- Item 2 (payments slice) is the audit lane's, not mine, and is still uncommitted.
- Item 5 partial, from this lane: `tsc --noEmit` is clean on the full functions
  tree as of 317b6ea; the three petpooja test files are 62/62. Full `npm test`
  not run here (other lanes' known failures).
- BLOCKED, deliberately NOT guessed at, needs the user or a cross-lane call:
  (a) in_stock semantics — the vendor console is behind email + password +
  reCAPTCHA and the authorised browser session never reached a logged-in read,
  so no change shipped on a hunch; the 317b6ea census is what will settle it on
  the next real push.
  (b) the api deploy — `firebase deploy --only functions:api` ships the WHOLE
  functions bundle, so it would also ship dispatch 39efc40 + 91f487c. Needs
  dispatch-lane + coordinator sign-off, not just mine. An earlier attempt failed
  on firebase CLI connect timeouts; no functions were uploaded, production is
  unchanged, and the worktree/.env/node_modules were cleaned up.
- OPEN DECISIONS for the repo owner, none of them guessed at tonight:
  `price` for the 81 variation-flagged items that ship `price:"0"` with empty
  variation definitions (so an absent price currently renders as an orderable 0);
  `active`; `is_combo` (the tombstone pass protects a field this path never
  writes); `item_ordertype`; tax handling (`item_tax` resolves to CGST 2.5% +
  SGST 2.5% with `tax_inclusive: false`, and none of it reaches the product doc);
  and the residual unauthenticated write risk on the credential-less
  `/petpooja/webhook` shape, where a parking write for an unresolvable restID
  creates documents with no bound and no TTL.
- Dead end recorded so nobody re-walks it: the 63 legacy `petpooja_products`
  documents are SEEDED FIXTURES, not payload-derived data. Their only writer was
  `burgonomics-foundation-core/scripts/seed.ts`, and that script's import
  (`petpoojaSampleData.ts`) was deleted 2026-10-11, so the write path is dead;
  firestore.rules denies client writes and no live function writes the
  collection. Every doc is a literal boolean `true` with NO in_stock field at
  all, the ids are `prd_*` slugs matching the seed array 63/63, and they overlap
  the real payload's numeric ids (30651–30791) zero times. They carry no
  information about the vendor's in_stock encoding.

### 2026-10-19 - vendor console access, the proven inbound callback, and 0f55c50

- The user supplied the vendor's sandbox console credentials (via the vendor
  email evidence). I used the console READ-ONLY over the existing SOCKS tunnel +
  debug browser: no VPN/network/service change, no email sent, and the credential
  was never printed, committed or put on the bus.
- Live console reads: configuration page = **Menu Push** selected, with the
  menu-sync / webhook / stockWebhook callback paths; **Menu item on/off had NO
  records** for the demo outlet; Menu list = the same 21 categories as my census;
  Help = a contact form with no stock documentation.
- **Design consequence:** because Menu Push is selected, the vendor does not
  provision the fetch file — so the hourly pull can never succeed for this outlet.
  That is the permanent explanation of the S3 "unable to fetch Object" error.
- The five vendor scenario orders are still in the console Order List with their
  exact client order ids + totals (one now Accepted), but they stay HISTORICAL,
  not current verified success (C08).
- **PROVEN: the inbound order-status callback works.** 2026-10-17T11:30:22Z
  parked as `unmatched_petpooja_orders/upo_bgx_variation_tax_1792168825392`
  (restId `31z58ciw0h`, rawStatus `"1"`) while the console shows that order
  Accepted; it parked only because the `clientOrderID` was probe-synthetic.
- Still open here: `in_stock "2"` (console on/off empty while all 166 items carry
  "2" → consistent with available, NOT decisive); the console session has expired
  and re-auth needs a human to solve the reCAPTCHA (never automated); the
  vendor's two email attachments are not in the local .txt and not findable
  locally.
- **`0f55c50`** (2 files, mine only, unpushed): inbound callbacks are now
  attributed to an outlet in `pos_webhook_audits`; that proven callback's audit
  row had recorded `restId: null`. +6 tests, petpooja files 84 → 90, full suite
  637 passed / 2 skipped / 0 failed, build exit 0, bite-checked. **INERT** until
  the `index.ts` owner passes `payload: p` at the two `/petpooja/webhook` audit
  calls (requested, not touched by me).
- **KOT-boundary review of the payments slice `425e5aa` — VERDICT GOOD**
  (my C02 duty; diff-only, no file touched). All five boundary conditions hold:
  the OTP mint is inside the same confirm transaction and only on the
  `written:true` path (so `confirmWritten` and the order binding are unmoved);
  `pushOrderToPetpooja` still has exactly its three callers (no second POST
  path); the dedup checks BOTH `petpoojaOrderId` and `petpoojaAcceptedNoId`;
  no `pp_` fabrication exists in payments source; and a POS rejection logs
  `pending_retry` rather than flipping a success state. Confirmed by brace
  structure that the KOT block is inside `if (confirmWritten)`, so a suppressed
  capture can never push a KOT. One non-blocking note: the outer dedup read at
  `webhookHandler.ts:597` is non-transactional — the authoritative guard is the
  claim inside `pushOrderToPetpooja`, which is correct but deserves one runbook
  line. **My lane is now code-complete and human-blocked.**

### 2026-10-19 sleep window - vendor PDFs read, two commits landed, KOT review extended

- **The vendor PDFs are local and were read** (they are *not* vendor-email
  attachments): `Downloads`, both dated 2026-10-06 - *API Guide for Placing
  Orders on Petpooja POS* (9pp) and *Petpooja Sandbox Guide for Integration
  Testing* (6pp). Findings recorded as **section 18** of
  `references/petpooja_save_order_api.md` with citations. The coordinator lane
  read the same files independently; the readings agree.
  1. **No vendor document describes an `in_stock` field in the Push Menu
     payload.** The Sandbox Guide makes the Item On/Off Webhook the documented
     stock carrier, so the 166 constant `"2"` values have no documented encoding:
     `in_stock` stays **UNKNOWN**, no mapping change, no tolerant fallback.
  2. `callback_url` is documented REQUIRED, and the dashboard Base URL fronts
     every webhook (which is why only *which* base URL is registered remains
     open); no callback auth is documented.
  3. `variation_id` / `variation_name` are optional and empty-string when absent.
  4. Discounts: `discount_type` + `discount_total`, no `discount` object - the
     line-level `item_discount` question is **closed**.
  5. `final_price`: the guide says unit figure, its total formula balances on line
     totals. Ours stays the line total - recorded, deliberately not "corrected".
- **`9caac04`** - +2 tests pinning the OrderItem variation fields (the
  empty-string shape with the key PRESENT, plus the legacy `variationId`/
  `variationName` resolution; neither key had any coverage) and reference-doc
  section 18. Targeted 90 -> 92; full suite 637 -> 639; tsc 0; build 0. Bite:
  dropping the `|| ""` default fails with "expected undefined to be ''".
- **`2a2126d`** - +1 test pinning the stock verb's fail-closed boundary: the only
  in-stock values are `1` / `"1"` / `true`, and `"2"` (the value the Push Menu
  payload carries) is in the out-of-stock set. Test-only; the probe was reverted
  byte-exact. Bite: adding `"2"` to the whitelist fails with "in_stock=2 must
  resolve to inStock=false". Full suite exit 0, 643 passed / 2 skipped / 0 failed.
- **KOT-boundary review extended** to the coordinator's two newest commits:
  `2f5d1aa` changes `webhookHandler.ts` but touches **no** boundary symbol (no
  push call, no dedup key, no claim field, no `confirmWritten`), and `db97311` is
  test-only and merely ADDS a KOT-presence assertion. **No boundary impact.**
- A transient red in `tests/webhook.replay.test.ts` was an **uncommitted
  in-flight edit** in the payments lane; `2f5d1aa` resolved it, so it was reported
  as resolved rather than as a stale blocker.
- **Deploy-candidate signoff**: `748a54a`, `0f55c50`, `9caac04`, `2a2126d` are all
  contained in HEAD `2a2126d` on `ui-sweep` (verified with
  `git merge-base --is-ancestor`) and the tree is gate-green. My lane has no
  uncommitted changes.
- Remaining in this lane is human-gated only: the `in_stock` decision (or one
  authorised item toggle), re-push authorisation, the registered callback base
  URL (console re-auth, never automated), and `RAZORPAY_WEBHOOK_SECRET` via the
  coordinator.

### 2026-10-19 consumer-scope round (user-directed subagents)

Scope correction applied: this lane is the delivery/takeaway **consumer** of the
catalogue/availability, not a POS/menu manager. All earlier proposals for vendor
item toggles or a catalogue re-push are withdrawn and were not performed.

- **Subagents (explicit model overrides only).** C1 `explore` /
  `opencode/deepseek-v4.1-flash-free` (usable trace). C2 `nexus-reviewer` /
  `opencode/glm-5.3-flash-free` — **degenerate output**, disclosed and not used.
  C3 retry `nexus-coder` / `opencode/deepseek-v4.1-flash-free` (usable). The
  retry deliberately used an agent whose own default model is *also* permitted,
  because the child's runtime model is **not independently observable** —
  `tools.sessions`, `tools.agents` and `tools.dashboard` all return empty for
  subagent children — and the Nexus role config defaults reviewer/tester to
  `opencode/mimo-v2.6-flash-free`, which is not permitted. Recorded as a tool
  limitation rather than asserted compliance.
- **`51a318a`** (test-only, my file, +42): two hermetic tests on the outbound
  stock push — an unlinked branch returns false **and fetch is never called**
  (a wrongly-routed toggle succeeds remotely and 86s another outlet's item), and
  a declared-production process with the POS mock active **rejects** instead of
  returning the mock's fabricated `true`. File 31 → 33; suite 665 passed /
  2 skipped / 0 failed; build 0; both bite-checked.
- **Read-only verification of the consumer join (mine, not a child's):** 26
  branches but only `demo` carries `petpoojaStoreId`, while all 17 stores carry
  `petpoojaRestId` and products exist for each resolved restId (partial,
  page-capped sample). So the hypothesised "empty menu" is **not** realised; the
  real asymmetry is that the sync writer can only ever link `demo`, so the other
  25 branches are unreachable by the Petpooja ingest. Context, not a defect.
- **Reported, not changed (not my files):** the consumer mapper defaults an
  ABSENT `inStock` to **available** (the reverse of the write-side fail-closed)
  and several consumers compare `=== false` only; and the 86ing path's
  `prod_unlinked_*` staging docs are invisible to consumers and never retired.
- **Still undetermined:** the vendor meaning of `in_stock` `"2"`. Two children
  agreed independently; no mapping was touched.
