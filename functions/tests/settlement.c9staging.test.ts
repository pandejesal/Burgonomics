import { describe, it, expect, vi, beforeEach } from "vitest";

/** Real settlement service against a Firestore shim that enforces read-before-write. */
const { savedDocs, mockDb } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const apply = (p: string, d: any, merge: boolean) => {
    const base = merge && savedDocs[p] ? { ...savedDocs[p] } : {};
    for (const [k, v] of Object.entries(d || {})) base[k] = v;
    savedDocs[p] = base;
  };
  const ref = (col: string, id: string): any => ({
    id,
    path: `${col}/${id}`,
    get: async () => ({ id, exists: !!savedDocs[`${col}/${id}`], data: () => savedDocs[`${col}/${id}`], ref: ref(col, id) }),
    set: async (d: any, o?: any) => apply(`${col}/${id}`, d, !!o?.merge),
    create: async (d: any) => apply(`${col}/${id}`, d, false),
    update: async (d: any) => apply(`${col}/${id}`, d, true),
  });
  const q = (col: string, filters: any[] = [], max = Infinity, after?: string): any => ({
    where: (f: string, op: string, v: any) => q(col, [...filters, { f, op, v }], max, after),
    orderBy: () => q(col, filters, max, after),
    limit: (n: number) => q(col, filters, n, after),
    startAfter: (d: any) => q(col, filters, max, String(d?.id ?? d)),
    get: async () => {
      let paths = Object.keys(savedDocs).filter((p) => p.startsWith(`${col}/`)).sort();
      if (after) paths = paths.filter((p) => p.slice(col.length + 1) > after);
      const docs = paths.slice(0, max === Infinity ? undefined : max).map((p) => {
        const id = p.slice(col.length + 1);
        return { id, ref: ref(col, id), data: () => savedDocs[p], exists: true };
      });
      return { empty: !docs.length, docs, size: docs.length };
    },
  });
  const mockDb: any = {
    collection: (col: string) => ({ ...q(col), add: async (d: any) => { apply(`${col}/auto`, d, false); return { id: "auto" }; }, doc: (id?: string) => ref(col, id || "auto") }),
    runTransaction: async (fn: any) => {
      let wrote = false;
      const tx = {
        get: async (r: any) => {
          if (wrote) throw new Error("Firestore transactions require all reads to be executed before all writes.");
          return r.get();
        },
        set: (r: any, d: any, o?: any) => { wrote = true; return r.set(d, o); },
        create: (r: any, d: any) => { wrote = true; return r.create(d); },
        update: (r: any, d: any) => { wrote = true; return r.update(d); },
      };
      return fn(tx);
    },
  };
  return { savedDocs, mockDb };
});

vi.mock("firebase-admin", () => {
  const f: any = vi.fn(() => mockDb);
  f.FieldValue = { serverTimestamp: () => "TS", increment: (n: number) => ({ __inc: n }), delete: () => "DEL" };
  return { default: { firestore: f, initializeApp: vi.fn(), apps: [{ name: "mock" }], auth: vi.fn(() => ({})), messaging: vi.fn(() => ({})) }, firestore: f, initializeApp: vi.fn(), apps: [{ name: "mock" }], auth: vi.fn(() => ({})), messaging: vi.fn(() => ({})) };
});

import { generateSettlementStatement } from "../src/modules/settlements/settlementService";

beforeEach(() => {
  for (const k of Object.keys(savedDocs)) delete savedDocs[k];
  savedDocs["branches/demo"] = { name: "Demo", active: true, settlementFee: 2000 };
  savedDocs["settlement_versions/demo_2026-09"] = { branchId: "demo", monthKey: "2026-09", latestVersion: 1 };
  savedDocs["branch_settlements/demo_2026-09_v001"] = { id: "demo_2026-09_v001", branchId: "demo", monthKey: "2026-09", version: 1, current: true, ledgerSchema: 1 };
  savedDocs["orders/o1"] = { id: "o1", branchId: "demo", paymentChannel: "cash", settlementEffectiveAtMs: Date.UTC(2026, 8, 15), settlementCaptureState: "confirmed", settlementCaptureUnresolved: false, customerId: "cust_walkin", status: { code: "COMPLETED" }, pricing: { grandTotal: 100 } };
});

describe("cycle-9 staging settlement fixes", () => {
  it("generation with prior versions reads them all before writing", async () => {
    const s = await generateSettlementStatement({ branchId: "demo", monthKey: "2026-09", caller: { uid: "u", role: "brand_owner" }, source: "on_demand", now: Date.UTC(2026, 9, 2) });
    expect(s!.version).toBe(2);
    expect(savedDocs["branch_settlements/demo_2026-09_v001"].current).toBe(false);
  });
});
