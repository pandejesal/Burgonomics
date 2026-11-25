import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";

/**
 * SEC-11 (A3 finding 6): POST /support/feedback must prove the caller owns the
 * order id it attaches.
 *
 * Before the fix the route wrote `orderId: req.body.orderId` verbatim, so any
 * signed-in caller could file feedback against someone else's order (polluting
 * the per-order support trail and probing which ids exist). These cases drive
 * the REAL Express handler through the real middleware; nothing is stubbed
 * except the Firestore reads/writes and the token verifier.
 */
vi.hoisted(() => {
  process.env.BURGONOMICS_ENV = "dev";
  process.env.APP_CHECK_ENFORCEMENT = "";
});

const h = vi.hoisted(() => {
  const docs = new Map<string, any>();
  const writes: Array<{ path: string; data: any }> = [];
  const verifyIdToken = vi.fn(async (token: string) => {
    if (token === "owner-token") return { uid: "u_owner", role: "customer" };
    if (token === "other-token") return { uid: "u_other", role: "customer" };
    throw new Error("invalid token");
  });

  const docRef = (path: string) => ({
    path,
    id: path.split("/").pop(),
    get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
    set: async (data: any, options?: any) => {
      writes.push({ path, data });
      const next = options?.merge && docs.get(path) ? { ...docs.get(path) } : {};
      for (const [k, v] of Object.entries(data)) {
        if (v === "DELETE") delete next[k];
        else next[k] = v;
      }
      docs.set(path, next);
    },
  });

  const db = {
    collection(name: string) {
      return {
        doc: (id: string) => docRef(`${name}/${id}`),
      };
    },
  };

  const messaging = {
    send: vi.fn(async () => "id"),
    sendEachForMulticast: vi.fn(async () => ({ successCount: 0, failureCount: 0, responses: [] })),
    subscribeToTopic: vi.fn(async () => ({ failureCount: 0 })),
    unsubscribeFromTopic: vi.fn(async () => ({ failureCount: 0 })),
  };

  return { docs, writes, verifyIdToken, db, messaging };
});

vi.mock("../src/core/firebase", () => ({
  db: h.db,
  auth: { verifyIdToken: h.verifyIdToken },
  messaging: h.messaging,
}));

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "UNIT_TIMESTAMP",
    arrayUnion: (value: unknown) => ({ union: value }),
    arrayRemove: (...values: unknown[]) => ({ remove: values }),
    delete: () => "DELETE",
  };
  const firestoreFn: any = vi.fn(() => h.db);
  firestoreFn.FieldValue = FieldValue;
  return {
    default: {
      firestore: firestoreFn,
      auth: vi.fn(() => ({ verifyIdToken: h.verifyIdToken })),
      messaging: vi.fn(() => h.messaging),
      appCheck: vi.fn(() => ({ verifyToken: vi.fn(async () => ({})) })),
      initializeApp: vi.fn(),
      apps: [{ name: "mock" }],
    },
    firestore: firestoreFn,
    auth: vi.fn(() => ({ verifyIdToken: h.verifyIdToken })),
    messaging: vi.fn(() => h.messaging),
    appCheck: vi.fn(() => ({ verifyToken: vi.fn(async () => ({})) })),
    initializeApp: vi.fn(),
    apps: [{ name: "mock" }],
  };
});

import { app } from "../src/index";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  h.docs.clear();
  h.writes.length = 0;
  h.docs.set("orders/ord_mine", { customerId: "u_owner", totals: { grandTotal: 100 } });
  h.docs.set("orders/ord_legacy", { userId: "u_owner", totals: { grandTotal: 100 } });
  h.docs.set("orders/ord_someone_else", { customerId: "u_other", totals: { grandTotal: 100 } });
});

function post(body: Record<string, unknown>, token = "owner-token") {
  return fetch(`${baseUrl}/support/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

function feedbackWrites() {
  return h.writes.filter((w) => w.path.startsWith("support_feedback/"));
}

describe("POST /support/feedback order ownership", () => {
  it("accepts feedback on the caller's own order", async () => {
    const res = await post({ rating: 5, comment: "great", orderId: "ord_mine" });
    expect(res.status).toBe(201);
    expect(feedbackWrites()).toHaveLength(1);
    expect(feedbackWrites()[0].data.orderId).toBe("ord_mine");
    expect(feedbackWrites()[0].data.customerId).toBe("u_owner");
  });

  it("accepts a legacy order bound by userId only", async () => {
    const res = await post({ rating: 4, orderId: "ord_legacy" });
    expect(res.status).toBe(201);
    expect(feedbackWrites()[0].data.orderId).toBe("ord_legacy");
  });

  it("refuses another customer's order with 403 and writes nothing", async () => {
    const res = await post({ rating: 1, comment: "spam", orderId: "ord_someone_else" });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("FEEDBACK_ORDER_FORBIDDEN");
    expect(feedbackWrites()).toHaveLength(0);
  });

  it("refuses a non-existent order with the SAME 403 (no id probing)", async () => {
    const missing = await post({ rating: 1, orderId: "ord_does_not_exist" });
    const foreign = await post({ rating: 1, orderId: "ord_someone_else" });
    expect(missing.status).toBe(403);
    expect(foreign.status).toBe(403);
    expect(await missing.json()).toMatchObject({ code: "FEEDBACK_ORDER_FORBIDDEN" });
    expect(feedbackWrites()).toHaveLength(0);
  });

  it("still records feedback with orderId null when none is supplied", async () => {
    const res = await post({ rating: 3, comment: "fine" });
    expect(res.status).toBe(201);
    expect(feedbackWrites()[0].data.orderId).toBeNull();
  });

  it("requires authentication before any order lookup", async () => {
    const res = await fetch(`${baseUrl}/support/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rating: 5 }),
    });
    expect(res.status).toBe(401);
    expect(feedbackWrites()).toHaveLength(0);
  });
});
