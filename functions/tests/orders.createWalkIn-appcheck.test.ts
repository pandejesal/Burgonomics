import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const { verifyToken, verifyIdToken, createWalkIn } = vi.hoisted(() => ({
  verifyToken: vi.fn(),
  verifyIdToken: vi.fn(),
  createWalkIn: vi.fn(),
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

vi.mock("../src/modules/orders/createWalkIn", async () => {
  const actual = await vi.importActual<typeof import("../src/modules/orders/createWalkIn")>(
    "../src/modules/orders/createWalkIn"
  );
  return {
    ...actual,
    createWalkIn,
  };
});

import { app } from "../src/index";
import { config } from "../src/config/env";

let server: Server;
let baseUrl: string;
let previousDeployEnv: string | undefined;
let previousEnforcement: boolean;

beforeAll(async () => {
  // Match the existing real-app route harness: no live production credentials
  // are needed. App Check itself remains the REAL middleware with enforcement
  // explicitly on; its SDK verification is the external boundary stubbed above.
  previousDeployEnv = process.env.BURGONOMICS_ENV;
  previousEnforcement = config.appCheck.enforcement;
  process.env.BURGONOMICS_ENV = "dev";
  config.appCheck.enforcement = true;
  server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
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
  createWalkIn.mockReset();
});

const samplePayload = {
  requestId: "req-appcheck-test-1",
  branchId: "branch-test-1",
  orderType: "takeaway",
  tender: "cash",
  items: [{ productId: "prod-1", quantity: 1 }],
  expectedTotalPaise: 15000,
};

function postCreateWalkIn(
  headers: Record<string, string>,
  body: any = samplePayload
) {
  return fetch(`${baseUrl}/orders/createWalkIn`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /orders/createWalkIn AppCheck enforcement & middleware composition", () => {
  it("CONTROL: an existing protected route rejects missing AppCheck in the same real app", async () => {
    const res = await fetch(`${baseUrl}/orders/bumpStatus`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer valid-auth-token" },
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden: missing App Check token" });
    expect(verifyIdToken).not.toHaveBeenCalled();
    expect(createWalkIn).not.toHaveBeenCalled();
  });

  it("missing AppCheck token under enforcement=true returns 403 before creation", async () => {
    const res = await postCreateWalkIn({
      Authorization: "Bearer valid-auth-token",
    });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json).toEqual({ error: "Forbidden: missing App Check token" });
    expect(verifyToken).not.toHaveBeenCalled();
    expect(verifyIdToken).not.toHaveBeenCalled();
    expect(createWalkIn).not.toHaveBeenCalled();
  });

  it("invalid AppCheck token under enforcement=true returns 403 before creation", async () => {
    verifyToken.mockRejectedValueOnce(new Error("invalid app check token"));
    const res = await postCreateWalkIn({
      "x-firebase-appcheck": "invalid-token",
      Authorization: "Bearer valid-auth-token",
    });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json).toEqual({ error: "Forbidden: invalid App Check token" });
    expect(verifyToken).toHaveBeenCalledWith("invalid-token");
    expect(verifyIdToken).not.toHaveBeenCalled();
    expect(createWalkIn).not.toHaveBeenCalled();
  });

  it("verified AppCheck token with missing/invalid auth returns 401 without entering service", async () => {
    verifyToken.mockResolvedValueOnce({ appId: "valid-app" });
    verifyIdToken.mockRejectedValueOnce(new Error("token revoked"));

    const res = await postCreateWalkIn({
      "x-firebase-appcheck": "valid-appcheck-token",
      Authorization: "Bearer revoked-token",
    });
    expect(res.status).toBe(401);
    expect(verifyToken).toHaveBeenCalledWith("valid-appcheck-token");
    expect(verifyIdToken).toHaveBeenCalledWith("revoked-token", true);
    expect(createWalkIn).not.toHaveBeenCalled();
  });

  it("verified AppCheck token with missing auth header returns 401 without entering service", async () => {
    verifyToken.mockResolvedValueOnce({ appId: "valid-app" });

    const res = await postCreateWalkIn({
      "x-firebase-appcheck": "valid-appcheck-token",
    });
    expect(res.status).toBe(401);
    expect(verifyToken).toHaveBeenCalledWith("valid-appcheck-token");
    expect(verifyIdToken).not.toHaveBeenCalled();
    expect(createWalkIn).not.toHaveBeenCalled();
  });

  it("verified AppCheck and auth still reject injected pricing through the real body schema", async () => {
    verifyToken.mockResolvedValueOnce({ appId: "valid-app" });
    verifyIdToken.mockResolvedValueOnce({ uid: "staff-uid-123" });
    const res = await postCreateWalkIn({
      "x-firebase-appcheck": "valid-appcheck-token",
      Authorization: "Bearer valid-auth-token",
    }, { ...samplePayload, total: 1 });
    expect(res.status).toBe(400);
    expect(verifyToken).toHaveBeenCalledWith("valid-appcheck-token");
    expect(verifyIdToken).toHaveBeenCalledWith("valid-auth-token", true);
    expect(createWalkIn).not.toHaveBeenCalled();
  });

  it("verified AppCheck token + valid auth reaches service and returns 201 receipt", async () => {
    verifyToken.mockResolvedValueOnce({ appId: "valid-app" });
    verifyIdToken.mockResolvedValueOnce({ uid: "staff-uid-123" });
    createWalkIn.mockResolvedValueOnce({
      orderId: "order-123",
      replayed: false,
      status: { code: "PLACED", label: "Order placed", kind: "upcoming", terminal: false },
      paymentStatus: "pending",
      totals: { grandTotal: 150 },
      settlementAvailable: false,
    });

    const res = await postCreateWalkIn({
      "x-firebase-appcheck": "valid-appcheck-token",
      Authorization: "Bearer valid-auth-token",
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json).toMatchObject({ orderId: "order-123", replayed: false });
    expect(verifyToken).toHaveBeenCalledWith("valid-appcheck-token");
    expect(verifyIdToken).toHaveBeenCalledWith("valid-auth-token", true);
    expect(createWalkIn).toHaveBeenCalledWith("staff-uid-123", expect.objectContaining(samplePayload));
  });
});
