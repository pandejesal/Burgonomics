import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";

const { mockDb, savedDocs, committedBatches, flags } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const committedBatches: Array<Array<{ kind: string; ref: any; data?: any }>> = [];
  const flags = {
    unsupportedCursor: false,
    ignoreCursor: false,
  };

  const createQuery = (
    colName: string,
    filters: Array<{ field: string; op: string; val: any }>,
    orderFields: Array<{ field: any; dir: "asc" | "desc" }> = [],
    startAfterDoc: any = null,
    limitNum: number | null = null
  ) => {
    const q: any = {
      where: (field: string, op: string, val: any) =>
        createQuery(colName, [...filters, { field, op, val }], orderFields, startAfterDoc, limitNum),
      orderBy: (field: any, dir: "asc" | "desc" = "asc") =>
        createQuery(colName, filters, [...orderFields, { field, dir }], startAfterDoc, limitNum),
      limit: (n: number) =>
        createQuery(colName, filters, orderFields, startAfterDoc, n),
      get: async () => {
        const matched: any[] = [];
        for (const [docPath, data] of Object.entries(savedDocs)) {
          if (!docPath.startsWith(`${colName}/`)) continue;
          const matches = filters.every((f) => data[f.field] === f.val);
          if (matches) {
            const id = docPath.replace(`${colName}/`, "");
            matched.push({
              id,
              ref: { id, path: docPath },
              data: () => data,
            });
          }
        }

        // Sort deterministically by id asc
        matched.sort((a, b) => a.id.localeCompare(b.id));

        let sliced = matched;
        if (startAfterDoc && !flags.ignoreCursor) {
          const afterId =
            typeof startAfterDoc === "string"
              ? startAfterDoc
              : startAfterDoc?.id || startAfterDoc?.ref?.id;
          const idx = matched.findIndex((d) => d.id === afterId);
          if (idx !== -1) {
            sliced = matched.slice(idx + 1);
          }
        }

        const finalDocs = limitNum != null ? sliced.slice(0, limitNum) : sliced;

        return {
          empty: finalDocs.length === 0,
          docs: finalDocs,
        };
      },
    };

    if (!flags.unsupportedCursor) {
      q.startAfter = (docOrId: any) =>
        createQuery(colName, filters, orderFields, docOrId, limitNum);
    }

    return q;
  };

  const mockDb = {
    collection: (colName: string) => ({
      doc: (docId?: string) => {
        const id = docId || `mock_id_${Math.random().toString(36).substring(2, 7)}`;
        return {
          id,
          path: `${colName}/${id}`,
          set: vi.fn(async (data: any, options?: any) => {
            const docPath = `${colName}/${id}`;
            if (options?.merge && savedDocs[docPath]) {
              savedDocs[docPath] = { ...savedDocs[docPath], ...data };
            } else {
              savedDocs[docPath] = data;
            }
          }),
          get: vi.fn(async () => {
            const docPath = `${colName}/${id}`;
            return {
              exists: !!savedDocs[docPath],
              data: () => savedDocs[docPath] || {},
            };
          }),
          create: vi.fn(async (data: any) => {
            const docPath = `${colName}/${id}`;
            if (savedDocs[docPath]) {
              const err: any = new Error("ALREADY_EXISTS: Document already exists");
              err.code = 6;
              throw err;
            }
            savedDocs[docPath] = data;
          }),
          delete: vi.fn(async () => {
            delete savedDocs[`${colName}/${id}`];
          }),
        };
      },
      where: (field: string, op: string, val: any) => createQuery(colName, [{ field, op, val }]),
      orderBy: (field: any, dir: "asc" | "desc" = "asc") => createQuery(colName, [], [{ field, dir }]),
      limit: (n: number) => createQuery(colName, [], [], null, n),
    }),
    batch: () => {
      const ops: Array<{ kind: string; ref: any; data?: any }> = [];
      return {
        update: vi.fn((ref: any, data: any) => {
          ops.push({ kind: "update", ref, data });
        }),
        set: vi.fn((ref: any, data: any, options?: any) => {
          ops.push({ kind: "set", ref, data });
        }),
        delete: vi.fn((ref: any) => {
          ops.push({ kind: "delete", ref });
        }),
        commit: vi.fn(async () => {
          if (ops.length > 400) {
            throw new Error(`Batch op limit exceeded: ${ops.length} ops committed (max allowed: 400)`);
          }
          committedBatches.push([...ops]);
          for (const op of ops) {
            const docPath = op.ref.path || `${op.ref.id}`;
            if (op.kind === "update") {
              savedDocs[docPath] = { ...(savedDocs[docPath] || {}), ...op.data };
            } else if (op.kind === "set") {
              savedDocs[docPath] = { ...(savedDocs[docPath] || {}), ...op.data };
            } else if (op.kind === "delete") {
              delete savedDocs[docPath];
            }
          }
        }),
      };
    },
    runTransaction: vi.fn(async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
      })
    ),
  };

  return { mockDb, savedDocs, committedBatches, flags };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_SERVER_TIMESTAMP",
    increment: (n: number) => n,
    arrayUnion: (item: any) => [item],
  };

  const firestoreFn: any = vi.fn(() => mockDb);
  firestoreFn.FieldValue = FieldValue;
  firestoreFn.FieldPath = {
    documentId: () => "__name__",
  };

  const mockAuth = {
    getUser: vi.fn(async (uid: string) => ({ uid, providerData: [] })),
  };

  return {
    default: {
      firestore: firestoreFn,
      auth: vi.fn(() => mockAuth),
      messaging: vi.fn(() => ({})),
      initializeApp: vi.fn(),
      apps: [{ name: "mock" }],
    },
    firestore: firestoreFn,
    auth: vi.fn(() => mockAuth),
    messaging: vi.fn(() => ({})),
    initializeApp: vi.fn(),
    apps: [{ name: "mock" }],
  };
});

import {
  migrateGuestAccount,
  mintGuestOwnershipProof,
} from "../src/modules/auth/guestMigration";

beforeAll(() => {
  process.env.OTP_HMAC_SECRET = "test-guest-proof-stress-secret";
});

afterAll(() => {
  delete process.env.OTP_HMAC_SECRET;
});

describe("Auth Module — Guest Account Migration Pagination & Chunk Stress (>400 records)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    flags.unsupportedCursor = false;
    flags.ignoreCursor = false;
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    committedBatches.length = 0;
  });

  it("migrates all 805 guest orders across pages, enforces <=400 batch writes, leaves tail and foreign docs protected", async () => {
    const guestSessionId = "sess_stress_orders_805";
    const permanentUid = "usr_stress_perm_805";
    const foreignSessionId = "sess_foreign_guest_other";

    // 1. Seed 805 eligible guest orders
    for (let i = 1; i <= 805; i++) {
      const padId = String(i).padStart(4, "0");
      const orderId = `ord_guest_${padId}`;
      savedDocs[`orders/${orderId}`] = {
        id: orderId,
        guestSessionId,
        customerId: "guest",
        total: 100 + i,
      };
    }

    // 2. Seed 50 foreign guest orders
    for (let i = 1; i <= 50; i++) {
      const padId = String(i).padStart(4, "0");
      const foreignOrderId = `ord_foreign_${padId}`;
      savedDocs[`orders/${foreignOrderId}`] = {
        id: foreignOrderId,
        guestSessionId: foreignSessionId,
        customerId: "guest",
        total: 500 + i,
      };
    }

    // 3. Seed 1 protected order belonging to another identified user
    const protectedOrderId = "ord_protected_victim_1";
    savedDocs[`orders/${protectedOrderId}`] = {
      id: protectedOrderId,
      guestSessionId,
      customerId: "usr_identified_victim_1",
      total: 999,
    };

    const proof = mintGuestOwnershipProof(guestSessionId);

    const result = await migrateGuestAccount(
      {
        guestSessionId,
        permanentUid,
        guestProof: proof,
      },
      { uid: permanentUid }
    );

    // Assertions:
    // 1. All 805 eligible docs migrated and count is truthful (not 400 truncation!)
    expect(result.success).toBe(true);
    expect(result.migratedOrdersCount).toBe(805);
    expect(result.skippedProtectedCount).toBe(1);

    // 2. Verify ALL 805 orders are migrated to permanentUid (no tail left behind)
    for (let i = 1; i <= 805; i++) {
      const padId = String(i).padStart(4, "0");
      const doc = savedDocs[`orders/ord_guest_${padId}`];
      expect(doc.customerId).toBe(permanentUid);
      expect(doc.originalGuestSessionId).toBe(guestSessionId);
    }

    // 3. Foreign guest orders must NOT be touched
    for (let i = 1; i <= 50; i++) {
      const padId = String(i).padStart(4, "0");
      const foreignDoc = savedDocs[`orders/ord_foreign_${padId}`];
      expect(foreignDoc.customerId).toBe("guest");
      expect(foreignDoc.originalGuestSessionId).toBeUndefined();
    }

    // 4. Protected order remains intact
    expect(savedDocs[`orders/${protectedOrderId}`].customerId).toBe("usr_identified_victim_1");

    // 5. Verify batch commit constraints: every committed batch must have <= 400 ops
    expect(committedBatches.length).toBeGreaterThanOrEqual(3);
    for (const batch of committedBatches) {
      expect(batch.length).toBeLessThanOrEqual(400);
    }
  });

  it("handles boundary condition with exactly 400 records cleanly without duplicate paging", async () => {
    const guestSessionId = "sess_boundary_exact_400";
    const permanentUid = "usr_boundary_exact_400";

    for (let i = 1; i <= 400; i++) {
      const padId = String(i).padStart(4, "0");
      const orderId = `ord_exact400_${padId}`;
      savedDocs[`orders/${orderId}`] = {
        id: orderId,
        guestSessionId,
        customerId: "guest",
        total: 100,
      };
    }

    const proof = mintGuestOwnershipProof(guestSessionId);

    const result = await migrateGuestAccount(
      {
        guestSessionId,
        permanentUid,
        guestProof: proof,
      },
      { uid: permanentUid }
    );

    expect(result.success).toBe(true);
    expect(result.migratedOrdersCount).toBe(400);

    for (let i = 1; i <= 400; i++) {
      const padId = String(i).padStart(4, "0");
      expect(savedDocs[`orders/ord_exact400_${padId}`].customerId).toBe(permanentUid);
    }

    for (const batch of committedBatches) {
      expect(batch.length).toBeLessThanOrEqual(400);
    }
  });

  it("handles empty boundary (0 records) cleanly", async () => {
    const guestSessionId = "sess_empty_boundary_000";
    const permanentUid = "usr_empty_boundary_000";
    const proof = mintGuestOwnershipProof(guestSessionId);

    const result = await migrateGuestAccount(
      {
        guestSessionId,
        permanentUid,
        guestProof: proof,
      },
      { uid: permanentUid }
    );

    expect(result.success).toBe(true);
    expect(result.migratedOrdersCount).toBe(0);
    expect(result.migratedTicketsCount).toBe(0);
  });

  it("migrates >400 tickets (450 tickets) across pages cleanly", async () => {
    const guestSessionId = "sess_stress_tickets_450";
    const permanentUid = "usr_stress_tickets_perm";

    for (let i = 1; i <= 450; i++) {
      const padId = String(i).padStart(4, "0");
      const ticketId = `tkt_guest_${padId}`;
      savedDocs[`tickets/${ticketId}`] = {
        id: ticketId,
        guestSessionId,
        customerId: "guest",
        subject: `Ticket #${i}`,
      };
    }

    const proof = mintGuestOwnershipProof(guestSessionId);

    const result = await migrateGuestAccount(
      {
        guestSessionId,
        permanentUid,
        guestProof: proof,
      },
      { uid: permanentUid }
    );

    expect(result.success).toBe(true);
    expect(result.migratedTicketsCount).toBe(450);

    for (let i = 1; i <= 450; i++) {
      const padId = String(i).padStart(4, "0");
      expect(savedDocs[`tickets/tkt_guest_${padId}`].customerId).toBe(permanentUid);
    }

    for (const batch of committedBatches) {
      expect(batch.length).toBeLessThanOrEqual(400);
    }
  });

  it("retries across interruption converge idempotently without duplicating migrated docs or counts", async () => {
    const guestSessionId = "sess_idempotent_retry_420";
    const permanentUid = "usr_idempotent_retry_perm";

    for (let i = 1; i <= 420; i++) {
      const padId = String(i).padStart(4, "0");
      const orderId = `ord_retry_${padId}`;
      savedDocs[`orders/${orderId}`] = {
        id: orderId,
        guestSessionId,
        customerId: "guest",
        total: 150,
      };
    }

    const proof = mintGuestOwnershipProof(guestSessionId);

    // First run: migrates all 420 orders
    const firstRun = await migrateGuestAccount(
      {
        guestSessionId,
        permanentUid,
        guestProof: proof,
      },
      { uid: permanentUid }
    );
    expect(firstRun.success).toBe(true);
    expect(firstRun.migratedOrdersCount).toBe(420);

    // Second run (simulating a client retry): all orders already belong to permanentUid
    const secondRun = await migrateGuestAccount(
      {
        guestSessionId,
        permanentUid,
        guestProof: proof,
      },
      { uid: permanentUid }
    );
    expect(secondRun.success).toBe(true);
    // Since orders now have customerId === permanentUid, isRelinkable returns false and skips them
    expect(secondRun.migratedOrdersCount).toBe(0);
    expect(secondRun.welcomeBonusAwarded).toBe(false);
  });

  it("rejects with clear pagination failure when >=400 records encounter unsupported cursor datastore and never reports success", async () => {
    flags.unsupportedCursor = true;
    const guestSessionId = "sess_stress_unsupported_cursor_450";
    const permanentUid = "usr_unsupported_cursor_perm";

    for (let i = 1; i <= 450; i++) {
      const padId = String(i).padStart(4, "0");
      const orderId = `ord_nocursor_${padId}`;
      savedDocs[`orders/${orderId}`] = {
        id: orderId,
        guestSessionId,
        customerId: "guest",
        total: 100,
      };
    }

    const proof = mintGuestOwnershipProof(guestSessionId);

    await expect(
      migrateGuestAccount(
        {
          guestSessionId,
          permanentUid,
          guestProof: proof,
        },
        { uid: permanentUid }
      )
    ).rejects.toMatchObject({
      code: "MIGRATION_PAGINATION_FAILED",
    });

    // Verify none of the orders were migrated into permanentUid
    for (let i = 1; i <= 450; i++) {
      const padId = String(i).padStart(4, "0");
      expect(savedDocs[`orders/ord_nocursor_${padId}`].customerId).toBe("guest");
    }
  });

  it("rejects with clear pagination failure when >=400 records encounter repeated / non-advancing cursor and never reports success", async () => {
    flags.ignoreCursor = true;
    const guestSessionId = "sess_stress_ignored_cursor_450";
    const permanentUid = "usr_ignored_cursor_perm";

    for (let i = 1; i <= 450; i++) {
      const padId = String(i).padStart(4, "0");
      const orderId = `ord_repeatcursor_${padId}`;
      savedDocs[`orders/${orderId}`] = {
        id: orderId,
        guestSessionId,
        customerId: "guest",
        total: 100,
      };
    }

    const proof = mintGuestOwnershipProof(guestSessionId);

    await expect(
      migrateGuestAccount(
        {
          guestSessionId,
          permanentUid,
          guestProof: proof,
        },
        { uid: permanentUid }
      )
    ).rejects.toMatchObject({
      code: "MIGRATION_PAGINATION_FAILED",
    });

    for (let i = 1; i <= 450; i++) {
      const padId = String(i).padStart(4, "0");
      expect(savedDocs[`orders/ord_repeatcursor_${padId}`].customerId).toBe("guest");
    }
  });
});
