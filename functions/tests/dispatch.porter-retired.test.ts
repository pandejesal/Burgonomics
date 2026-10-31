import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * Porter is RETIRED as a dispatch partner.
 *
 * The old default was fail-open: `PORTER_ENABLED !== "false"` meant an unset
 * variable left Porter quote-eligible, and porter.adapter.isEligible() returns
 * config.porter.enabled — so a cancelled carrier could still win a quote from
 * the local rate card. These tests pin the opt-in default so a plain deploy
 * never routes customers to a carrier we no longer have a contract with.
 *
 * config is built at module load from process.env, so each case re-imports.
 */

const CORE = {
  RAZORPAY_KEY_ID: "rzp_test_unit_only",
  RAZORPAY_KEY_SECRET: "unit-only",
  RAZORPAY_WEBHOOK_SECRET: "unit-only",
  OTP_HMAC_SECRET: "unit-only",
};

async function inFreshEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: (
    env: typeof import("../src/config/env"),
    adapter: typeof import("../src/modules/dispatch/providers/porter.adapter")
  ) => T
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
    const adapter = await import("../src/modules/dispatch/providers/porter.adapter");
    return fn(env, adapter);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

afterEach(() => {
  vi.resetModules();
});

describe("Porter retirement — dispatch is fail-closed unless explicitly enabled", () => {
  it("is disabled when PORTER_ENABLED is unset (the default deploy)", async () => {
    await inFreshEnv({ PORTER_ENABLED: undefined }, (env, adapter) => {
      expect(env.config.porter.enabled).toBe(false);
      expect(adapter.porterAdapter.isEligible()).toBe(false);
    });
  });

  it("is disabled when PORTER_ENABLED is any value other than 'true'", async () => {
    await inFreshEnv({ PORTER_ENABLED: "false" }, (env, adapter) => {
      expect(env.config.porter.enabled).toBe(false);
      expect(adapter.porterAdapter.isEligible()).toBe(false);
    });

    await inFreshEnv({ PORTER_ENABLED: "1" }, (env, adapter) => {
      expect(env.config.porter.enabled).toBe(false);
      expect(adapter.porterAdapter.isEligible()).toBe(false);
    });
  });

  it("stays opt-in for historical reconciliation when explicitly set to 'true'", async () => {
    await inFreshEnv({ PORTER_ENABLED: "true" }, (env, adapter) => {
      expect(env.config.porter.enabled).toBe(true);
      expect(adapter.porterAdapter.isEligible()).toBe(true);
    });
  });

  it("never demands Porter credentials while Porter is disabled", async () => {
    await inFreshEnv(
      {
        PORTER_ENABLED: undefined,
        PORTER_API_KEY: undefined,
        PORTER_CUSTOMER_ID: undefined,
        PORTER_WEBHOOK_SECRET: undefined,
        BORZO_ENABLED: "false",
        SHADOWFAX_ENABLED: "false",
        PETPOOJA_ENABLED: "false",
      },
      (env) => {
        expect(() =>
          env.assertWebhookSecrets({ perEnabledIntegrations: true })
        ).not.toThrow();
      }
    );
  });
});
