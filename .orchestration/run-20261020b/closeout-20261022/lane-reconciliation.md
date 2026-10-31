# Lane reconciliation — run 20261020b closeout

Generated: 2026-10-22T01:34Z. Read-only inspection; nothing committed.
HEADs — root `d5f8c0d`, `burgonomics-foundation-core` `2f47cef`, `burgonomics-partner` `6f81fba`.
Dirty (porcelain -uall): root 19 M + 102 ?? = 121; customer 27 + 28 = 55; partner 15 + 16 = 31.

Method: `git status --porcelain`, `git log --oneline -25`, `git diff`/`--stat`, `git show --stat`,
plus file mtimes as an authorship proxy. The tree moved during inspection
(`closeout-20261022/human-production-checklist.md` appeared mid-run; root 120 -> 121), so counts
are as of 01:34Z.

Key finding: most dirty tracked files predate this run — customer/partner product mtimes cluster on
10-13..10-17. Only items called out below were written 10-20..10-22. `evidence-matrix.md` records
the rule QA applied: *"All dirty/untracked = FOREIGN until claimed."* No dirty path has a
DS-then-GLM record covering its exact bytes.

## Ownership and class map

| Repo | Path (or group) | Lane | Class | Evidence | Recommendation |
|---|---|---|---|---|---|
| root | `firestore.rules` (same diff in all three repos) | 07 | EXCLUDE_RUNTIME | R17 users-field hunks only; `main-ticket-workflow-status.md:24-30` (2+/2- per copy); committed rules at `d5f8c0d`/`2f47cef`/`6f81fba` | Never stage |
| root | tickets 7-path bundle: `core/errors.ts`, `index.ts`, `modules/tickets/tickets.service.ts`, `tests/tickets.notify.test.ts`, + `ticketRouteErrors.ts`, `tickets.resolve-race.test.ts`, `tickets.route-errors.test.ts` | 04 | NEEDS_REVIEW | `evidence/lane-04-gate4.txt:1-23` gate PASS on these exact paths; review chain INVALID per `spot-checks.md:357-372` (cited "DS" was GLM-served); `gate4:44-46` says final delta came after review; `tickets.service.ts` mtime 10-22 01:03 post-dates the gate | Fresh DS + separate GLM on current bytes, then re-gate |
| root | `functions/src/modules/dispatch/dispatch.webhooks.ts` | 04 | NEEDS_REVIEW | Inline "F7 (DS review)" claim only; `gate4:48` lists it FOREIGN to that bundle | Review the F7 hunk |
| root | `modules/notifications/unregisterToken.ts`, NEW `tests/notifications.token-ownership.test.ts` | 07 | NEEDS_REVIEW | Inline DS/GLM claims only; `evidence/lane-04-unregister-standalone.txt:15-22` shows **2 failing tests** (`db.runTransaction is not a function`) | Fix mock, review |
| root | `modules/auth/guestMigration.schema.ts`, `core/validation.ts` | AMBIGUOUS (07 content / 04 path `core/**`) | AMBIGUOUS_OWNERSHIP | Comment-only truth correction | 07 owner + 04 ack |
| root | `functions/tests/petpooja.evidence-truth.test.ts`, `references/petpooja_save_order_api.md` | 06 | NEEDS_REVIEW | None | With lane-06 doc review |
| root | `.gitignore` (+2 petpooja evidence paths) | 06 | NEEDS_REVIEW | None; mtime 10-14 | With the petpooja docs, or drop |
| root | `references/ui_ux_spec.md` | 05 (`LANES.md:35` `references/**`) | NEEDS_REVIEW | None; content is design wording, mtime 10-14 | 03-vs-05 handoff first |
| root | `GEMINI.md`, `_config/design_system.md`, `_config/coding_standards.md`, `UI_SWEEP_STATE.md` | 03 | NEEDS_REVIEW | None; CTA-orange token split, mtimes 10-14/10-17 | Design-token docs bundle |
| root | `firebase.json`, `scripts/validate-mobile-hosting.cjs` (+test) | 11 | NEEDS_REVIEW | `R18-ios-release-preparation.md:3-7` says "no commit, no push"; `WORKLOG.md` attributes it to the 10-17 coordinator | Hosting-ignore + MIME bundle |
| root | `.github/workflows/functions-ci.yml` | none | FOREIGN_UNKNOWN | mtime 10-13, pre-run; no lane owns CI config | Main decides |
| root | `controller/queue.json`, `controller/state.json`, `controller/status.json` | none | EXCLUDE_RUNTIME | Runtime controller state; `CONTRACT.md:16` | Never commit |
| root | `.merge_file_ZPdkGb` | none | EXCLUDE_RUNTIME | Merge leftover; `CONTRACT.md:16` | Do not stage |
| root | `.orchestration/run-20261020b/qa/**` (5 files) | 12 | NEEDS_REVIEW | QA-owned (`LANES.md:51-52`); artifacts themselves unreviewed | Main spot-read, then commit |
| root | `.orchestration/run-20261020b/evidence/**` (lane-03/04/06/07/09/11, lane05) | 05 (dir), authors as named | NEEDS_REVIEW | `gate4` PASS; `lane-11/android-release-signing-gate.md` scoped only to `android/app/build.gradle` (already committed) | Commit only with the code each file evidences |
| root | `BASELINE.md`, `CONTRACT.md`, `LANES.md`, `SUPERVISION.md`, `lane-01..12.md`, `lane-04-ticket-lease-resume.md`, `supervisor-a.md`, `supervisor-b.md` | none (Main/run) | FOREIGN_UNKNOWN | Authored by Main/supervisors, not lane paths | Main-only decision |
| root | `closeout-20261022/{CONTRACT.md,sessions.json,snapshot.cjs,human-production-checklist.md}` | none (Main) | FOREIGN_UNKNOWN | New 10-22 | Main only |
| root | `A08-*`, `NIGHT_DONE.md`, `R15-*`, `R18-*`, `R24-*`, `R25-*`, `STORE_LISTINGS_DRAFT.md`, `WORKLOG.md` | none (10-13..10-19 sessions) | FOREIGN_UNKNOWN | `WORKLOG.md:1-5`, `NIGHT_DONE.md:1-5` name earlier sessions | Separate decision |
| root | `client-handover/release-builds/*.aab` (2), `output.txt` | none | EXCLUDE_RUNTIME | Build output / scratch; `CONTRACT.md:17-18` | Never commit |
| customer | `src/features/menu/**`, `favorites/FavoriteHeart.tsx`, `home/CategoryGrid.tsx`, `shared/components/common/ConsumerRouteTransition.tsx`, `styles.css` + new tests, `menu/utils/*.test.ts` | 03 | NEEDS_REVIEW | None; mtimes 10-13..10-14 except `tests/playwright/ui-a11y-gestures.*` (10-20 19:16) | Own DS+GLM before commit |
| customer | `src/features/addresses/**`, `profile/components/AddressFormModal.tsx` (+2 tests), `routes/addresses.create.tsx`/`profile.addresses.tsx` (+tests), `tests/address-persistence-failures.test.ts`, `tests/order-service-auth-isolation.test.ts` | 01 | NEEDS_REVIEW | None; mtimes 10-13..10-16 | Lane-01 review |
| customer | `payment/hooks/useRazorpayPayment.ts` (+test), `payments/repositories/PaymentRepository.ts`, `payments/components/PaymentRecoveryPanel.test.tsx`, `tests/payment-response-wire.test.ts`, `paid-order-finalization.test.ts`, `server-payment-truth-guards.test.ts` | AMBIGUOUS (01 by `features/**`; 08 owns `routes/payment.tsx` only) | AMBIGUOUS_OWNERSHIP | None; SC-002/SC-012 cover committed fixes, not these bytes | 01-vs-08 handoff, then review |
| customer | `tests/rules/firestore.rules.test.ts` | 07 | NEEDS_REVIEW | +99; `supervisor-b.md:138-141` calls it an older foreign delta | Keep out of rules commits |
| customer | `.github/workflows/{android,ios}-build.yml`, `MAC_INSTRUCTIONS.txt`, `mac-build.sh`, `scripts/patch-ios-spm.js`, `scripts/select-xcode-toolchain.sh`, `scripts/validate-ios-workflow.test.cjs`, `public/.well-known/assetlinks.json` | 11 | NEEDS_REVIEW | `R18:3-7` "no commit"; `WORKLOG.md` items 3-4 | Release-infra bundle |
| customer | `test-results/.last-run.json` | none | EXCLUDE_RUNTIME | Test artifact | Never commit |
| partner | `components/layout/Header.tsx`, `Sidebar.tsx`, `pages/{DeliveryQueuePage,KDSPage}.tsx`, `features/kds/hooks/useKDSRealtimeStream.ts`, `pages/admin/AdminRoutes.tsx`, `features/delivery/hooks/usePorterLogistics.ts` + tests | 02 | NEEDS_REVIEW | None; mtimes 10-13..10-14 | Lane-02 review |
| partner | `src/hooks/useMenu.ts` (+test), `src/pages/MenuPage.tsx`, `tests/partner-menu-seed-honesty-guard.test.ts` | AMBIGUOUS (02 path / 06 content) | AMBIGUOUS_OWNERSHIP | `review-queue.md:28` claim retained, no gate | Owner decision, then DS+GLM |
| partner | `src/services/petpoojaSync.ts`, `tests/petpoojaSync.test.ts` | 06 | NEEDS_REVIEW | `review-queue.md:29` cycle-4 dormant, no evidence | Fresh review |
| partner | `src/index.css`, `tests/playwright/*` | 03 | NEEDS_REVIEW | None; playwright 10-20 19:16 | Lane-03 partner bundle |
| partner | `.github/workflows/ci.yml`, `ios/.../project.pbxproj`, `MAC_INSTRUCTIONS.txt`, `public/.well-known/assetlinks.json`, `scripts/select-xcode-toolchain.sh`, `scripts/validate-ios-workflow.test.cjs` | 11 | NEEDS_REVIEW | `MARKETING_VERSION 1.0 -> 1.0.0`; `WORKLOG.md` item 4 | Lane-11 bundle |
| partner | `tests/partnerops-*.test.ts(x)` | 02 | NEEDS_REVIEW | None; 10-20 | Fold into lane-02 review |
| partner | `test-results/.last-run.json` | none | EXCLUDE_RUNTIME | Test artifact | Never commit |

## COMMITTABLE_NOW bundles

**None.** No dirty/untracked path's *current bytes* carry both an independent DeepSeek review and
a separate GLM verification plus an exact-path gate record.

Nearest miss: the lane-04 seven-path ticket bundle (root). It has a real isolated gate PASS with
byte-equality at gate time (`evidence/lane-04-gate4.txt:1-23`; 892 tests, tsc 0, build 0) and is the
only bundle one review away. Still not committable: `spot-checks.md:357-372` invalidated the review
chain (both "final" reviewers were served by the author's model) and `gate4:44-46` admits the final
delta arrived after review. Needed: fresh DS child, then a separate GLM child, on today's bytes,
then a re-gate. The three committed rules SHAs (`d5f8c0d`/`2f47cef`/`6f81fba`) are the pattern to
copy, not outstanding work.

## Largest NEEDS_REVIEW clusters

1. **Lane 03, customer (~25 paths).** Menu components, gesture CSS, shared primitives, ~5 new test
   files; mostly written 10-13..10-14, before this run. `gate-log.md:9` lists "lane03 follow-up
   gesture/a11y packets" as a candidate, not a completed item.
2. **Lane 01, customer addresses/profile (~10 paths).** 587-line `AddressFormModal.tsx` delta plus
   routes and tests; no review artifact mentions them.
3. **Lane 11, release infrastructure (both repos, ~10 paths).** `R18` says in its header it
   deliberately did not commit; the android signing evidence covers only `android/app/build.gradle`,
   already committed as `593a09f`/`6719ceb`.
4. **Lane 04, root functions (2 clusters).** Gated-but-unreviewed tickets bundle; un-gated F7 hunk.
5. **Lane 07, `unregisterToken.ts`.** Comments claim a review; the only execution evidence on disk
   shows its tests failing against the current implementation.

Why review is missing: `closeout-20261022/` holds no `lane-XX.md` reports yet; supervisor logs stop
at 11:36Z on 10-21; QA spot-checks stop at SC-026 (~15:20Z 10-21); `gate-log.md:7` still lists the
root "lane04 canonical-tip full-bundle gate" as a *next* candidate.

## Honesty note

I committed nothing, staged nothing, and ran no git write command. Every row is an inference from
`git status`/`git log`/`git diff`, mtimes, and the named artifacts — a path appearing in this table
is **not** evidence that it is correct, reviewed, or safe to ship. The ALREADY_COMMITTED claims rest
on `main-ticket-workflow-status.md` plus SHAs read from each repo log; I did not re-verify those
commits' contents. Git emitted only benign LF/CRLF warnings; no command failed.
