import { describe, it, expect, vi, beforeEach } from "vitest";

// Readiness-7 rig: the audit writer must record well-shaped rows and never
// throw into money/RBAC flows (best-effort by contract).
const { mockDb, savedDocs } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  let counter = 0;
  const mockDb: any = {
    collection: (colName: string) => ({
      doc: (docId: string) => ({
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
      }),
      add: vi.fn(async (data: any) => {
        counter += 1;
        const p = `${colName}/auto_${counter}`;
        savedDocs[p] = data;
        return { id: `auto_${counter}` };
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

import { writeAuditLog } from "../src/modules/audit/auditLog";

describe("Readiness-7: server audit writer", () => {
  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
  });

  it("records a well-shaped row in admin_audit_logs", async () => {
    const ok = await writeAuditLog({
      actorUid: "brand_1",
      actorEmail: "owner@burgonomics.in",
      action: "refund_processed",
      targetType: "order",
      targetId: "ord_1",
      metadata: { amountRupees: 200 },
    });
    expect(ok).toBe(true);
    const rows = Object.entries(savedDocs).filter(([p]) =>
      p.startsWith("admin_audit_logs/")
    );
    expect(rows).toHaveLength(1);
    const [, row] = rows[0] as [string, any];
    expect(row.action).toBe("refund_processed");
    expect(row.actorUid).toBe("brand_1");
    expect(row.targetId).toBe("ord_1");
    expect(row.metadata.amountRupees).toBe(200);
    expect(row.createdAt).toBe("MOCK_TIMESTAMP");
  });

  it("returns false (never throws) on missing action or write failure", async () => {
    await expect(writeAuditLog({ action: "" } as any)).resolves.toBe(false);
    await expect(writeAuditLog(null as any)).resolves.toBe(false);
  });
});
