# Burgonomics launch handoff — start here

Date: 2026-10-28. Status: approved requirements and discovery handoff, **not an implementation plan or release approval**.

This packet is intended for a new session with no conversation history. The user explicitly chose to have that session create the detailed plan. Application implementation is not authorised by this packet alone.

## Outcome requested

- Publish **both Delivery and Partner on both Apple App Store and Google Play**.
- Improve Delivery's crowded, hard-to-read interface; give Partner focused operational polish rather than a full workflow redesign.
- Make the real backend, payment, Petpooja POS/KOT, stock and operational flows work. No mocks presented as live services, fabricated confirmations, or unsupported promises.
- Retain the original targets: **2026-11-03 for tested release candidates/submission readiness** and **2026-11-08 for public launch**. These are targets, not claims of feasibility or guaranteed store approval. Reassess remaining time in the new session without silently moving the dates.
- Reelo implementation may wait. Investigate it without replacing Petpooja POS or silently migrating loyalty balances.

## Read order

1. Read the workspace's actual `AGENTS.md`, `GEMINI.md`, and `CONTEXT.md`, and the applicable app/package instructions.
2. Read [approved decisions](01-APPROVED-DECISIONS.md).
3. Read [workspace and evidence](07-EVIDENCE-AND-WORKSPACE.md) before trusting a baseline or test claim.
4. Load only the relevant requirements: [Delivery](02-DELIVERY-UX.md), [Partner](03-PARTNER-UX.md), [backend/security](04-BACKEND-SECURITY.md), [Reelo](05-REELO-INVESTIGATION.md), and [release acceptance](06-RELEASE-ACCEPTANCE.md).
5. Use [the fresh-session prompt](08-NEW-SESSION-PROMPT.md) to start planning.

## What has actually happened

- Read-only source reconnaissance and requirements interviews were completed.
- REA was registered project-locally in `opencode.jsonc`, with backups and targeted JSONC checks. Its Android bridge path was configured; a subsequent REA device-list call succeeded but returned **zero devices**.
- No application source, rules, production data, deployments or store submissions were changed by this requirements task.
- No app typecheck, unit suite, emulator suite, web/native build or end-to-end acceptance run was performed in this task.
- No competitor/app screen was inspected and no design screenshot was generated. The physical phone was visible earlier, but unavailable at the last check.
- This documentation packet and a scoped Stage 08 routing/summary addendum were then written. Historical PASS claims elsewhere are not fresh evidence.

## Approval and safety boundaries

Burgonomics' team approves proposed designs from screenshots forwarded by the user. Proposed mockups must be labelled as proposals; a working build gets separate functional acceptance evidence. Burgonomics owns the Apple/Google accounts and controls credentials and submission approval.

The user approved phone UI inspection and project-local REA registration. That does **not** authorise real payments/refunds, POS sends, rider bookings, SMS/push sends, production writes/deploys, private customer-data reads, store submissions, commits or pushes. Supervised live acceptance is agreed in principle only; exact scope needs separate approval.

## ICM routing

The packet lives under Stage 08 because the initial request starts with Delivery Home/Menu/Cart. It is a cross-stage handoff, not completion of those stages.

| Concern | Stage contract to load selectively |
|---|---|
| Mobile builds, signing, release tooling | `stages/01_project_setup/CONTEXT.md` |
| Security rules and access, if changed | `stages/02_firebase_firestore/CONTEXT.md` |
| Staff invitations/auth, if changed | `stages/03_auth_roles/CONTEXT.md` |
| Partner operations/KDS polish | `stages/04_dashboard/CONTEXT.md` |
| Order, payment, POS, dispatch acceptance | `stages/05_orders/CONTEXT.md` |
| Grill Coins and Reelo investigation | `stages/06_customers/CONTEXT.md` |
| Delivery categories, continuous menu, stock | `stages/08_menu/CONTEXT.md` |
| Upcoming-store contract comparison only | `stages/10_branches/CONTEXT.md` |

For each owned work item, read its Inputs and Verify sections. Do not bulk-load the repository or treat old contracts as current source proof. Known conflicts are listed in the evidence file.

## Completion of the next session

Produce a realistic, dependency-ordered, multi-file implementation plan, with owners, exact owned repositories/files, approval gates, test commands, source fingerprints and blockers. Separate offline, emulator, sandbox, native-device, live-provider and store-review exits. Then stop for user approval before implementing application changes. Do not interpret an empty new context as permission to forget these boundaries.
