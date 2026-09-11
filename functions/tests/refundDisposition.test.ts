import { describe, it, expect, vi, beforeEach } from "vitest";

// Loop 7/120: drives the REAL disposeRefundRequest against a mocked
// Firestore — the reject path must prove it records server-side and refuses
// missing/settled requests loudly.

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
      const docPath = `${colName}/${docId}`;
      savedDocs[docPath] =
        options?.merge && savedDocs[docPath] ? { ...savedDocs[docPath], ...data } : data;
    }),
    update: vi.fn(async (data: any) => {
      const docPath = `${colName}/${docId}`;
      savedDocs[docPath] = { ...(savedDocs[docPath] || {}), ...data };
    }),
  });
  const mockDb = {
    collection: (colName: string) => ({
      doc: (docId?: string) => docRef(colName, docId || `mock_${Math.random().toString(36).slice(2, 8)}`),
    }),
  };
  return { mockDb, savedDocs };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_SERVER_TIMESTAMP",
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

import { disposeRefundRequest } from "../src/modules/payments/refundRequests";

describe("disposeRefundRequest", () => {
  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
  });

  it("rejects a PENDING request and records reason + decider", async () => {
    savedDocs["refunds/rf_1"] = {
      orderId: "ord_1",
      amountPaise: 5000,
      status: "PENDING",
    };
    const res = await disposeRefundRequest({
      refundId: "rf_1",
      reason: "Duplicate request",
      decidedBy: "finance_1",
    });
    expect(res).toMatchObject({ id: "rf_1", status: "REJECTED" });
    expect(savedDocs["refunds/rf_1"].disposition).toMatchObject({
      decision: "rejected",
      reason: "Duplicate request",
      decidedBy: "finance_1",
    });
  });

  it("404s a missing request (no silent no-op)", async () => {
    await expect(
      disposeRefundRequest({ refundId: "rf_missing", reason: "x" })
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("409s an already-settled request (no rewrite of COMPLETED rows)", async () => {
    savedDocs["refunds/rf_done"] = { orderId: "ord_2", status: "COMPLETED" };
    await expect(
      disposeRefundRequest({ refundId: "rf_done", reason: "changed mind" })
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(savedDocs["refunds/rf_done"].disposition).toBeUndefined();
  });
});
