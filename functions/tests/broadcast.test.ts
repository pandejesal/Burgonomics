import { describe, it, expect, vi, beforeEach } from "vitest";

// Readiness-8 rig: broadcast lists registered tokens (bounded wave),
// multicasts through the stubbed sender (VITEST=true reports all-success),
// and records measured counts — never estimates.
const { mockDb, savedDocs } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const docRef = (colName: string, docId: string) => ({
    id: docId,
    path: `${colName}/${docId}`,
    get: vi.fn(async () => ({
      exists: !!savedDocs[`${colName}/${docId}`],
      data: () => savedDocs[`${colName}/${docId}`] || {},
    })),
    set: vi.fn(async (data: any, options?: any) => {
      const p = `${colName}/${docId}`;
      savedDocs[p] =
        options?.merge && savedDocs[p] ? { ...savedDocs[p], ...data } : data;
    }),
  });
  let autoId = 0;
  const mockDb: any = {
    collection: (colName: string) => ({
      doc: (docId?: string) => {
        if (!docId) {
          autoId += 1;
          docId = `auto_${autoId}`;
        }
        return docRef(colName, docId);
      },
      limit: (_n: number) => ({
        get: vi.fn(async () => {
          const docs = Object.entries(savedDocs)
            .filter(([p]) => p.startsWith(`${colName}/`))
            .map(([p, d]) => ({ id: p.split("/")[1], data: () => d }));
          return { docs, forEach: (fn: any) => docs.forEach(fn) };
        }),
      }),
      add: vi.fn(async (data: any) => {
        autoId += 1;
        savedDocs[`${colName}/auto_${autoId}`] = data;
        return { id: `auto_${autoId}` };
      }),
    }),
  };
  return { mockDb, savedDocs };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TIMESTAMP",
    increment: (n: number) => n,
    arrayUnion: (item: any) => [item],
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

import { broadcastToDevices } from "../src/modules/notifications/broadcast";

const CALLER: any = { uid: "brand_1", email: "owner@burgonomics.in" };

describe("Readiness-8: customer broadcast", () => {
  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
  });

  it("sends to registered tokens and records measured counts", async () => {
    savedDocs["device_tokens/tok_a"] = { token: "tok_a", userId: "c1" };
    savedDocs["device_tokens/tok_b"] = { token: "tok_b", userId: "c2" };
    savedDocs["device_tokens/tok_a_dup"] = { token: "tok_a", userId: "c1" };
    const res = await broadcastToDevices(
      { title: "BOGO Live", body: "Double cheese, today only" },
      CALLER
    );
    expect(res.success).toBe(true);
    expect(res.targeted).toBe(2); // deduped
    expect(res.successCount).toBe(2);
    expect(res.failureCount).toBe(0);
    const casts = Object.entries(savedDocs).filter(([p]) =>
      p.startsWith("broadcasts/")
    );
    expect(casts).toHaveLength(1);
    const [, cast] = casts[0] as [string, any];
    expect(cast.title).toBe("BOGO Live");
    expect(cast.targeted).toBe(2);
    expect(cast.successCount).toBe(2);
    expect(cast.sentByUid).toBe("brand_1");
    const audits = Object.entries(savedDocs).filter(([p]) =>
      p.startsWith("admin_audit_logs/")
    );
    expect(audits).toHaveLength(1);
    expect((audits[0][1] as any).action).toBe("broadcast_sent");
  });

  it("reports honest zeros with no tokens, still recording the wave", async () => {
    const res = await broadcastToDevices(
      { title: "Quiet", body: "Nobody home" },
      CALLER
    );
    expect(res.targeted).toBe(0);
    expect(res.successCount).toBe(0);
    const casts = Object.entries(savedDocs).filter(([p]) =>
      p.startsWith("broadcasts/")
    );
    expect(casts).toHaveLength(1);
  });

  it("rejects empty title/body", async () => {
    await expect(
      broadcastToDevices({ title: "", body: "x" }, CALLER)
    ).rejects.toThrow();
    await expect(
      broadcastToDevices({ title: "x", body: "  " }, CALLER)
    ).rejects.toThrow();
  });
});
