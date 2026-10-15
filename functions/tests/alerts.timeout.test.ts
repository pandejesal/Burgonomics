import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

const { mockDb, setCalls } = vi.hoisted(() => {
  const setCalls: any[] = [];
  const mockDb: any = {
    collection: (_col: string) => ({
      doc: (_id: string) => ({
        set: vi.fn(async (data: any) => {
          setCalls.push(data);
        }),
      }),
    }),
  };
  return { mockDb, setCalls };
});

vi.mock("firebase-admin", () => {
  const FieldValue = { serverTimestamp: () => "MOCK_TIMESTAMP" };
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

import { captureErrorSnapshot } from "../src/core/errors";
import { config } from "../src/config/env";

/**
 * P2 (finding 13): alert webhook fetches must carry an abort timeout —
 * captureErrorSnapshot AWAITS dispatchDeveloperAlert on inline request paths,
 * so a hung Slack/Discord endpoint must not hold the caller until the
 * platform kills the function.
 */

const originalFetch = globalThis.fetch;
let fetchCalls: Array<{ url: string; init: any }> = [];
let fetchBehavior: "ok" | "reject" = "ok";

beforeAll(() => {
  globalThis.fetch = vi.fn(async (url: any, init: any) => {
    fetchCalls.push({ url: String(url), init });
    if (fetchBehavior === "reject") throw new Error("webhook unreachable");
    return new Response("ok", { status: 200 });
  }) as any;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

let savedAlerts: any = {};

beforeEach(() => {
  savedAlerts = { ...config.alerts };
  config.alerts.slackWebhookUrl = "https://hooks.slack.test/services/T00/B00/XXX";
  config.alerts.discordWebhookUrl = "https://discord.test/api/webhooks/1/abc";
  fetchCalls = [];
  fetchBehavior = "ok";
  for (const k of Object.keys(setCalls)) delete (setCalls as any)[k];
  setCalls.length = 0;
});

afterEach(() => {
  config.alerts.slackWebhookUrl = savedAlerts.slackWebhookUrl;
  config.alerts.discordWebhookUrl = savedAlerts.discordWebhookUrl;
});

describe("alert webhook timeouts (P2 finding 13)", () => {
  it("Slack + Discord alert fetches carry an AbortSignal timeout", async () => {
    const id = await captureErrorSnapshot({
      source: "tests",
      severity: "high",
      message: "timeout rig probe",
    });

    expect(id).toMatch(/^err_/);
    expect(setCalls).toHaveLength(1); // snapshot still written to Firestore
    expect(fetchCalls).toHaveLength(2);
    for (const call of fetchCalls) {
      expect(call.init?.signal).toBeInstanceOf(AbortSignal);
      expect(call.init.signal.aborted).toBe(false);
    }
    expect(fetchCalls.map((c) => c.url)).toEqual(
      expect.arrayContaining([
        "https://hooks.slack.test/services/T00/B00/XXX",
        "https://discord.test/api/webhooks/1/abc",
      ])
    );
  });

  it("a rejecting webhook never breaks captureErrorSnapshot (alert path is best-effort)", async () => {
    fetchBehavior = "reject";
    const id = await captureErrorSnapshot({
      source: "tests",
      severity: "p0_critical",
      message: "webhook down probe",
    });
    expect(id).toMatch(/^err_/);
    expect(fetchCalls).toHaveLength(2); // both attempted, both failed quietly
    expect(setCalls).toHaveLength(1);
  });

  it("medium severity never touches the webhooks", async () => {
    await captureErrorSnapshot({ source: "tests", severity: "medium", message: "quiet probe" });
    expect(fetchCalls).toHaveLength(0);
    expect(setCalls).toHaveLength(1);
  });
});

/**
 * Live finding (2026-10-15): every Petpooja snapshot insert threw
 * `Cannot use "undefined" as a Firestore value (found in field "customerId")`
 * — the four optional refs and `context` were written as explicit `undefined`
 * whenever a caller omitted them. The throw was swallowed by
 * captureErrorSnapshot's own catch, so NO dev_error_snapshots row was ever
 * persisted for a Petpooja failure: the "manual review required" / "KOT push
 * failed" trail ops depends on silently did not exist, while the endpoint
 * still answered 200. Firestore rejects explicit undefined, so the key must
 * be omitted entirely.
 */
describe("captureErrorSnapshot — never writes an undefined field value", () => {
  it("omits absent optional refs instead of writing undefined", async () => {
    await captureErrorSnapshot({
      source: "petpooja",
      severity: "medium",
      message: "Petpooja 86ing webhook arrived without item_id",
    });

    expect(setCalls).toHaveLength(1);
    const written = setCalls[0];
    const undefinedKeys = Object.entries(written)
      .filter(([, value]) => value === undefined)
      .map(([key]) => key);
    expect(undefinedKeys).toEqual([]);
    // The specific keys that used to be written as undefined.
    expect(Object.prototype.hasOwnProperty.call(written, "customerId")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(written, "razorpayPaymentId")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(written, "porterOrderId")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(written, "petpoojaOrderId")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(written, "context")).toBe(false);
    expect(written.id).toMatch(/^err_/);
  });

  it("still persists and masks the refs a caller does supply", async () => {
    await captureErrorSnapshot({
      source: "petpooja",
      severity: "medium",
      message: "KOT push failed for order ord_1",
      orderId: "ord_1",
      branchId: "br_1",
      petpoojaOrderId: "PP-123456",
      context: { attempt: 1, phone: "+919825000001", token: "SHOULD_BE_DROPPED" },
    });

    const written = setCalls[0];
    expect(written.petpoojaOrderId).toBe("PP****56");
    expect(written.orderId).toBe("ord_1");
    expect(written.branchId).toBe("br_1");
    // Forbidden context keys dropped, safe ones kept.
    expect(written.context).toEqual({ attempt: 1 });
    const undefinedKeys = Object.entries(written)
      .filter(([, value]) => value === undefined)
      .map(([key]) => key);
    expect(undefinedKeys).toEqual([]);
  });
});
