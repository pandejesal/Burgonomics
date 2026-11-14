import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * F2 (stress sweep 2026-10-24): a dispatch provider that can book a REAL rider
 * must also be able to receive that rider's callbacks.
 *
 * Borzo/Shadowfax outbound keys used to be enough to book while their webhook
 * secrets were optional — production could buy riders whose status callbacks
 * the (empty-secret) verifier has to deny, leaving orders untracked forever.
 * These tests pin the fail-closed boot assertion AND the production runtime
 * eligibility guard. No provider is called.
 *
 * ── Ancillary Admin SDK I/O is controlled here ──────────────────────────────
 * The adapters reach `src/core/firebase.ts` transitively (adapter → shared →
 * dispatch/dropContact → core/dropContact → core/firebase), which imports the
 * real `firebase-admin` and calls `initializeApp()` plus `firestore()` /
 * `auth()` / `messaging()` at module load. This suite exercises NOTHING of that:
 * `isEligible()` reads only `config.*` and `isDeclaredProduction()`. The stub
 * below therefore replaces that ancillary external I/O boundary ONLY.
 *
 * It is NOT an SDK integration test and proves nothing about remote provider
 * acceptance. Real `dotenv`/env parsing, real provider config, and the real
 * `isEligible()` / `isDeclaredProduction()` logic stay UNMOCKED.
 *
 * The stub mirrors the actual export shape `src/core/firebase.ts` consumes:
 * `apps` is NON-EMPTY, so `initializeApp()` is skipped (and asserted not to be
 * called); `firestore`/`auth`/`messaging` return handles whose OPERATIONS throw
 * a tripwire error — creating the handle is fine, using it is not.
 */
const adminStub = vi.hoisted(() => {
  /** Every attempted Firebase operation, for the per-case "no I/O" guard. */
  const ioCalls: string[] = [];
  const operations = (surface: string, names: readonly string[]) =>
    Object.fromEntries(
      names.map((name) => [
        name,
        () => {
          ioCalls.push(`${surface}.${name}`);
          throw new Error(
            `[test boundary] ${surface}.${name}() refused — this suite must not perform Firebase I/O`
          );
        },
      ])
    );

  return {
    ioCalls,
    initializeApp: vi.fn(),
    credential: { cert: vi.fn(() => ({ projectId: "stub" })) },
    // Non-empty: `core/firebase.ts` skips initializeApp entirely.
    apps: [{ name: "[DEFAULT]" }],
    firestore: vi.fn(() =>
      operations("firestore", [
        "doc",
        "collection",
        "collectionGroup",
        "runTransaction",
        "batch",
        "getAll",
        "settings",
        "listCollections",
        "recursiveDelete",
      ])
    ),
    auth: vi.fn(() =>
      operations("auth", [
        "verifyIdToken",
        "createCustomToken",
        "getUser",
        "updateUser",
        "deleteUser",
        "listUsers",
        "generateEmailVerificationLink",
      ])
    ),
    messaging: vi.fn(() =>
      operations("messaging", [
        "send",
        "sendEach",
        "sendEachForMulticast",
        "sendMulticast",
        "sendAll",
        "subscribeToTopic",
        "unsubscribeFromTopic",
      ])
    ),
  };
});

vi.mock("firebase-admin", () => ({
  initializeApp: adminStub.initializeApp,
  apps: adminStub.apps,
  credential: adminStub.credential,
  firestore: adminStub.firestore,
  auth: adminStub.auth,
  messaging: adminStub.messaging,
  default: {
    initializeApp: adminStub.initializeApp,
    apps: adminStub.apps,
    credential: adminStub.credential,
    firestore: adminStub.firestore,
    auth: adminStub.auth,
    messaging: adminStub.messaging,
  },
}));

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

beforeEach(() => {
  // Reset observable calls WITHOUT removing the boundary: `clear` keeps the
  // mock implementations (so a handle is still created and still refuses
  // operations) and only clears recorded calls.
  adminStub.initializeApp.mockClear();
  adminStub.firestore.mockClear();
  adminStub.auth.mockClear();
  adminStub.messaging.mockClear();
  adminStub.ioCalls.length = 0;
});

afterEach(() => {
  // Boundary guard: this suite never initializes the real SDK and never
  // performs a Firebase operation. Creating a handle is allowed.
  expect(adminStub.initializeApp).not.toHaveBeenCalled();
  expect(adminStub.ioCalls).toEqual([]);
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
