import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

/**
 * CASH-FLOWS: a COD order the SERVER created reaches the kitchen immediately.
 *
 * F04's "no KOT before payment" is about an online order whose money has not
 * arrived. A COD order has no gateway money to wait for, so the ticket prints
 * at creation — but ONLY for the server-priced order, because the proof is the
 * `paymentChannel: "cash"` marker that only `orders/createCashOrder` writes.
 * A payload that merely says `payment.method: "cod"` keeps the old
 * staff-acceptance rule (`pushKotForCashOrderOnAccept`).
 */
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
        savedDocs[path] = opts?.merge && savedDocs[path] ? { ...savedDocs[path], ...data } : data;
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
  isServerAuthorisedCashOrder,
  pushKotForServerCashOrderOnCreate,
} from "../src/modules/petpooja/orderPush";
import { config } from "../src/config/env";

const status = (code: string, terminal = false) => ({ code, label: code, kind: "x", terminal });

describe("which cash order may print at creation", () => {
  it("is true only for a server-priced cash order", () => {
    expect(
      isServerAuthorisedCashOrder({
        paymentChannel: "cash",
        payment: { method: "cod" },
        status: status("PLACED"),
      })
    ).toBe(true);
    // A client-typed cod order carries no server marker: staff acceptance only.
    expect(
      isServerAuthorisedCashOrder({
        payment: { method: "cod" },
        status: status("PLACED"),
      })
    ).toBe(false);
    // A gateway order is never this lane.
    expect(
      isServerAuthorisedCashOrder({
        paymentChannel: "razorpay",
        payment: { method: "upi" },
        status: status("PLACED"),
      })
    ).toBe(false);
    // A closed order owes no ticket.
    expect(
      isServerAuthorisedCashOrder({
        paymentChannel: "cash",
        payment: { method: "cod" },
        status: status("CANCELLED", true),
      })
    ).toBe(false);
  });
});

describe("KOT on create for a server cash order", () => {
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
      petpoojaTaxes: [
        { id: "3928", name: "CGST", rate: 2.5 },
        { id: "3929", name: "SGST", rate: 2.5 },
      ],
    };
    savedDocs["products/itm_1"] = {
      id: "itm_1",
      branchId: "branch_a",
      price: 199,
      inStock: true,
      petpoojaItemId: "7765862",
    };
  });

  afterEach(() => {
    config.mock.petpoojaPos = prevMock;
    vi.unstubAllGlobals();
  });

  const posAck = () => ({
    ok: true,
    status: 200,
    json: async () => ({ success: "1", petpooja_order_id: "pp_cash_1" }),
  });

  it("pushes exactly one KOT at creation", async () => {
    savedDocs["orders/ord_cod_1"] = {
      id: "ord_cod_1",
      fulfillment: "delivery",
      branchId: "branch_a",
      customerName: "Cash Customer",
      customerPhone: "+919825000009",
      items: [{ id: "itm_1", name: "Burger", price: 199, quantity: 1 }],
      pricing: { grandTotal: 199, gst: 9.95 },
      payment: { method: "cod", status: "pending" },
      paymentChannel: "cash",
      cashDuePaise: 19900,
      status: status("PLACED"),
    };
    fetchMock.mockResolvedValueOnce(posAck());

    const pushed = await pushKotForServerCashOrderOnCreate(
      "ord_cod_1",
      savedDocs["orders/ord_cod_1"]
    );

    expect(pushed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(savedDocs["orders/ord_cod_1"].petpoojaOrderId).toBe("pp_cash_1");
  });

  it("does nothing for a client-typed cod order", async () => {
    const order = {
      id: "ord_client_cod",
      branchId: "branch_a",
      payment: { method: "cod" },
      status: status("PLACED"),
    };
    expect(await pushKotForServerCashOrderOnCreate("ord_client_cod", order)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
