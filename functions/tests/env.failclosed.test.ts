import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Boot-with-empty-env negative test (H-M2/C3/C4/M16): an empty env must deny
// every webhook/signature path and never mint order_mock_* ids.

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TIMESTAMP",
    increment: (n: number) => n,
    arrayUnion: (item: any) => [item],
  };
  const firestoreFn: any = vi.fn(() => ({}));
  firestoreFn.FieldValue = FieldValue;
  return {
    default: {
      firestore: firestoreFn,
      auth: vi.fn(() => ({})),
      messaging: vi.fn(() => ({})),
      initializeApp: vi.fn(),
      apps: [{ name: "mock" }],
    },
    firestore: firestoreFn,
    auth: vi.fn(() => ({})),
    messaging: vi.fn(() => ({})),
    initializeApp: vi.fn(),
    apps: [{ name: "mock" }],
  };
});

const SECRET_KEYS = [
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "RAZORPAY_WEBHOOK_SECRET",
  "PETPOOJA_APP_KEY",
  "PETPOOJA_APP_SECRET",
  "PETPOOJA_ACCESS_TOKEN",
  "PORTER_API_KEY",
  "PORTER_CUSTOMER_ID",
  "PORTER_WEBHOOK_SECRET",
  "OTP_HMAC_SECRET",
  "BURGONOMICS_ENV",
  "MOCK_PAYMENT_GATEWAY",
  "MOCK_PORTER_DISPATCH",
  "MOCK_PETPOOJA_POS",
];

let savedEnv: Record<string, string | undefined> = {};
let savedNodeEnv: string | undefined;

beforeEach(() => {
  savedEnv = {};
  for (const k of SECRET_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  savedNodeEnv = process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  vi.resetModules();
});

afterEach(() => {
  for (const k of SECRET_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedNodeEnv;
  vi.resetModules();
});

describe("fail-closed boot on empty env", () => {
  it("defaults every secret to empty and every mock flag to false", async () => {
    const { config } = await import("../src/config/env");
    expect(config.razorpay.keyId).toBe("");
    expect(config.razorpay.keySecret).toBe("");
    expect(config.razorpay.webhookSecret).toBe("");
    expect(config.petpooja.appKey).toBe("");
    expect(config.petpooja.appSecret).toBe("");
    expect(config.petpooja.accessToken).toBe("");
    expect(config.porter.apiKey).toBe("");
    expect(config.porter.webhookSecret).toBe("");
    expect(config.mock.paymentGateway).toBe(false);
    expect(config.mock.porterDispatch).toBe(false);
    expect(config.mock.petpoojaPos).toBe(false);
  });

  it("mock flags engage ONLY on the exact string 'true'", async () => {
    process.env.MOCK_PAYMENT_GATEWAY = "1";
    process.env.MOCK_PORTER_DISPATCH = "yes";
    process.env.MOCK_PETPOOJA_POS = "";
    const { config } = await import("../src/config/env");
    expect(config.mock.paymentGateway).toBe(false);
    expect(config.mock.porterDispatch).toBe(false);
    expect(config.mock.petpoojaPos).toBe(false);
  });

  it("assertWebhookSecrets throws on empty env and passes when fully set", async () => {
    let mod = await import("../src/config/env");
    expect(() => mod.assertWebhookSecrets()).toThrow(/missing secrets/);
    for (const k of SECRET_KEYS.filter((k) => !k.startsWith("MOCK_"))) {
      process.env[k] = `test_value_for_${k}`;
    }
    vi.resetModules();
    mod = await import("../src/config/env");
    expect(() => mod.assertWebhookSecrets()).not.toThrow();
  });

  it("assertProductionKeys refuses empty env, mock flags, and mock-like secrets", async () => {
    process.env.NODE_ENV = "production";
    let mod = await import("../src/config/env");
    expect(() => mod.assertProductionKeys()).toThrow(/FATAL/);
    for (const k of SECRET_KEYS.filter((k) => !k.startsWith("MOCK_"))) {
      process.env[k] = `live_value_for_${k}`;
    }
    vi.resetModules();
    mod = await import("../src/config/env");
    expect(() => mod.assertProductionKeys()).not.toThrow();
    process.env.MOCK_PORTER_DISPATCH = "true";
    vi.resetModules();
    const mod2 = await import("../src/config/env");
    expect(() => mod2.assertProductionKeys()).toThrow(/mock mode active in production/);
  });

  it("deploymentEnv refuses ambiguity and honors explicit declaration (Readiness-2)", async () => {
    // Neither BURGONOMICS_ENV nor NODE_ENV (beforeEach cleared both) → FATAL.
    let mod = await import("../src/config/env");
    expect(() => mod.deploymentEnv()).toThrow(/BURGONOMICS_ENV/);
    expect(() => mod.assertProductionKeys()).toThrow(/BURGONOMICS_ENV/);

    process.env.BURGONOMICS_ENV = "bogus";
    vi.resetModules();
    mod = await import("../src/config/env");
    expect(() => mod.deploymentEnv()).toThrow(/BURGONOMICS_ENV/);

    process.env.BURGONOMICS_ENV = "staging";
    vi.resetModules();
    mod = await import("../src/config/env");
    expect(mod.deploymentEnv()).toBe("staging");
    // Staging enforces secrets on empty env but allows mocks.
    expect(() => mod.assertProductionKeys()).toThrow(/missing secrets/);

    process.env.BURGONOMICS_ENV = "dev";
    vi.resetModules();
    mod = await import("../src/config/env");
    expect(mod.deploymentEnv()).toBe("dev");
    expect(() => mod.assertProductionKeys()).not.toThrow();

    process.env.BURGONOMICS_ENV = "production";
    vi.resetModules();
    mod = await import("../src/config/env");
    expect(mod.deploymentEnv()).toBe("production");
    // Production WITHOUT NODE_ENV now enforces — the old code slept here.
    expect(() => mod.assertProductionKeys()).toThrow(/FATAL/);
  });

  it("forged webhooks deny on empty env with zero writes possible", async () => {
    const security = await import("../src/core/security");
    const { config } = await import("../src/config/env");
    // Empty secrets deny: every verifier returns false on !secret.
    expect(
      security.verifyRazorpayWebhookSignature("raw", "forged", config.razorpay.webhookSecret)
    ).toBe(false);
    expect(
      security.verifyPorterWebhookSignature("raw", "forged", config.porter.webhookSecret)
    ).toBe(false);
    const { verifyPetpoojaSignature } = await import("../src/modules/petpooja/client");
    expect(verifyPetpoojaSignature("raw", "forged")).toBe(false);
    // Dedicated OTP secret throws instead of reusing the webhook secret.
    expect(() => security.getOtpHmacSecret()).toThrow(/OTP_HMAC_SECRET is unset/);
  });

  it("Petpooja middleware 401s on empty env and ignores body.app_key", async () => {
    const { verifyPetpoojaAuth } = await import("../src/core/middleware");
    const { config } = await import("../src/config/env");
    const res: any = {
      status: vi.fn(() => ({ json: vi.fn() })),
    };
    const next = vi.fn();

    // Empty appKey: deny everything, never next().
    verifyPetpoojaAuth({ headers: {}, body: {} } as any, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();

    // Configured: header app_key passes, body.app_key fallback is gone.
    config.petpooja.appKey = "test_pp_app_key";
    const res2: any = { status: vi.fn(() => ({ json: vi.fn() })) };
    const next2 = vi.fn();
    verifyPetpoojaAuth(
      { headers: { "x-petpooja-token": "test_pp_app_key" }, body: {} } as any,
      res2,
      next2
    );
    expect(next2).toHaveBeenCalledTimes(1);

    // Outbound bearers are never valid inbound credentials.
    config.petpooja.accessToken = "test_pp_access_token";
    config.petpooja.appSecret = "test_pp_app_secret";
    for (const bad of ["test_pp_access_token", "test_pp_app_secret", "wrong"]) {
      const r: any = { status: vi.fn(() => ({ json: vi.fn() })) };
      const n = vi.fn();
      verifyPetpoojaAuth(
        { headers: { "x-petpooja-token": bad }, body: {} } as any,
        r,
        n
      );
      expect(r.status).toHaveBeenCalledWith(401);
      expect(n).not.toHaveBeenCalled();
    }

    // Body-only app_key no longer authenticates.
    const rBody: any = { status: vi.fn(() => ({ json: vi.fn() })) };
    const nBody = vi.fn();
    verifyPetpoojaAuth(
      { headers: {}, body: { app_key: "test_pp_app_key" } } as any,
      rBody,
      nBody
    );
    expect(rBody.status).toHaveBeenCalledWith(401);
    expect(nBody).not.toHaveBeenCalled();
  });
});
