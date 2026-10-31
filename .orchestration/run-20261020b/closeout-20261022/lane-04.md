# Lane-04 closeout — dispatch webhook boundary packet (CLOSED this session)

- Queue task `dispatch-boundary-closeout`; original root `ses_ea5c89e34ffeE5jJ0PRSjVSH2k`.
- Commit (local only, never pushed): root **d3f37285aa4e22abd1b1856268625b97d29386a1** on 4b6e4f6, exactly 3 paths:
  - `functions/src/modules/dispatch/dispatch.webhooks.ts` blob 51db3573702f07bc2c1aeb97e2268f8c87d6978a (sha256 0D10309936D9CEE8B7F3C72AE7951D878DC723A1999EBCF271888B41C4A60AE7)
  - `functions/tests/dispatch.webhook-boundary.fresh.test.ts` blob 09f239eb077409c415d5884129e723d0ce86bd17 (sha256 611097CE74C5BB2AD865A853916DE043FCFA1785760EF88799CAA9E3587C9742)
  - `references/delivery_routing.md` blob 122f1e7764a3b4adc60ca92eda3a6ead97df24e6 (sha256 E17C00E20827C8CC533B3E35FF8592F81F489A4D4814E999DFC94962D90524AE)
- Scope honoured: only the packet's three paths; no reimplementation of the committed ticket lease (`5e1777c`) or Porter retirement (`086b60d`); no index/payments/notifications/adapters/apps/rules edits; no index/payments/notifications/adapters/apps/rules edits; foreign dirty files untouched and (exact-path `git add` only); worktree index back to HEAD after the commit.
- Fixed defects (`lane-04-webhook-task.md`):
  1. Stale-map ownership bypass (HIGH): pre-mutation ownership proof against the ORDER's CURRENT `dispatchProvider`/`dispatchOrderId` (rewritten by every book/rebook; the old `dispatch_order_map` row is never deleted) parks HIGH `order_id_conflict` / `order_binding_unproven` incl. the partial-metadata (provider bound, id absent) and both-absent classes; zero order/rider/status/rebook writes and no FCM on a mismatch; numeric/padded ids normalize via regex strip (no float precision loss past 2^53); hint path uses the same normalizer.
  2. Non-sticky containment (HIGH): central needs_review guard consumes every non-DELIVERED canonical event on a contained active booking (no re-arm of `needsRebook`, no state overwrite, no alert); DELIVERED stays exempt; releases only via dispatchBook's fresh rebook-state rewrite; explicitly not transactional (last-write-wins documented; no race claims).
  3. Main's vocabulary decision: `CANCELLED_BY_CUSTOMER`/`RETURNED_TO_SELLER` → existing `needs_review` dispatch state, needsRebook=false, cause in existing `rebookTrigger` (`customer_cancelled`/`returned_to_seller`) + `riderCancellationReason`; NO `order.status` write (no RIDER_CANCELLED stencil); refund/payment fields untouched. Ordinary carrier cancels keep prior behaviour verbatim.
  4. Test fidelity: strict-absent harness (orders included, no defaultOrder fallback), explicit seeds, mislabelled dead-dispatch fixture renamed, duplicate fixture deduped, passthrough tx shim documented as NOT race evidence, positive controls for numeric/padded ids, big-int >2^53 distinction, fresh post-rebook booking, late DISPATCHED/ALLOTTED on a contained booking.
- RED/GREEN (real runs, final test file):
  - RED vs pristine committed 086b60d source: **16 failed / 11 passed (27)** — the original packet's defect pins (F2 rewind, F7 read-side) plus the two HIGH finding groups fail.
  - RED vs frozen v1 packet bytes (442e70d5…e883cc): **12 failed / 15 passed (27)** — only the post-v1 finding groups fail; the packet-fixed pins stay green.
  - Groups separable; no production source was mutated to fake RED (immutably frozen v1 copies + committed checkout in detached worktrees; both cleaned up after runs).
  - GREEN on final bytes: focused 27/27; committed neighbours 53/53.
- Isolated exact-bundle gate (one heavy functions gate, slot released by lane07 before start): detached worktree at current root HEAD **4b6e4f6** + ONLY the 3 owned paths (status showed exactly 2 modified + 1 untracked; hashes MATCH main tree):
  - `npm run typecheck` exit 0
  - `npm test -- --maxWorkers=2` exit 0: 77 files passed | 1 skipped; **939 passed | 2 skipped (941)**, 71.73s
  - `npm run build` exit 0
- Review chain (final bytes only, serving-proven via the local session API `api/session/:id/message`):
  - DeepSeek reviewer `ses_e9edb8e2fffeUTqdlpvixpbn5H`: round-1 VERDICT APPROVE (must-fix empty, findings numbered) on the 04B5F3EA freeze, then round-2 reconfirm VERDICT APPROVE with byte-proven delta reversal (reconstructed hashes reproduce round-1 exactly). Serving: 47/47 assistant rows `deepseek-v4.1-flash-free`, 0 zero-output.
  - GLM verifier `ses_e9ec321cdffeA7C2uhogmtyUVA` (different session AND different model): VERDICT APPROVE, must-fix empty. Serving: 13/13 rows `glm-5.3-flash-free`.
  - DISCLOSED correction: one earlier reviewer call reusing a mixed session (`ses_e9eea71d0ffeJfBUL8fOP0Zx5v`) served glm-5.3-flash-free on all 25 rows — it was NOT a DeepSeek review and is not part of the accepted chain; the run-1 findings it produced were still independently re-derived and applied before the accepted review.
- Evidence files: `.orchestration/run-20261020b/evidence/closeout-lane04-webhook-evidence.md` (hashes, RED/GREEN, gate numbers, serving proofs), `closeout-lane04-red1-v1packet.txt` (round-1 run + LABELED CORRECTION note), `closeout-lane04-webhook-final-green.txt`.
- Residual follow-up (outside the packet's 3 owned paths — router module, not touched): torn-down dispatch paths (`releaseClaimFailed`, `dispatchCancel`, DR8 manual lane) leave stale `dispatchProvider`/`dispatchOrderId` bindings that the webhook's ownership proof cannot distinguish from abandoned bookings; DS finding 2, queued as a router-side test-first follow-up. `needs_review` is shared with the Porter poller staleness path (documented clause in delivery_routing.md).
- No push, no deploy, no vendor/rider/payment call, no secret/PII/credential/provider change, no email.
