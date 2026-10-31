# Burgonomics Delivery + Partner: implementation and launch plan

**28 October 2026 · PROPOSED PLAN · limited Phase A authorised; implementation and submission not authorised**

Output directory: `C:\Users\DELL\Desktop\Burgonomics\stages\08_menu\output\launch-plan-20261028`.

Both apps remain in scope for **Google Play and Apple App Store**. Requirements D01–D30 in the [approved handoff](../launch-handoff-20261028/01-APPROVED-DECISIONS.md) are retained; layouts, technical changes, staffing and release actions below are proposals, not approvals.

**Packet status:** this directory is the planning deliverable of [`08-NEW-SESSION-PROMPT.md`](../launch-handoff-20261028/08-NEW-SESSION-PROMPT.md). Everything added afterwards is **proposed design or read-only evidence**, frozen for review. **No design approval, baseline selection, implementation authority, native/build acceptance, provider/merchant entitlement or store approval exists.**

## Read in this order

| Document | Use |
|---|---|
| [01 — Decisions, ownership and approvals](01-DECISIONS-AND-OWNERSHIP.md) | Boundaries, repository isolation, accountable people, unresolved decisions |
| [02 — Current evidence and blockers](02-CURRENT-EVIDENCE.md) | Rechecked source, tools, device observations and failed worker routes |
| [03 — Delivery design and work packages](03-DELIVERY-DESIGN.md) | Concrete Home/Menu/Cart/theme proposals and implementation contracts |
| [04 — Partner design and work packages](04-PARTNER-DESIGN.md) | Focused operational polish, invite-only access and state handling |
| [05 — Backend and security repair](05-BACKEND-SECURITY.md) | Financial authority, rules, payments, POS, stock, dispatch and reconciliation |
| [06 — Release infrastructure and stores](06-RELEASE-INFRASTRUCTURE.md) | Four native releases, signing, accounts, privacy and distribution |
| [07 — Reelo feasibility](07-REELO-FEASIBILITY.md) | Investigation only; Petpooja and existing Grill Coins retained |
| [08 — Dependency-ordered schedule](08-SCHEDULE.md) | Original seven-calendar-day target, effort, decision checkpoints and fallback |
| [09 — Acceptance and command matrix](09-ACCEPTANCE-MATRIX.md) | Separate evidence gates for Delivery/Partner × Android/iOS |
| [10 — Source fingerprints](10-SOURCE-FINGERPRINTS.md) | Observed source identities; not release/build attestations |
| [11 — Validation and next approval](11-VALIDATION-AND-NEXT-APPROVAL.md) | What was and was not checked; next authorised step |

## What each part is

| Artifact | Kind | Status |
|---|---|---|
| Documents 01–11 and this README | Prompt deliverable: implementation/launch plan | Proposed; planning only |
| [`proposals/v1/`](proposals/v1/README.md) | Early proposed design checkpoint (v0-r1) | Proposed; superseded for coverage; not approved |
| [`proposals/v2/`](proposals/v2/README.md) | Current proposed missing-state packet (v2-r1: 38 states, 89 PNGs, 10 boards) | Proposed; awaits exact design-team feedback |
| [`phase-a/device-review-20261028/`](phase-a/device-review-20261028/README.md) | Read-only installed-app and competitor observation on one Android phone | Evidence only; the black frame was an interrupted capture, not a defect |
| [`phase-a/provider-doc-review-20261028/`](phase-a/provider-doc-review-20261028/README.md) | Read-only reading of supplied Petpooja/Borzo/Shadowfax documents | Reference only; no merchant entitlement or live call |
| [07 — Reelo feasibility](07-REELO-FEASIBILITY.md) | Decision note plus one open financial item (OPEN-EARN-1) | D31–D33 settled; earning behaviour unresolved |
| [`phase-a/BASELINE-REGISTER.md`](phase-a/BASELINE-REGISTER.md) | Read-only Git/worktree inventory and ownership gaps | No baseline adopted |

## Outcome and date assessment

- **3 November: tested release candidates/submission readiness remains a stretch target, not a forecast.** No approved visual mockups, integrated release baseline, fresh package/emulator gates, signed iOS distribution build or store-account eligibility evidence exists in this session.
- **8 November: public launch remains the original target, not a commitment.** Neither platform's review time is controlled by the development team.
- If a relevant new personal Play account/app still needs its **12-testers/14-continuous-days** closed test, starting 28 October cannot meet 8 November. The earliest qualifying application would be approximately **11 November at the actual qualifying timestamp**, followed by production-access and app review. This condition has not been established for Burgonomics' accounts.
- Recommend a **conditional, independent four-release plan**: preserve both targets, authorise a design/baseline/account-readiness phase first, then reforecast on 29 October using actual approvals and named capacity. Do not lower security, financial, native or operator gates to preserve a date.

## Highest-priority blockers

1. Dirty root and two independent dirty app repositories; no implementation baseline/worktree has been approved or adopted.
2. Source-confirmed client-writable refund accounting and client-total POS fallbacks remain. Further callback/status and pricing contradictions are detailed in document 05. No exploit or security clearance is claimed.
3. Both current iOS archive workflows are unsigned scaffolds. Firebase metadata lists Android/web registrations only; app-scoped searches found no local `GoogleService-Info.plist` in either app.
4. Actual Apple/Google account verification, production eligibility, signing custody, latest uploaded versions and review access remain unknown.
5. Initial planning workers all failed. A subsequent exact-roster pass returned Free DeepSeek, Go DeepSeek and independent GLM document reports; Phoenix was quota-blocked and NVIDIA returned `Invalid request`. The corrected plan was rechecked within a bounded scope; **implementation/code/security/native/provider review gates remain unfulfilled**, not waived by documentary review.
6. A local Android phone was inspected read-only, including Martinoz and La Pino'z entry/menu screens; an earlier La Pino'z attempt had been blocked by an update gate. Installed Android APKs are not linked to current source, the Partner read covered entry keywords only, and no iOS device, newly built release or full competitor-flow comparison was verified.

## Phase A update — 28 October 2026

The user approved **proposed mockup screenshots, baseline ownership reconciliation and owner-led read-only account/signing checks only**. [Phase A index](phase-a/README.md), [baseline/ownership register](phase-a/BASELINE-REGISTER.md), [rejected WhatsApp draft—do not send](phase-a/OWNER-WHATSAPP.md), [v0 screenshot boards](proposals/v1/README.md).

All 118 selected source hashes matched; no release baseline or old worktree was adopted. The current design set is **[v2-r1](proposals/v2/README.md)** — 38 states in both themes, 13 narrow/tablet/enlarged-type/text-spacing samples and 10 boards — alongside the preserved v0-r1 checkpoint. Both are **proposed, not approved**. Store/signing evidence is missing; the generic draft was rejected as not the current message and was not sent. Application implementation still requires explicit approval after design and baseline selection.

Phase A was later frozen as read-only evidence. Additions after the plan are the [connected-phone comparison](phase-a/device-review-20261028/README.md) and the [supplied provider-document review](phase-a/provider-doc-review-20261028/README.md); neither is implementation, native acceptance or merchant entitlement. The [Reelo note](07-REELO-FEASIBILITY.md) records the settled no-loyalty-UI launch scope and the one open earn question.

The user subsequently requested [cross-session context sharing](phase-a/SESSION-HANDOFF-20261028.md) and continuation from [the original fresh-session prompt](phase-a/PROMPT-RECONCILIATION.md). That prompt is planning-only; it does not expand application/operational authority or replace the existing plan.

## Fresh prompt execution/review — 28 October 2026

[Review packet and current evidence](../launch-plan-review-20261028/README.md) records the renewed read-only source/device/tool checks, actual five-route outcomes, accepted Delivery/backend/dependency corrections, and the correction-only GLM recheck. Source hashes still matched; the complete detailed plan is retained here rather than duplicated. The final two LOW diagram/ownership clarifications were parent-verified after that recheck and are separately fingerprinted. No review of planning documents is a passing app, rules, native, provider, store or design-team gate.

No app source/rules were edited or app tests/builds/deployments/store submissions run; no explicit merchant action or commit/push was initiated. Documentation validation and the limits of observing SDK startup traffic are reported separately in document 11.
