import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// CASH-KOT: a cash / pay-at-store order must NOT print a KOT when it is
// created — `payment.method` is client-written, so anyone could mint an
// unpaid ticket by writing "cod". The gate is STAFF ACCEPTANCE: the first
// transition out of PLACED into CONFIRMED/PREPARING (the KDS "Accept KOT
// (Start Prep)" button) through POST /orders/bumpStatus.
//
// In-memory Firestore mock with real-ish get/set/transaction semantics (same
// shape as petpooja.kot-race) so the real pushOrderToPetpooja idempotency
// markers are exercised.
const { mockDb, savedDocs } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const docRef = (col: string, id: string) => {
    const path = `${col}/${id}`;
    return {
      id,
      path,
      get: vi.fn(async () => ({
        exists: Object.prototype.hasOwnProperty.call(savedDocs, path),
        data: () => savedDocs[path],
        ref: docRef(col, id),
      })),
      set: vi.fn(async (data: any, opts?: any) => {
        savedDocs[path] =
          opts?.merge && savedDocs[path] ? { ...savedDocs[path], ...data } : data;
      }),
    };
  };
  const mockDb: any = {
    collection: (col: string) => ({ doc: (id: string) => docRef(col, id) }),
    runTransaction: vi.fn(async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
      })
    ),
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

import {
  isCashOrPayAtStoreOrder,
  isCashKotAcceptTransition,
  pushKotForCashOrderOnAccept,
} from "../src/modules/petpooja/orderPush";
import { config } from "../src/config/env";

const status = (code: string) => ({ code, label: code, kind: "x", terminal: false });
const cash = (code: string) => ({ id: "ord_cash_1", branchId: "branch_a", payment: { method: "cod" }, status: status(code) });
const online = (code: string) => ({ id: "ord_online_1", branchId: "branch_a", payment: { method: "upi" }, status: status(code) });

describe("CASH-KOT gate", () => {
  it("treats cod (cash-on-delivery / pay-at-store) and legacy cash as cash orders", () => {
    expect(isCashOrPayAtStoreOrder({ payment: { method: "cod" } })).toBe(true);
    expect(isCashOrPayAtStoreOrder({ payment: { method: "CASH" } })).toBe(true);
    expect(isCashOrPayAtStoreOrder({ paymentMethod: "cod" })).toBe(true);
  });

  it("never treats an online order as a cash order", () => {
    for (const method of ["upi", "card", "netbanking", "wallet", "online"]) {
      expect(isCashOrPayAtStoreOrder({ payment: { method } })).toBe(false);
    }
    expect(isCashOrPayAtStoreOrder({})).toBe(false);
  });

  it("fires on every first departure from PLACED into a live status", () => {
    expect(isCashKotAcceptTransition(cash("PLACED"), cash("PREPARING"))).toBe(true);
    expect(isCashKotAcceptTransition(cash("PLACED"), cash("CONFIRMED"))).toBe(true);
    // A direct jump past PREPARING must not silently skip the ticket.
    expect(isCashKotAcceptTransition(cash("PLACED"), cash("READY"))).toBe(true);
    // Creation (no status delta), later bumps, and fees/notes updates do nothing.
    expect(isCashKotAcceptTransition(cash("PLACED"), cash("PLACED"))).toBe(false);
    expect(isCashKotAcceptTransition(cash("PREPARING"), cash("READY"))).toBe(false);
    expect(isCashKotAcceptTransition(cash("PLACED"), cash("CANCELLED"))).toBe(false);
    expect(
      isCashKotAcceptTransition(cash("PLACED"), {
        ...cash("DELIVERED"),
        status: { code: "DELIVERED", label: "Delivered", kind: "completed", terminal: true },
      })
    ).toBe(false);
    // Online orders are never this path, even on the same transition.
    expect(isCashKotAcceptTransition(online("PLACED"), online("PREPARING"))).toBe(false);
  });

  it("the customer create trigger no longer pushes a KOT", () => {
    const source = readFileSync(
      resolve(__dirname, "../src/modules/notifications/triggers.ts"),
      "utf8"
    );
    const createStart = source.indexOf("onOrderCreatedNotificationTrigger");
    const updateStart = source.indexOf("handleOrderStatusChanged");
    expect(createStart).toBeGreaterThan(-1);
    expect(updateStart).toBeGreaterThan(createStart);
    expect(source.slice(createStart, updateStart)).not.toContain("pushKotForCashOrder");
  });

  it("the create rules pin status PLACED, so a customer cannot create past PLACED", () => {
    const rules = readFileSync(resolve(__dirname, "../../firestore.rules"), "utf8");
    const start = rules.indexOf("function orderCreateInitialStatus()");
    expect(start).toBeGreaterThan(-1);
    const body = rules.slice(start, start + 400);
    expect(body).toContain("request.resource.data.status.code == 'PLACED'");
    expect(body).toContain("request.resource.data.status.terminal != true");
    // BOTH customer and walk-in create arms require it.
    const createStart = rules.lastIndexOf("match /orders/{orderId}");
    const createEnd = rules.indexOf("allow update: if (", createStart);
    const createArm = rules.slice(createStart, createEnd);
    expect(createArm.match(/orderCreateInitialStatus\(\)/g)).toHaveLength(2);
  });
});

describe("CASH-KOT push on staff acceptance", () => {
  let prevMock: boolean;
  const fetchMock = vi.fn();

  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    prevMock = config.mock.petpoojaPos;
    config.mock.petpoojaPos = false; // live path — the POS POST is stubbed
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    savedDocs["branches/branch_a"] = {
    petpoojaStoreId: "res_a",
    // H2: the branch's CAPTURED tax catalogue (no builder default exists).
    petpoojaTaxes: [
      { id: "3928", name: "CGST", rate: 2.5 },
      { id: "3929", name: "SGST", rate: 2.5 },
    ],
  };
    // POS-11: POS lines are priced from the catalog, so the line's product
    // must exist there (a real order always does). P1-J: the catalog document
    // also carries the POS IDENTITY the KOT is allowed to relay.
    savedDocs["products/itm_1"] = {
      id: "itm_1",
      branchId: "branch_a",
      price: 199,
      inStock: true,
      petpoojaItemId: "7765862",
    };
    savedDocs["orders/ord_cash_1"] = {
      id: "ord_cash_1",
      fulfillment: "takeaway",
      branchId: "branch_a",
      customerName: "Test Customer",
      customerPhone: "+919825000001",
      items: [{ id: "itm_1", name: "Burger", price: 199, quantity: 1 }],
      pricing: { grandTotal: 199, gst: 9.95 },
      payment: { method: "cod", status: "CASH_PENDING" },
      status: status("PLACED"),
    };
  });

  afterEach(() => {
    config.mock.petpoojaPos = prevMock;
    vi.unstubAllGlobals();
  });

  const posAck = () => ({
    ok: true,
    status: 200,
    json: async () => ({ success: "1", petpooja_order_id: "pp_ack_1" }),
  });

  it("pushes exactly once on PLACED -> PREPARING", async () => {
    fetchMock.mockResolvedValueOnce(posAck());

    const pushed = await pushKotForCashOrderOnAccept(
      "ord_cash_1",
      savedDocs["orders/ord_cash_1"],
      { ...savedDocs["orders/ord_cash_1"], status: status("PREPARING") }
    );

    expect(pushed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(savedDocs["orders/ord_cash_1"].petpoojaOrderId).toBe("pp_ack_1");
  });

  it("pushes exactly once on a direct PLACED -> READY bump", async () => {
    fetchMock.mockResolvedValueOnce(posAck());

    const pushed = await pushKotForCashOrderOnAccept(
      "ord_cash_1",
      savedDocs["orders/ord_cash_1"],
      { ...savedDocs["orders/ord_cash_1"], status: status("READY") }
    );

    expect(pushed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(savedDocs["orders/ord_cash_1"].petpoojaOrderId).toBe("pp_ack_1");
  });

  it("pushes nothing on PLACED -> CANCELLED", async () => {
    const pushed = await pushKotForCashOrderOnAccept(
      "ord_cash_1",
      savedDocs["orders/ord_cash_1"],
      { ...savedDocs["orders/ord_cash_1"], status: status("CANCELLED") }
    );

    expect(pushed).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(savedDocs["orders/ord_cash_1"].petpoojaOrderId).toBeUndefined();
  });

  it("a redelivered update event does not push a second KOT", async () => {
    fetchMock.mockResolvedValue(posAck());

    await pushKotForCashOrderOnAccept(
      "ord_cash_1",
      savedDocs["orders/ord_cash_1"],
      { ...savedDocs["orders/ord_cash_1"], status: status("PREPARING") }
    );
    const again = await pushKotForCashOrderOnAccept(
      "ord_cash_1",
      savedDocs["orders/ord_cash_1"],
      { ...savedDocs["orders/ord_cash_1"], status: status("PREPARING") }
    );

    expect(again).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a later transition (PREPARING -> READY) pushes nothing", async () => {
    const pushed = await pushKotForCashOrderOnAccept(
      "ord_cash_1",
      cash("PREPARING"),
      cash("READY")
    );
    expect(pushed).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an online order moved to PREPARING is never pushed by this path", async () => {
    const pushed = await pushKotForCashOrderOnAccept(
      "ord_online_1",
      online("PLACED"),
      online("PREPARING")
    );
    expect(pushed).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a POS failure resolves (false) and parks the order for the retry worker", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      json: async () => ({ success: "1" }),
    });

    const pushed = await pushKotForCashOrderOnAccept(
      "ord_cash_1",
      savedDocs["orders/ord_cash_1"],
      { ...savedDocs["orders/ord_cash_1"], status: status("PREPARING") }
    );

    expect(pushed).toBe(false);
    expect(savedDocs["orders/ord_cash_1"].petpoojaStatus).toBe("pending_retry");
    expect(savedDocs["orders/ord_cash_1"].petpoojaOrderId).toBeUndefined();
  });
});
