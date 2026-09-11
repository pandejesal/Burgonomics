import { describe, it, expect, vi, beforeEach } from "vitest";

// Loop 37/120: drives the REAL unregisterDeviceToken against a mocked
// Firestore — logout detach must delete the token identity and scrub every
// fan-out list, and tolerate already-clean state.

const { mockDb, savedDocs, calls } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const calls: { deleted: string[]; updated: string[] } = { deleted: [], updated: [] };
  const docRef = (colName: string, docId: string) => ({
    id: docId,
    path: `${colName}/${docId}`,
    ref: { path: `${colName}/${docId}` },
    get: vi.fn(async () => ({
      exists: !!savedDocs[`${colName}/${docId}`],
      data: () => savedDocs[`${colName}/${docId}`] || {},
    })),
    set: vi.fn(async (data: any, options?: any) => {
      const docPath = `${colName}/${docId}`;
      savedDocs[docPath] =
        options?.merge && savedDocs[docPath] ? { ...savedDocs[docPath], ...data } : data;
    }),
    update: vi.fn(async (data: any) => {
      const docPath = `${colName}/${docId}`;
      calls.updated.push(docPath);
      savedDocs[docPath] = { ...(savedDocs[docPath] || {}), ...data };
    }),
    delete: vi.fn(async () => {
      const docPath = `${colName}/${docId}`;
      calls.deleted.push(docPath);
      delete savedDocs[docPath];
    }),
  });
  const mockDb = {
    collection: (colName: string) => ({
      doc: (docId?: string) => docRef(colName, docId || `mock_${Math.random().toString(36).slice(2, 8)}`),
      where: () => ({
        limit: () => ({
          get: async () => ({
            forEach: (cb: (d: any) => void) => {
              Object.keys(savedDocs)
                .filter((p) => p.startsWith(`${colName}/`))
                .forEach((p) => cb({ ref: docRef(colName, p.split("/")[1]) }));
            },
          }),
        }),
      }),
    }),
  };
  return { mockDb, savedDocs, calls };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_SERVER_TIMESTAMP",
    increment: (n: number) => n,
    arrayUnion: (item: any) => [item],
    arrayRemove: (item: any) => [item],
    delete: () => "MOCK_DELETE",
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

import { unregisterDeviceToken } from "../src/modules/notifications/unregisterToken";

describe("unregisterDeviceToken", () => {
  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    calls.deleted.length = 0;
    calls.updated.length = 0;
  });

  it("deletes the token doc and scrubs every fan-out list", async () => {
    savedDocs["device_tokens/tok_1"] = { token: "tok_1", userId: "u1" };
    savedDocs["users/u1"] = { fcmTokens: ["tok_1", "tok_9"] };
    savedDocs["users/u2"] = { fcmTokens: ["tok_1"] };
    const res = await unregisterDeviceToken({ token: "tok_1", uid: "u1" });
    expect(res.success).toBe(true);
    expect(calls.deleted).toContain("device_tokens/tok_1");
    expect(calls.updated).toContain("users/u1");
    expect(calls.updated).toContain("users/u2");
    expect(res.removedFromUsers).toBe(2);
  });

  it("succeeds silently on unknown tokens (idempotent logout)", async () => {
    const res = await unregisterDeviceToken({ token: "tok_ghost", uid: "u1" });
    expect(res.success).toBe(true);
    expect(calls.deleted).toEqual([]);
  });
});
