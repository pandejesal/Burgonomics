# Integration readiness — local checks, 29 October 2026

**Not end-to-end provider acceptance.** Three read/execute-only subagents checked
the current root backend and the isolated Delivery candidate. No charges,
refunds, transfers, POS tickets, courier bookings/cancellations, SMS, push,
production writes, deployments or credential changes were performed.
Backend, rules and Partner source were not edited by this task.

## Tests actually run

| Scope | Result | What it does not establish |
|---|---|---|
| Root backend Razorpay/Petpooja service, relay-truth, POS-pending-alert tests | 4 files / **71 passed** | Actual merchant payment, POS/KOT/printer or alert delivery |
| Root backend courier readiness, Shadowfax gates, provider contracts, Borzo phone normalization | 4 files / **103 passed** | Vendor authentication, serviceability, rider assignment or callbacks |
| Delivery auth discard/bootstrap | 2 files / **14 passed** | Real OTP/login, App Check attestation or FCM delivery |

These are **188 passing tests across three separate bounded runs**, not one
combined suite. All used `--maxWorkers=1`; courier wire flags were off and
`dispatch.wire.test.ts` was not run. The backend tests skip real dotenv loading
under Vitest and stub provider I/O. Some POS tests deliberately force mock mode.
This proves the tested local behavior only, not that the configured keys work.

Subagent sessions: `ses_e77deea61ffelG8mA386w8euRh` (payment/POS, including its
corrected report), `ses_e77dee87dffeH1dHQ2jx2anNxT` (couriers, corrected contract
assessment), `ses_e77dedd7dffe89F2VowzmY8kEZ` (Firebase, corrected QA provenance).

## Configuration and remaining gates

### Razorpay — test credentials present, native acceptance blocked

- The effective local backend declares staging, has non-placeholder test-mode
  key/secret and a webhook secret; payment mock mode is off.
- No `VITE_RAZORPAY_KEY_ID` was found in the inspected customer env files. This
  **does not itself block checkout**: the backend response supplies `keyId`,
  `paymentsService.ts:185` passes it through and adapter initialization validates
  that order key. It skips eager SDK preload, not all checkout. The original
  subagent's contrary simulation/missing-key diagnosis was withdrawn.
- **The actual mode mismatch:** a normal `vite build` mobile bundle has
  `import.meta.env.PROD=true`; `razorpayAdapter.ts:136–159,221–225` rejects
  `rzp_test_*` keys even when the backend declares staging. No guard was relaxed.
- A separately scoped sandbox build/checkout plan or correctly provisioned
  release credentials is required before merchant acceptance. No payment/order
  endpoint was invoked here. Do not turn this UI QA build into a live-payment
  test by simply swapping credentials.

### Petpooja — credentials present, merchant acceptance not run

- Effective app key, app secret, access token and webhook secret are present;
  POS is enabled and configured mock mode is off.
- The unknown-stock policy is configured as `available`, overriding the
  fail-closed default. The backend owner/operator must reconcile the outlet's
  actual stock encoding before claiming 86ing correctness; no stock was changed.
- Slack/Discord alert endpoints were absent in the probe. Passing the POS-pending
  threshold/document tests is not evidence that an external alert is delivered.
  This is not a claim that all logging/monitoring is absent.
- Real KOT, printer, callback and 86ing acceptance are **NOT RUN**. Do not reapply
  older candidate B01/B02/B03 fixes: the current root belongs to another session.

### Borzo — test host/key present, callback secret missing

- Enabled, non-placeholder API key present, configured for Borzo's test host;
  mock dispatch is off. `DISPATCH_ALLOW_TEST_BOOKING=false` and the live-readiness
  enforcement flag is off in the local staging configuration.
- **`BORZO_WEBHOOK_SECRET` is absent.** The parent verified that
  `dispatch.webhooks.ts:129–147,454–465` rejects every callback with an empty
  secret (401). A successful quote alone would not prove a working lifecycle.
- `BORZO_CUSTOMER_ID` is absent but unused by the present adapter; it is not a
  demonstrated blocker. No quote, booking or callback was sent to the provider.

### Shadowfax hyperlocal — do not enable as-is

Current blockers: disabled, missing API key/client code/webhook secret, and
`contractVerified=false`. Additionally its default host is **production** while
the local backend declares staging. Host/credential/contract sign-off must be
reconciled before any flag flip; no flag was changed.

The corrected courier review also identified **contract-risk candidates for the
backend owner**, not live provider rejection evidence:

| Risk | Current source | Captured native hyperlocal documentation |
|---|---|---|
| Pickup/drop address limit | `shadowfax.adapter.ts:436,448` truncates to 350 | `shadowfax-api-hyperlocal-schemas.md:255–260` specifies max 255 |
| Rider identity fields | `:512–515` reads `name/contact_number/phone` | `schemas.md:319–328` uses `rider_name/rider_phone` |
| Missing city fallback | `:433,445` can send empty strings | `schemas.md:243–249` marks city required; provider acceptance of empty is untested |
| Client order id | `:427` conditional on context | `schemas.md:178–182` required; current router supplies it, so this is a latent direct-caller risk |
| Staging host safety | readiness has a Borzo host gate but not an equivalent Shadowfax refusal | Native staging host is documented in the toolkit |

The existing contract test pins the adapter's rider shape, not the documented
shape. **103 green tests do not clear these risks.** The original "config only,
adapter fully aligned" conclusion was withdrawn. No backend fix was applied.

Courier source hashes were only captured at one point, not before/after; no
no-drift claim is made for that lane. Shadowfax adapter measured SHA256:
`d0438174bcee11eb84870fd308fd6bd3d2d61c717f70d147a11acfea3fe28bd9`.
The payment/POS lane did compare its seven inspected source/test/package hashes
before and after and reported no drift during its bounded run.

### Firebase — client configuration present, production readiness unproven

- Six required publishable client settings load and the bundle's project/config
  identity matches the original app configuration. Presence is not credential
  correctness. The live Home browser checks load the public catalogue; this does
  not test authenticated workflows, deployed rules or Storage authorization.
- The QA wrapper deliberately injects those public settings into the worktree
  process without copying `.env`. Provenance is therefore accounted for.
- The **external debug-only Gradle manifest overlay exists** and removes native
  Firebase automatic startup/FCM components. JS push/analytics are also forced
  off and the web reCAPTCHA site key is blank. This QA APK cannot prove App Check
  attestation or push delivery. Deployed server enforcement remains **NOT RUN**.
- The candidate is built from dirty worktree source, not its old HEAD; the auth
  hardening symbols are present in the generated bundle. An early subagent claim
  that the APK necessarily lacked them was withdrawn.
- Some payment/notification/profile gateways fall back to a production Functions
  host when an explicit base is absent. No workflow triggering those calls was
  exercised, and none of those gateways was edited in this UI task.
- Actual Auth OTP/login, native App Check, token registration/FCM delivery,
  deployed Firestore/Storage rules and iOS/signing/store acceptance remain
  **BLOCKED / NOT RUN**, not implicitly passing because configuration exists.

## Evidence boundaries

Toolkit: `developer-resources/provider-toolkit-20261029/MASTER-REFERENCE.md` and
its captured public provider docs, not a vendor acceptance packet. Config probes
were local effective-value classifications, not reads of deployed secrets. Raw
env values/credential material are not reproduced here. No Grill Coins balances,
history, Reelo bill exports or customer/provider records were migrated or written.
