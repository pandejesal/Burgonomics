import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * P1 — App Check ENROLMENT proof (real app, enforcement ON).
 *
 * The route list decides who gets attestation. Enrolling a path whose client
 * cannot send `X-Firebase-AppCheck` turns every request into 403 before auth,
 * so the enrolment decision has to be observable, not just asserted in prose:
 *
 *  - `/orders/customerCancel` is NOT enrolled → under enforcement a request
 *    with no App Check token still reaches `requireAuth` (401), never 403.
 *  - `/orders/deliveryOtp` IS enrolled → the same request is refused 403 by
 *    App Check first, and a verified token falls through to `requireAuth` (401).
 *
 * The App Check SDK is the only external boundary stubbed; the middleware, the
 * route list and the auth stack are the real ones from `src/index.ts`.
 */
const { verifyToken, verifyIdToken } = vi.hoisted(() => ({
  verifyToken: vi.fn(),
  verifyIdToken: vi.fn(),
}));

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TIMESTAMP",
    increment: (n: number) => n,
    arrayUnion: (item: any) => [item],
    delete: () => "MOCK_DELETE",
  };
  const firestoreFn: any = vi.fn(() => ({
    collection: vi.fn(() => ({
      doc: vi.fn(() => ({
        get: async () => ({ exists: false, data: () => undefined }),
        set: async () => undefined,
      })),
      where: vi.fn(() => ({ limit: vi.fn(() => ({ get: async () => ({ empty: true, docs: [] }) })) })),
      get: async () => ({ empty: true, docs: [] }),
    })),
    runTransaction: async (fn: any) => fn({ get: async () => ({ exists: false }), set: () => undefined }),
  }));
  firestoreFn.FieldValue = FieldValue;
  const authFn: any = vi.fn(() => ({ verifyIdToken, getUser: vi.fn() }));
  const appCheckFn: any = vi.fn(() => ({ verifyToken }));

  return {
    default: {
      firestore: firestoreFn,
      auth: authFn,
      messaging: vi.fn(() => ({ send: vi.fn() })),
      appCheck: appCheckFn,
      initializeApp: vi.fn(),
      apps: [{ name: "mock" }],
      credential: { cert: vi.fn() },
    },
    firestore: firestoreFn,
    auth: authFn,
    messaging: vi.fn(() => ({ send: vi.fn() })),
    appCheck: appCheckFn,
    initializeApp: vi.fn(),
    apps: [{ name: "mock" }],
    credential: { cert: vi.fn() },
  };
});

import { app } from "../src/index";
import { config } from "../src/config/env";

let server: Server;
let baseUrl: string;
let previousDeployEnv: string | undefined;
let previousEnforcement: boolean;

beforeAll(async () => {
  previousDeployEnv = process.env.BURGONOMICS_ENV;
  previousEnforcement = config.appCheck.enforcement;
  process.env.BURGONOMICS_ENV = "dev";
  config.appCheck.enforcement = true;
  server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  config.appCheck.enforcement = previousEnforcement;
  if (previousDeployEnv === undefined) delete process.env.BURGONOMICS_ENV;
  else process.env.BURGONOMICS_ENV = previousDeployEnv;
});

beforeEach(() => {
  verifyToken.mockReset();
  verifyIdToken.mockReset();
});

function post(path: string, headers: Record<string, string> = {}, body: unknown = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("App Check enrolment under enforcement=true", () => {
  it("CONTROL: an enrolled route refuses a missing token with 403 before auth", async () => {
    const res = await post("/orders/createWalkIn", {}, {
      requestId: "req-control-1",
      branchId: "branch-control-1",
      orderType: "takeaway",
      tender: "cash",
      items: [{ productId: "prod-1", quantity: 1 }],
      expectedTotalPaise: 15000,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden: missing App Check token" });
  });

  it("/orders/customerCancel is NOT attestation-gated: it reaches requireAuth (401)", async () => {
    const res = await post("/orders/customerCancel", {}, { orderId: "ord_appcheck_1" });
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    // A 403 here would mean the route was enrolled without a client that can
    // present a token — the exact regression this pin prevents.
    expect(String(body.error ?? "")).not.toContain("App Check");
  });

  it("/orders/customerCancel ignores a forged token and still answers 401 (no gate)", async () => {
    verifyToken.mockRejectedValue(new Error("forged"));
    const res = await post("/orders/customerCancel", { "x-firebase-appcheck": "forged" }, { orderId: "ord_appcheck_2" });
    expect(res.status).toBe(401);
  });

  it("/orders/deliveryOtp IS attestation-gated: 403 without a token", async () => {
    const res = await post("/orders/deliveryOtp", {}, { orderId: "ord_appcheck_3" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden: missing App Check token" });
  });

  it("/orders/deliveryOtp with a verified token falls through to requireAuth (401)", async () => {
    verifyToken.mockResolvedValue({ appId: "mock" });
    const res = await post("/orders/deliveryOtp", { "x-firebase-appcheck": "verified" }, { orderId: "ord_appcheck_4" });
    expect(res.status).toBe(401);
  });
});
