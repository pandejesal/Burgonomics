# Main acceptance: ticket workflow rules

Status: ACCEPTED by Main after independent review and exact-bundle gates.
Truth label: LOCAL CODE VERIFIED only. No deployment, provider test, live data,
native-device E2E, or push is claimed.

## Local commits

| Packet | Repository | Commit | Exact scope |
|---|---|---|---|
| B, prerequisite | customer | `8123bbc411176dea3d8bf79bc38520f93a17ac1b` | `tests/payments-contract.test.ts` |
| A | root | `d5f8c0dee2c8f23ec4ebc5c199d461a6087fca1d` | `firestore.rules`, `references/ticketing.md` |
| A | customer | `2f47cef1dd9d9b7696898c3c502051df22b7dc2f` | `firestore.rules`, `tests/rules/ticket-resolution-lease.rules.test.ts` |
| A | partner | `6f81fbafa4ba907d8c6cd770a6f332ebd6222af2` | `firestore.rules` |

All three A commits contain rules blob
`32238e8b1a46eb84622cbfcf20cdc124a060d963` (38,313 bytes), SHA256
`a59226fc8833b0c0b80fc17f7c48f5053231d6d6740435bd39c6f96659691b10`.
The R17 users-field additions remain unstaged, exactly 2 insertions/2 deletions
in each working rules copy. Each real index was empty after the filtered commit.

## What changed

- Terminal tickets cannot be reopened, reassigned, or have resolution text rewritten
  by a client. The shared helper covers both roles and both ticket collections.
- Existing money-audit maps cannot become client strings, including on inconsistent
  nonterminal documents. Tests check every field, nested refund data, and timestamps.
- Timeline/updatedAt replies remain possible. This does not enforce append-only history.
- Comments and the reference now describe committed backend truth: a resolution lease
  was not present at the cited backend revision. Unknown-field denial is defence in depth.
- Packet B adopts the existing test-only correction for the already-committed,
  read-only `markPaymentFailed` contract. No production payment implementation changed.

## Independent review

1. DeepSeek: `ses_ea0ea7f1fffeZ2HBINJSWgDln5`, both packets APPROVE.
2. Separate GLM: `ses_ea0a81b8fffeIodADuKguUl1My`, both packets APPROVE.

API assistant records: 35/35 DeepSeek and 32/32 GLM, zero model mismatches.
Review covered the frozen v2 files, not dirty working copies. Snapshot directory:
`C:/Users/DELL/AppData/Local/Temp/opencode/main-ticket-workflow-v2/`.

## Gates and negative controls

| Isolated bundle | Results |
|---|---|
| B: customer `2aa9809` + one test file | typecheck 0; 83 files / 538 unit tests passed; build 0 |
| A: customer `8123bbc` + only rules/test | 4 files / 108 rules tests passed; typecheck 0; 83 files / 538 unit tests passed; build 0 |
| A: partner `050a4de` + only rules | typecheck 0; 84 files / 544 tests passed, 1 skipped; build 0 |

Final-step exit records and logs: `B-*.json/log`, `A-*.json/log`, `P-*.json/log`
in the v2 snapshot directory. Partner tests required the existing sibling DOM
dependency and six existing public Firebase client settings, reused in-memory only;
no setting values were printed and no dummy keys or credential changes were made.

The same final rules test file against pristine committed rules produced 6 failed /
102 passed: the six terminal writes unexpectedly succeeded. Removing the stored-map
guard in an emulator-only mutation produced 1 failed / 107 passed, precisely the
nonterminal money-map overwrite. These negative controls are retained in the v1 logs.
The stale payment assertion separately failed on a pristine base (1 failed / 10 passed).

Interrupted runs, wrapper timeouts, and the initial Partner harness failures remain
in their logs and are not counted as successful gates. The successful A rules retry
captured exit 0 for the complete command; later steps also have explicit exit records.

## Remaining work

The backend ticket-resolution lease is still a separate, unfinished packet. This
acceptance does not certify its uncommitted implementation, concurrency behavior,
deployment, or any refund/provider effect. Next work must resume that existing
packet with fresh exact-byte DS then GLM review, not redo the completed customer
typecheck, scroll, or Android signing fixes.
