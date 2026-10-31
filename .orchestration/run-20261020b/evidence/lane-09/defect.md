# Lane 09 — Borzo book-time ambiguity + contact phone (evidence)

Session: ses_ea5c87a64ffecPa7h3J8Zxpw6h · model opencode/deepseek-v4.1-flash-free · parentID=null
Repo: root `C:/Users/DELL/Desktop/Burgonomics` · base HEAD at start: `4be553b`
Owned paths (claimed on fresh-run-2-ownership): borzo.adapter.ts, dispatch.borzo-duplicate-book.test.ts (adopted untracked), dispatch.borzo-contact-phone.test.ts (new), this evidence dir.

## Provenance / adoption

The retired team left `functions/src/modules/dispatch/providers/borzo.adapter.ts` dirty (+36/−2:
duplicate guard, no-id ambiguity) and `functions/tests/dispatch.borzo-duplicate-book.test.ts`
untracked, with a GATE START but no GATE END and no commit. This lane adopts those bytes (no
reset/stash), verifies them, and closes two holes they did not cover.

## Defect 1 (HIGH) — duplicate signal carrying an order id walked to a second courier

At the adopted bytes the guard was `if (providerOrderId === null) { …duplicate… }`. Any
`order_is_duplicate` response that ALSO named an order id skipped the guard, reached
`assertBorzoResponse`, and `classifyBorzoError` mapped the code to `transient` (it is deliberately
NOT in `BORZO_NOT_SERVICED_CODES`). `dispatch.router.ts:628-648` treats a `ProviderDispatchError`
as walkable (`continue`), so the next provider is booked while Borzo may already hold the order.

The file's own comment claimed an id-carrying duplicate "binds truthfully below" — true only when
`is_successful !== false`. With `is_successful: false` it walked.

Failing repro (before fix), `functions` cwd:

    npx vitest run tests/dispatch.borzo-duplicate-book.test.ts
    × a duplicate that ALSO names an order id and is NOT a success is a plain AMBIGUOUS 502 (no walk)
    × a 200 is_successful:false body naming an order id is ALSO AMBIGUOUS, not a walkable fault)
    AssertionError: expected 'ProviderDispatchError' not to be 'ProviderDispatchError'

Fix: the guard keys on the duplicate CODE + `accepted = res.ok && is_successful !== false`
instead of on a missing id; a non-success body that names an order-scoped id is ambiguous for the
same reason. Ambiguity is a plain Error (`code: PROVIDER_BOOK_AMBIGUOUS`, 502, no `kind`) so the
router cannot fail over. Duplicate-ECHO that IS a success still binds (positive control preserved).

## Defect 2 (MEDIUM) — silent phone truncation fabricated a contact

`borzoPhone` returned `digits.slice(0, 12)` for every input of 12+ digits. `"+91 098250 12345"`
(13 digits) became `910982501234` — a different, plausible recipient sent to Borzo on live
quote/create calls. Fix: exact 10/11/12-digit forms normalise; anything longer returns `null`
(quote omits the key; book fails closed before the network call).

## Post-fix local results (dirty tree, LOCAL CODE VERIFIED)

    npx vitest run tests/dispatch.borzo-duplicate-book.test.ts tests/dispatch.borzo-contact-phone.test.ts
    Test Files 2 passed (2) | Tests 24 passed (24)
    npx vitest run dispatch
    Test Files 10 passed | 1 skipped (11) | Tests 190 passed | 2 skipped (192)
    npx tsc --noEmit  -> exit 0

## Independent review + verification trail

1. DS #1 (ses_ea536b50cffercwExAGihAlqNQ, model verified `opencode/deepseek-v4.1-flash-free`
   in the session record): APPROVING-WITH-RESIDUALS, claims A–D TRUE; residuals applied.
2. GLM #1 (ses_ea4b7b533ffewXZQD54jXfk2C3, `opencode/glm-5.3-flash-free`):
   VERIFIED-WITH-RESIDUALS; falsified one shape — a create-order abort/timeout (no response) was
   classified transient and still walked.
3. DS #2 (ses_ea4ad6c22ffe8Kn5kLG6OdryVf): APPROVING-WITH-RESIDUALS on the timeout delta; comment
   honesty + test realism applied; socket-loss and string-proxy concerns routed out of grant.
4. GLM #2 (ses_ea49fa2eaffeev5DdwFxQSN3lU): VERIFIED-WITH-RESIDUALS, "safe to gate and commit
   as-is"; its cheap in-grant residual (12-digit value must start with 91) applied after.

## Isolated exact-bundle gate (root/functions)

Detached worktree `Temp/opencode/lane09-ses_ea5c87a64ffecPa7h3J8Zxpw6h/borzo-wt` at root HEAD
`70a09be` + only the 3 changed paths (node_modules junction, no installs, no shared-index
mutation, no stash). Byte-identical to the committed blobs (SHA256 checked per file).

    npx tsc --noEmit          -> exit 0
    npx vitest run            -> 70 files passed / 1 skipped; 846 tests passed / 2 skipped
    npm run build             -> exit 0

## Commit

`b4d43ed` on `ui-sweep` — exactly 3 files, +828/−13 (adapter +118/−13, both new test files).
Local only, NOT pushed. Post-commit re-run of the two suites: 27/27.

## Routed out-of-grant residuals (not fixed here)

- `providers/shared.ts:42-46,74-76` — `classifyThrown` discards `name`/`cause`, so a post-send
  socket loss (UND_ERR_SOCKET/ECONNRESET) is still classified transient and walks; a stalled
  pre-send handshake aborts as "timeout" and is (safely) called ambiguous. Fix belongs in
  shared.ts (structured abort reason) -> lane 04.
- `dispatch.router.ts:191-219,615-649,949-953` — after any plain ambiguity error the router writes
  `dispatchStatus: "dispatch_failed"`, `needsRebook: true`, and records no attempt for the
  provider, so the auto-rebook worker / staff rebook can re-enter and book a different provider.
  The ambiguity is not durable and no reconciliation handle is persisted -> lane 04.
- `providers/shadowfax.adapter.ts:202` — `contactDigits` slices the last 10 digits, silently
  truncating garbage into a plausible recipient (same class this commit removes from Borzo);
  its error class for a missing contact is also inconsistent with Borzo's -> lane 10.

## Post-guard re-verification (QA 21:36Z provenance rule)

DS #1 ran 19:28Z, before Main's 21:29Z guard ruling, so the chain was re-run on the COMMITTED bytes:

| role | child | model (session_v2) | parent | verdict |
|---|---|---|---|---|
| DS (post-guard) | `ses_ea4360f75ffePYenmUjZmFdRFq` | `opencode/deepseek-v4.1-flash-free` | this root | APPROVING-WITH-RESIDUALS |
| GLM (post-guard) | `ses_ea41b865effejM9SSbM9j3G5lr` | `opencode/glm-5.3-flash-free` | this root | VERIFIED |

GLM demonstrated discrimination dynamically: the committed suites run against the pre-commit adapter
score **14 failed / 13 passed**, against the commit **27/27**. Dispatch suite 210 passed / 1 skipped
file, `tsc --noEmit` exit 0 at the time of the run.

### CORRECTION to the commit message (scope honesty)

`b4d43ed` says "never walk to a second courier". Literally that is false beyond a single
`dispatchBook` invocation. Guaranteed: no SYNCHRONOUS failover inside one `book()` call for the
covered shapes. NOT guaranteed: the 5-minute auto-rebook worker (see N1) and 5xx/HTML/reset
responses with no id evidence (N2/N3), which still walk.

### Additional routed residuals (lane 04, policy-level)

- N1 (MED): ambiguity is not durable — router records no attempt/provider, so a later rebook can
  book a different provider. Fix: ambiguity-specific release (`needs_reconciliation`,
  `needsRebook: false`, persisted `client_order_id`).
- N2 (MED): create-order 5xx/HTML with no id walks. Both reviewers agree a blanket
  "5xx => ambiguous" rule would destroy legitimate outage failover; the fix is the N1 policy, not
  another adapter guard. Note the dangerous sub-case (5xx body carrying an id or duplicate code)
  IS already ambiguous, because those guards are status-independent.
- N3 (LOW, new): post-connect reset (`ECONNRESET`/"socket hang up") carries no abort token, so it
  still walks — same undecidability family; needs shared.ts structured abort reasons or a
  provider-side `client_order_id` reconciliation sweep.
- LOW, recorded not fixed: exact-string duplicate matching; `res.data.id` bind/ambiguity asymmetry;
  12-digit `91`+trunk-0 pass-through (caller-supplied, we do not fabricate it); one stray `)` in a
  test title.

## Labels

LOCAL CODE VERIFIED (tests/typecheck/build on the exact committed bundle above). No Borzo sandbox
call, no booking, no credentials. `BORZO_WEBHOOK_SECRET`, callback registration and a no-real-rider
guarantee remain external blockers (not exercised here).
