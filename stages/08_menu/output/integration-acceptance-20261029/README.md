# Integration acceptance — 29 October 2026

This is a new verification/repair run, not a replacement for the launch handoff,
brand packet, or earlier immutable evidence. The owner requested five non-GPT
planning agents, a written plan, then implementation and broad edge-case testing.
The handoff's old planning-only instruction is superseded by that request; its
no-live-operation and evidence requirements still apply.

## Exact candidates

| Candidate | Location under `.swarm-worktrees/` | HEAD |
|---|---|---|
| Delivery | `delivery-launch-ui-20261028` | `7affdf698576110a64e008a492f2d8380abe2d58` |
| Partner | `partner-launch-ui-20261029` | `7374d3e183f7272b91c19749fc192eaddee9e3ae` |
| Backend | `backend-email-contract-20261029` | `31e82c3c415757064e3b33010ade4d2b0d8ebd6f` |

All three contain pre-existing uncommitted work. Do not reset, restore, stash,
reapply old patches, or copy an entire dirty original checkout over them.

## Planning roster

1. DeepSeek Free — Delivery/Partner authentication.
2. DeepSeek OpenCode Go — Razorpay/Petpooja financial and POS contracts.
3. MiniMax M3.1 Flash NVIDIA — Borzo/Shadowfax and actual-emulator replay.
4. GLM 5.3 Flash Free — Firebase rules/claims/App Check/FCM.
5. GLM 5.3 Flash NVIDIA — cross-app contracts, other integrations and acceptance.

The server restart initially produced empty reports. Those are not completed
plans or test runs. Same-session recovery is recorded separately from execution.

## Evidence levels and boundaries

Source review, hermetic unit tests, actual local emulator, browser, bundled native
app, merchant sandbox, operator acceptance and deployed production are separate
levels. No finite matrix proves every possible edge case.

- Local synthetic fixtures only for account creation, OTP, payment, refund, POS,
  dispatch and push acceptance. No real SMS, charges, transfers, refunds, tickets,
  courier bookings/cancellations, push sends, deployments or store submissions.
- Phone `RZCX51TXRKB` is confirmed online. Parent exclusively owns mobile control.
  Only a compatible Delivery debug replacement with data preserved is allowed;
  never clear/uninstall/downgrade or replace Partner.
- No credentials or private customer data in files, console reports or artifacts.
- Root `firestore.rules` is the configured deployment **source**, not evidence of
  what is currently deployed. New rules repairs belong in an isolated candidate;
  original dirty source/mirrors must not be overwritten.
- Keep D31–D33: no loyalty migration, no deletion of Grill Coins history, and no
  duplicate app-generated bills into Reelo.

## Outputs

See `tasks/plan.md` and `tasks/todo.md`; per-lane reports, fingerprints, exact
commands/results, skips, blocked cases and native artifacts are added as verified.
