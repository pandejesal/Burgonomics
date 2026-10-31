# Copy this prompt into the fresh session

Work in `C:\Users\DELL\Desktop\Burgonomics`. You have no prior chat context. Start by verifying and reading:

`stages/08_menu/output/launch-handoff-20261028/README.md`

Then read the approved-decisions and evidence files linked there, and only the requirement/stage inputs needed for the work. Follow actual workspace/app `AGENTS.md`, `GEMINI.md`, `CONTEXT.md` and ICM instructions. The packet is a requirements/evidence handoff, not an already-approved implementation plan.

## Task for this session

Create a realistic, multi-Markdown-file implementation and launch plan for both Burgonomics Delivery and Partner on both Apple App Store and Google Play. **Do not begin application implementation, production operations or store submission.** Ask only unresolved decisions or newly discovered contradictions; do not re-interview settled requirements or ask the user for facts you can safely inspect.

Key approved requirements: four 2×2 flipping Home category shortcuts (Burgers, Wraps, Sides, Shakes & Drinks), continuous sectioned menu, empty-cart reorder instead of Home reorder, one expandable Cart cooking-instructions field, user-supplied Awards & Recognition / Upcoming Stores, readable self-hosted Inter, white light mode / black dark mode with System-Light-Dark override, green primary and sparse orange highlights. Partner gets focused operational polish and invite-only access. Keep Petpooja POS; investigate Reelo without committing migration. See the decision file for exact scope and numbering corrections.

Original targets remain **2026-11-03 tested release candidates/submission readiness** and **2026-11-08 public launch target**, not promises. If current time or external dependencies make them infeasible, say so with evidence and offer a revised decision; do not silently move dates or weaken gates.

## Establish facts first

- Re-check each independent repository's HEAD, working-tree state, owned worktree and source hashes. Do not reset, stash, overwrite, commit or discard existing user work. A root worktree does not automatically capture independent nested app repos or uncommitted changes.
- Verify the actual current tools/configuration. Use Vera first where indexed, then exact scoped search after a miss. Root index was stale and app trees unindexed; global root globs missed files in nested repositories. Verify exact paths before reading.
- Discover the approved local phone again. Last REA/Mobile checks found no device. Compare Martinoz, La Pino'z and both Burgonomics apps only when available. Record actual screen/build evidence; do not invent comparison findings or use a paid cloud device without approval.
- Review root-rule refund accounting, POS/COD pricing fallbacks, rules mirror drift and the other scoped security leads. Source inspection is not an executed exploit test or security clearance.
- Verify current account/signing/native build readiness through appropriately scoped access. Burgonomics owns the accounts, but current verification/production eligibility was not checked. Customer iOS workflow was unsigned, AASA had TEAMID placeholders, and local native Firebase config was missing.

## Required planning outputs

Produce an indexed set of documents covering decisions/approval ownership, Delivery design, Partner design, backend/security repair, release infrastructure, Reelo feasibility, a dependency-ordered seven-day-target schedule, and an evidence/acceptance matrix for four app/platform releases. Pick and report an exact output directory; do not overwrite this handoff as if it were implementation evidence.

For each work package include its owner/model, exact verified repository and owned files, prerequisites, acceptance criteria, commands, source/artifact fingerprints, failure/rollback/reconciliation handling, estimated effort and external blockers. Route to applicable ICM stages and require edit-source updates so stale specs/tests do not reintroduce obsolete behaviour.

## Explicit subagent model roster

The user explicitly requested all three DeepSeek routes below, GLM Free and NVIDIA NIM MiniMax. Use these exact catalog-verified IDs as the permitted roster, with purposeful scoped assignments and safe isolation. Specify the `model` argument on each delegated task; do not let a worker silently inherit the orchestrator's model.

| Requested route | Exact model ID | Suitable planning/review assignments |
|---|---|---|
| DeepSeek V4.1 Flash — OpenCode Free | `opencode/deepseek-v4.1-flash-free` | Repository exploration, focused dependency tracing and bounded fact checks |
| DeepSeek V4.1 Flash — OpenCode Go | `opencode-go/deepseek-v4.1-flash` | Complex backend/mobile design, implementation decomposition and failure-path analysis |
| DeepSeek V4.1 Flash 1017 — Phoenix Grove API | `phoenix-grove/deepseek-v4.1-flash-1017` | Provider/API contract investigation and architecture cross-checks |
| GLM 5.3 Flash Free — OpenCode | `opencode/glm-5.3-flash-free` | Independent correctness/security review and adversarial edge cases |
| MiniMax M3.1 Flash — NVIDIA NIM | `nvidia/minimaxai/minimax-m3.1-flash` | Scoped larger-context synthesis, test-matrix design and documentation consistency |

Re-discover the catalog and check actual authentication/quota before relying on a route. Catalog entries are not evidence of a successful worker run. If a route fails, report it; choose an appropriate available route within this roster or ask before adding a different provider/model. Do not retry billing failures in a loop, silently use paid substitutes, or interpret “etc.” as permission for arbitrary additional models. Do not create busywork merely to exercise every route. Planning delegation does not authorise application implementation. Historical model executions and the earlier paid DeepSeek funding failure are in the evidence file.

## Non-negotiable approval gates

- Proposed visual mockups first, explicitly labelled. The user forwards screenshots to Burgonomics' team for design approval. No design is approved merely because the user approved the requirements.
- After design and implementation approval, require code review, package typecheck/unit/build gates, authoritative-rules emulator tests, styled-browser QA, Android/iOS native evidence and scoped provider acceptance. Do not count skipped/interrupted tests or old artifacts as passing new source.
- A paid-but-POS-pending order shows honest pending confirmation; staff alert at 2 minutes and escalation at 5 minutes. Do not blindly duplicate ambiguous sends, claim physical KOT output from ACK, or automatically refund from those thresholds.
- Live acceptance is agreed in principle only. Exact outlet/order/amount/operator/POS/refund/dispatch actions require separate approval. Phone UI access and an authenticated Firebase MCP are not that approval.
- No production data writes/deploys, real financial/POS/delivery/SMS/push actions, private customer-data extraction, store submissions, commits or pushes without specific approval. Keep credentials outside docs/chat/repositories.
- Nothing gets labelled “working”, “secure”, “ready”, “submitted” or “live” beyond the evidence actually collected for that exact source/build/environment. Keep proposed, implemented, locally verified, sandbox verified, native verified, operator accepted and store-approved states separate.

End the session by presenting the detailed plan, honest schedule/blockers and the specific approval needed next. Stop before application implementation.
