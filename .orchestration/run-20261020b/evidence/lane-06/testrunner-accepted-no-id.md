# Lane 06 evidence — partner test-runner accepted-without-id honesty fix (2026-10-20)

## Defect
`burgonomics-partner/src/features/orders/services/petpoojaTestRunnerService.ts:62`
(pre-fix) — `defaultTestScenarioRunner` threw `Test runner returned no Petpooja
Order ID.` whenever `petpoojaOrderId` was absent/null.

Server contract (functions/src/modules/petpooja/testRunner.ts, committed):
200 + `{ success:true, petpoojaOrderId: string|null, petpoojaOrderIdReturned }`.
`petpoojaOrderId:null` on 200 = POS ACCEPTED without returning an id. Live
sandbox norm (references/petpooja_save_order_api.md §16.8/§19.2): all five
relayed scenarios were saved by the POS with empty `orderID`; the Order List
shows them as RECEIVED (0/5 fulfilment verified, separate issue).

Effect pre-fix: every POS-accepted id-less relay rendered as `Failed` in the
partner test-runner modal — the false negative the functions side already
removed (§16.8 list item 3), still alive on the partner side.

## Repro (failing tests BEFORE fix)
`npx vitest run src/features/orders/services/petpoojaTestRunnerService.test.ts`
→ 14 tests, 4 failed:
1. "does NOT throw on the documented accepted-without-id response (petpoojaOrderId null)"
2. "does NOT throw when the legacy field is simply absent but success is true"
3. "still throws when the relay is reported as not accepted (success !== true)" (message parity)
4. "still throws on an empty/unexpected body (fail-closed)" (message parity)

## Fix (owned files only)
- `defaultTestScenarioRunner` returns `{ petpoojaOrderId: null }` on an
  accepted-no-id body; throws on: no body, `success:false` (even with an id
  string present), unknown shape, transport error. `TestScenarioRunner`
  widened to `petpoojaOrderId: string | null`.
- `runAllPetpoojaTestScenarios` marks accepted-no-id as `Fulfilled` with null
  id; `formatPetpoojaIdsForCopy` excludes null ids (copy list never invents).
- No new status string; `PetpoojaTestRunnerModal.tsx` (lane-02 file) untouched.

## After fix
- Same test file: 15/15 passed.
- Partner full src suite: 27 files / 183 tests passed.
- `npm run typecheck` (tsc --noEmit): clean.

## Out of scope (proposals)
- `src/services/partnerFunctionsApi.ts:319` type says `petpoojaOrderId: string`
  — should be `string | null` to match the server (lane-02 path, proposal only).
- Modal toast currently counts accepted-no-id as "fulfilled" — lane-02 copy
  decision; service-level truth is fixed first.
