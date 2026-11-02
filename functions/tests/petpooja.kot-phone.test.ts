import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * KOT-PHONE — the KOT must carry a real customer contact, resolved the same way
 * every other booking path resolves it.
 *
 * A real customer-app order has NO `customerPhone`, and BOTH address blocks
 * carry `contactPhone: ""` (the address form permits an empty contact). The
 * builder read `order.customerPhone || order.customer?.phone ||
 * order.address?.contactPhone` and therefore relayed `phone: ""` — the outlet
 * prints a ticket nobody can be called about, and a rider can never reach the
 * customer.
 *
 * The customer signs in BY PHONE, so the verified Auth profile already holds it.
 * Contract pinned here:
 *   - a persisted `customerPhone` is used as-is, with NO Auth I/O (hot path);
 *   - otherwise the shared resolver (functions/src/core/dropContact.ts) supplies
 *     it: address contacts, then the VERIFIED Auth phone;
 *   - a failed Auth lookup never blocks the KOT, and is logged;
 *   - Petpooja's documented shape is a 10-digit contact number, so the relay
 *     sends the national 10 digits (never a fake/blank-but-valid value).
 *
 * Real document shapes only.
 */
const { savedDocs, mockDb, getUserSpy } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const getUserSpy = vi.fn();

  const docRef = (col: string, id: string): any => {
    const path = `${col}/${id}`;
    const ref: any = {
      id,
      path,
      get: async () => ({
        exists: Object.prototype.hasOwnProperty.call(savedDocs, path),
        data: () => savedDocs[path],
        ref,
      }),
      set: async (data: any, opts?: any) => {
        savedDocs[path] =
          opts?.merge && savedDocs[path] ? { ...savedDocs[path], ...data } : { ...data };
      },
    };
    return ref;
  };

  const q = (): any => ({
    where: () => q(),
    orderBy: () => q(),
    limit: () => q(),
    startAfter: () => q(),
    get: async () => ({ empty: true, docs: [] }),
  });

  const mockDb: any = {
    collection: (col: string) => ({ ...q(), doc: (id?: string) => docRef(col, id as string) }),
    getAll: async (...refs: any[]) => Promise.all(refs.map((r: any) => r.get())),
    runTransaction: async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
      }),
  };
  return { savedDocs, mockDb, getUserSpy };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TIMESTAMP",
    increment: (n: number) => n,
    delete: () => "MOCK_DELETE",
  };
  const firestoreFn: any = vi.fn(() => mockDb);
  firestoreFn.FieldValue = FieldValue;
  const authFn: any = vi.fn(() => ({ getUser: getUserSpy }));
  return {
    default: {
      firestore: firestoreFn,
      auth: authFn,
      messaging: vi.fn(() => ({})),
      initializeApp: vi.fn(),
      apps: [{ name: "mock" }],
    },
    firestore: firestoreFn,
    auth: authFn,
    messaging: vi.fn(() => ({})),
    initializeApp: vi.fn(),
    apps: [{ name: "mock" }],
  };
});

import { pushOrderToPetpooja } from "../src/modules/petpooja/orderPush";
import { config } from "../src/config/env";

const BRANCH = "branch_phone";
const UID = "uid_phone_customer";

let prevMock: boolean;
const fetchMock = vi.fn();

function seedCommon() {
  savedDocs[`branches/${BRANCH}`] = {
    name: "Phone Outlet",
    petpoojaStoreId: "res_phone",
    petpoojaTaxes: [{ id: "3928", name: "CGST", rate: 2.5 }],
  };
  savedDocs["products/prod_phone"] = {
    id: "prod_phone",
    branchId: BRANCH,
    name: "Smash Burger",
    price: 250,
    inStock: true,
    petpoojaItemId: "7765862",
  };
}

/** The exact shape the customer app writes: no customerPhone, empty contacts. */
function seedCustomerAppOrder(id: string, extra: Record<string, any> = {}) {
  savedDocs[`orders/${id}`] = {
    id,
    branchId: BRANCH,
    customerId: UID,
    userId: UID,
    customerName: "Aarav Mehta",
    fulfillmentType: "DELIVERY",
    paymentMethod: "COD",
    dispatchProvider: "borzo",
    deliveryAddress: {
      full: "12 Adajan Main Rd, Surat",
      line1: "12 Adajan Main Rd",
      contactName: "Aarav Mehta",
      contactPhone: "",
      lat: 21.17,
      lng: 72.83,
    },
    address: {
      street: "12 Adajan Main Rd",
      contactName: "Aarav Mehta",
      contactPhone: "",
    },
    items: [
      { id: "l1", productId: "prod_phone", name: "Smash Burger", price: 250, quantity: 1 },
    ],
    pricing: {
      grandTotal: 310,
      gst: 11.9,
      packagingFee: 0,
      deliveryFee: 60,
      discount: 0,
      loyaltyDiscount: 0,
    },
    paymentStatus: "completed",
    status: "pending",
    ...extra,
  };
}

function relayed(): any {
  const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  expect(call).toBeTruthy();
  return JSON.parse(call[1].body).orderinfo.OrderInfo;
}

beforeEach(() => {
  for (const key of Object.keys(savedDocs)) delete savedDocs[key];
  prevMock = config.mock.petpoojaPos;
  config.mock.petpoojaPos = false; // live path; the POST is stubbed
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ success: "1", orderID: "pp_phone_1" }),
  });
  vi.stubGlobal("fetch", fetchMock);
  getUserSpy.mockReset();
  getUserSpy.mockResolvedValue({
    uid: UID,
    phoneNumber: "+919825012345",
    displayName: "Aarav Mehta",
  });
  seedCommon();
});

afterEach(() => {
  config.mock.petpoojaPos = prevMock;
  vi.unstubAllGlobals();
});

describe("KOT-PHONE customer contact on the relayed KOT", () => {
  it("fills the phone from the verified Auth profile when the order has none", async () => {
    seedCustomerAppOrder("ord_phone_auth");

    expect(await pushOrderToPetpooja("ord_phone_auth")).toBe(true);
    const info = relayed();
    // The resolver's documented form is +<country><national>; the relay keeps
    // that explicit-country shape (references/petpooja_save_order_api.md §3:
    // `phone` is the contact number, 10-digit national in the vendor's example).
    expect(info.Customer.details.phone).toBe("+919825012345");
    expect(info.Customer.details.phone).not.toBe("");
    expect(getUserSpy).toHaveBeenCalledWith(UID);
  });

  it("uses a persisted customerPhone as-is, with NO Auth round-trip (hot path)", async () => {
    seedCustomerAppOrder("ord_phone_persisted", { customerPhone: "+919825099999" });

    expect(await pushOrderToPetpooja("ord_phone_persisted")).toBe(true);
    expect(relayed().Customer.details.phone).toBe("+919825099999");
    expect(getUserSpy).not.toHaveBeenCalled();
  });

  it("prefers a real address contactPhone over the Auth profile", async () => {
    seedCustomerAppOrder("ord_phone_address");
    savedDocs["orders/ord_phone_address"].address.contactPhone = "9825088888";

    expect(await pushOrderToPetpooja("ord_phone_address")).toBe(true);
    expect(relayed().Customer.details.phone).toBe("+919825088888");
    expect(getUserSpy).not.toHaveBeenCalled();
  });

  it("a FAILED Auth lookup never blocks the KOT and is logged", async () => {
    seedCustomerAppOrder("ord_phone_auth_down");
    getUserSpy.mockRejectedValueOnce(
      Object.assign(new Error("auth/user-not-found"), { code: "auth/user-not-found" })
    );

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const snapshotSpy: string[] = [];
    const origWarn = warn.getMockImplementation();
    void origWarn;
    try {
      expect(await pushOrderToPetpooja("ord_phone_auth_down")).toBe(true);
    } finally {
      // The ticket still relays; the contact gap is visible, not fatal.
      const info = relayed();
      expect(info.Customer.details.phone).toBe("");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // An operator-visible snapshot is written for the missing contact.
      for (const [path, doc] of Object.entries(savedDocs)) {
        if (path.startsWith("dev_error_snapshots/")) {
          snapshotSpy.push(String((doc as any)?.message || ""));
        }
      }
      expect(snapshotSpy.join(" ")).toMatch(/customer phone/i);
      // And the failed lookup is logged rather than swallowed silently.
      const logged = warn.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
      expect(logged).toMatch(/auth|phone/i);
      warn.mockRestore();
    }
  });

  it("keeps the ticket relayed when the profile has no phone at all", async () => {
    seedCustomerAppOrder("ord_phone_none");
    getUserSpy.mockResolvedValueOnce({ uid: UID, phoneNumber: undefined });

    expect(await pushOrderToPetpooja("ord_phone_none")).toBe(true);
    expect(relayed().Customer.details.phone).toBe("");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
