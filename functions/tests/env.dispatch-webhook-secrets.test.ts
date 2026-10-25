import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * F2 (stress sweep 2026-10-24): a dispatch provider that can book a REAL rider
 * must also be able to receive that rider's callbacks.
 *
 * Borzo/Shadowfax outbound keys used to be enough to book while their webhook
 * secrets were optional — production could buy riders whose status callbacks
 * the (empty-secret) verifier has to deny, leaving orders untracked forever.
 * These tests pin the fail-closed boot assertion AND the production runtime
 * eligibility guard. No provider is called.
 */

const CORE: Record<string, string> = {
  RAZORPAY_KEY_ID: "rzp_live_unit_only",
  RAZORPAY_KEY_SECRET: "unit-only",
  RAZORPAY_WEBHOOK_SECRET: "unit-only",
  OTP_HMAC_SECRET: "unit-only",
  PETPOOJA_APP_KEY: "unit-only",
  PETPOOJA_APP_SECRET: "unit-only",
  PETPOOJA_ACCESS_TOKEN: "unit-only",
  // Retired provider: must not demand its own secrets in this suite.
  PORTER_ENABLED: "false",
};

/** Every env key this suite touches; reset between cases so nothing leaks. */
const TOUCHED = [
  ...Object.keys(CORE),
  "BORZO_ENABLED",
  "BORZO_API_KEY",
  "BORZO_WEBHOOK_SECRET",
  "SHADOWFAX_ENABLED",
  "SHADOWFAX_API_KEY",
  "SHADOWFAX_CLIENT_CODE",
  "SHADOWFAX_CONTRACT_VERIFIED",
  "SHADOWFAX_WEBHOOK_SECRET",
  "MOCK_BORZO_DISPATCH",
  "MOCK_SHADOWFAX_DISPATCH",
  "BURGONOMICS_ENV",
  "NODE_ENV",
];

async function inFreshEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: (env: typeof import("../src/config/env")) => T
): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const key of TOUCHED) {
    previous[key] = process.env[key];
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(CORE)) process.env[key] = value;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  vi.resetModules();
  try {
    const env = await import("../src/config/env");
    return await fn(env);
  } finally {
    for (const key of TOUCHED) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

const KEYED_BORZO = {
  BORZO_ENABLED: "true",
  BORZO_API_KEY: "unit_borzo_key",
  BORZO_WEBHOOK_SECRET: undefined,
  SHADOWFAX_ENABLED: "false",
};

const KEYED_SHADOWFAX = {
  BORZO_ENABLED: "false",
  SHADOWFAX_ENABLED: "true",
  SHADOWFAX_API_KEY: "unit_sfx_key",
  SHADOWFAX_CLIENT_CODE: "unit_sfx_client",
  SHADOWFAX_CONTRACT_VERIFIED: "true",
  SHADOWFAX_WEBHOOK_SECRET: undefined,
};

afterEach(() => {
  vi.resetModules();
});

describe("F2 boot: an enabled, keyed dispatch provider needs its callback secret", () => {
  it("production boot refuses a keyed Borzo with no BORZO_WEBHOOK_SECRET", async () => {
    await inFreshEnv(KEYED_BORZO, (env) => {
      expect(() => env.assertWebhookSecrets()).toThrow(/BORZO_WEBHOOK_SECRET/);
    });
  });

  it("production boot passes once the callback secret is present", async () => {
    await inFreshEnv(
      { ...KEYED_BORZO, BORZO_WEBHOOK_SECRET: "unit_borzo_whsec" },
      (env) => {
        expect(() => env.assertWebhookSecrets()).not.toThrow();
      }
    );
  });

  it("production boot refuses a keyed Shadowfax with no SHADOWFAX_WEBHOOK_SECRET", async () => {
    await inFreshEnv(KEYED_SHADOWFAX, (env) => {
      expect(() => env.assertWebhookSecrets()).toThrow(/SHADOWFAX_WEBHOOK_SECRET/);
    });
  });

  it("staging (per-enabled) also refuses the enabled pair", async () => {
    await inFreshEnv(KEYED_BORZO, (env) => {
      expect(() => env.assertWebhookSecrets({ perEnabledIntegrations: true })).toThrow(
        /BORZO_WEBHOOK_SECRET/
      );
    });
  });

  it("a whitespace-only secret is not a secret", async () => {
    await inFreshEnv(
      { ...KEYED_BORZO, BORZO_WEBHOOK_SECRET: "   " },
      (env) => {
        expect(() => env.assertWebhookSecrets()).toThrow(/BORZO_WEBHOOK_SECRET/);
      }
    );
  });

  it("an ENABLED but UNKEYED provider does not demand a secret it can never use", async () => {
    await inFreshEnv(
      {
        BORZO_ENABLED: "true",
        BORZO_API_KEY: undefined,
        BORZO_WEBHOOK_SECRET: undefined,
        SHADOWFAX_ENABLED: "false",
      },
      (env) => {
        // Unkeyed Borzo is excluded from the fan-out (DR2): no booking, no
        // callback. Demanding a secret here would only brick boot.
        expect(() => env.assertWebhookSecrets()).not.toThrow();
      }
    );
  });
});

describe("F2 runtime: production eligibility refuses an empty callback secret", () => {
  it("keyed Borzo without a webhook secret is ineligible in production, eligible with one", async () => {
    await inFreshEnv(
      {
        BURGONOMICS_ENV: "production",
        BORZO_ENABLED: "true",
        BORZO_API_KEY: "unit_borzo_key",
        BORZO_WEBHOOK_SECRET: undefined,
        SHADOWFAX_ENABLED: "false",
      },
      async (env) => {
        const { borzoAdapter } = await import(
          "../src/modules/dispatch/providers/borzo.adapter"
        );
        expect(borzoAdapter.isEligible()).toBe(false);

        env.config.borzo.webhookSecret = "unit_borzo_whsec";
        expect(borzoAdapter.isEligible()).toBe(true);

        // Mock mode generates no vendor callbacks, so it stays eligible.
        env.config.borzo.webhookSecret = "";
        env.config.mock.borzoDispatch = true;
        expect(borzoAdapter.isEligible()).toBe(true);
      }
    );
  });

  it("keyed+contract-verified Shadowfax without a webhook secret is ineligible in production", async () => {
    await inFreshEnv(
      {
        BURGONOMICS_ENV: "production",
        BORZO_ENABLED: "false",
        SHADOWFAX_ENABLED: "true",
        SHADOWFAX_API_KEY: "unit_sfx_key",
        SHADOWFAX_CLIENT_CODE: "unit_sfx_client",
        SHADOWFAX_CONTRACT_VERIFIED: "true",
        SHADOWFAX_WEBHOOK_SECRET: undefined,
      },
      async (env) => {
        const { shadowfaxAdapter } = await import(
          "../src/modules/dispatch/providers/shadowfax.adapter"
        );
        expect(shadowfaxAdapter.isEligible()).toBe(false);

        env.config.shadowfax.webhookSecret = "unit_sfx_whsec";
        expect(shadowfaxAdapter.isEligible()).toBe(true);
      }
    );
  });

  it("dev keeps the fan-out usable with a fake key and no callback secret", async () => {
    await inFreshEnv(
      {
        BURGONOMICS_ENV: "dev",
        BORZO_ENABLED: "true",
        BORZO_API_KEY: "unit_borzo_key",
        BORZO_WEBHOOK_SECRET: undefined,
        SHADOWFAX_ENABLED: "false",
      },
      async () => {
        const { borzoAdapter } = await import(
          "../src/modules/dispatch/providers/borzo.adapter"
        );
        expect(borzoAdapter.isEligible()).toBe(true);
      }
    );
  });
});
