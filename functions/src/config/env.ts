import * as dotenv from "dotenv";
// Test runners own process.env (env.failclosed.test.ts asserts empty-env
// fail-closed behavior after deleting keys) — a developer's local
// functions/.env must never leak into suites via re-import and flip those
// expectations. Vitest sets VITEST=true in workers; dotenv stays live
// everywhere else (emulators, deployed Cloud Functions ignore .env files).
if (process.env.VITEST !== "true") {
  dotenv.config();
}

// Fail-closed env (H-M2/C3): NO mock literals anywhere in this file. Every
// secret defaults to "" (unset). Webhook/signature verifiers treat an empty
// secret as "deny" (their verify*() return false when !secret), so booting
// with an empty env denies forged webhooks with 401/400 — it never mints
// order_mock_* payable orders. Mock mode engages ONLY on explicit
// MOCK_*="true" (exact string match); a missing/empty/renamed value is live.
//
/** Explicit opt-in: only the exact string "true" enables a mock flag. */
function explicitMock(flag: string | undefined): boolean {
  return flag === "true";
}

/**
 * A positive finite number from an env string, else the default. `Number("6s")`
 * is NaN and `setTimeout(fn, NaN)` fires IMMEDIATELY, which would time out every
 * dispatch quote at once (audit finding 13); a NaN rupee threshold silently
 * disables the DR7 fare-confirmation gate (`NaN` comparisons are always false),
 * so the same guard covers both. 0/negative/non-numeric fall back to the default.
 */
function positiveNumber(raw: string | undefined, fallback: number): number {
  const n = Number(raw ?? "");
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const config = {
  firebase: {
    projectId:
      process.env.GCLOUD_PROJECT ||
      process.env.FIREBASE_PROJECT_ID ||
      "burgonomics-7faa8",
    region:
      process.env.FUNCTION_REGION || process.env.FIREBASE_REGION || "asia-south1",
  },
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID || "",
    keySecret: process.env.RAZORPAY_KEY_SECRET || "",
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || "",
  },
  petpooja: {
    enabled: process.env.PETPOOJA_ENABLED !== "false",
    appKey: process.env.PETPOOJA_APP_KEY || "",
    appSecret: process.env.PETPOOJA_APP_SECRET || "",
    accessToken: process.env.PETPOOJA_ACCESS_TOKEN || "",
    // Inbound HMAC secret, NEVER sent outbound. Starts as a copy of
    // APP_SECRET (Petpooja signs with the issued secret today) — set it
    // independently to rotate inbound trust without touching outbound auth.
    webhookSecret: process.env.PETPOOJA_WEBHOOK_SECRET || "",
    menuUrl:
      process.env.PETPOOJA_MENU_URL ||
      "https://qle1yy2ydc.execute-api.ap-southeast-1.amazonaws.com/V1/mapped_restaurant_menus",
    orderUrl:
      process.env.PETPOOJA_ORDER_URL ||
      "https://47pfzh5sf2.execute-api.ap-southeast-1.amazonaws.com/V1/save_order",
    stockUrl:
      process.env.PETPOOJA_STOCK_URL ||
      "https://qle1yy2ydc.execute-api.ap-southeast-1.amazonaws.com/V1/update_item_stock",
    callbackUrl:
      process.env.PETPOOJA_CALLBACK_URL ||
      `https://asia-south1-${process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID || "burgonomics-7faa8"}.cloudfunctions.net/api/petpooja/webhook`,
  },
  porter: {
    enabled: process.env.PORTER_ENABLED !== "false",
    apiKey: process.env.PORTER_API_KEY || "",
    customerId: process.env.PORTER_CUSTOMER_ID || "",
    webhookSecret: process.env.PORTER_WEBHOOK_SECRET || "",
    baseUrl: process.env.PORTER_BASE_URL || "https://api.porter.in",
  },
  // Multi-provider dispatch (references/delivery_routing.md §9). Providers are
  // OPTIONAL: an unset key excludes the provider from the quote fan-out (it is
  // not a failure) — DR2. Empty webhook secrets deny inbound events, never
  // verify against a default.
  borzo: {
    enabled: process.env.BORZO_ENABLED !== "false",
    apiKey: process.env.BORZO_API_KEY || "",
    customerId: process.env.BORZO_CUSTOMER_ID || "",
    // Inbound Callback Secret Key (Personal cabinet) — HMAC-SHA256 arrives in
    // the X-DV-Signature header; NEVER the outbound X-DV-Auth-Token.
    webhookSecret: process.env.BORZO_WEBHOOK_SECRET || "",
    // Production Business API 1.8 base (test: https://robotapitest-in.borzodelivery.com);
    // the adapter appends /api/business/1.8 when the base omits it.
    baseUrl: process.env.BORZO_BASE_URL || "https://robot-in.borzodelivery.com",
  },
  shadowfax: {
    enabled: process.env.SHADOWFAX_ENABLED !== "false",
    apiKey: process.env.SHADOWFAX_API_KEY || "",
    // Merchant/client code required by POST /api/v2/orders/ (place order).
    clientCode: process.env.SHADOWFAX_CLIENT_CODE || "",
    webhookSecret: process.env.SHADOWFAX_WEBHOOK_SECRET || "",
    // Hyperlocal Marketplace production base (staging: https://hlbackend.staging.shadowfax.in).
    baseUrl: process.env.SHADOWFAX_BASE_URL || "https://api.shadowfax.in",
    // Fail-closed contract gate. Shadowfax's native contract (paths, auth header,
    // order/serviceability/tracking shape, callback schema) is UNVERIFIED — the
    // adapter's field names are ours, not evidence. Granting keys must therefore
    // NOT by itself put an unverified provider into the live fan-out; a human
    // flips this only after the contract is confirmed. Default false.
    contractVerified: process.env.SHADOWFAX_CONTRACT_VERIFIED === "true",
  },
  dispatch: {
    quoteTimeoutMs: positiveNumber(process.env.DISPATCH_QUOTE_TIMEOUT_MS, 6000),
    // DR7 fare-confirmation threshold. A non-numeric value used to become NaN,
    // and every `|delta| > NaN` comparison is false, so a single env typo
    // silently disabled the confirmation gate (review finding on 39efc40).
    fareConfirmDeltaInr: positiveNumber(process.env.DISPATCH_FARE_CONFIRM_DELTA_INR, 20),
    // Opt-in test-window preflight (round-3 N1(b), default OFF so dev and
    // production behaviour is unchanged): when true, dispatchQuote/dispatchBook
    // first refuse if a dispatch mock is active, if the agreed test courier is
    // not callable, or if it would be sent to a live host. See readiness.ts.
    requireLive: process.env.DISPATCH_REQUIRE_LIVE === "true",
    // Booking-only opt-in for the TEST window (exact "true" only; inert unless
    // requireLive is on). Quoting is read-only, but a create-order can dispatch
    // a REAL rider, so booking stays blocked until a real-rider-exclusion
    // confirmation is recorded. See readiness.ts.
    allowTestBooking: process.env.DISPATCH_ALLOW_TEST_BOOKING === "true",
  },
  alerts: {
    slackWebhookUrl: process.env.SLACK_DEV_WEBHOOK_URL || "",
    discordWebhookUrl: process.env.DISCORD_DEV_WEBHOOK_URL || "",
  },
  appCheck: {
    enforcement: process.env.APP_CHECK_ENFORCEMENT === "true",
  },
  mock: {
    paymentGateway: explicitMock(process.env.MOCK_PAYMENT_GATEWAY),
    porterDispatch: explicitMock(process.env.MOCK_PORTER_DISPATCH),
    petpoojaPos: explicitMock(process.env.MOCK_PETPOOJA_POS),
    borzoDispatch: explicitMock(process.env.MOCK_BORZO_DISPATCH),
    shadowfaxDispatch: explicitMock(process.env.MOCK_SHADOWFAX_DISPATCH),
  },
};

/**
 * Fail-closed secret accessor for webhook/HMAC paths. Throws — never returns
 * a mock literal — when the secret is unset, so a misconfigured boot denies
 * instead of verifying against a well-known value.
 */
export function requireEnvSecret(
  value: string | undefined,
  envName: string
): string {
  if (!value) {
    throw new Error(
      `FATAL: ${envName} is unset — refusing to verify webhooks against an empty secret. ` +
        `Set ${envName} in functions/.env (dotenv file, not functions:config).`
    );
  }
  return value;
}

/** Names of the secrets a live boot must provide (docs live in .env.example). */
const REQUIRED_SECRETS: Array<[envName: string, value: () => string]> = [
  ["RAZORPAY_KEY_ID", () => config.razorpay.keyId],
  ["RAZORPAY_KEY_SECRET", () => config.razorpay.keySecret],
  ["RAZORPAY_WEBHOOK_SECRET", () => config.razorpay.webhookSecret],
  ["PETPOOJA_APP_KEY", () => config.petpooja.appKey],
  ["PETPOOJA_APP_SECRET", () => config.petpooja.appSecret],
  ["PETPOOJA_ACCESS_TOKEN", () => config.petpooja.accessToken],
  ["PORTER_API_KEY", () => config.porter.apiKey],
  ["PORTER_WEBHOOK_SECRET", () => config.porter.webhookSecret],
  ["OTP_HMAC_SECRET", () => process.env.OTP_HMAC_SECRET || ""],
];

/**
 * Throws listing every unset secret. Call at boot when the process must not
 * run half-configured (production); webhook handlers additionally deny
 * per-request via empty-secret checks, so an empty env can never accept a
 * forged webhook even where this assert is not wired.
 *
 * `perEnabledIntegrations` (staging only — controller C11 / round-3 ACK): a
 * capability that is genuinely switched OFF must not demand credentials it will
 * never use, otherwise a staging boot fails for a disabled provider. It never
 * relaxes what an ENABLED integration needs, and it does not touch the
 * production path (which stays unconditional) or any signature check.
 */
export function assertWebhookSecrets(
  options: { perEnabledIntegrations?: boolean } = {}
): void {
  const missing = REQUIRED_SECRETS.filter(([name, read]) =>
    options.perEnabledIntegrations
      ? integrationEnabledForSecret(name) && !read()
      : !read()
  ).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `FATAL: missing secrets (${missing.join(", ")}) — set them in functions/.env ` +
        `(dotenv file, not functions:config). Refusing to boot half-configured.`
    );
  }
}

/**
 * Which integration an env secret belongs to, for the staging readiness check.
 * Payments (Razorpay) and the delivery OTP are core paths with no off switch, so
 * they always require their secrets; Porter/Petpooja are capability-flagged.
 */
function integrationEnabledForSecret(envName: string): boolean {
  if (envName.startsWith("PORTER_")) return config.porter.enabled;
  if (envName.startsWith("PETPOOJA_")) return config.petpooja.enabled;
  return true;
}

// Fail-fast guard for India production: never silently run live payments,
// dispatch, or POS sync in mock mode or half-configured. (Mock Porter/Petpooja
// in prod means fake riders and phantom KOTs — worse than refusing to boot.)
export type DeploymentEnv = "production" | "staging" | "dev";

/**
 * Readiness-2: the SINGLE source of truth for where this process thinks it
 * runs. The old code gated everything on NODE_ENV, but nothing in the repo
 * sets NODE_ENV for deploys (no workflow, no firebase config) — an operator
 * deploying without it would boot half-configured with mocks and sleeping
 * guards. BURGONOMICS_ENV must be set explicitly (functions/.env); an
 * explicit production NODE_ENV still counts, but ambiguity is FATAL.
 */
export function deploymentEnv(): DeploymentEnv {
  const raw = (process.env.BURGONOMICS_ENV || "").trim().toLowerCase();
  if (raw === "production" || raw === "staging" || raw === "dev") return raw;
  if (process.env.NODE_ENV === "production") return "production";
  throw new Error(
    "FATAL: BURGONOMICS_ENV is unset or invalid — set it to dev, staging, or " +
      "production in functions/.env. Refusing to boot with an ambiguous environment."
  );
}

/**
 * Non-throwing production predicate for RUNTIME guard rails on money paths.
 * Boot still fails loudly through deploymentEnv()/assertProductionKeys();
 * this only powers belt-and-braces checks that must hold even when config is
 * mutated after boot (a flipped flag, a half-initialized deploy). Ambiguity
 * (neither BURGONOMICS_ENV nor an explicit NODE_ENV=production) resolves to
 * "not production" here — the boot assert is the strict gate for that case.
 */
export function isDeclaredProduction(): boolean {
  const raw = (process.env.BURGONOMICS_ENV || "").trim().toLowerCase();
  if (raw === "production") return true;
  if (raw === "staging" || raw === "dev") return false;
  return process.env.NODE_ENV === "production";
}

/** Razorpay test-mode key ids are always `rzp_test_*` (live: `rzp_live_*`). */
export function isRazorpayTestKeyId(keyId: string | undefined): boolean {
  return /^rzp_test_/i.test(String(keyId || "").trim());
}

/**
 * ZERO-MOCK runtime guard for payment execution pathways. The boot-time
 * assert is necessary but not sufficient: `config.mock.paymentGateway` is a
 * plain mutable object, so a process that boots clean can still be flipped
 * into minting `order_mock_*` orders / accepting any non-empty signature /
 * faking Route transfers. In a declared production process every payment
 * entrypoint refuses instead.
 */
export function assertLivePaymentsContext(operation: string): void {
  if (config.mock.paymentGateway && isDeclaredProduction()) {
    throw new Error(
      `FATAL: MOCK_PAYMENT_GATEWAY is active in production — refusing ${operation} (fail-closed).`
    );
  }
}

/**
 * ZERO-MOCK runtime guard for the Petpooja POS bridge. Boot refuses a
 * declared-production process with MOCK_PETPOOJA_POS=true (assertProductionKeys),
 * but `config.mock.petpoojaPos` stays mutable afterwards — and a flipped flag
 * would turn real KOT pushes, 86ing, and menu syncs into phantom/synthetic
 * operations (fake `pp_kot_*` orders, canned catalogs) in a LIVE store.
 * Every petpooja entrypoint calls this before touching its mock branch.
 */
export function assertLivePetpoojaContext(operation: string): void {
  if (config.mock.petpoojaPos && isDeclaredProduction()) {
    throw new Error(
      `FATAL: MOCK_PETPOOJA_POS is active in production — refusing ${operation} (fail-closed).`
    );
  }
}

/**
 * ZERO-MOCK runtime guard for the multi-provider dispatch path (DR11). Boot
 * refuses a declared-production process with any MOCK_*_DISPATCH flag
 * (assertProductionKeys), but `config.mock` is a plain mutable object: a
 * process that boots clean can be flipped afterwards, and a flipped dispatch
 * flag puts `[TEST]` riders and mock fares on LIVE orders with no refusal — the
 * doc's claim that mocks "can never run in production" rested on the boot
 * assert alone (audit finding 9). Every provider adapter calls this at the top
 * of its mock branch.
 */
export function assertLiveDispatchContext(operation: string): void {
  if (!isDeclaredProduction()) return;
  const activeMocks = (
    [
      ["MOCK_PORTER_DISPATCH", config.mock.porterDispatch],
      ["MOCK_BORZO_DISPATCH", config.mock.borzoDispatch],
      ["MOCK_SHADOWFAX_DISPATCH", config.mock.shadowfaxDispatch],
    ] as Array<[string, boolean]>
  )
    .filter(([, on]) => on)
    .map(([name]) => name);
  if (activeMocks.length > 0) {
    throw new Error(
      `FATAL: ${activeMocks.join(", ")} active in production — refusing ${operation} (fail-closed).`
    );
  }
}

export function assertProductionKeys(): void {
  // deploymentEnv() prioritizes explicit BURGONOMICS_ENV ("dev" | "staging" | "production")
  // and falls back to NODE_ENV === "production" when BURGONOMICS_ENV is unset.
  // Using deploymentEnv() directly ensures Cloud Run containers (which always set
  // NODE_ENV=production) honor BURGONOMICS_ENV="dev" or "staging".
  const declared = deploymentEnv();
  // Staging mirrors prod secrets for ENABLED integrations without the mock ban
  // (staging legitimately exercises fallback paths); a capability that is
  // switched off does not demand credentials it will never use (C11).
  if (declared === "staging") {
    assertWebhookSecrets({ perEnabledIntegrations: true });
    return;
  }
  if (declared !== "production") return;
  // Declared production (or explicit production NODE_ENV): full enforcement.
  assertWebhookSecrets();
  const activeMocks = (
    [
      ["MOCK_PAYMENT_GATEWAY", config.mock.paymentGateway],
      ["MOCK_PORTER_DISPATCH", config.mock.porterDispatch],
      ["MOCK_PETPOOJA_POS", config.mock.petpoojaPos],
      ["MOCK_BORZO_DISPATCH", config.mock.borzoDispatch],
      ["MOCK_SHADOWFAX_DISPATCH", config.mock.shadowfaxDispatch],
    ] as Array<[string, boolean]>
  )
    .filter(([, on]) => on)
    .map(([name]) => name);
  if (activeMocks.length > 0) {
    throw new Error(
      `FATAL: mock mode active in production (${activeMocks.join(", ")}) — ` +
        `fake riders and phantom KOTs are worse than refusing to boot.`
    );
  }
  const mockLike = REQUIRED_SECRETS.filter(([, read]) =>
    read().toLowerCase().includes("mock")
  ).map(([name]) => name);
  if (mockLike.length > 0) {
    throw new Error(
      `FATAL: mock-like secrets in production (${mockLike.join(", ")}) — ` +
        `set live keys in functions/.env (dotenv file, not functions:config).`
    );
  }
  // Live mode must refuse test-mode keys: an rzp_test_* key against the live
  // deployment creates orders nobody can pay (or, worse, "succeeds" against
  // Razorpay's test realm while production traffic silently fails).
  if (isRazorpayTestKeyId(config.razorpay.keyId)) {
    throw new Error(
      "FATAL: rzp_test_* Razorpay key in production — set the rzp_live_* key " +
        "in functions/.env (dotenv file, not functions:config)."
    );
  }
}
