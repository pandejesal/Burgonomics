import * as dotenv from "dotenv";
dotenv.config();

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

export const config = {
  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID || "burgonomics-7faa8",
    region: process.env.FIREBASE_REGION || "asia-south1",
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
      `https://asia-south1-${process.env.FIREBASE_PROJECT_ID || "burgonomics-7faa8"}.cloudfunctions.net/api/petpooja/webhook`,
  },
  porter: {
    enabled: process.env.PORTER_ENABLED !== "false",
    apiKey: process.env.PORTER_API_KEY || "",
    customerId: process.env.PORTER_CUSTOMER_ID || "",
    webhookSecret: process.env.PORTER_WEBHOOK_SECRET || "",
    baseUrl: process.env.PORTER_BASE_URL || "https://api.porter.in",
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
 */
export function assertWebhookSecrets(): void {
  const missing = REQUIRED_SECRETS.filter(([, read]) => !read()).map(
    ([name]) => name
  );
  if (missing.length > 0) {
    throw new Error(
      `FATAL: missing secrets (${missing.join(", ")}) — set them in functions/.env ` +
        `(dotenv file, not functions:config). Refusing to boot half-configured.`
    );
  }
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

export function assertProductionKeys(): void {
  // Throws FATAL on ambiguity (see deploymentEnv) — boot refuses rather
  // than guessing. Explicit production NODE_ENV short-circuits to enforcement.
  const nodeProd = process.env.NODE_ENV === "production";
  const declared = nodeProd ? ("production" as const) : deploymentEnv();
  // Staging mirrors prod secrets without the mock ban (staging legitimately
  // exercises fallback paths); dev runs unguarded and mock-friendly.
  if (declared === "staging") {
    assertWebhookSecrets();
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
}
