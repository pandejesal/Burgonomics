import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * GPT-6.2 Sol final review 2026-11-22 — M1 / M6 / M7 service regressions.
 * Hermetic in-memory Firestore: queries (both bounds), transactions, increments.
 */
const { savedDocs, mockDb, queries } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const queries: any[] = [];
  const applyWrites = (path: string, data: any, merge: boolean) => {
    const base = merge && savedDocs[path] ? { ...savedDocs[path] } : {};
    for (const [key, value] of Object.entries(data || {})) {
      if (value && typeof value === "object" && typeof (value as any).__inc === "number") {
        base[key] = (Number(base[key]) || 0) + (value as any).__inc;
      } else base[key] = value;
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
    if (typeof value?.toMillis === "function") return Number(value.toMillis());
    return Number(new Date(value));
  };
  const matches = (path: string, filters: any[]) => {
    const data = savedDocs[path] || {};
    return filters.every(({ field, op, value }) => {
      const actual = field.split(".").reduce((n: any, k: string) => n?.[k], data);
      if (op === "==") return actual === value;
      if (op === ">=") return toMillis(actual) >= toMillis(value);
      if (op === "<") return toMillis(actual) < toMillis(value);
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
        makeQuery(col, filters, max, typeof docOrId === "string" ? docOrId : String(docOrId?.id ?? "")),
      get: async () => {
        queries.push({ col, filters, max });
        let paths = Object.keys(savedDocs)
          .filter((p) => p.startsWith(`${col}/`))
          .filter((p) => matches(p, filters))
          .sort();
        if (after) paths = paths.filter((p) => p.slice(col.length + 1) > after);
        const docs = paths.slice(0, max === Infinity ? undefined : max).map((p) => {
          const id = p.slice(col.length + 1);
          return { id, data: () => savedDocs[p], exists: true };
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
      }),
  };
  return { savedDocs, mockDb, queries };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TS",
    increment: (n: number) => ({ __inc: n }),
    delete: () => "MOCK_DEL",
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
  SETTLEMENT_PAYMENTS,
  generateSettlementStatement,
  markSettlementPaid,
  SettlementError,
} from "../src/modules/settlements/settlementService";
import { settlementMonthBounds } from "../src/modules/settlements/settlementMath";

const BRANCH = "br_surat";
const NOV = settlementMonthBounds("2026-11");
const DEC = settlementMonthBounds("2026-12");
const NOV_END = NOV.endMs + 3600_000;
const DEC_END = DEC.endMs + 3600_000;
const OWNER = { uid: "u_owner", role: "brand_owner", email: "o@x.com" };

function seedBranch() {
  savedDocs[`branches/${BRANCH}`] = {
    name: "Surat",
    active: true,
    settlementFee: 2000,
    createdAt: { toMillis: () => NOV.startMs - 100 * 86400_000 },
  };
}

beforeEach(() => {
  for (const k of Object.keys(savedDocs)) delete savedDocs[k];
  queries.length = 0;
  seedBranch();
});

function seedOnline(id: string, atMs: number, extra: Record<string, any> = {}) {
  savedDocs[`orders/${id}`] = {
    id,
    branchId: BRANCH,
    createdAt: { toMillis: () => atMs },
    settlementEffectiveAtMs: atMs,
    paymentChannel: "razorpay",
    payment: { capturedAmountPaise: 50000 },
    status: { code: "DELIVERED" },
    ...extra,
  };
}

describe('cutover accounting', () => {
  const generate = () => generateSettlementStatement({ branchId: BRANCH, monthKey: '2026-11', caller: OWNER, source: 'on_demand', now: DEC_END });
  const pay = (statementId: string, reference: string) => markSettlementPaid({ statementId, reference, paidOn: '2026-12-03', caller: OWNER, now: DEC_END });

  it('rejects a distinct payment on an unchanged regenerated month', async () => {
    seedOnline('original', NOV.startMs, {payment:{capturedAmountPaise:210000}});
    await pay((await generate())!.id, 'original');
    const revised = (await generate())!;
    await expect(pay(revised.id, 'another')).rejects.toMatchObject({code:'SETTLEMENT_ZERO_DELTA'});
  });

  it('a payment interleaved with regeneration records only the signed delta', async () => {
    seedOnline('interleave', NOV.startMs + 8000, {payment:{capturedAmountPaise:210000}});
    const v1 = (await generate())!;
    await pay(v1.id, 'first');
    const v2 = (await generate())!;
    // The ledger is authoritative inside the transaction: no residual delta.
    expect(v2.outstandingPaise).toBe(0);
    await expect(pay(v2.id, 'again')).rejects.toMatchObject({code:'SETTLEMENT_ZERO_DELTA'});
    savedDocs['orders/interleave'].settlementProcessedRefunds = {rf:5000};
    savedDocs['orders/interleave'].refundedTotalPaise = 5000;
    const v3 = (await generate())!;
    expect(v3.outstandingPaise).toBe(-5000);
    await pay(v3.id, 'collection');
    expect(savedDocs[`settlement_payments/${BRANCH}_2026-11`].settledNetPaise).toBe(5000);
  });

  it('records the signed late refund delta, not the full revised net', async () => {
    seedOnline('original', NOV.startMs, {payment:{capturedAmountPaise:210000}});
    await pay((await generate())!.id, 'original');
    Object.assign(savedDocs['orders/original'], { refundedTotalPaise:500, refundLedger:{rf:500}, settlementProcessedRefunds:{rf:500} });
    const revised = (await generate())!;
    const result = await pay(revised.id, 'collection');
    expect(result.statement.payments.at(-1)?.settledNetPaise).toBe(-500);
    expect(savedDocs[`branch_settlements/${revised.id}`].outstandingPaise).toBe(0);
    expect(savedDocs[`settlement_payments/${BRANCH}_2026-11`].settledNetPaise).toBe(9500);
  });

  it('voids a pre-ledger statement without issuing a payment', async () => {
    const s=(await generate())!;
    delete savedDocs[`settlement_payments/${BRANCH}_2026-11`];
    delete savedDocs[`branch_settlements/${s.id}`].ledgerSchema;
    await expect(pay(s.id,'old')).rejects.toMatchObject({code:'SETTLEMENT_VOID'});
  });

  it.each([4000,4001])('probes the month boundary with %i orders and later backlog', async n => {
    for(let i=0;i<n;i++) seedOnline(`current-${i}`,NOV.startMs);
    for(let i=0;i<30;i++) seedOnline(`later-${i}`,DEC.startMs);
    const s=(await generate())!;
    expect(s.ordersTruncated).toBe(n>4000);
    expect(s.onlineOrders).toBe(4000);
    const canonical=queries.find(q=>q.filters.some((f:any)=>f.field==='settlementEffectiveAtMs' && f.op==='>='));
    expect(canonical.filters).toEqual(expect.arrayContaining([{field:'settlementEffectiveAtMs',op:'>=',value:NOV.startMs},{field:'settlementEffectiveAtMs',op:'<',value:NOV.endMs}]));
  });

  it.each(['pending','failed','processed'])('deducts only settled gateway refund money: %s',async state=>{
    seedOnline('sale',NOV.startMs,{refundedTotalPaise:400,refundLedger:{rf:400}, refundStatus:state,
      settlementProcessedRefunds:state==='processed'?{rf:400}:{}});
    expect((await generate())!.onlineRefundedPaise).toBe(state==='processed'?400:0);
  });
});

describe("M7 — query both bounds and one shared effective timestamp", () => {
  it("buckets by capture time and never counts a later-month order toward this month", async () => {
    // Placed in November, captured in December.
    seedOnline("ord_cross", NOV.startMs + 1000, {
      settlementEffectiveAtMs: DEC.startMs + 1000,
    });
    seedOnline("ord_nov", NOV.startMs + 2000);

    const nov = await generateSettlementStatement({
      branchId: BRANCH,
      monthKey: "2026-11",
      caller: OWNER,
      source: "on_demand",
      now: NOV_END,
    });
    const dec = await generateSettlementStatement({
      branchId: BRANCH,
      monthKey: "2026-12",
      caller: OWNER,
      source: "on_demand",
      now: DEC_END,
    });
    expect(nov!.onlineOrders).toBe(1);
    expect(dec!.onlineOrders).toBe(1);
    // Both month bounds are part of every time query.
    const timeQueries = queries.filter((q) => q.col === "orders" && q.filters.some((f: any) => f.op === "<"));
    expect(timeQueries.length).toBeGreaterThan(0);
    expect(timeQueries[0].filters).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "branchId", op: "==" })])
    );
  });
});

describe("M6 — payment ledger per branch/month, only the delta payable", () => {
  it("regenerating an unchanged paid month exposes zero outstanding", async () => {
    seedOnline("ord_paid", NOV.startMs + 5000);
    const v1 = await generateSettlementStatement({
      branchId: BRANCH,
      monthKey: "2026-11",
      caller: OWNER,
      source: "on_demand",
      now: NOV_END,
    });
    await markSettlementPaid({
      statementId: v1!.id,
      reference: "UTR-PAID",
      paidOn: "2026-12-03",
      caller: OWNER,
      now: DEC_END,
    });
    const v2 = await generateSettlementStatement({
      branchId: BRANCH,
      monthKey: "2026-11",
      caller: OWNER,
      source: "on_demand",
      now: DEC_END,
    });
    expect(v2!.version).toBe(2);
    expect(v2!.priorSettledNetPaise).toBe(v1!.netPayablePaise);
    expect(v2!.outstandingPaise).toBe(0);
    expect(v2!.paidStatus).toBe("paid");
    expect(v2!.payments).toHaveLength(1);
    expect(savedDocs[`${SETTLEMENT_PAYMENTS}/${BRANCH}_2026-11`].settledNetPaise).toBe(
      v1!.netPayablePaise
    );
  });

  it("a late refund leaves only the negative delta outstanding", async () => {
    seedOnline("ord_refund", NOV.startMs + 6000);
    const v1 = await generateSettlementStatement({
      branchId: BRANCH,
      monthKey: "2026-11",
      caller: OWNER,
      source: "on_demand",
      now: NOV_END,
    });
    await markSettlementPaid({
      statementId: v1!.id,
      reference: "UTR-R",
      paidOn: "2026-12-03",
      caller: OWNER,
      now: DEC_END,
    });
    savedDocs["orders/ord_refund"].refundedTotalPaise = 5000;
    savedDocs["orders/ord_refund"].settlementProcessedRefunds = { rf_late: 5000 };
    const v2 = await generateSettlementStatement({
      branchId: BRANCH,
      monthKey: "2026-11",
      caller: OWNER,
      source: "on_demand",
      now: DEC_END,
    });
    expect(v2!.outstandingPaise).toBe(-5000);
  });
});

describe("M6 — incomplete statements cannot be marked paid", () => {
  it("blocks a truncated version even if a brand owner asks", async () => {
    seedOnline("ord_trunc", NOV.startMs + 7000);
    const s = await generateSettlementStatement({
      branchId: BRANCH,
      monthKey: "2026-11",
      caller: OWNER,
      source: "on_demand",
      now: NOV_END,
    });
    savedDocs[`branch_settlements/${s!.id}`].ordersTruncated = true;
    await expect(
      markSettlementPaid({
        statementId: s!.id,
        reference: "UTR-T",
        paidOn: "2026-12-03",
        caller: OWNER,
        now: DEC_END,
      })
    ).rejects.toMatchObject({ code: "SETTLEMENT_INCOMPLETE" });
  });
});


describe('r4 unresolved captures and terminal refunds', () => {
  const generate = () => generateSettlementStatement({ branchId: BRANCH, monthKey: '2026-11', caller: OWNER, source: 'on_demand', now: DEC_END });
  const pay = (id: string) => markSettlementPaid({ statementId: id, reference: 'R4', paidOn: '2026-12-03', caller: OWNER, now: DEC_END });

  it('an unresolved capture blocks the statement until provider confirmation', async () => {
    seedOnline('unresolved', NOV.startMs, {
      payment: { capturedAmountPaise: 210000 },
      settlementEffectiveAtMs: undefined,
      settlementCaptureState: 'pending',
      settlementCaptureUnresolved: true,
    });
    const blocked = (await generate())!;
    expect(blocked.unresolvedCaptures).toBe(1);
    expect(blocked.complete).toBe(false);
    await expect(pay(blocked.id)).rejects.toMatchObject({ code: 'SETTLEMENT_INCOMPLETE' });
    savedDocs['orders/unresolved'].settlementEffectiveAtMs = NOV.startMs + 10;
    savedDocs['orders/unresolved'].settlementCaptureState = 'confirmed';
    savedDocs['orders/unresolved'].settlementCaptureUnresolved = false;
    const resolved = (await generate())!;
    expect(resolved.unresolvedCaptures).toBe(0);
    expect(resolved.complete).toBe(true);
    await expect(pay(resolved.id)).resolves.toMatchObject({ reused: false });
  });

  it('deducts only terminal processed refunds, replay is idempotent, failed clears', async () => {
    seedOnline('refundcase', NOV.startMs, {
      payment: { capturedAmountPaise: 210000 },
      settlementProcessedRefunds: {},
    });
    savedDocs['orders/refundcase'].refundedTotalPaise = 500;
    expect((await generate())!.onlineRefundedPaise).toBe(0);
    savedDocs['orders/refundcase'].settlementProcessedRefunds = { rf_1: 500 };
    expect((await generate())!.onlineRefundedPaise).toBe(500);
    expect((await generate())!.onlineRefundedPaise).toBe(500);
    savedDocs['orders/refundcase'].settlementProcessedRefunds = {};
    expect((await generate())!.onlineRefundedPaise).toBe(0);
  });
});


describe("cycle 9c unresolved capture month scope", () => {
  const generateAt = (monthKey: string, now: number) =>
    generateSettlementStatement({ branchId: BRANCH, monthKey, caller: OWNER, source: "on_demand", now });
  const endOf = (y: number, m: number) => Date.UTC(y, m + 1, 1) - 19800000;

  it("a November-created unresolved row blocks November and later, not September or October", async () => {
    savedDocs["orders/unres_nov"] = {
      id: "unres_nov", branchId: BRANCH, paymentChannel: "razorpay",
      payment: { capturedAmountPaise: 10000 }, settlementCaptureUnresolved: true,
      createdAt: new Date(Date.UTC(2026, 10, 10)).toISOString(),
    };
    expect((await generateAt("2026-09", endOf(2026, 8) + 86400000))!.complete).toBe(true);
    expect((await generateAt("2026-10", endOf(2026, 9) + 86400000))!.complete).toBe(true);
    expect((await generateAt("2026-11", endOf(2026, 10) + 86400000))!.complete).toBe(false);
    expect((await generateAt("2026-12", endOf(2026, 11) + 86400000))!.complete).toBe(false);
  });

  it("an order created at 23:59 IST on 31 October blocks October and November", async () => {
    savedDocs["orders/unres_oct"] = {
      id: "unres_oct", branchId: BRANCH, paymentChannel: "razorpay",
      payment: { capturedAmountPaise: 10000 }, settlementCaptureUnresolved: true,
      createdAt: new Date(Date.UTC(2026, 9, 31, 18, 29, 0)).toISOString(),
    };
    expect((await generateAt("2026-09", endOf(2026, 8) + 86400000))!.complete).toBe(true);
    expect((await generateAt("2026-10", endOf(2026, 9) + 86400000))!.complete).toBe(false);
    expect((await generateAt("2026-11", endOf(2026, 10) + 86400000))!.complete).toBe(false);
  });
});


describe("cycle 9c-r2 unresolved scan fails closed", () => {
  it("2000 later-month rows cannot hide an in-month unresolved capture", async () => {
    for (let i = 0; i < 2000; i += 1) {
      savedDocs[`orders/unres_nov_${String(i).padStart(4, "0")}`] = {
        id: `unres_nov_${i}`, branchId: BRANCH, paymentChannel: "razorpay",
        payment: { capturedAmountPaise: 10000 }, settlementCaptureUnresolved: true,
        createdAt: new Date(Date.UTC(2026, 10, 10)).toISOString(),
      };
    }
    savedDocs["orders/unres_oct"] = {
      id: "unres_oct", branchId: BRANCH, paymentChannel: "razorpay",
      payment: { capturedAmountPaise: 10000 }, settlementCaptureUnresolved: true,
      createdAt: new Date(Date.UTC(2026, 9, 10)).toISOString(),
    };
    const oct = await generateSettlementStatement({
      branchId: BRANCH, monthKey: "2026-10", caller: OWNER, source: "on_demand",
      now: Date.UTC(2026, 10, 2),
    });
    expect(oct!.complete).toBe(false);
    expect(oct!.notes.join(" ")).toMatch(/truncat|incomplete/i);
  });
});
