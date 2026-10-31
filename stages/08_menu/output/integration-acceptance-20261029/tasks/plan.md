# Integration verification and bounded repair plan

Status: planning synthesis; all five lane reports must be recorded before app
implementation starts. Read-only source/device preflight is in progress.

## Sequence and ownership

| Slice | Owner/model | Acceptance | Dependencies |
|---|---|---|---|
| A1 Auth challenge races | DeepSeek Free | Deferred-request tests prove one verify/request; cancelled/obsolete completions cannot restore a session | Five-lane plan recorded |
| A2 OTP editing | Same Delivery writer | Middle-digit deletion preserves slots; partial paste starts at focus; disabled/late WebOTP cannot submit | A1; no other Delivery writer |
| B1 Refund decision race | DeepSeek Go | Concurrent rejection has one winner, original decision preserved, branch access remains enforced | Five-lane plan; synthetic DB only |
| B2 Payment attempt binding | Same backend writer | Multi-attempt `order.paid` never transfers a failed/ambiguous payment; no guessed payment id | B1 |
| B3 Fees/tax/86 findings | Same backend writer, parent review | Reproduce before repair; derive policy only from verified config/contracts, refuse unknowns, never invent tax or shipping policy | Inspect actual schema and discount fields first |
| C1 Courier replay | MiniMax NVIDIA | Actual current-source Firestore transactions/native loopback transport; replacement booking survives late callbacks; zero external requests | Backend source frozen for snapshot |
| D1 Rules candidate | GLM Free | Root-source policy imported without overwriting originals; all client roles denied server-owned money writes; missing-scope tokens denied | Confirm exact source differences |
| D2 Rules/Auth emulators | Same lane, isolated harness | Real emulator, synthetic demo project, fail on missing emulator, zero skipped mandatory cases | D1; no shared-db reset |
| E1 Browser contract checks | GLM NVIDIA | Login and payment UI tests distinguish mocked success from real integrations; API shapes/amounts agree | Final source snapshots; dedicated browser contexts |
| P1 Phone update/replay | Parent | Signer/code/current hash verified before data-preserving update; notes/theme persist; award content shown; no order/SMS/payment | Written plan, exact APK verification |

Each coding task is bounded to its named source and regression tests. Agents must
report a proposed extension before touching another lane. Source-review findings
are hypotheses until reproduced: tax percentage versus discounted tax, offline
grace, storage policy and account deletion need particular care.

## Verification contracts

Delivery: focused auth and route tests, then `npx --no-install tsc --noEmit`,
`npx --no-install vitest run --exclude 'tests/rules/**' --maxWorkers=1`, and actual
`npm run build` (mobile build is not web-build proof).

Backend: focused payment/POS/refund cases, then
`npx --no-install tsc --noEmit`,
`npx --no-install vitest run --maxWorkers=1`, `npm run build`, and diff checks.
Existing live wire skips remain explicit, not enabled or counted as acceptance.

Partner: focused auth/role tests; typecheck/unit/build for any changed candidate.
Authenticated operational browser checks require a synthetic emulator identity;
no real operator credentials or native replacement.

Rules/dispatch: use existing cached Java and SDKs, demo project IDs and explicitly
owned loopback ports. Capture exact source closure/hash before execution. Do not
reuse an old snapshot as current proof or run a historical harness unchanged when
its fixtures no longer satisfy the actual contract.

## Threat model / failure handling

Trust boundaries: client→Firebase/Auth, client→payment API, signed provider
callback→server state, server→external vendor, and local persisted session→live
identity. Assets: money, payouts/refunds, outlet isolation, personal data, session
identity and a single physical fulfilment attempt.

Use failing regressions before fixes, transaction/epoch ownership fences, strict
money/identity validation and durable ambiguity parking. Do not weaken tests,
disable security, invent provider success or blindly replay a possibly-sent call.
On failed gates preserve evidence, diagnose, repair only owned files and rerun the
affected gate. No broad reverts or cleanup of unfamiliar files.

## External exits

Live merchant keys/webhook registrations/Route accounts, Petpooja outlet tax and
quantity/add-on semantics, Shadowfax's approved contract, real SMS/App Check/FCM,
release signing/iOS and operator/store approval remain unverified until separately
executed with exact permitted scope. Original release dates remain conditional.
