# Checkout / Guest OTP — reCAPTCHA Ownership & Challenge Contract (REVISED 4)
> **STATUS: REVISED_DRAFT_NEEDS_REVIEW — design only. No source/test/config/Auth change; no SMS/OTP sent.**
> Base: `polish-core-20261025` @ `038dff8`. Fifth revision after REVISE #4 (stale-resolve ordering). Task `T2.4-CAPTCHA`. One future auth writer lands all caller changes atomically; the trust coder keeps checkout/receipt/payment/FulfillmentCard only (copy work DONE, read-only accepted).
## 1. Decision
Bindings are keyed by **DOM host identity per logical flow**, never by "the active one"; every request/verify carries the flow plus an **opaque challenge handle**; unmount clears only its own verifier identity; every attempt is bounded at 60s with honest unknown-outcome copy; adoption and the store commit require the **same intent epoch** captured at request/verify entry, and a late SDK completion is cleaned up only by reference to the exact stale user instance. Delivery stays Firebase SMS; `deliveryMethod` remains a compatibility parameter and is never an instruction.

**Closed decisions (do not reopen):** Firebase SMS is the only transport; the web SDK stays inside the Capacitor WebView with **no** native auth plugin (real-device proof is a manual release blocker); `deliveryMethod` keeps its signature but every new request is SMS and the value is never forwarded. Q1/Q2/Q3 are decided; the only remaining limits are manual verification, not product questions.

## 2. Identity model (F1)
- `HostId` = per-instance `useId()` token; `FlowId` = `"login" | "otp" | "checkout"`. **Binding owner** = `FlowId`, at most one connected host per flow. **Challenge owner** = the `FlowId` recorded at issue. `ChallengeHandle` = `crypto.randomUUID()` with a `getRandomValues` fallback; it is app-scoped, opaque, **never placed in a URL**, and is not a private SDK token. iOS 15 `randomUUID` runtime is unverified; the fallback is declared, not proven.
- No `lastActiveHost`, no `document.getElementById`, no "first ready binding". If flow B requests while A is mounted, B's element is used; A is untouched.
- **Route transfer is explicit**: `/auth/otp` reads `handle` from the store and calls `adoptChallenge("otp", handle)`. Without adoption `verifyOtp("otp", handle, code)` → `CHALLENGE_MISMATCH`; with it the unmounted PhoneLogin host does not brick the screen. **Sheet close/reopen is resume, not re-request**: `{isOpen && …}` unmounts the host on close, so a reopen binds a new `hostId` against `none`, then `resumeChallenge("checkout")` restores `step="otp"` by flow/handle — no network, no second SMS.
- `logout` / `changePhone` / `userReset` call `invalidateAuthAttempts(reason)`: bump `intentEpoch` even when no new request is issued, clear handle + challenge, release only attempt refs, keep any in-flight lock until settle/deadline.

## 3. Verified current state (read-only trace)
| Fact | Evidence |
|---|---|
| Module singletons `recaptchaVerifier`/`confirmationResult`; `window.recaptchaVerifier` (no reader) | `authService.ts:23-24,63,229-234` |
| Default id; unconditional clear; lazy init hardcodes it; `render()` rejection swallowed | `authService.ts:38,46-53,88-104` |
| `size:"normal"` fixed; expired only warns; only transport `signInWithPhoneNumber`; `deliveryMethod` echoed | `authService.ts:54-62,106-113` |
| Raw errors to logger and `console`; `error.message` returned by request/verify/refresh | `authService.ts:65,117,128-131,181,190-193,213` |
| `verifyOtp` depends on the global; `otpToken` is the phone | `authService.ts:110,136-145` |
| Duplicate static containers; OTP route re-inits/clears | `__root.tsx:297`, `auth.otp.tsx:69-74,199`, `PhoneLoginForm.tsx:139` |
| Sheet has no host, portals `z-[70]`; passes `"whatsapp"`; local `step` | `QuickAuthSheet.tsx:21,60,108-117,237-238` |
| Store copies the service message into `state.error`; challenge drops `expiresInSec`; `logout` leaves the module result alive | `authStore.ts:259,286,262-272,334-363` vs `authService.ts:24` |
| No observer writes the store (only the 3s `profileService.me()` one-shot + `authStateReady` reads); `useFirebaseAuth` effect dead; `StrictMode` on; no `connectAuthEmulator` in `src`; CSP allows Google/Firebase frames | `profileService.ts:139-152`, `authStore.ts:78,179-206`, `authService.ts:202`, `useFirebaseAuth.ts:22-27`, `boot.tsx:20-26`, `firebase.ts:63-67`, `index.html:14-15` |

SDK (12.16.0, `index-DBOuNQej.js`): element or id (`:8795-8799`); visible verifier needs an **empty** container (`:8879-8882`); `clear()` destroys/empties and throws if destroyed (`:8869-8877,8898-8899`); `render()` idempotent per instance (`:8850-8857`); emulator sets `appVerificationDisabledForTesting` (`:3899`) → mock loader (`:8721-8726`); **`MockWidget` writes no DOM** (`:3405-3426,3440-3468`). `RecaptchaParameters` is untyped (`auth-public.d.ts:2932-2934`), so `compact` is pass-through only.

## 4. State machines
**Binding (per flow).** `none | ready{hostId, element, verifier, size} | dirty{hostId, element, reason}`
| From | Event | To | Rule |
|---|---|---|---|
| none | `bindHost(flow, hostId, el)` | ready | construct with measured size |
| ready/dirty | `bindHost(flow, same hostId)` | unchanged | idempotent (StrictMode); re-arm only on request |
| ready/dirty | `bindHost(flow, other hostId)` | unchanged | `HOST_CONFLICT` — never overwrite a still-connected host |
| no entry for flow | `requestOtp(flow)` | — | `RECAPTCHA_NOT_BOUND` |
| none/ready/dirty | `releaseHost(same/other)` | none / unchanged | none: no-op; same: null ref first, then `clear()` only when not destroyed (try/catch); other: no-op |
| dirty | `requestOtp(same flow)` | ready | null ref → clear-if-needed → require `childNodes.length===0` → construct on the **same element** |
| any | late `expired-callback` | unchanged | only if `entry.verifier===captured && entry.hostId===captured` |

If `childNodes.length!==0` after clear, the host replaces its child node before construction. StrictMode counts **per verifier instance**: `constructs − clears === 1` while mounted.

**Attempt (one active process-wide, to prevent a second SMS).** `idle | requesting{flow,gen,epoch,phone,deadlineAt} | issued{flow,handle,phone,gen,epoch,issuedAt} | unknown{flow,gen,epoch,phone}`
| From | Event | To | Rule |
|---|---|---|---|
| idle | `requestOtp(flow)` | requesting | needs a binding; lock until settle **or** 60s |
| requesting | any `requestOtp` | requesting | `AUTH_OTP_IN_FLIGHT` |
| requesting | resolve gen+epoch current | issued | store handle+flow+phone+`displayExpiresAt` |
| requesting | resolve for gen/epoch ≠ the live attempt | unchanged | ignore that completion (older attempt); current request untouched; orphan guard §4.1 |
| requesting | failure | idle | `dirty(flow)`; authored code |
| requesting | deadline | unknown | "We couldn't confirm this request. A code may arrive; request a new code to continue."; bump `gen` so the old result is unusable; lock opens |
| idle/unknown | resolve any | unchanged | defensive discard, log `{code}` only, no state |
| unknown | `requestOtp(flow)` | requesting | allowed after the deadline (hand lock already open); a late resolve of the old attempt still cannot overwrite |
| issued(X) | `requestOtp(Y≠X)` | issued | `CHALLENGE_ACTIVE_OTHER_FLOW` + `{flow, maskedPhone, handle}` |
| issued(X) | `requestOtp(X)` / `resendOtp(X)` | requesting | only after `resendAfterSec` from `issuedAt`; supersedes the handle (old handle → `CHALLENGE_MISMATCH`); exactly one `signInWithPhoneNumber` |
| verifying | `requestOtp(flow)` / `resendOtp(flow)` | verifying | `AUTH_OTP_IN_FLIGHT` — one attempt process-wide; UI must surface it, no second SDK call |
| issued | `adoptChallenge(Z, handle)` | issued(Z) | same epoch, `Z` mounted, no newer accepted op → transfer; else `CHALLENGE_MISMATCH`/`STALE_EPOCH` |
| issued | `verifyOtp` entry | verifying | gen+epoch match required; else stays `issued` + `CHALLENGE_MISMATCH` |
| verifying | completion **and** store commit | idle | both re-check gen+epoch; any mismatch → no auth + orphan guard |
| issued | SDK `auth/code-expired` | idle | `dirty`, `step="phone"`, busy false |
| any | `invalidateAuthAttempts(reason)` | idle | bump `intentEpoch`; exits `issued`/`unknown`; lock until settle/deadline |

`AUTH_REQUEST_DEADLINE_MS = AUTH_VERIFY_DEADLINE_MS = 60_000`. `displayExpiresAt = issuedAt + 300_000` is a **display heuristic, never provider truth**; `auth/code-expired` is authoritative. No abort, cancellation, or exactly-once SMS is claimed.

**4.1 Late auth: epoch gate + guarded cleanup (G3).**
- `intentEpoch` is bumped by every `invalidateAuthAttempts`, even with no new request; captured at request and verify entry; re-checked after `confirm()` **and again after `persistSession`** before `set({status:"authenticated"})`. On failure, `clearPersistedSession()` and no app auth.
- Source fact: `confirm()` → `signInWithCredential` (`:8963-8971,9015`), which installs and persists `currentUser` before `confirm()` resolves, regardless of our store decision. App-rejection alone is **not** logout; never describe it as one.
- Cleanup: capture the exact `userCredential.user` instance. Only if `auth.currentUser === staleInstance` **and** the epoch is still invalid **and** no newer accepted operation exists, call `signOut()` once, re-checking identity immediately before. If identity differs, never sign out. No retry loop. A new verify may start only when the SDK holds no orphan user (or the guarded cleanup has run), so two auth operations never overlap blindly.
- Residual hard limit: `signOut` has no atomic compare-and-swap, so a same-tick newer sign-in race is not provable. On failure, quarantine: stay `guest`, persist a `quarantinedUid` marker in `secureStorage` (uid only, never phone), and surface one explicit "Sign out of the unfinished session" action that re-checks identity. At bootstrap, if the SDK holds a user while no persisted session exists (or the uid mismatches), stay `guest` and expose the same action — never auto-`signOut` there, because the stale instance reference is gone after reload; bootstrap already requires persisted tokens + uid match (`authStore.ts:179-206`) and never hydrates from SDK alone. Multi-tab/device proof is a **manual release blocker**.
- Never purge cart/payment/profile caches; clear only attempt refs. Never auto-auth after explicit logout. "Do nothing" is not treated as cleanup.

## 5. API contract and caller catalogue
```ts
type AuthFlowId = "login" | "otp" | "checkout";
type HostId = string;  type ChallengeHandle = string;   // opaque app id, never in a URL
bindHost(flow, hostId, element, measure?): { ok: true; size: "normal"|"compact" } | { ok: false; code: HostFailure };
releaseHost(flow, hostId): void;
requestOtp(flow, phone, deliveryMethod?, otpToken?): Promise<ApiResult<RequestOtpResponse>>;
resendOtp(flow: AuthFlowId): Promise<ApiResult<RequestOtpResponse>>;   // flow = currently mounted surface
verifyOtp(flow, handle, code): Promise<ApiResult<VerifyOtpResponse>>;
adoptChallenge(toFlow, handle): { ok: true } | { ok: false; code: "CHALLENGE_MISMATCH" | "STALE_EPOCH" };
resumeChallenge(flow): IssuedView | null;                               // no network
invalidateAuthAttempts(reason: "logout"|"changePhone"|"userReset"): void; // bumps intentEpoch
// HostFailure: HOST_CONFLICT|RECAPTCHA_NOT_BOUND|RECAPTCHA_CONTAINER_NOT_READY|RECAPTCHA_RENDER_FAILED
// Attempt: AUTH_OTP_IN_FLIGHT|CHALLENGE_ACTIVE_OTHER_FLOW{flow,maskedPhone,handle}|CHALLENGE_MISMATCH|STALE_EPOCH|AUTH_LAST_ATTEMPT_UNKNOWN
```
The earlier "surface unchanged" claim is withdrawn: the leading `flow` (and `handle` on verify) is a breaking change to `AuthRepository`, `authStore`, `useFirebaseAuth`, and every call site, landed atomically.

| Caller | Now | Revised |
|---|---|---|
| `auth.login.tsx:51` | `requestOtp(sanitized,"sms")` | `requestOtp("login", sanitized, "sms")` |
| `auth.otp.tsx:69-79` | `verifyOtp(value)` | `adoptChallenge("otp", handle)` on mount; `verifyOtp("otp", handle, value)` |
| `auth.otp.tsx:92-95` | `resendOtp()` | `resendOtp("otp")` — current mounted flow, **not** `challenge.flow` |
| `QuickAuthSheet.tsx:60,84` | `requestOtp(…,"whatsapp")`, `verifyOtp(otp)` | `requestOtp("checkout", …, "sms")`, `verifyOtp("checkout", handle, otp)` |
| `authStore.ts:257,284,313-324` | repo(phone,dm), repo(otpToken,code), requestOtp(challenge.phone, challenge.deliveryMethod) | repo(flow,phone,dm), repo(flow,handle,code), `resendOtp(flow)` delegates |
| `AuthRepository.ts:18-24`, `useFirebaseAuth.ts:30,53` | 3-arg / 2-arg | leading `flow` (`+handle`) passthrough; add a `resendOtp(flow)` passthrough (no exception to the single entry point) |

`resendOtp` ownership: the **attempt layer** owns it — it reads the active attempt's `phone` and `issuedAt`, enforces `resendAfterSec` itself (not the UI countdown), supersedes the handle and issues exactly one SMS. `authStore.resendOtp(flow)` is a thin delegator; `auth.otp.tsx:92-95` passes the currently mounted flow. A reused solved-widget token is unproven, so at most one `dirty` re-arm is allowed and no double SMS.

`deliveryMethod` compatibility: accepted, never forwarded, response always reports `"sms"`; a legacy cached `"whatsapp"` is normalized to `"sms"` on resend. No WhatsApp path is claimed.

## 6. Redaction (F5, corrected diagnosis)
The logger console sink is **dev-only** (`logger.ts:62,65`); production `logger.error` writes nowhere. Real production leaks are direct `console.*` with raw values and raw provider text returned to callers.
| Site | Leak | Fix |
|---|---|---|
| `authService.ts:117,190,65,181` | raw error objects to a sink or `console` | `logger.error(msg, undefined, { code })` / `{ code }` only |
| `authService.ts:128-131,191-193,213` | `error.message` returned | `fail(code, AUTHORED_COPY(code))` only |
| `authStore.ts:259,286` | copies service message into `state.error` | safe once service is authored |
| `QuickAuthSheet.tsx:68,103`, `auth.login.tsx:60`, `auth.otp.tsx:87,105` | `console.error(msg, res.error)` | `{ code }` only |
| `userMessages.ts:129-140` | regex-rescues provider text | unreachable for auth; keep for other domains |

Invariant: a mock failure whose message contains synthetic `+919999900000` must never reach any sink, console call, or returned `ApiResult.error.message`. Masked phone (`******3210`) is the only phone form in UI payloads or logs.

## 7. `QuickAuthSheet.tsx` allowed edits (F6 — exhaustive)
1. Insert one `<RecaptchaHost flow="checkout" />` inside the portal dialog and pass `flow:"checkout"` + the store `handle` into request/verify.
2. On open: `resumeChallenge("checkout")` → `step="otp"` + masked phone; else `step="phone"`. Read-only derivation; no new request.
3. Busy state from store status + local, recovering on `AUTH_OTP_IN_FLIGHT`, `AUTH_LAST_ATTEMPT_UNKNOWN`, timeout, `auth/code-expired` (→ phone, dirty, busy false), and `CHALLENGE_ACTIVE_OTHER_FLOW` (→ show `maskedPhone`, offer resume/adopt of `handle`, or `invalidateAuthAttempts("userReset")`; never a dead end).
4. Replace the two `console.error` lines with `{ code }` logging.
No copy, layout, or checkout-flow changes; receipt/payment/FulfillmentCard untouched. Resume is decided by handle presence + owner/epoch validation, not `t+299`.

## 8. Size selection (F4)
`const size = measure() >= 304 ? "normal" : "compact"` (normal ≈304px, compact ≈164px; the sheet content box at a 320 viewport is 278px). `measure` defaults to `element.clientWidth` and is injectable for jsdom. Bind only when measured width `> 0`; otherwise retry on rAF (max 10) then `RECAPTCHA_CONTAINER_NOT_READY`. No mid-flow resize (remount only, never while `requesting`); no `transform: scale()`; no `invisible`; no emulator-only bypass under `src/`. Host exposes `data-recaptcha-size`. `compact` is unproven SDK surface (untyped parameters) → unit mock + manual real-device check.

## 9. Acceptance tests (proposed, **not run**)
Unit — jsdom, mock `firebase/auth` only:
1. F1: A+B mounted; request B → constructor gets **B's element**, A's verifier not cleared; `verifyOtp("login", handleB)` → `CHALLENGE_MISMATCH`; `verifyOtp("checkout", handleB)` succeeds.
2. F1 adoption/invalidation: request on `login`; unmount; mount `otp`; adopt → verify succeeds; without adopt → `CHALLENGE_MISMATCH`; `logout`/`changePhone` clear the handle → `NO_CHALLENGE`, `resumeChallenge` null, no implicit re-request.
3. G1 binding: dirty A on `login`, bind B → `HOST_CONFLICT`; request with no binding → `RECAPTCHA_NOT_BOUND`; resend from `/auth/otp` constructs on the **otp** host, not the origin login host.
4. F2 rearm/stale-expiry: failure then retry → exactly 2 constructors on the same element; release nulls before clear; double release no throw; a `clear()` throwing `auth/internal-error` is caught and logged `{code}`; an old verifier's `expired-callback` cannot dirty the new host.
5. F2 StrictMode: per-instance clears, `constructs − clears === 1`, unique `recaptcha-*` ids, zero `id="recaptcha-container"`.
6. G2 unknown/resend: deadline → authored copy, no OTP input; after the deadline `requestOtp` proceeds (cooldown-balanced); **A(gen1) → deadline → B(gen2) → A resolves late keeps `requesting{gen2}` and the lock; B resolves → `issued` with B's handle; exactly two `signInWithPhoneNumber` calls, never three**; cross-flow request returns `{flow,maskedPhone,handle}` and resume/adopt or `userReset` exits it; resend before cooldown → cooldown error with zero SDK calls, after cooldown → exactly one `signInWithPhoneNumber`, old handle `CHALLENGE_MISMATCH`, `resumeChallenge` shows only the new challenge, at most one `dirty` cycle.
7. G3 request deadline + late issue: logout mid-request, late success with matching phone → no authenticated state; epoch gate rejects at completion **and** store commit.
8. G3 verify deadline: never-resolving `confirm` → busy false, `otp_sent`, actionable; resend while `verifying` → `AUTH_OTP_IN_FLIGHT` with zero extra SDK calls; late success after logout → no auth, `signOut` only if `currentUser === staleInstance`, cart/payment untouched.
9. G3 newB-before-oldA: B completes, A resolves later → B stays authenticated, A never re-authenticates, no signOut of B.
10. F4 size seam (host widths): `277 → compact`, `304 → normal`, `348 → normal`.
11. F5 sentinel: no sink/console/returned message contains `+919999900000`.
12. F6 resume: issued at t+299 → `step="otp"`, zero `signInWithPhoneNumber`; `auth/code-expired` → phone, busy false.
13. Release guard: source scan fails on `appVerificationDisabledForTesting|connectAuthEmulator` under `src/`.

Browser (real layout, emulator mock verifier): viewport 320 (host 278) and 390 (host 348) → **host rect inside the open dialog rect**, no horizontal overflow, `data-recaptcha-size` as expected. Name: *"host placement, mock verifier, no real challenge solved"* — the mock writes no DOM, so widget geometry is never asserted. Emulator 9098 remains a **separate, later, owned** task: test-only entry outside `src`, loopback + demo-project guards, 8099 guest lane not loosened, no verification bypass under `src`, no real SMS.

Commands (proposed): `npx vitest run tests/auth-flow-owner.test.tsx tests/auth-binding-rearm.test.ts tests/auth-attempt-epoch.test.ts tests/auth-redaction.test.ts` · `npx vitest run tests/auth-error-copy.integration.test.tsx tests/auth-verify-singleflight.test.ts` · `npx tsc --noEmit` · `npm run test` · `node tests/emulator/run-lane.mjs` (after the separate lane task).

## 10. Rejected / risks / limits
- **Single global slot/"active" binding, phone-as-nonce, implicit adoption, dirty-flow rebind, clearing the gate on logout, or a store observer** — each reproduces a guess or permits a second SMS; no observer exists, and adding one creates the race it pretends to solve. Rejected.
- Risk / not proven: `compact` support, real 320 layout, `confirm()`/`signOut` timing across tabs, WebView challenge rendering, real Google challenge, real OTP delivery, provider config, iOS 15 runtime — manual checks and a manual release blocker; a mobile test failure cannot prove provider configuration. Emulator evidence proves wiring and placement only.

## 11. Questions
No open product questions: Q1 (SMS), Q2 (WebView, no native plugin), Q3 (single auth writer) are decided. One **manual hard limit**, not a question: the epoch gate *guarantees* no auto-auth after logout and is implementable, but reference-guarded `signOut` cannot be atomic against a concurrent newer sign-in across tabs — an unproven cleanup stays quarantined, never adopts implicitly, and multi-tab/device plus iOS 15 runtime checks remain release blockers.
