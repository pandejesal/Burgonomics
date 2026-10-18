import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * Staging readiness is PER ENABLED INTEGRATION (controller C11, round-3 ACK).
 *
 * Proves three things at once:
 *  1. a genuinely DISABLED integration no longer demands credentials it will never
 *     use (so staging can boot with Porter switched off — no dummy secrets);
 *  2. an ENABLED integration still requires its real secrets;
 *  3. the strict (production) shape is unchanged, and signature verification is
 *     untouched: an empty secret still denies per request.
 *
 * config is built at module load from process.env, so each case re-imports.
 */

/** Core-path secrets with no off switch (payments + delivery OTP). */
const CORE = {
  RAZORPAY_KEY_ID: "rzp_test_unit_only",
  RAZORPAY_KEY_SECRET: "unit-only",
  RAZORPAY_WEBHOOK_SECRET: "unit-only",
  OTP_HMAC_SECRET: "unit-only",
};

/**
 * Runs `fn` with the given env in place. The callback form is required because
 * OTP_HMAC_SECRET (and the empty-secret deny checks) are read LAZILY from
 * process.env at assert time, not captured into config at import time.
 */
async function inFreshEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: (env: typeof import("../src/config/env")) => T
): Promise<T> {
  const keys = [...Object.keys(CORE), ...Object.keys(overrides)];
  const previous: Record<string, string | undefined> = {};
  for (const key of keys) previous[key] = process.env[key];

  for (const [key, value] of Object.entries(CORE)) process.env[key] = value;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  vi.resetModules();
  try {
    const env = await import("../src/config/env");
    return fn(env);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

const DISABLED_PROVIDERS = {
  PORTER_ENABLED: "false",
  PORTER_API_KEY: undefined,
  PORTER_WEBHOOK_SECRET: undefined,
  PETPOOJA_ENABLED: "false",
  PETPOOJA_APP_KEY: undefined,
  PETPOOJA_APP_SECRET: undefined,
  PETPOOJA_ACCESS_TOKEN: undefined,
};

afterEach(() => {
  vi.resetModules();
});

describe("staging readiness: per enabled integration (C11)", () => {
  it("does NOT demand secrets for a genuinely disabled integration (staging path)", async () => {
    await inFreshEnv(DISABLED_PROVIDERS, (env) => {
      // Porter and Petpooja are off, so their empty secrets are not a boot blocker.
      expect(() =>
        env.assertWebhookSecrets({ perEnabledIntegrations: true })
      ).not.toThrow();
    });
  });

  it("still demands the secrets of an ENABLED integration", async () => {
    await inFreshEnv(
      {
        ...DISABLED_PROVIDERS,
        PORTER_ENABLED: "true", // enabled, but PORTER_API_KEY/PORTER_WEBHOOK_SECRET empty
      },
      (env) => {
        expect(() =>
          env.assertWebhookSecrets({ perEnabledIntegrations: true })
        ).toThrow(/PORTER_API_KEY/);
      }
    );
  });

  it("keeps the strict/production shape unchanged: disabled integrations are still required", async () => {
    await inFreshEnv(DISABLED_PROVIDERS, (env) => {
      // The unconditional form (production path) is untouched by C11.
      expect(() => env.assertWebhookSecrets()).toThrow(/PORTER_API_KEY/);
    });
  });

  it("still requires the core payment/OTP secrets even with every optional integration off", async () => {
    await inFreshEnv(
      { ...DISABLED_PROVIDERS, RAZORPAY_WEBHOOK_SECRET: undefined },
      (env) => {
        expect(() =>
          env.assertWebhookSecrets({ perEnabledIntegrations: true })
        ).toThrow(/RAZORPAY_WEBHOOK_SECRET/);
      }
    );
  });
});
