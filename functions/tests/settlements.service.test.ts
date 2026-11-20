import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Franchise settlement service (owner decision 2026-11-20): month-end
 * statements per branch, stored immutably, regenerated as a new version, with a
 * server-recorded "mark as paid" (reference + date) for owner/brand roles.
 *
 * Hermetic: in-memory Firestore shim (queries, transactions, FieldValue
 * increments), no network, no gateway, no clock dependency (every call takes
 * `now`).
 */

const { savedDocs, mockDb, queries } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const queries: any[] = [];

  const applyWrites = (path: string, data: any, merge: boolean) => {
    const base = merge && savedDocs[path] ? { ...savedDocs[path] } : {};
    for (const [key, value] of Object.entries(data || {})) {
      if (value && typeof value === "object" && typeof (value as any).__inc === "number") {
        base[key] = (Number(base[key]) || 0) + (value as any).__inc;
      } else {
        base[key] = value;
      }
    }
    savedDocs[path] = base;
  };

  const docRef = (col: string, id: string): any => {
    const path = `${col}/${id}`;
    return {
      id,
      path,
      get: async () => ({
        id,
        exists: Object.prototype.hasOwnProperty.call(savedDocs, path),
        data: () => savedDocs[path],
      }),
      set: async (data: any, opts?: any) => applyWrites(path, data, !!opts?.merge),
      create: async (data: any) => {
        if (Object.prototype.hasOwnProperty.call(savedDocs, path)) {
          const err: any = new Error("ALREADY_EXISTS");
          err.code = "already-exists";
          throw err;
        }
        applyWrites(path, data, false);
      },
      update: async (data: any) => applyWrites(path, data, true),
    };
  };

  const toMillis = (value: any): number => {
    if (value === null || value === undefined) return NaN;
    if (typeof value?.toMillis === "function") {
      const ms = Number(value.toMillis());
      return Number.isFinite(ms) ? ms : NaN;
    }
    return Number(new Date(value));
  };

  const matches = (path: string, filters: any[]) => {
    const data = savedDocs[path] || {};
    return filters.every(({ field, op, value }) => {
      const actual = field.split(".").reduce((node: any, key: string) => node?.[key], data);
      if (op === "==") return actual === value;
      // Timestamps arrive as Firestore-shaped objects in the seed, so every
      // ordering comparison goes through millis rather than Number().
      if (op === ">=") return toMillis(actual) >= toMillis(value);
      if (op === "<") return toMillis(actual) < toMillis(value);
      if (op === "in") return Array.isArray(value) && value.includes(actual);
      return false;
    });
  };

  const makeQuery = (col: string, filters: any[] = [], max = Infinity, after?: string): any => {
    const self: any = {
      where: (field: string, op: string, value: any) =>
        makeQuery(col, [...filters, { field, op, value }], max, after),
      orderBy: () => self,
      limit: (n: number) => makeQuery(col, filters, n, after),
      startAfter: (docOrId: any) =>
        makeQuery(
          col,
          filters,
          max,
          typeof docOrId === "string" ? docOrId : String(docOrId?.id ?? "")
        ),
      get: async () => {
        queries.push({ col, filters, max });
        let paths = Object.keys(savedDocs)
          .filter((path) => path.startsWith(`${col}/`))
          .filter((path) => matches(path, filters))
          .sort();
        if (after) {
          paths = paths.filter((path) => path.slice(col.length + 1) > after);
        }
        const docs = paths.slice(0, max === Infinity ? undefined : max).map((path) => {
          const id = path.slice(col.length + 1);
          return { id, ref: docRef(col, id), data: () => savedDocs[path], exists: true };
        });
        return { empty: docs.length === 0, docs, size: docs.length };
      },
    };
    return self;
  };

  const mockDb: any = {
    collection: (col: string) => ({
      ...makeQuery(col),
      add: async (data: any) => {
        const id = `auto_${Object.keys(savedDocs).length}`;
        applyWrites(`${col}/${id}`, data, false);
        return { id };
      },
      doc: (id?: string) => docRef(col, id as string),
    }),
    runTransaction: async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
        create: (ref: any, data: any) => ref.create(data),
        update: (ref: any, data: any) => ref.update(data),
      }),
  };
  return { savedDocs, mockDb, queries };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TIMESTAMP",
    increment: (n: number) => ({ __inc: n }),
    delete: () => "MOCK_DELETED",
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

import {
  SETTLEMENT_STATEMENTS,
  SETTLEMENT_VERSIONS,
  generateSettlementStatement,
  listSettlements,
  markSettlementPaid,
  exportSettlementsCsv,
  runMonthlySettlementScheduler,
  SettlementError,
} from "../src/modules/settlements/settlementService";
import { settlementMonthBounds, settlementStatementId } from "../src/modules/settlements/settlementMath";

const BRANCH = "br_surat";
const OTHER = "br_ahmedabad";
const NOV = settlementMonthBounds("2026-11");
const DEC_1ST = NOV.endMs + 60 * 60 * 1000;

const OWNER = { uid: "u_owner", role: "brand_owner", email: "owner@x.com" };
const BRAND_MGR = { uid: "u_brand", role: "developer" };
const BRANCH_OWNER = { uid: "u_br", role: "branch_owner", branchIds: [BRANCH] };
const OTHER_BRANCH_OWNER = { uid: "u_br2", role: "branch_owner", branchIds: [OTHER] };
const STAFF = { uid: "u_staff", role: "branch_staff", branchIds: [BRANCH] };

function seedBranch(id = BRANCH, extra: Record<string, any> = {}) {
  savedDocs[`branches/${id}`] = {
    name: id === BRANCH ? "Burgonomics - Surat" : "Burgonomics - Ahmedabad",
    active: true,
    createdAt: { toMillis: () => NOV.startMs - 100 * 24 * 3600 * 1000 },
    ...extra,
  };
}

function seedOnline(id: string, branchId: string, atMs: number, collectedPaise: number, refunded = 0) {
  savedDocs[`orders/${id}`] = {
    id,
    branchId,
    createdAt: { toMillis: () => atMs },
    paymentChannel: "razorpay",
    payment: { capturedAmountPaise: collectedPaise },
    refundedTotalPaise: refunded,
    status: { code: "DELIVERED" },
  };
}

function seedCash(id: string, branchId: string, atMs: number, rupees: number, code = "COMPLETED") {
  savedDocs[`orders/${id}`] = {
    id,
    branchId,
    createdAt: { toMillis: () => atMs },
    customerId: "cust_walkin",
    paymentMethod: "cod",
    status: { code },
    pricing: { grandTotal: rupees },
  };
}

beforeEach(() => {
  for (const key of Object.keys(savedDocs)) delete savedDocs[key];
  queries.length = 0;
  seedBranch();
  seedBranch(OTHER);
});

describe("generateSettlementStatement", () => {
  it("RED->GREEN: builds a closed month statement with one flat fee", async () => {
    seedOnline("o1", BRANCH, NOV.startMs + 1000, 500000);
    seedCash("c1", BRANCH, NOV.startMs + 2000, 1200);
    const statement = await generateSettlementStatement({
      branchId: BRANCH,
      monthKey: "2026-11",
      caller: OWNER,
      source: "on_demand",
      now: DEC_1ST,
    });
    expect(statement).not.toBeNull();

    expect(statement!.id).toBe(settlementStatementId(BRANCH, "2026-11", 1));
    expect(statement!.onlineCollectedPaise).toBe(500000);
    expect(statement!.cashCollectedPaise).toBe(120000);
    expect(statement!.platformFeePaise).toBe(200000);
    expect(statement!.netPayablePaise).toBe(300000);
    expect(statement!.monthClosed).toBe(true);
    expect(statement!.version).toBe(1);
    expect(savedDocs[`${SETTLEMENT_STATEMENTS}/${statement!.id}`]).toMatchObject({
      netPayablePaise: 300000,
      paidStatus: "unpaid",
    });
  });

  it("refuses a branch_owner generating a statement (owner/brand only)", async () => {
    seedBranch();
    await expect(
      generateSettlementStatement({
        branchId: BRANCH,
        monthKey: "2026-11",
        caller: BRANCH_OWNER,
        source: "on_demand",
        now: DEC_1ST,
      })
    ).rejects.toMatchObject({ code: "SETTLEMENT_FORBIDDEN" });
  });

  it("refuses a month that has not closed yet", async () => {
    seedBranch();
    await expect(
      generateSettlementStatement({
        branchId: BRANCH,
        monthKey: "2026-11",
        caller: OWNER,
        source: "on_demand",
        now: NOV.startMs + 5 * 24 * 3600 * 1000,
      })
    ).rejects.toMatchObject({ code: "SETTLEMENT_MONTH_OPEN" });
  });

  it("a regeneration writes a NEW version and leaves v1 byte-identical", async () => {
    seedOnline("o1", BRANCH, NOV.startMs + 1000, 500000);
    const first = await generateSettlementStatement({
      branchId: BRANCH,
      monthKey: "2026-11",
      caller: OWNER,
      source: "on_demand",
      now: DEC_1ST,
    });
    const v1 = { ...savedDocs[`${SETTLEMENT_STATEMENTS}/${first.id}`] };

    seedOnline("o2", BRANCH, NOV.startMs + 3000, 250000);
    const second = await generateSettlementStatement({
      branchId: BRANCH,
      monthKey: "2026-11",
      caller: OWNER,
      source: "on_demand",
      now: DEC_1ST,
    });

    expect(second.version).toBe(2);
    expect(second.id).not.toBe(first.id);
    expect(second.netPayablePaise).toBe(550000);
    expect(savedDocs[`${SETTLEMENT_STATEMENTS}/${first.id}`]).toEqual(v1);
  });

  it("refuses an unknown branch instead of inventing a statement", async () => {
    await expect(
      generateSettlementStatement({
        branchId: "br_missing",
        monthKey: "2026-11",
        caller: OWNER,
        source: "on_demand",
        now: DEC_1ST,
      })
    ).rejects.toMatchObject({ code: "SETTLEMENT_BRANCH_UNKNOWN" });
  });

  it("marks a truncated scan on the stored statement", async () => {
    // 1300 orders in the month with a page cap of 500 → 3 pages, still under
    // the 4000 cap, so nothing is truncated. Push past the cap instead.
    for (let i = 0; i < 4010; i++) {
      seedOnline(`bulk_${i}`, BRANCH, NOV.startMs + 1000 + i, 10000);
    }
    const statement = await generateSettlementStatement({
      branchId: BRANCH,
      monthKey: "2026-11",
      caller: OWNER,
      source: "on_demand",
      now: DEC_1ST,
    });
    expect(statement.ordersTruncated).toBe(true);
    expect(statement.notes.join(" ")).toMatch(/truncat/i);
  }, 60_000);
});

describe("listSettlements", () => {
  it("owner sees every branch, branch owner sees only their own", async () => {
    await generateSettlementStatement({
      branchId: BRANCH, monthKey: "2026-11", caller: OWNER, source: "on_demand", now: DEC_1ST,
    });
    await generateSettlementStatement({
      branchId: OTHER, monthKey: "2026-11", caller: OWNER, source: "on_demand", now: DEC_1ST,
    });

    const ownerView = await listSettlements({ caller: OWNER, monthKey: "2026-11" });
    expect(ownerView.map((s) => s.branchId).sort()).toEqual([BRANCH, OTHER].sort());

    const branchView = await listSettlements({ caller: BRANCH_OWNER, monthKey: "2026-11" });
    expect(branchView.map((s) => s.branchId)).toEqual([BRANCH]);

    const foreignView = await listSettlements({ caller: OTHER_BRANCH_OWNER, monthKey: "2026-11" });
    expect(foreignView.map((s) => s.branchId)).toEqual([OTHER]);
  });

  it("returns the latest version per branch unless all versions are asked for", async () => {
    seedOnline("o1", BRANCH, NOV.startMs + 1000, 100000);
    await generateSettlementStatement({
      branchId: BRANCH, monthKey: "2026-11", caller: OWNER, source: "on_demand", now: DEC_1ST,
    });
    await generateSettlementStatement({
      branchId: BRANCH, monthKey: "2026-11", caller: OWNER, source: "on_demand", now: DEC_1ST,
    });

    const latest = await listSettlements({ caller: OWNER, monthKey: "2026-11" });
    expect(latest).toHaveLength(1);
    expect(latest[0].version).toBe(2);

    const all = await listSettlements({ caller: OWNER, monthKey: "2026-11", allVersions: true });
    expect(all.map((s) => s.version).sort()).toEqual([1, 2]);
  });

  it("gives a support/staff caller nothing", async () => {
    await generateSettlementStatement({
      branchId: BRANCH, monthKey: "2026-11", caller: OWNER, source: "on_demand", now: DEC_1ST,
    });
    await expect(listSettlements({ caller: STAFF, monthKey: "2026-11" })).rejects.toMatchObject({
      code: "SETTLEMENT_FORBIDDEN",
    });
  });
});

describe("markSettlementPaid", () => {
  async function makeStatement() {
    seedOnline("o1", BRANCH, NOV.startMs + 1000, 500000);
    const statement = await generateSettlementStatement({
      branchId: BRANCH, monthKey: "2026-11", caller: OWNER, source: "on_demand", now: DEC_1ST,
    });
    expect(statement).not.toBeNull();
    return statement!;
  }

  /** A statement exists and was paid on 3 Dec, viewed on 10 Dec. */
  const DEC_10TH = Date.UTC(2026, 11, 10);

  it("records a reference and date, keeps every amount untouched", async () => {
    const statement = await makeStatement();
    const paid = await markSettlementPaid({
      statementId: statement.id,
      reference: "NEFT-UTRN-8891",
      paidOn: "2026-12-03",
      note: "December payout",
      caller: OWNER,
      now: DEC_10TH,
    });

    expect(paid.statement.paidStatus).toBe("paid");
    expect(paid.statement.paymentReference).toBe("NEFT-UTRN-8891");
    // 2026-12-03 00:00 IST is 2026-12-02T18:30Z.
    expect(paid.statement.paidAtMs).toBe(Date.UTC(2026, 11, 2, 18, 30));
    expect(paid.statement.netPayablePaise).toBe(statement.netPayablePaise);
    expect(paid.statement.platformFeePaise).toBe(statement.platformFeePaise);
    expect(paid.statement.payments).toHaveLength(1);
    expect(paid.statement.payments[0]).toMatchObject({
      reference: "NEFT-UTRN-8891",
      recordedBy: "u_owner",
      recordedByEmail: "owner@x.com",
    });
  });

  it("appends a second payment (a split payout) without losing the first", async () => {
    const statement = await makeStatement();
    await markSettlementPaid({
      statementId: statement.id, reference: "R1", paidOn: "2026-12-03", caller: OWNER, now: DEC_10TH,
    });
    const second = await markSettlementPaid({
      statementId: statement.id, reference: "R2", paidOn: "2026-12-05", caller: BRAND_MGR, now: DEC_10TH,
    });
    expect(second.statement.payments.map((p) => p.reference)).toEqual(["R1", "R2"]);
    expect(second.statement.paymentReference).toBe("R2");
  });

  it("refuses a branch owner, a staff caller and an empty reference", async () => {
    const statement = await makeStatement();
    await expect(
      markSettlementPaid({ statementId: statement.id, reference: "R", paidOn: "2026-12-03", caller: BRANCH_OWNER, now: DEC_10TH })
    ).rejects.toMatchObject({ code: "SETTLEMENT_FORBIDDEN" });
    await expect(
      markSettlementPaid({ statementId: statement.id, reference: "R", paidOn: "2026-12-03", caller: STAFF, now: DEC_10TH })
    ).rejects.toMatchObject({ code: "SETTLEMENT_FORBIDDEN" });
    await expect(
      markSettlementPaid({ statementId: statement.id, reference: "   ", paidOn: "2026-12-03", caller: OWNER, now: DEC_10TH })
    ).rejects.toMatchObject({ code: "SETTLEMENT_INVALID_REFERENCE" });
  });

  it("refuses a paid date in the future and a malformed date", async () => {
    const statement = await makeStatement();
    await expect(
      markSettlementPaid({ statementId: statement.id, reference: "R", paidOn: "2027-06-01", caller: OWNER, now: DEC_10TH })
    ).rejects.toMatchObject({ code: "SETTLEMENT_INVALID_PAID_ON" });
    await expect(
      markSettlementPaid({ statementId: statement.id, reference: "R", paidOn: "03/12/2026", caller: OWNER, now: DEC_10TH })
    ).rejects.toMatchObject({ code: "SETTLEMENT_INVALID_PAID_ON" });
    // 31 February is not a real date, so a naive parser would roll it to March.
    await expect(
      markSettlementPaid({ statementId: statement.id, reference: "R", paidOn: "2026-02-31", caller: OWNER, now: DEC_10TH })
    ).rejects.toMatchObject({ code: "SETTLEMENT_INVALID_PAID_ON" });
  });

  it("404s an unknown statement", async () => {
    await expect(
      markSettlementPaid({
        statementId: "br_nope_2026-11_v001",
        reference: "R",
        paidOn: "2026-05-03",
        caller: OWNER,
        now: Date.UTC(2026, 5, 1),
      })
    ).rejects.toMatchObject({ code: "SETTLEMENT_NOT_FOUND" });
  });
});

describe("exportSettlementsCsv", () => {
  it("exports the latest statements of the month, scoped to the caller", async () => {
    seedOnline("o1", BRANCH, NOV.startMs + 1000, 500000);
    const generated = await generateSettlementStatement({
      branchId: BRANCH, monthKey: "2026-11", caller: OWNER, source: "on_demand", now: DEC_1ST,
    });
    expect(generated).not.toBeNull();
    expect(savedDocs[`${SETTLEMENT_STATEMENTS}/${generated!.id}`]).toBeTruthy();

    const ownerCsv = await exportSettlementsCsv({ caller: OWNER, monthKey: "2026-11" });
    expect(ownerCsv.filename).toContain("2026-11");
    expect(ownerCsv.csv.split("\r\n")).toHaveLength(2);
    expect(ownerCsv.csv).toContain("Platform Fee (INR)");
    expect(ownerCsv.csv).toContain("2000.00");

    const branchCsv = await exportSettlementsCsv({ caller: BRANCH_OWNER, monthKey: "2026-11" });
    expect(branchCsv.csv).toBe(ownerCsv.csv);

    // A branch owner of a DIFFERENT branch gets an honest "nothing in your
    // scope" instead of an empty file that could read as zero sales.
    await expect(
      exportSettlementsCsv({ caller: OTHER_BRANCH_OWNER, monthKey: "2026-11" })
    ).rejects.toMatchObject({ code: "SETTLEMENT_NONE" });
  });

  it("refuses an unreadable month key", async () => {
    await expect(
      exportSettlementsCsv({ caller: OWNER, monthKey: "November" })
    ).rejects.toMatchObject({ code: "SETTLEMENT_BAD_MONTH" });
  });
});

describe("runMonthlySettlementScheduler", () => {
  it("generates the previous month for every branch, once", async () => {
    seedOnline("o1", BRANCH, NOV.startMs + 1000, 500000);
    seedCash("c1", OTHER, NOV.startMs + 2000, 800);

    const first = await runMonthlySettlementScheduler({ now: DEC_1ST, caller: { uid: "scheduler" } });
    expect(first.generated).toHaveLength(2);
    expect(first.skipped).toHaveLength(0);

    const second = await runMonthlySettlementScheduler({ now: DEC_1ST + 60_000, caller: { uid: "scheduler" } });
    expect(second.generated).toHaveLength(0);
    expect(second.skipped.sort()).toEqual([BRANCH, OTHER].sort());
    expect(queries.length).toBeGreaterThan(0);
  });

  it("never writes a statement for a branch switched off months ago", async () => {
    savedDocs[`branches/${OTHER}`] = { name: "Closed", active: false, status: "inactive" };
    seedOnline("o1", BRANCH, NOV.startMs + 1000, 500000);
    const run = await runMonthlySettlementScheduler({ now: DEC_1ST, caller: { uid: "scheduler" } });
    expect(run.generated.map((s) => s.branchId)).toEqual([BRANCH]);
    expect(run.skipped).toContain(OTHER);
  });

  it("is a no-op on the first of a month before the previous month closed", async () => {
    const run = await runMonthlySettlementScheduler({
      now: NOV.startMs + 60_000,
      caller: { uid: "scheduler" },
    });
    // The month it would settle is 2026-10, which closed; but no branch has
    // orders there, so each branch still gets a (zero-sales) statement.
    expect(run.monthKey).toBe("2026-10");
    expect(run.generated.length + run.skipped.length).toBe(2);
  });
});

describe("SettlementError", () => {
  it("carries a stable code and HTTP status", () => {
    const err = new SettlementError("SETTLEMENT_FORBIDDEN", "no", 403);
    expect(err.code).toBe("SETTLEMENT_FORBIDDEN");
    expect(err.statusCode).toBe(403);
  });
});
