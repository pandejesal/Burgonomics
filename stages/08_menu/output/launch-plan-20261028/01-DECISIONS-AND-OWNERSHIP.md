# 01 — Decisions, ownership and approval boundaries

Status: proposed execution contract. Read [the unchanged D01–D30 decision record](../launch-handoff-20261028/01-APPROVED-DECISIONS.md) for approved requirements. No implementation work package is currently authorised.

## What is settled

- Delivery and Partner each target Android and iOS; release approval may be given independently for each app/platform, not for an unsafe shared backend.
- Delivery: four 2×2 square image-flipping shortcuts; all menu categories remain in a continuous list; reorder moves from Home to empty Cart; one expandable Cart cooking-instructions input; Awards & Recognition then Upcoming Stores at Home's bottom.
- Both apps: white light canvas, black dark canvas, green primary, sparse orange, self-hosted Inter, System default with persisted System/Light/Dark override. Brand lettering stays in the logo.
- Partner: operational polish without a workflow/routing rewrite; publicly downloadable, staff access invite-only and server-authorised.
- Keep Petpooja. Reelo investigation is not a migration or launch-feature commitment. Preserve existing Grill Coins history/balances; continued earn/redeem requires business approval and financial tests.
- Paid-but-POS-pending: honest customer status, durable reconciliation, staff alert at 2 minutes and escalation at 5 minutes. Neither threshold authorises blind retries, automatic refunds or a claim that a KOT printed.
- Only individually accepted outlets/modes/tenders can take orders. Delivery, Takeaway and Dine-in are not silently removed to meet a date; a failed lane stays blocked and its proposed disablement needs recorded business approval.

## People and model routes

Human roles below are accountable **roles to be named**, not an assertion that staff have been assigned. A model cannot approve a design, restaurant procedure, accounting policy, signing identity or submission.

| Role | Accountability | Proposed assistant route |
|---|---|---|
| Release lead / user | Baseline selection, staffing, sequencing, approval ledger and go/no-go coordination | Main orchestrator `openai/gpt-6.1-sol` (this session) |
| Burgonomics design approver | Approve labelled mockup screenshots forwarded by user | Main orchestrator for proposed design/spec; Free explorer for bounded source checks |
| Delivery engineer | Home/Menu/Cart/theme implementation after approval | `opencode-go/deepseek-v4.1-flash` |
| Partner engineer | Theme, operational states, KDS/navigation polish | `opencode-go/deepseek-v4.1-flash` (separate worker/checkout) |
| Backend/security engineer | Price/payment/rules/POS/access repairs | `opencode-go/deepseek-v4.1-flash` |
| Provider integration owner | Merchant/vendor contract, mappings and reconciliation sign-off | `phoenix-grove/deepseek-v4.1-flash-1017` |
| Independent reviewer | Scoped diff review; financial/branch/auth edge cases; review remains required before merge | `opencode/glm-5.3-flash-free` |
| QA/release engineer | Evidence matrix, reproducible builds, native/browser runs and test counts | `nvidia/minimaxai/minimax-m3.1-flash` |
| Fast source checker | Exact paths, bounded dependency tracing and fingerprint checks | `opencode/deepseek-v4.1-flash-free` |
| Account/signing owner | Apple/Play verification, legal agreements, signing custody, secure console access | Human only; agents assist read-only within granted scope |
| Finance + outlet operator | Catalog tax/rounding, rewards/refund policy, real KOT and fulfilment acceptance | Human only |

All five initial planning-worker attempts failed; see the dated [02](02-CURRENT-EVIDENCE.md). The user's later renewed prompt authorised a purposeful fresh exact-roster review: Free DeepSeek, Go DeepSeek and GLM returned bounded reports; Phoenix was quota-blocked and NVIDIA returned `Invalid request`. [Actual outcomes and recheck provenance](../launch-plan-review-20261028/02-MODEL-REVIEWS.md) supersede only the claim that no documentary reviewer has run. These remain conditional implementation assignments, not staffed engineering capacity. Check the same route before relying on it; no silent inheritance, paid substitute, new provider, repeated billing retry or further subdelegation is authorised. A missing qualified route still requires an approved roster decision or named human; code/security/native/provider gates do not disappear.

## Common contract inherited by every work package

1. **Baseline:** use the verified independent repository and exact owned paths in the domain document. Source groups `G-ROOT`, `G-DELIVERY`, `G-PARTNER` are in [10](10-SOURCE-FINGERPRINTS.md). They identify inspected inputs, not a complete releasable checkout. Fingerprint every actual edited source/test/config/lock file before and after work. No new release artifacts exist yet.
2. **Isolation:** current task owns only this new planning directory plus an appended Stage 08 routing/summary note. Read-only workers owned no worktrees. Do not adopt an older `.swarm-worktrees` directory merely because it exists. For implementation, approve separate base commits and file-level dirty overlays for root, Delivery and Partner; then create owned worktrees under workspace `.swarm-worktrees`. The root worktree must not stand in for either app repository.
3. **Preservation:** inventory existing tracked/untracked work, proposed transfers and their owner. No reset, stash, blanket patch copy, key copy, commit, push or cleanup of old worktrees. An approval to implement is not approval to publish Git changes. Without a permitted baseline-capture method, implementation stays blocked.
4. **Concurrency:** a single writer owns each file at a time. Delivery `home.tsx` and `cart.tsx`, Partner layout/theme files, root rules and `razorpay.service.ts` are integration points; transfer ownership explicitly. Serialise changes within those files. Review a precise per-repository diff against the approved snapshot, never the entire unrelated dirty diff.
5. **Evidence:** each package records command/cwd/exit/duration/counts/skips, input/output hashes, environment and artifact identity. Claims use: **proposed → implemented → locally verified → sandbox verified → native verified → operator accepted → store-approved**, with applicability stated. Passing one state does not imply the next. Failed, skipped or interrupted tests are not passes.
6. **Gates:** use command sets in [09](09-ACCEPTANCE-MATRIX.md), then independent review. On PowerShell 5.1 run each command separately and stop at nonzero exit. Unit fixtures are hermetic; no provider probe/backfill/deploy masquerades as a test.
7. **Recovery:** stop on source drift or failing acceptance; preserve logs, relevant diffs and durable financial/POS identifiers. Repair/roll back only the package's approved changes in its owned worktree. Never restore insecure financial rules or delete payment/POS evidence to make rollback easy. Production pause/deploy/rollback/reconciliation requires separate operational approval.
8. **ICM edit-source:** the package includes the corresponding spec/stage/test update listed below. An implementation is not done while old specs/tests demand obsolete behaviour. This plan identifies those corrections; it does not rewrite authoritative specs before the proposed design/contract is approved.
9. **New paths:** anything labelled “proposed new” is not an existing file or successful artifact. Verify the parent and final filename at implementation time; extend the baseline and ownership register before creation.

## Approval ledger

| Gate | Required approval/evidence | Owner | Current state |
|---|---|---|---|
| A — Plan-to-design | Approve phase A scope, name people, permit baseline inventory and labelled non-production mockups; arrange read-only account/signing verification | User/release lead | Limited Phase A scope granted 28 Oct: mockup screenshots, ownership reconciliation, owner-led read-only account/signing checks only; people/selection/handover still pending |
| B — Design | Screenshot IDs/revision, Home/Menu/empty + populated Cart, both themes, Partner operational screens; team approval forwarded by user | Burgonomics design team | Initial v0 screenshots exist under `proposals/v1/`; no screenshot approved; complete A1 state set pending v0 feedback |
| C — Implementation | Exact per-repo baseline/dirty overlay/worktrees, package scope, revised specs, budget/capacity and acceptance commands | User/release lead | Not granted |
| D — Local/sandbox | Reviewed code, full package gates, authoritative rules emulator, styled browser QA; approved sandbox host/account/action envelope | Reviewer + QA + provider owner | Not run/granted |
| E — Native/pilot | Signed builds with source manifest; Android+iOS runs; separately approved exact live actions | QA + operator + user | Existing Android UI observation only; no pilot approved |
| F — Release | Per-app/platform store metadata, legal/signing/account readiness, all relevant gates, explicit submission authority | Burgonomics account owner | Not granted |
| G — Public operation | Store outcome, selected accepted outlets/modes, monitoring/on-call and rollback authorisation | Burgonomics release + operations | Not granted |

Phone UI permission and Firebase authentication do not grant gates D–G. Credentials, reviewer passwords, API secrets and customer exports belong in controlled systems, not this directory/chat/Git.

Phase A progress is recorded in [phase-a/README.md](phase-a/README.md). Existing logo/verified local food photos were approved for internal v0 mockups. The generic account/signing WhatsApp text was [rejected as not the current message](phase-a/OWNER-WHATSAPP.md); do not send it. All account evidence remains pending. The user subsequently requested [cross-session context sharing](phase-a/SESSION-HANDOFF-20261028.md), not new worker execution. These approvals do not restore model routes, select a release baseline, grant A2/C implementation, or grant gates D–G. Old work-package estimates/assignments below remain proposals.

The subsequent repetition of `08-NEW-SESSION-PROMPT.md` was executed as its explicit read-only planning/review task, including its exact five-model roster. It does not change B–G, source ownership, account/signing or operational approvals. Completed document review and retained initial mockups do not imply the team approved a design or that app code was independently reviewed.

## Work packages for phase A

### A0 — Baseline reconciliation (4–8 human hours)

Owner: release lead with Free source checker, conditional on route recovery. Repositories: all three exact roots in document 02. **Read-only ownership:** the 98 base and 20 supplemental source entries in document 10, each repository's Git status/worktree metadata and the instructions already verified. Output: proposed baseline/overlay/ownership register under this planning directory; no application edits. Prerequisite: gate A and clarification of any overlapping active writer. Acceptance: root + both app commits, dirty overlays and full eventual release input manifests agree; secrets excluded; every implementation worktree has a named owner/base; no inherited edits lost. Commands: `git -C <verified-root> rev-parse HEAD`, `git -C <verified-root> status --short`, `git -C <verified-root> worktree list --porcelain`, `Get-FileHash -LiteralPath <verified-owned-file> -Algorithm SHA256`. Source identity: all three G groups; artifact identity: none yet. On mismatch stop and obtain owner reconciliation, not automatic merging.

### A1 — Proposed design screenshot packet (12–20 hours including one review round)

Owner: designer/main orchestrator; human design team approves. Read-only source ownership: Delivery/Partner G groups and the existing-screen images in document 02. Proposed new output: this directory's `proposals/v1/` (not created here), with labelled non-production comps and an image manifest. Prerequisites: gate A, approved brand/food image reuse, accurate featured-category mapping; approved awards/store content is optional because empty sections hide. Acceptance: all screens/states in documents 03/04; every image says “PROPOSED — NOT IMPLEMENTED”; no invented awards/prices/openings or live-data claims; team approves exact revision before coding. Verification: image-file SHA-256, contrast calculation and manual review at 320/390/768 CSS px and 200% text. No app gate is claimed by mockup creation. Reject/revise comps without touching production or app source.

### A2 — Contract reconciliation (4–6 hours after decisions)

Owner: release lead/documenter, with provider/finance owners for contracts. Future owned root files: `GEMINI.md`, `_config/design_system.md`, `_config/deployment_strategy.md`, `references/ui_ux_spec.md`, `references/backend_upgrade_spec.md`, `references/order_flow.md`, `references/petpooja_pos.md`, `references/rbac.md`, and the applicable stage `CONTEXT.md` files below. All paths were verified; changes remain proposed. Prerequisites: relevant design/accounting/vendor decisions and gate C. Acceptance: explicit launch overlay replaces obsolete instructions without falsifying historical verification. Commands: link/content checks and `git diff --check -- <owned-files>`; affected implementation packages still require document 09's gates. Fingerprints: capture these document bytes before edit in addition to the G groups. Recovery: retain decision history, correct the erroneous source, do not rewrite an old PASS into current evidence.

| Route | Required edit-source correction |
|---|---|
| Stage 01 | Reconcile `com.burgonomics.app` prose with actual `com.burgonomics` native/Firebase/store identity; current SDK/signing and environment separation |
| Stage 02 | Root deployment rules as tested authority; field/role schemas and mirror ownership |
| Stage 03 | Current canonical roles/aliases, invite lifecycle, revocation/branch authorisation; replace stale claims path |
| Stage 04 | Partner light/dark/System/Inter, true feed health, no guaranteed background web-audio loop or forced Porter resurrection |
| Stage 05 | Current `modules/petpooja` paths, financial/POS facts and 2m/5m policy; resolve obsolete Takeaway/Dine-in PIN prose and provider references |
| Stage 06 | Grill Coins financial authority, Reelo investigation only; no customer export as an implied launch operation |
| Stage 08 | Four featured categories ≠ full POS taxonomy; continuous sections, single Cart note, move reorder, preserve supported selections |
| Stage 10 | Developer-maintained Home announcements only; no new CMS, Notify Me or automatic orderable-outlet creation |

## Only unresolved decisions to resolve next

- **Release baseline/capacity:** which existing dirty overlays/worktrees are approved inputs, who owns overlapping work, and which named human lanes can actually be staffed? Git state cannot establish authorisation or capacity.
- **New pricing contradiction:** finance/catalog owner must ratify tax-inclusive versus tax-exclusive item semantics, discount/GST/rounding/fees and outlet tax mappings. Inspect authoritative approved vendor/accounting material first; do not ask the user to re-explain facts already in source.
- **Refund business identity:** are two separately authorised same-amount partial refunds distinct operations? Current code keys replay by amount. Define request identity/reconciliation policy with finance, not inferred vendor guarantees.
- **Schedule decision:** retain 3/8 November as conditional targets with hard go/no-go checkpoints, or approve the fallback proposal in document 08 after account/capacity verification. No date has been changed by this packet.
- **Live acceptance:** name exact outlet/operator/order/amount/action/refund/dispatch envelope only after offline/sandbox gates. It is not needed to approve design planning now.

Account status, existing files, installed versions and safe metadata are inspection tasks, not another requirements interview. Award/opening copy and secure account verification remain human-owned inputs; never request secret values in chat.

## Launch decisions recorded 28 October 2026 (D31-D33)

These extend the approved handoff's D01-D30 and are release-lead decisions, not vendor or design approval.

| ID | Decision |
|---|---|
| D31 | The launch app ships with **no loyalty balance or redemption UI**. Existing Firebase Grill Coins balances and history are preserved untouched — not displayed, spent, migrated or deleted. Reelo continues as the restaurant's CRM/marketing system via its existing Petpooja bill sync. |
| D32 | Exactly **one bill producer**: Petpooja to Reelo. The app must not upload, re-post or mirror the same sale into Reelo. |
| D33 | Reelo point awarding is owner-configurable. Launch configuration must not credit a customer twice for one bill. New Grill Coins earn/redeem behaviour at launch is the remaining open item; hiding the UI alone is not a financial control. |

Consequence: no Reelo-dependent UI, no direct Reelo read/redeem, no Grill Coins migration and no dual spendable balance are in the launch scope. Revisiting this needs a new architecture/financial/privacy plan, sandbox evidence and separate implementation approval. See [07-REELO-FEASIBILITY.md](07-REELO-FEASIBILITY.md).

**Open financial decision — OPEN-EARN-1 (not settled by D31–D33):** does new Grill Coins **earning** stop at launch, or continue server-side while the app shows no balance or redemption? Hiding the UI does not stop ledger writes; continuing creates points a customer cannot see or spend and may duplicate Reelo awards. This needs the finance/product owner. It blocks loyalty code, loyalty copy and any release claim about rewards; it does not block this planning packet. No default is assumed here.
