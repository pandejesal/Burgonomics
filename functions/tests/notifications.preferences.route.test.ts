/**
 * Route contract for the canonical preferences read/write (customer C-01/C-02
 * depends on it):
 *   GET  /notifications/preferences?installationId=... -> 200
 *        {installationId, notificationPrefs, version, exists}
 *        absent record => defaults + version 0 + exists:false (never 404)
 *        missing auth => 401, invalid installationId => 400
 *   POST 409 => {error, code, currentVersion, currentPrefs}; stale replay 200.
 *
 * Boots the real Express app against an in-memory Firestore-shaped fake; no
 * network, no emulator.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";

vi.hoisted(() => {
  process.env.BURGONOMICS_ENV = "dev";
  process.env.APP_CHECK_ENFORCEMENT = "";
});

const h = vi.hoisted(() => {
  const prefs = new Map<string, any>();
  const verifyIdToken = vi.fn(async (token: string) => {
    if (token !== "valid-token") throw new Error("invalid token");
    return { uid: "unit_user", role: "customer" };
  });

  const keyOf = (path: string) => {
    const [, uid, , installationId] = path.split("/");
    return `${uid}/${installationId}`;
  };

  const db = {
    collection(name: string) {
      if (name !== "users") throw new Error(`unexpected collection: ${name}`);
      return {
        doc(uid: string) {
          return {
            collection(sub: string) {
              if (sub !== "device_prefs") throw new Error(`unexpected sub: ${sub}`);
              return {
                doc(installationId: string) {
                  const path = `users/${uid}/device_prefs/${installationId}`;
                  return {
                    id: installationId,
                    path,
                    get: async () => ({
                      exists: prefs.has(keyOf(path)),
                      data: () => prefs.get(keyOf(path)) || {},
                    }),
                  };
                },
              };
            },
          };
        },
      };
    },
    runTransaction: async (fn: any) => {
      const writes: Array<{ path: string; data: any }> = [];
      const result = await fn({
        get: async (ref: any) => ({
          exists: prefs.has(keyOf(ref.path)),
          data: () => prefs.get(keyOf(ref.path)) || {},
        }),
        set: (ref: any, data: any) => writes.push({ path: ref.path, data }),
      });
      for (const write of writes) {
        const key = keyOf(write.path);
        prefs.set(key, { ...(prefs.get(key) || {}), ...write.data });
      }
      return result;
    },
  };

  const messaging = {
    send: vi.fn(async () => "id"),
    sendEachForMulticast: vi.fn(async () => ({ successCount: 0, failureCount: 0, responses: [] })),
    subscribeToTopic: vi.fn(async () => ({ failureCount: 0 })),
    unsubscribeFromTopic: vi.fn(async () => ({ failureCount: 0 })),
  };

  return { prefs, verifyIdToken, db, messaging };
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
  h.prefs.clear();
  h.verifyIdToken.mockClear();
});

function getPrefs(query: string, token?: string) {
  return fetch(`${baseUrl}/notifications/preferences${query}`, {
    method: "GET",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

function postPrefs(body: Record<string, unknown>, token = "valid-token") {
  return fetch(`${baseUrl}/notifications/preferences`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

describe("GET /notifications/preferences", () => {
  it("401 without a bearer token", async () => {
    const res = await getPrefs("?installationId=install_unit_1");
    expect(res.status).toBe(401);
  });

  it("400 for a missing or malformed installationId", async () => {
    expect((await getPrefs("", "valid-token")).status).toBe(400);
    expect((await getPrefs("?installationId=short", "valid-token")).status).toBe(400);
    expect((await getPrefs("?installationId=bad value", "valid-token")).status).toBe(400);
  });

  it("200 with documented defaults, version 0 and exists:false for an absent record", async () => {
    const res = await getPrefs("?installationId=install_absent", "valid-token");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      installationId: "install_absent",
      version: 0,
      exists: false,
      notificationPrefs: {
        offers: true,
        orderUpdates: true,
        announcements: false,
        supportReplies: true,
      },
    });
  });

  it("200 with the canonical record for an existing installation", async () => {
    h.prefs.set("unit_user/install_unit_1", {
      version: 7,
      notificationPrefs: { announcements: true, offers: false },
    });
    const res = await getPrefs("?installationId=install_unit_1", "valid-token");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      installationId: "install_unit_1",
      version: 7,
      exists: true,
      notificationPrefs: {
        offers: false,
        orderUpdates: true,
        announcements: true,
        supportReplies: true,
      },
    });
  });
});

describe("POST /notifications/preferences conflict envelope", () => {
  it("409 carries currentVersion/currentPrefs for the customer rebase card", async () => {
    h.prefs.set("unit_user/install_unit_1", {
      version: 4,
      notificationPrefs: { offers: false, announcements: true },
    });
    const res = await postPrefs({
      installationId: "install_unit_1",
      notificationPrefs: { offers: true },
      expectedVersion: 3,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "preferences version conflict",
      code: "PREF_VERSION_CONFLICT",
      currentVersion: 4,
      currentPrefs: {
        offers: false,
        orderUpdates: true,
        announcements: true,
        supportReplies: true,
      },
    });
  });

  it("409 idempotency_conflict carries the same current values", async () => {
    h.prefs.set("unit_user/install_unit_1", {
      version: 2,
      notificationPrefs: { offers: false },
      recentMutations: [{ mutationId: "mutation_unit_1", version: 2, prefsHash: "offers:0", prefs: { offers: false } }],
    });
    const res = await postPrefs({
      installationId: "install_unit_1",
      notificationPrefs: { announcements: false },
      expectedVersion: 2,
      mutationId: "mutation_unit_1",
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "idempotency conflict",
      code: "idempotency_conflict",
      currentVersion: 2,
      currentPrefs: {
        offers: false,
        orderUpdates: true,
        announcements: false,
        supportReplies: true,
      },
    });
  });

  it("a stale replay stays 200 with currentVersion/currentPrefs", async () => {
    h.prefs.set("unit_user/install_unit_1", {
      version: 5,
      notificationPrefs: { offers: false },
      recentMutations: [
        {
          mutationId: "mutation_unit_1",
          version: 2,
          prefsHash: "offers:0",
          prefs: { offers: false, orderUpdates: true, announcements: false, supportReplies: true },
        },
      ],
    });
    const res = await postPrefs({
      installationId: "install_unit_1",
      notificationPrefs: { offers: false },
      expectedVersion: 5,
      mutationId: "mutation_unit_1",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      replicated: true,
      version: 2,
      stale: true,
      currentVersion: 5,
    });
    expect(body.currentPrefs).toEqual({
      offers: false,
      orderUpdates: true,
      announcements: false,
      supportReplies: true,
    });
  });
});
