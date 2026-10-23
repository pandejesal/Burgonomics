import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockDb, savedDocs } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const docRef = (col: string, id: string) => {
    const path = `${col}/${id}`;
    return {
      id,
      path,
      get: vi.fn(async () => ({
        exists: Object.prototype.hasOwnProperty.call(savedDocs, path),
        data: () => (savedDocs[path] ? JSON.parse(JSON.stringify(savedDocs[path])) : undefined),
        ref: docRef(col, id),
      })),
      set: vi.fn(async (data: any, opts?: any) => {
        savedDocs[path] =
          opts?.merge && savedDocs[path] ? { ...savedDocs[path], ...data } : { ...data };
      }),
      update: vi.fn(async (data: any) => {
        if (!savedDocs[path]) throw new Error(`Document ${path} does not exist`);
        savedDocs[path] = { ...savedDocs[path], ...data };
      }),
    };
  };

  const mockDb: any = {
    collection: (col: string) => ({
      doc: (id: string) => docRef(col, id),
      where: (field: string, op: string, val: any) => ({
        limit: (n: number) => ({
          get: async () => {
            const matched = Object.entries(savedDocs)
              .filter(([p]) => p.startsWith(`${col}/`))
              .map(([p, data]) => ({
                id: p.slice(col.length + 1),
                ref: docRef(col, p.slice(col.length + 1)),
                data: () => data,
              }))
              .filter((d) => d.data()[field] === val)
              .slice(0, n);
            return { docs: matched, empty: matched.length === 0 };
          },
        }),
      }),
    }),
    runTransaction: vi.fn(async (fn: any) =>
      fn({
        get: async (ref: any) => ref.get(),
        set: async (ref: any, data: any, opts?: any) => ref.set(data, opts),
        update: async (ref: any, data: any) => ref.update(data),
      })
    ),
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

import { pushOrderToPetpooja } from "../src/modules/petpooja/orderPush";
import { config } from "../src/config/env";

describe("KOT Truth & Relay Semantics (Review Finding 5 & Limitations)", () => {
  let prevMock: boolean;
  const fetchMock = vi.fn();

  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    prevMock = config.mock.petpoojaPos;
    config.mock.petpoojaPos = false; // Live path default
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);

    savedDocs["branches/branch_truth_1"] = {
      name: "Ahmedabad Truth Outlet",
      petpoojaStoreId: "res_truth_01",
    };

    savedDocs["orders/ord_truth_1"] = {
      id: "ord_truth_1",
      branchId: "branch_truth_1",
      customerName: "Relay Truth Customer",
      customerPhone: "+919825000001",
      items: [{ id: "itm_1", name: "Smash Burger", price: 200, quantity: 1 }],
      pricing: { grandTotal: 200, gst: 10 },
      status: "pending",
    };
  });

  afterEach(() => {
    config.mock.petpoojaPos = prevMock;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("mock push records kotPushedAt and synced state but NEVER manufactures kotPrinted", async () => {
    config.mock.petpoojaPos = true;

    const res = await pushOrderToPetpooja("ord_truth_1");
    expect(res).toBe(true);

    const doc = savedDocs["orders/ord_truth_1"];
    expect(doc.petpoojaStatus).toBe("synced");
    expect(doc.petpoojaSyncStatus).toBe("synced");
    expect(doc.petpoojaMock).toBe(true);
    // KOT Truth: network relay acceptance or mock delivery is NOT physical printer proof!
    expect(doc.kotPrinted).toBeUndefined();
    expect(doc.kotPrintedAt).toBeUndefined();
    expect(doc.kotPushedAt).toBe("MOCK_SERVER_TIMESTAMP");
  });

  it("live relay ACK with order ID records petpoojaOrderId and kotPushedAt but NO printed claim", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: "1",
        message: "Your order is saved.",
        orderID: "PP-SERVER-8888",
        restID: "res_truth_01",
      }),
    });

    const res = await pushOrderToPetpooja("ord_truth_1");
    expect(res).toBe(true);

    const doc = savedDocs["orders/ord_truth_1"];
    expect(doc.petpoojaOrderId).toBe("PP-SERVER-8888");
    expect(doc.petpoojaStatus).toBe("synced");
    expect(doc.petpoojaSyncStatus).toBe("synced");
    // Network ACK from POS cloud server does not prove kitchen hardware printed physical ticket
    expect(doc.kotPrinted).toBeUndefined();
    expect(doc.kotPrintedAt).toBeUndefined();
    expect(doc.kotPushedAt).toBe("MOCK_SERVER_TIMESTAMP");
  });

  it("live relay ACK without order ID records accepted-no-id and kotPushedAt but NO printed claim", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: "1",
        message: "Your order is saved.",
        orderID: "",
        restID: "res_truth_01",
      }),
    });

    const res = await pushOrderToPetpooja("ord_truth_1");
    expect(res).toBe(true);

    const doc = savedDocs["orders/ord_truth_1"];
    expect(doc.petpoojaAcceptedNoId).toBe(true);
    expect(doc.petpoojaStatus).toBe("synced");
    expect(doc.petpoojaSyncStatus).toBe("synced");
    // No physical printing claimed
    expect(doc.kotPrinted).toBeUndefined();
    expect(doc.kotPrintedAt).toBeUndefined();
    expect(doc.kotPushedAt).toBe("MOCK_SERVER_TIMESTAMP");
  });

  it("preserves genuine preexisting physical printer evidence on subsequent push ACKs", async () => {
    // Order already had genuine physical printer proof from terminal printer webhook/event
    const genuinePrinterTimestamp = 1700000000000;
    savedDocs["orders/ord_truth_1"].kotPrinted = true;
    savedDocs["orders/ord_truth_1"].kotPrintedAt = genuinePrinterTimestamp;

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: "1",
        message: "Your order is saved.",
        orderID: "PP-SERVER-9999",
      }),
    });

    const res = await pushOrderToPetpooja("ord_truth_1");
    expect(res).toBe(true);

    const doc = savedDocs["orders/ord_truth_1"];
    expect(doc.petpoojaOrderId).toBe("PP-SERVER-9999");
    expect(doc.petpoojaStatus).toBe("synced");
    // Genuine historical evidence preserved via merge
    expect(doc.kotPrinted).toBe(true);
    expect(doc.kotPrintedAt).toBe(genuinePrinterTimestamp);
    expect(doc.kotPushedAt).toBe("MOCK_SERVER_TIMESTAMP");
  });

  it("deduplication on ID or no-ID prevents duplicate provider POSTs without manufacturing printing claims", async () => {
    // 1. With ID
    savedDocs["orders/ord_truth_1"].petpoojaOrderId = "pp_existing_123";
    const dupRes1 = await pushOrderToPetpooja("ord_truth_1");
    expect(dupRes1).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();

    // 2. Without ID (acceptedNoId)
    delete savedDocs["orders/ord_truth_1"].petpoojaOrderId;
    savedDocs["orders/ord_truth_1"].petpoojaAcceptedNoId = true;
    const dupRes2 = await pushOrderToPetpooja("ord_truth_1");
    expect(dupRes2).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(savedDocs["orders/ord_truth_1"].kotPrinted).toBeUndefined();
  });

  it("reconciliation marker blocks direct push when POS delivery is ambiguous (unreachable / timeout)", async () => {
    savedDocs["orders/ord_truth_1"].petpoojaStatus = "reconciliation_required";
    savedDocs["orders/ord_truth_1"].kotSyncFailed = true;

    const res = await pushOrderToPetpooja("ord_truth_1");
    expect(res).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
