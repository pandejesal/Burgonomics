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
