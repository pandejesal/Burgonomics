import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Dispatch test-window readiness preflight (round-3 N1/N2, controller C06/C11/C13).
 *
 * Hermetic: proves the gate refuses fake/live evidence and, equally important,
 * that it is INERT unless explicitly opted in — dev and production behaviour must
 * be unchanged. No provider is called here.
 */
const { mockDb } = vi.hoisted(() => {
  const mockDb: any = {
    collection: () => ({
      doc: () => ({
        get: vi.fn(async () => ({ exists: false, data: () => undefined, ref: {} })),
        set: vi.fn(async () => undefined),
      }),
      where: () => ({
        limit: () => ({ get: async () => ({ empty: true, docs: [] }) }),
      }),
    }),
    runTransaction: vi.fn(async (fn: any) =>
      fn({ get: (r: any) => r.get(), set: (r: any, d: any, o?: any) => r.set(d, o) })
    ),
  };
  return { mockDb };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TIMESTAMP",
    increment: (n: number) => n,
    arrayUnion: (item: any) => [item],
  };
  const firestoreFn: any = vi.fn(() => mockDb);
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

import { config } from "../src/config/env";
import {
  assertDispatchReadinessIfRequired,
  assertDispatchTestReadiness,
  dispatchReadinessReport,
  BORZO_PRODUCTION_HOST,
  BORZO_TEST_HOST,
} from "../src/modules/dispatch/readiness";
import { dispatchBook, dispatchQuote } from "../src/modules/dispatch/dispatch.router";

/** A distinctive value so a leak assertion cannot pass by accident. */
const FAKE_KEY = "borzo-key-must-never-appear-9f3c";

const saved = {
  borzo: { ...config.borzo },
  shadowfax: { ...config.shadowfax },
  porter: { ...config.porter },
  mock: { ...config.mock },
  dispatch: { ...config.dispatch },
};

/** The agreed test-window configuration (N2: Porter disabled, mocks off). */
function setTestWindow() {
  config.borzo.enabled = true;
  config.borzo.apiKey = FAKE_KEY;
  config.borzo.baseUrl = `https://${BORZO_TEST_HOST}`;
  config.shadowfax.enabled = false;
  config.shadowfax.apiKey = "";
  config.shadowfax.clientCode = "";
  config.shadowfax.webhookSecret = "";
  config.porter.enabled = false;
  config.porter.apiKey = "";
  config.porter.customerId = "";
  config.porter.webhookSecret = "";
  config.mock.borzoDispatch = false;
  config.mock.shadowfaxDispatch = false;
  config.mock.porterDispatch = false;
  config.dispatch.requireLive = true;
}

beforeEach(() => {
  setTestWindow();
});

afterEach(() => {
  config.borzo = { ...saved.borzo };
  config.shadowfax = { ...saved.shadowfax };
  config.porter = { ...saved.porter };
  config.mock = { ...saved.mock };
  config.dispatch = { ...saved.dispatch };
});

describe("dispatch test-window readiness", () => {
  it("passes for the agreed test window (Borzo test host, mocks off, Porter disabled)", () => {
    const report = assertDispatchTestReadiness();
    expect(report.violations).toEqual([]);
    const borzo = report.providers.find((p) => p.provider === "borzo")!;
    expect(borzo.eligible).toBe(true);
    expect(borzo.mock).toBe(false);
    expect(borzo.host).toBe(BORZO_TEST_HOST);
    expect(borzo.testHost).toBe(true);
    // The two providers that must not be called in this run are genuinely excluded.
    expect(report.providers.find((p) => p.provider === "shadowfax")!.eligible).toBe(false);
    expect(report.providers.find((p) => p.provider === "porter")!.eligible).toBe(false);
  });

  it("refuses when a dispatch mock is active", () => {
    config.mock.borzoDispatch = true;
    const report = dispatchReadinessReport();
    expect(report.violations.join(" ")).toContain("borzo: MOCK dispatch is ON");
    expect(() => assertDispatchTestReadiness()).toThrow(/readiness FAILED/);
  });

  it("refuses when the test courier points at a LIVE host", () => {
    config.borzo.baseUrl = `https://${BORZO_PRODUCTION_HOST}`;
    const report = dispatchReadinessReport();
    expect(report.violations.join(" ")).toContain(`not the TEST host '${BORZO_TEST_HOST}'`);
    expect(() => assertDispatchTestReadiness()).toThrow(/live host/);
  });

  it("refuses when Porter is left eligible (it can win the bid and divert to the manual lane)", () => {
    config.porter.enabled = true;
    expect(dispatchReadinessReport().violations.join(" ")).toContain("porter: eligible");
  });

  it("refuses when Shadowfax becomes eligible while its contract is unverified", () => {
    config.shadowfax.enabled = true;
    config.shadowfax.apiKey = "sfx-placeholder";
    config.shadowfax.clientCode = "sfx-client";
    expect(dispatchReadinessReport().violations.join(" ")).toContain("shadowfax: eligible");
  });

  it("refuses when the agreed test courier is disabled or unkeyed", () => {
    config.borzo.enabled = false;
    expect(dispatchReadinessReport().violations.join(" ")).toContain("borzo: disabled");
    config.borzo.enabled = true;
    config.borzo.apiKey = "";
    expect(dispatchReadinessReport().violations.join(" ")).toContain("borzo: enabled without an API key");
  });

  it("never puts a credential value in the report or the thrown message", () => {
    config.mock.borzoDispatch = true; // force a violation while a key is present
    const report = dispatchReadinessReport();
    expect(JSON.stringify(report)).not.toContain(FAKE_KEY);
    let message = "";
    try {
      assertDispatchTestReadiness();
    } catch (err: any) {
      message = String(err?.message || "");
    }
    expect(message).toContain("readiness FAILED");
    expect(message).not.toContain(FAKE_KEY);
    // The report names hosts and booleans only.
    expect(JSON.stringify(report)).toContain(BORZO_TEST_HOST);
  });

  it("is INERT unless opted in: no refusal with requireLive=false, refusal with it true", () => {
    config.mock.borzoDispatch = true; // would refuse if the gate were always on
    config.dispatch.requireLive = false;
    expect(assertDispatchReadinessIfRequired()).toBeNull();

    config.dispatch.requireLive = true;
    expect(() => assertDispatchReadinessIfRequired()).toThrow(/readiness FAILED/);
  });

  it("guards dispatchQuote and dispatchBook first when opted in", async () => {
    config.mock.borzoDispatch = true;
    const quoteErr: any = await dispatchQuote({
      pickupLat: 23.0131,
      pickupLng: 72.5085,
      dropLat: 23.0338,
      dropLng: 72.5262,
      customerName: "E2E TEST",
      customerPhone: "+919999900000",
      orderId: "ord_e2e_disp_readiness",
    } as any).then(
      () => null,
      (e) => e
    );
    expect(String(quoteErr?.message || "")).toContain("readiness FAILED");

    const bookErr: any = await dispatchBook({ orderId: "ord_e2e_disp_readiness" } as any).then(
      () => null,
      (e) => e
    );
    expect(String(bookErr?.message || "")).toContain("readiness FAILED");
  });
});

describe("DISPATCH_REQUIRE_LIVE defaults", () => {
  it("is false when unset, so production and dev keep their current behaviour", async () => {
    const previous = process.env.DISPATCH_REQUIRE_LIVE;
    delete process.env.DISPATCH_REQUIRE_LIVE;
    vi.resetModules();
    try {
      const fresh = await import("../src/config/env");
      expect(fresh.config.dispatch.requireLive).toBe(false);
    } finally {
      if (previous !== undefined) process.env.DISPATCH_REQUIRE_LIVE = previous;
      vi.resetModules();
    }
  });
});
