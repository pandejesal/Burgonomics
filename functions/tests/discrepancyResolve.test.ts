import { describe, it, expect, vi, beforeEach } from "vitest";

// Loop 25/120: drives the REAL resolveDiscrepancy against a mocked
// Firestore — resolution must record server-side and refuse missing/settled
// rows loudly.

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

import { resolveDiscrepancy } from "../src/modules/payments/discrepancies";

describe("resolveDiscrepancy", () => {
  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
  });

  it("resolves a needs_review row with an attributed record", async () => {
    savedDocs["payment_discrepancies/dis_1"] = {
      orderId: "ord_1",
      reason: "AMOUNT_MISMATCH",
      status: "needs_review",
    };
    const res = await resolveDiscrepancy({
      discrepancyId: "dis_1",
      resolution: "refunded",
      note: "Released via Razorpay",
      decidedBy: "finance_1",
    });
    expect(res).toMatchObject({ id: "dis_1", status: "RESOLVED" });
    expect(savedDocs["payment_discrepancies/dis_1"].resolution).toMatchObject({
      decision: "refunded",
      note: "Released via Razorpay",
      decidedBy: "finance_1",
    });
  });

  it("404s a missing row (no silent no-op)", async () => {
    await expect(
      resolveDiscrepancy({ discrepancyId: "dis_missing", resolution: "resolved" })
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("409s an already-resolved row (no rewrite)", async () => {
    savedDocs["payment_discrepancies/dis_done"] = { orderId: "ord_2", status: "resolved" };
    await expect(
      resolveDiscrepancy({ discrepancyId: "dis_done", resolution: "resolved" })
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(savedDocs["payment_discrepancies/dis_done"].resolution).toBeUndefined();
  });
});
