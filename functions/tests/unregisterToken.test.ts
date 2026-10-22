import { describe, it, expect, vi, beforeEach } from "vitest";

// Loop 37/120: drives the REAL unregisterDeviceToken against a mocked
// Firestore — logout detach must delete the token identity and scrub every
// fan-out list, and tolerate already-clean state.
//
// Close-out adaptation (Lane 07, token-unregister-closeout): the source now
// runs the ownership compare+delete and the holders scrub in transactions.
// This fake therefore buffers transaction writes and applies them at commit,
// returns the real QuerySnapshot surface (docs/size/forEach) and interprets
// arrayRemove like Firestore does. None of these gaps were source defects.

const { mockDb, savedDocs, calls } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const calls: { deleted: string[]; updated: string[] } = { deleted: [], updated: [] };

  const applyPatch = (docPath: string, data: Record<string, any>) => {
    const current = savedDocs[docPath];
    if (!current) {
      const err = new Error("NOT_FOUND") as Error & { code?: number };
      err.code = 5;
      throw err;
    }
    const next: Record<string, any> = { ...current };
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === "object" && (value as any).__op === "arrayRemove") {
        next[key] = (current[key] || []).filter(
          (token: string) => !(value as any).vals.includes(token),
        );
      } else {
        next[key] = value;
      }
    }
    savedDocs[docPath] = next;
    calls.updated.push(docPath);
  };

  const documentsMatching = (
    colName: string,
    field: string,
    _op: string,
    value: string,
    limit: number,
  ) => {
    const docs = Object.keys(savedDocs)
      .filter((p) => p.startsWith(`${colName}/`))
      .filter((p) => Array.isArray(savedDocs[p][field]) && savedDocs[p][field].includes(value))
      .slice(0, limit)
      .map((p) => ({
        ref: { path: p, update: async (data: Record<string, any>) => applyPatch(p, data) },
      }));
    return {
      docs,
      size: docs.length,
      forEach: (cb: (d: (typeof docs)[number]) => void) => docs.forEach(cb),
    };
  };

  const docRef = (colName: string, docId: string) => {
    const docPath = `${colName}/${docId}`;
    return {
      id: docId,
      path: docPath,
      ref: { path: docPath },
      get: vi.fn(async () => ({
        exists: !!savedDocs[docPath],
        data: () => savedDocs[docPath] || {},
      })),
      set: vi.fn(async (data: any, options?: any) => {
        savedDocs[docPath] =
          options?.merge && savedDocs[docPath] ? { ...savedDocs[docPath], ...data } : data;
      }),
      update: vi.fn(async (data: Record<string, any>) => applyPatch(docPath, data)),
      delete: vi.fn(async () => {
        calls.deleted.push(docPath);
        delete savedDocs[docPath];
      }),
    };
  };

  const queryAt = (colName: string, field: string, op: string, value: string, limit: number) => ({
    __run: async () => documentsMatching(colName, field, op, value, limit),
    get: async () => documentsMatching(colName, field, op, value, limit),
  });

  const mockDb = {
    collection: (colName: string) => ({
      doc: (docId?: string) =>
        docRef(colName, docId || `mock_${Math.random().toString(36).slice(2, 8)}`),
      where: (field: string, op: string, value: string) => ({
        limit: (n: number) => queryAt(colName, field, op, value, n),
        ...queryAt(colName, field, op, value, 100),
      }),
    }),
    runTransaction: async (fn: (tx: any) => Promise<unknown>) => {
      const bufferedDeletes: string[] = [];
      const bufferedUpdates: Array<{ path: string; data: Record<string, any> }> = [];
      const result = await fn({
        get: async (target: any) =>
          typeof target.__run === "function" ? target.__run() : target.get(),
        delete: (ref: { path: string }) => {
          bufferedDeletes.push(ref.path);
        },
        update: (ref: { path: string }, data: Record<string, any>) => {
          bufferedUpdates.push({ path: ref.path, data });
        },
      });
      // Commit: buffered writes only become visible once the transaction body
      // resolved, exactly like the real client (a mid-flight apply would make
      // the rebind-race test in the ownership suite pass for the wrong reason).
      for (const p of bufferedDeletes) {
        calls.deleted.push(p);
        delete savedDocs[p];
      }
      for (const u of bufferedUpdates) applyPatch(u.path, u.data);
      return result;
    },
  };
  return { mockDb, savedDocs, calls };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_SERVER_TIMESTAMP",
    increment: (n: number) => n,
    arrayUnion: (...vals: any[]) => ({ __op: "arrayUnion", vals }),
    arrayRemove: (...vals: any[]) => ({ __op: "arrayRemove", vals }),
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
    // Unrelated holder on another token: must remain byte-identical.
    savedDocs["users/u3"] = { fcmTokens: ["tok_other"] };
    const res = await unregisterDeviceToken({ token: "tok_1", uid: "u1" });
    expect(res.success).toBe(true);
    expect(calls.deleted).toContain("device_tokens/tok_1");
    expect(calls.updated).toContain("users/u1");
    expect(calls.updated).toContain("users/u2");
    expect(res.removedFromUsers).toBe(2);
    // Exact remaining tokens: only the detached token is gone.
    expect(savedDocs["users/u1"].fcmTokens).toEqual(["tok_9"]);
    expect(savedDocs["users/u2"].fcmTokens).toEqual([]);
    // The unrelated holder was never touched.
    expect(savedDocs["users/u3"].fcmTokens).toEqual(["tok_other"]);
    expect(calls.updated).not.toContain("users/u3");
  });

  it("succeeds silently on unknown tokens (idempotent logout)", async () => {
    const res = await unregisterDeviceToken({ token: "tok_ghost", uid: "u1" });
    expect(res.success).toBe(true);
    expect(res.removedFromUsers).toBe(0);
    expect(calls.deleted).toEqual([]);
    expect(calls.updated).toEqual([]);
  });
});
