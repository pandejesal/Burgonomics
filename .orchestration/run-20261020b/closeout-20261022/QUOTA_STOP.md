# Provider quota hard stop — 2026-10-22

## What happened

The autonomous window ran 00:05:59Z–03:05:59Z. Between **01:48:35Z and 01:52:42Z**
every working session on the two permitted free models failed with the same provider
error:

```
provider.free-limit 429
"Free usage limit reached. Connect a provider or subscribe to OpenCode Go to keep
going, or switch models."
```

This is a **free-tier usage limit**, not a per-model cooldown, and it hit both
`opencode/deepseek-v4.1-flash-free` and `opencode/glm-5.3-flash-free`. There is no
permitted model left to fall back to, and Main did not substitute a paid model,
another provider, a new session or an IP change.

One already-queued handoff (`dispatch-teardown-binding`, root04) was delivered at
**04:28:14Z** and failed with the same free-limit 429, which proves the limit had not
recovered 2.5 hours later. No further retries were attempted.

The window deadline (03:05:59Z) had also expired by the time work could resume.

## Verified state at the stop (2026-10-22T04:34Z)

| Repo | HEAD | Index | Pushed |
|---|---|---|---|
| root | `d3f3728` | empty | never (`origin/ui-sweep` is behind by 127) |
| customer | `6e25a0c` | empty | never |
| partner | `6f81fba` | empty | never |

Controller: `enabled: true`, budget **12/12 deliveries**, decision
`needs_attention` / `continuation_cap_reached`. It will not deliver anything else on
its own, and it has not been reset.

## Commits landed in this window (all local, reviewed, gated)

| Repo | Commit | Packet |
|---|---|---|
| root | `086b60d` | Porter retired by default; direct book/rebook refuse before I/O |
| root | `4b6e4f6` | device-token detach ownership + rebind scrub race |
| root | `d3f3728` | dispatch webhook stale-map ownership + sticky manual-review containment |
| customer | `6e25a0c` | address save/delete honesty, no duplicate submit, account-switch safe |

Accepted in `controller/state.json` only after Main independently re-verified commit
scope, committed blob hashes, gate exit codes and message-level serving models.

## Unfinished packets, exact resumption point

| Owner | Packet | State when quota hit | Next step on resume |
|---|---|---|---|
| root02 `ses_ea5c8a2daffekU3r3U5bPrJspn` | `restaurant-dispatch-choice` | 30/30 focused green, tsc clean, DeepSeek review done, was spawning the GLM verifier | GLM verification → isolated PARTNER gate → commit |
| root07 `ses_ea5c88140ffeqstoAT9sWrRWFE` | `fcm-recipient-ownership` | isolated Functions gate was running at `d3f3728` + 3 frozen paths | finish gate → commit |
| root08 `ses_ea5c87df5ffe7Vjpzr9yv5VLpA` | `customer-payment-truth` | DeepSeek review child in flight | both reviews → customer gate → customer commit + root money-safety-pin commit |
| root05 `ses_ea5c88b2fffeMMzjFL6tYZzs5W` | `references-porter-drift` | mid-edit (was on `verification/7.3.md`) | finish doc edits → reviews → commit |
| root11 `ses_ea5c87669ffeLD1vE6kugwmFVm` | `release-infra-closeout` | DeepSeek review child in flight | both reviews → node suites → per-repo commits |
| root10 `ses_ea5c878abffemS4Xy9icDiSjo8` | `shadowfax-fail-closed-verification` | evidence doc drafted, DeepSeek reviewer reading it | DS + GLM verdicts → finalize doc |
| root12 `ses_ea5c87413ffeBOyHpHeVPuHIoW` | `qa-porter-retirement` | was spawning the DeepSeek reviewer | QA doc |
| root04 `ses_ea5c89e34ffeE5jJ0PRSjVSH2k` | `dispatch-teardown-binding` | handoff delivered 04:28Z, immediate free-limit 429 | not started; brief is frozen and ready |

Their uncommitted work is preserved in the three working trees. Nothing was stashed,
reset, checked out or staged, and no foreign dirty path was touched.

## Ready-to-admit briefs (written, never sent)

- `lane-07-rules-task.md` — R17 tenant/trust-field hardening; the three rules mirrors
  are already byte-identical (`113FA5EA…`); emulator is runnable here (firebase CLI
  15.32.1 + Android Studio JBR 21).
- `lane-06-petpooja-task.md` — production build must refuse writing the demo
  `PP-BRG-*` catalog.
- `lane-03-menu-a11y-task.md` — customer menu availability truth, search races,
  gesture + a11y packet.
- `lane-04-teardown-task.md` — frozen; already described above.
- `lane-11-release-task.md`, `lane-08-payments-task.md`, `lane-10-shadowfax-task.md`,
  `lane-12-qa-porter-task.md`, `lane-05-references-task.md` — the briefs behind the
  packets above.

The explicit-handoff ledger is **6/6 used**; further handoffs need a fresh ledger or
the user's explicit approval.

## To resume

1. Confirm the free tier is available again (one bounded probe, not a retry loop).
2. Re-admit one packet at a time to its existing root session with the same brief;
   the sessions already hold the context.
3. Keep the gate arbitration: one Functions heavy gate at a time (root07 currently
   holds it), Partner gate root02, Customer gate root08.
4. Do not promote any uncommitted work to "done": it is preserved but unreviewed.
