# Existing session follow-up: close the address server-truth debt

Queue task: `customer-address-server-truth`. Owner: original root01
`ses_ea5c8a548ffex6hMqeB90XmuF0` (DeepSeek V4.1 Flash Free). No replacement writer.
This continues the packet you closed as `6e25a0c`; do not reopen the committed nine
paths unless a real defect requires it, and do not redo the completed review chain.

## The debt you recorded (now the packet)

Your own evidence `closeout-20261022/lane-01.md` lists four honest limits. Three are
real product gaps and one is an uncommitted test you wrote. Close them:

1. **Server addresses are device-local.** `AddressRepository.list()` serves the locally
   persisted store, and `addressService.list()` (the Firestore read) has **no call
   site**, so after a login on a new device the customer's saved addresses are not
   seeded back from the server. Add the seed path: hydrate the local store from
   `addressService.list()` for the authenticated uid, without overwriting unsynced
   local writes, without resurrecting a deleted address, and without leaking one
   account's addresses into another after an account switch on the same device.
2. **Deleting the default promotes a new local default without mirroring it to the
   server.** Either mirror the promotion server-side or do not present the promoted
   address as the server default until the write confirms. No false "default" state.
3. **`/addresses/create` failure UX.** `src/features/addresses/components/AddressForm.tsx`
   handles its own errors; read it, prove it, and add the missing coverage. If it is
   already correct, say so and commit only the test.
4. **`AddressFormModal.a11y.test.tsx` is untracked and outside the last commit.**
   Adopt it only if it passes against the committed component; otherwise fix or report
   it. Do not stage a failing test.

A missing read-back is not a false success — but "saved addresses vanish on a new
device" is a real customer-facing defect. Treat it as one.

## Exact sole-writer scope (CUSTOMER repo)

- `src/features/addresses/repositories/AddressRepository.ts`
- `src/features/addresses/services/addressService.ts`
- `src/features/addresses/components/AddressForm.tsx` (and its existing test if needed)
- `src/routes/profile.addresses.tsx`
- `src/routes/addresses.create.tsx` (only if the route, not the form, owns a failure)
- `tests/address-persistence-failures.test.ts`
- `src/features/profile/components/AddressFormModal.a11y.test.tsx` (adopt only if green)
- Evidence `closeout-20261022/lane-01-address-debt.md`

OUT of scope: `src/shared/**` (lane 03 owns it), menu, payment, notifications, rules,
Functions, partner repo, native. Preserve every foreign dirty path — the customer tree
has an active payments owner (lane 08) and ~40 other dirty entries.

## Required proof

- New device / fresh login: server addresses seed into the list; an offline or failed
  read leaves the local list intact and shows no false empty state.
- Account switch A → B on one device: B never sees A's addresses, and A's cache is not
  written into B's store.
- Delete the default: the promotion is either server-confirmed or explicitly labelled
  pending; a failed mirror write does not leave a false server-default claim.
- `/addresses/create` failure: no navigation, no success toast, input retained,
  accessible error.
- These must be RED over the committed `6e25a0c` bytes where they describe the new
  behaviour, then GREEN on your candidate. Do not weaken an existing test.

## Reviews, gate, commit

Freeze final bytes with immutable copies + Git blobs + SHA256; prove RED/GREEN.
ONE fresh read-only actual DeepSeek Free reviewer, THEN a DIFFERENT fresh read-only
actual GLM Free verifier; verify actual serving models through the local session API;
reviewers write nothing and spawn no children. On 429/transport stop and report.

CUSTOMER heavy-gate slot: **yours first** (your packet is small). Isolate at the
current customer HEAD plus only your reviewed paths and run
`npx --no-install tsc --noEmit`, `npm test -- --maxWorkers=2`, `npm run build`.
Post `GATE START` / `GATE END` on `fresh-run-2-coordination`; lane 03 is waiting for
that slot and must not start until you post END. Then commit only your reviewed paths
locally, verify committed blobs, never push/deploy.

Report `QUEUE_TASK: customer-address-server-truth` with the commit (or BLOCKED), which
of the four debts you closed vs left open and why, hashes, RED/GREEN counts, review IDs
+ actual models, and gate exits. End with the exact unquoted final line
`SUPERVISOR_STATE: COMPLETE` only when the packet is really closed.
