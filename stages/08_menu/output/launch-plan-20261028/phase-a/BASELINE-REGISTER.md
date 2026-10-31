# Phase A baseline and ownership reconciliation

**Inventory verified; release selection and owner handover remain blocked.** Read-only capture: 28 October 2026, 09:34:33 IST. [Machine-readable snapshot](baseline-snapshot.json). None of these checkouts/worktrees is adopted by this task.

## Three independent repositories

| Group / repository | HEAD on `ui-sweep` | Tracked dirty / staged | Registered worktrees |
|---|---|---|---|
| Root `Burgonomics` | `31e82c3c415757064e3b33010ade4d2b0d8ebd6f` | 99 / 0 | 28 |
| Delivery `burgonomics-foundation-core` | `7affdf698576110a64e008a492f2d8380abe2d58` | 9 / 0 | 26 |
| Partner `burgonomics-partner` | `7374d3e183f7272b91c19749fc192eaddee9e3ae` | 11 / 0 | 15 |

All **118/118 selected planning-source hashes matched** document 10. This is byte identity with the planning observations, not a full source/dependency/release manifest or evidence those bytes pass tests. Untracked paths are individually inventoried in the snapshot; root count increases as this packet is written. Ignored files/dependencies/build inputs are not a complete inventory. No secret/environment/private signing contents or hashes were captured.

## Material alternate candidates, separately observed read-only

“Ahead” below means committed Git ancestry relative to that repository's main `ui-sweep` checkout. It does **not** mean newer dirty bytes, better code, approval, ownership or release readiness. All comparisons returned zero main-only commits; no branch was merged.

| Repository / `.swarm-worktrees/` name | HEAD | Ahead | Tracked dirty / untracked | Treatment |
|---|---|---:|---|---|
| Root `polish-backend-20261025` | `c26effe867c662f2008445ee6dae73d176c77bb8` | 32 | 0 / 0 | Candidate only; release/overlay owner unresolved |
| Root `polish-release-ci-20261027` | `cd0662e8eac0c786fd7ce32ed0e9996ab10f02d3` | 32 | 0 / 0 | Separate history, not the backend candidate |
| Root `petpooja-vendor-contract-20261028` | `c26effe867c662f2008445ee6dae73d176c77bb8` | 32 | 3 / 15 | Reserved to `ses_e94d6379dffePDVml2TD7LGSxA`; no transfer |
| Delivery `polish-core-20261025` | `af66c966cc015ab2ee21b19f769d40445522d221` | 13 | 4 / 0 | Menu/nav and notification-preference dirty work; owner unresolved |
| Delivery `polish-customer-ci-20261027` | `fb7db84155d03d1c88f1eeb52e4dff4f1024e80d` | 14 | 0 / 0 | CI candidate only; owner unresolved |
| Delivery `polish-checkout-20261025` | `038dff83b866b9c0905a51776196415fb90d47aa` | 12 | 2 / 1 | Payment route and generated route-tree overlay; owner unresolved |
| Delivery `polish-customer-p1-20261025` | `038dff83b866b9c0905a51776196415fb90d47aa` | 12 | 21 / 0 | Cart/checkout/customiser/payment/tracking overlap; owner unresolved |
| Partner `polish-partner-20261025` | `0fa8d1b26233f517178cfbe44dbf9e3eb74e2836` | 19 | 5 / 6 | KDS/theme/order-detail dirty work; owner unresolved |
| Partner `polish-partner-data-20261025` | `167f1602381ecf62345f264f056b380f41489df3` | 23 | 6 / 3 | Manual-order/menu/orders overlay; owner unresolved |

Other registered worktrees, including prunable/locked entries, remain listed in the snapshot and untouched. Worktree existence and commit authorship do not establish present permission to reuse its files.

## Known ownership and explicit reservations

| Scope | Evidence / owner | Authority now |
|---|---|---|
| `phase-a/`, `proposals/v1/`, dated packet routing/ledger additions | This user-approved Phase A task | Documentation and isolated design artifacts only |
| Petpooja vendor candidate's seven manifest files and local evidence | Session `ses_e94d6379dffePDVml2TD7LGSxA`, actual tool records and 7/7 hash match at capture | Reserved to that task; no copy, merge, deploy or vendor submission here |
| Main root financial/rules/POS overlays | Dirty-path inventory only | Original author/current writer unknown; preserve; no transfer |
| Delivery/Partner main overlays and older polish candidates | Git status/worktree metadata | Original author/current writer unknown; preserve; no transfer |
| Backend-advice session `ses_e7f7d9238ffeeZTT1SvnTZhd2K` | Inspected terminal checks and advice | Test/advice evidence does not grant ownership of shared snapshots or this launch packet |
| Baseline/overlay selection | Burgonomics release lead/user | Not yet supplied; Phase A inventory is not selection |
| Design approval | Burgonomics design team through user | Exact screenshot IDs/revision still require approval |
| Signing/accounts | Burgonomics account/signing owners | Read-only status requested; no access/custody delegated |

The Petpooja session was observed active again during Phase A; its user requested an official-doc review after the earlier result. An active-session response and changing `outcome` metadata are observations at a point in time, not final completion evidence. Its seven-file candidate matched the earlier manifest at capture; any later edits/review require fresh fingerprints and explicit handover. The earlier “official docs not fully reviewed” report must not be treated as a permanent conclusion about work still in progress.

## Overlap requiring serialised handover before implementation

- Root: `orderPush.ts`, `testRunner.ts` and vendor reference already differ across the dirty main checkout and the vendor candidate. The candidate starts **32 committed changes beyond main HEAD**. Copying it over main could lose unrelated dirty fixes or omit its dependencies. Its test total does not validate main.
- Delivery: `src/routes/cart.tsx`, `checkout.tsx`, customisers and generated route tree overlap planned D4 and older P1/checkout candidates. `CategoryNavRail.tsx` has a separate dirty candidate overlapping D3. Select file-level overlays only after their owners attest scope and provenance.
- Partner: KDS/theme/order-detail candidates overlap P1/P2 and main dirty files; menu/manual-order work overlaps P3 and money authority. One writer per path, with explicit handover.
- Root/Partner rules share the recorded hash; Delivery rules differ. That discrepancy is **preserved, not reconciled by copying**. Authoritative rules/emulator repair belongs to later approved implementation.

## Required release-lead response, not actions performed

For each repository/candidate: name the human custodian; confirm whether its current writer is finished and grants a handover; identify the exact base commit and each accepted/rejected dirty overlay with its hash; specify an approved non-destructive capture method and new implementation worktree. Record acceptance and exclusion rather than deleting anything.

Until that response, all app/backend implementation baselines remain **unselected**. No reset, stash, key copy, blanket patch, worktree unlock/prune, commit, push or source rewrite was performed. No complete release-input manifest or independent code-review approval exists from Phase A. Original launch targets remain unchanged.
