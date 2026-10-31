# NIGHT_DONE — 2026-10-17 night shift

Status: **night closed.** Verified state, what shipped, and the one thing that is
NOT fixed. Written by the Petpooja lane (ses_ed03fcd6cffex1u0DNLajjXmn2) after
closing its own lane and pre-computing the coordinator's WORKLOG item 5 checks.

---

## 1. The one thing that is NOT fixed — read this first

**The demo storefront still renders all 166 items as Sold Out.** Nothing in this
night's work changed that, and nothing was shipped on a guess.

Every item in the real Petpooja Push Menu carries `"in_stock": "2"`, and the
mapper's whitelist accepts only `1 / "1" / true`, so all 166 products were written
`inStock: false`. **What `"2"` means is UNRESOLVED.** The vendor's published Push
Menu schema does not document the field at all, and the stock signal they *do*
document is a different, boolean one that Petpooja sends *to* us.

**One action settles it AND repairs the 166 documents at the same time:** in the
Petpooja POS, turn ONE item off (or 86 it), then press the **Burgonomics API
Menu** push button again. The re-push

- rewrites the 166 demo docs with the real category ids, category names and
  descriptions (currently mis-mapped — see §3), and
- records the raw `in_stock` values with counts on the `petpooja_sync_logs` row
  (`inStockValues`), so the flipped item's value brackets the enum from data
  rather than from a hunch.

That requires the mapper commits to be deployed first (§5).

---

## 2. Verified green (read-only, taken on the current tree)

| Check | Result |
|---|---|
| `npx tsc --noEmit` (functions) | **exit 0**, no output |
| Full test suite (`npx vitest run`) | **53 files passed, 1 skipped (54); 611 tests passed, 2 skipped, 0 failed** (re-measured — see §11) |
| Petpooja three-file gate | 78 passed |
| Root preflight (`scripts/validate-mobile-hosting.cjs`) | **PASS 25 / WARN 0 / FAIL 2 / SKIP 0** — both FAILs are the team-owned `TEAMID.` AASA placeholder, so this is "green except TEAMID". The run wrote no files. |

The full suite was green **including** the audit lane's uncommitted payments work.

---

## 3. What was committed tonight (all reviewed, none pushed, none deployed)

**Petpooja lane** — every cost/coordinator note is closed:

| Commit | What it does |
|---|---|
| `152d834` | Refuse a vendor-failed menu body on the scheduled path instead of recording a green zero-item sync |
| `9c20c12` | Split vendor refusal from malformed body; positive-signal classification |
| `b26d5e3` | The push branch guards its own input at the boundary; the 400-vs-503 intent decided and pinned |
| `1627204` | Mapper reads the vendor's OWN field names (`item_categoryid`, `itemdescription`, `item_image_url`) + guarded category-name join |
| `317b6ea` | `in_stock` census on the sync-log row + a warning when a catalogue comes out ALL dark (purely additive) |
| `9407006` | First-wins category join, `String()`-normalised id, sanitized vendor-truth fixture |
| `cc9fc8c` | Docs: §17.1–§17.13 in `references/petpooja_save_order_api.md` |

**Dispatch lane** — `39efc40`, `91f487c`, `8a144f7` (fabricated-value removal,
Borzo error classification, DR3 gap recorded; follow-up closed all findings).

Chains are FULLY reviewed with **zero blockers**. Deliberately open, owner-side:
wire probes (`WIRE_BORZO=1` + a Shadowfax sandbox order) before production
traffic, and a `store.phone` backfill for pre-orders-snapshot orders.

**Why the payload mapping needed fixing at all:** the mapper read `itemcategoryid`
/ `item_description` / `itemimageurl` while the payload sends `item_categoryid` /
`itemdescription` / `item_image_url`, so all 166 docs were written
`"uncategorized"` / `"Other"` / `""` while the payload carried 166 real category
ids, 21 real names and 110 real descriptions. `imageUrl: null` is a **vendor data
gap** — `item_image_url` is the empty string on every item — not our bug.

---

## 4. Production is unchanged, and that is provable from the data

- Newest `petpooja_sync_logs` row is still **2026-10-17T11:02:53Z**, with **no
  rows after it** — no 11:30 / 12:30 / 13:30 tick rows. That is what the already
  deployed refusal fix predicts: every branch's vendor lookup now throws instead
  of writing a fake `COMPLETED / created: 0`.
- **No row carries `inStockValues`**, which only `317b6ea` writes — so none of
  tonight's Petpooja commits is deployed.
- `pos_webhook_audits` newest is still the 11:02:53Z push, `itemCount: 166`.

---

## 5. Before the next deploy — two constraints

1. **`firebase deploy --only functions:api` ships the WHOLE functions bundle.**
   A Petpooja deploy therefore also ships whatever else is committed, including
   the dispatch lane's work. The dispatch client-regression checks passed, so
   this is a coordination step, not a blocker.
2. **An earlier deploy attempt failed on `firebase` CLI connect timeouts** to
   Google's APIs (this machine's network was flaky; direct fetches to the same
   hosts answered in ~400ms). Nothing was uploaded, production was untouched, and
   the worktree / `.env` copy / `node_modules` junction were all cleaned up with
   the real `node_modules` verified intact.

Deploy from a clean worktree at HEAD, never the dirty tree, and copy the
gitignored `functions/.env` in first or the boot refuses on mock keys.

---

## 6. ONE OUTSTANDING LANE ITEM — not mine to commit

**The audit lane's payments slice is still UNCOMMITTED**, though its tests pass on
the current tree:

```
 M functions/src/modules/payments/razorpay.service.ts
 M functions/src/modules/payments/webhookHandler.ts
 M functions/tests/e2e.flow.test.ts
 M functions/tests/paymentSignature.test.ts
 M functions/tests/webhook.replay.test.ts
?? functions/tests/captured-payment-binding.test.ts
?? functions/tests/payment-confirmation-concurrency.test.ts
?? functions/tests/payment-confirmation-webhook-concurrency.test.ts
```

I did **not** touch or commit it: `functions/src/modules/payments/**` belongs to
another lane, and committing someone else's in-flight work unattended is exactly
how a night ends badly. **It should be committed + reviewed before any deploy, or
it can be lost.** This is also why this file does not claim item 5's precondition
was met: WORKLOG item 2 had not landed.

---

## 7. Owner decisions still open (none guessed at)

- **`in_stock` semantics** (§1) — the blocker for the storefront.
- **`price`** — 81 of 166 items ship `price: "0"` and those are exactly the
  `itemallowvariation: "1"` items, while the variation *definitions* are absent
  (`variation: []` on all 166, top-level `variations` empty). Those prices are
  missing from the payload, not relocated; today an absent price renders as an
  **orderable zero**. Also an ask to Petpooja: should those definitions arrive in
  the push?
- **`active`**, **`is_combo`** (the tombstone pass protects a field this path
  never writes), **`item_ordertype`** — read nowhere; all single-valued in this
  capture, so latent, not live.
- **Tax** — `item_tax` resolves to CGST 2.5% + SGST 2.5% with `tax_inclusive:
  false`, and none of it reaches the product doc, so every stored price is
  ex-GST with no tax metadata.
- **Unbounded parking writes** — the credential-less `/petpooja/webhook` shape
  can create documents for an unresolvable `restID` with no bound and no TTL.
  Two options were identified (bound to linked outlets, or cap/TTL); neither was
  chosen unilaterally.

## 8. Team asks (unchanged, from the coordinator)

Play Console account (longest lead), Apple Team ID (the single remaining
preflight FAIL), App Store Connect invite, privacy-policy domain decision
(`burgonomics.com/privacy` 404s), Firebase iOS plists for both apps.

---

## 9. What could not be settled tonight, and why

**`in_stock: "2"`.** The vendor's developer console is behind email + password +
reCAPTCHA. The browser route was authorised and the tunnel was made stable
(a stale half-dead SSH session holding the VM's single connection slot was the
real cause of the earlier flapping — **not** ProtonVPN, which was left untouched),
but the session never reached a logged-in read: the copied profile's PHP session
was dead and the interactive window did not survive to a sign-in. So no ground
truth was obtained and **no change was shipped on an assumption**.

**A lead that died, recorded so nobody re-walks it:** the 63 legacy
`petpooja_products` documents are **seeded fixtures**, not payload-derived data.
Their only writer was a seed script whose data import was deleted 2026-10-11; the
rules deny client writes and no live function writes the collection. Every doc is
a literal boolean `true` with **no `in_stock` field at all**, ids are `prd_*`
slugs matching the seed array 63/63, and they overlap the real payload's numeric
ids (30651–30791) **zero** times.

---

## 10. State of the machine

- Working tree: other lanes' dirty files remain (payments slice, root docs and
  config) — **left exactly as found**.
- Nothing pushed. Nothing deployed tonight.
- A stable SOCKS tunnel supervisor may still be running
  (`%LOCALAPPDATA%\Burgonomics\PetpoojaTunnel`, logs alongside). To stop
  everything: `Stop-Process -Id <supervisor pid> -Force` then kill any
  `ssh.exe` whose command line contains `127.0.0.1:1080`. The user's own Brave
  profile was never opened or modified.
- `WORKLOG.md` carries an additive Petpooja-lane status block; the coordinator's
  entries there are untouched.

---

## 11. Postscript — re-measured after two further test-only commits

Written after §1–§10; the figures in §2 were re-measured here and supersede the
originals.

- Two further **test-only** commits landed on this lane, each closing a gap a
  reviewer had named, neither changing production code (both module diffs verified
  empty):
  - `147fad6` — pins the menu push's outlet-code resolution chain, including the
    three documented spellings no test touched and the flattened
    `restaurants[0].menusharingcode` fallback that the vendor-truth fixture
    deliberately avoids.
  - `5d064e7` — exercises the **LIVE** push path and its **RETIRE** pass. Mock
    mode skips the retire block entirely, so the code that can retire real
    products had never run in any test. Now pinned per the source: an absent
    branch-scoped orderable POS SKU becomes `inStock: false` + `ghostRetired:
    true` with a timestamp and is **never deleted**, while combos, local-only
    docs, already-out-of-stock items, other branches and an empty feed are
    protected.
- The dispatch lane also closed finding 15 in `f52beb6`.
- Re-measured on the tree containing all of the above: `tsc --noEmit` exit 0;
  full suite **611 passed, 2 skipped, 0 failed**; the three petpooja files
  **82 passed**.
- **One flake, worth writing down.** On the first of the two re-measurement runs,
  `tests/porter.service.test.ts > … never invents a locality for the delivery
  address (finding 6 class, drop side)` FAILED; it then passed both in isolation
  (28/28) and on the immediately repeated full run. That file is currently
  **uncommitted and mid-edit in the dispatch lane**, so this is an observation for
  its owner rather than a defect in committed state — but a flaky test in a file
  that will gate the coordinator's "confirm green" check should not go unrecorded.
- Everything in §1 still stands: the storefront is still not fixed, and the
  `in_stock` question is still unresolved and still deliberately not guessed at.
- Later still, after the coordinator's close-out below (2026-10-18): `59211a8`
  surfaces the **unpriced in-stock SKU** hazard. 81 of the 166 items ship
  `price: "0"` and those are exactly the variation-flagged ones, while the
  variation definitions are absent from the payload — so the moment the pending
  `in_stock` fix lands, those 81 SKUs become orderable **for free**. The commit
  adds counts to the sync-log row plus ONE warning that fires only when an
  unpriced SKU is actually **in stock**, so it stays silent in today's
  all-out-of-stock state and speaks up exactly when the hazard becomes real.
  Deliberately decision-free: the price mapping, the `inStock` whitelist and every
  pricing policy are untouched, so §7's open price decision still stands. The same
  commit corrected a mis-reference in `references/petpooja_save_order_api.md`
  §17.12 (it credited §16.9, which is about linking the DEMO outlet, not about
  deploys) and had §17.7 record the instrument.

## 12. Postscript — vendor console access + the proven inbound callback (2026-10-19)

- The vendor's sandbox console was used **read-only** through the existing SOCKS
  tunnel + debug browser (no VPN/network change, no email sent, and the
  credential was never printed, committed or posted on the bus).
- Captured live: the configuration page has **type = Menu Push** selected, with
  the menu-sync / webhook / stockWebhook callback paths; **Menu item on/off
  returned NO records** for the demo outlet; Menu list showed the same 21
  categories as my census; Help is a contact form only and documents no stock
  enum.
- Consequence recorded: with Menu Push selected the vendor does not provision the
  fetch file, so the hourly menu pull **cannot succeed for this outlet by
  design** — that is the permanent explanation of the recurring S3 "unable to
  fetch Object" error, not a transient fault.
- The five vendor-required scenario orders are still in the console Order List
  with their exact client order ids + totals (one now shows Accepted). They
  remain **historical, not current verified success** (C08): a re-run is required.
- **PROVEN:** the inbound order-status callback works end-to-end. The
  2026-10-17T11:30:22Z call parked as
  `unmatched_petpooja_orders/upo_bgx_variation_tax_1792168825392`
  (restId `31z58ciw0h`, rawStatus `"1"`) and the console shows that order
  Accepted. It parked **only** because that `clientOrderID` was probe-synthetic,
  not because the channel is broken — which closes the run's longest-standing
  unknown.
- Not settled by the emails or the console: `in_stock "2"` (the console on/off
  view is empty while all 166 pushed items carry "2" → consistent with
  available, **not decisive**). The console session has since **expired**, and
  re-auth needs a human to solve the reCAPTCHA — deliberately never automated.
- **Commit `0f55c50` (this lane, unpushed):** an inbound callback is now
  attributed to its outlet in `pos_webhook_audits` — the audit row for that
  proven callback had recorded `restId: null`. Tested (+6; petpooja files
  84 → 90; full suite 637 passed / 2 skipped / 0 failed; `npm run build` exit 0;
  bite-checked: reverting fails with "expected null to be '31z58ciw0h'").
  **INERT** until the two `index.ts` `/petpooja/webhook` audit calls pass
  `payload: p`; requested from the `index.ts` owner (coordinator) and not
  touched by me.

---

# Coordinator lane close-out (added 2026-10-18 ~01:00 — additive, Petpooja content above untouched)

Lane: release review + read-only validation + documentation. **Nothing in this
section changed `functions/**`, credentials, production, or any remote.**

## Validation evidence this lane produced (beyond §2 above)
- `jarsigner -verify` on BOTH archived AABs: **exit 0** (JAR-vs-JarInputStream
  notices are the standard AAB scheme note, not a failure). Recorded hashes:
  - `client-handover/release-builds/burgonomics-partner-v1.0.0-20261017.aab`
    26.4 MB — SHA-256 `B86291AD4BF39AF5FA4DA886FCA0F4DC3199D0ADB168400C4CA26410AAA01120`
  - `client-handover/release-builds/burgonomics-customer-v1.0.0-20261017.aab`
    20.9 MB — SHA-256 `60D1B11CA673B4D14439F6D06A38E5ABCB341CD9837864FBF17609CAEB01CE4B`
- Root hosting preflight re-run at close: PASS 25 / FAIL 2 (TEAMID only).
- Both archived AABs are **build candidates for store upload**, not approved
  production releases: no store account exists, the payment/dispatch
  integrations are mock or unverified, and the 166-item catalogue is mis-mapped
  until the re-push in §1.

## Review verdicts delivered by this lane (all diff-verified)
| Commit | Verdict |
|---|---|
| `152d834` | GOOD-WITH-CAVEATS (residuals later closed) |
| `9c20c12` | GOOD-WITH-CAVEATS (F1/F3/F4 verified fixed) |
| `b26d5e3` | GOOD — residual closure verified by direct diff-read |
| `1627204` | GOOD — empirically bite-checked in a scratch worktree |
| `317b6ea` | GOOD — strictly additive observability |
| `39efc40` | GOOD-WITH-CAVEATS (client regression risk cleared by reading both web clients; `driver_allocated` vs `rider_assigned` are different fields, no mismatch) |
| `91f487c` | PARTIAL at the time (Porter direct path still fabricated a name) → closed by |
| `8a144f7` | GOOD — all remaining findings verified closed by direct diff-read |
| `147fad6` | GOOD — test-only (verified: single test file); pinned precedence matches `menuSyncWebhook.ts:526-548` exactly |
| `5d064e7` | GOOD — test-only (verified: single test file); closes this lane's HIGH live-coverage finding; asserts live resolution semantics |
| `f52beb6` | GOOD-WITH-CAVEATS — canonical-body dedup verified conservative (array order, value types, HMAC-over-raw all intact); closes finding 15. Info caveat: "byte-identical hashes as before" is inaccurate — non-canonical bodies get a new id, so one duplicate processing is possible per event in flight across the deploy (bounded, self-healing; suggest a corrected sentence + runbook line) |
| `711df6a` | GOOD — Porter drop-address invention removed into a pure `resolveDropAddress()`; real-order payload unchanged (required client fields), lat/lng preserved; adds Porter to the existing wire-probe owner item |

## Pre-review of the UNCOMMITTED payments slice (coordinator, read-only, ~01:15)

Reviewed the dirty diff without touching it (the lane owns those files). Suite
green on the tree: **591 passed / 2 skipped / 0 failed**.

Verified sound in source: fail-closed amount binding when an order has no stored
total (server-intent fallback bound by gateway order **and** ownership, else
`ump_*` park with `confirm_amount_unknown` + `amountSource`, still HTTP 200 so
captured money is not retried); a transactional CONFIRMED write that suppresses
foreign-capture and later/terminal state instead of regressing, with split and
KOT both gated on `confirmWritten`; a second distinct capture parked as ONE
deterministic `payment_discrepancies/dis_<order>_<payment>` doc; KOT dedupe now
also honouring `petpoojaAcceptedNoId`.

**OPEN FINDING (Medium, needs an owner decision before launch) — A08 B6 is not
in this slice.** `webhookHandler.ts` has no OTP code at all and never calls
`finishVerifiedPayment`, and the verify-path mint/backfill only runs on a later
verify call. An app-closed payer's delivery order therefore confirms with **no
handover OTP**, and `verifyDeliveryOtp` throws — staff cannot complete handover
on exactly the orders the webhook channel exists to serve. Either mint in the
webhook confirm transaction (A08's proposal: only when eligible and no hash
exists, never overwrite, sharing the existing helper) or record it as an
accepted, owner-visible launch gap.

**Already closed, verified — do not re-audit:** A08 **B1** (signature codes
removed from the client uncaptured whitelist) and **B2** (`markPaymentFailed`
server-truth paid guard with `ORDER_ALREADY_PAID`/`ORDER_TERMINAL` refusals),
both fixed and committed client-side.

Not verified here (not green, not red): B3, B4, B5.

## Documentation corrections this lane made at close
The store package and partner Mac runbook contained claims stronger than the
evidence. Corrected in `STORE_LISTINGS_DRAFT.md` and
`burgonomics-partner/MAC_INSTRUCTIONS.txt`:
1. Listing copy is now explicitly an **unverified skeleton** — every claim that
   has not passed an end-to-end acceptance check must be re-verified or removed
   before upload.
2. Reviewer access now requires a **working demo account** (a video is
   supplementary, not a substitute); the app must be reviewable.
3. Mock/test integrations are no longer described as safe to ship via staged
   rollout; these builds are internal-test candidates only.
4. Partner runbook: removed the unverified Xcode/archive workflow claim and the
   `.xcworkspace` assumption; SPM statement downgraded from "resolves" to
   "constraints inspected — resolve and archive on the Mac to confirm"; push
   notifications require APNs credentials **and** a device delivery test, not
   just the plist; core's `patch-ios-spm.js` noted as also rewriting plugin
   implementations, so it must not be skipped or copied based on version
   inspection alone.
5. A stray non-English filler word in the customer-app description template was
   removed.

## Lane status
**Complete for tonight, and human-blocked from here.** All reviews delivered and
verified; all local validations green; artifacts archived with hashes; the
remaining work is other-lane (payments commit) or human-only (store accounts,
Team ID, dashboard re-push, owner decisions). No further action taken so as not
to exceed authority (no push/deploy/credential/network/destructive operations).
