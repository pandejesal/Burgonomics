import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";

/**
 * P1-F — every delivery order was unbookable: "Customer phone number is missing".
 *
 * LIVE EVIDENCE (order ord_1793599121207_hJvkYS, paid, placed through the real
 * customer app): POST /dispatch/book returned 500 with that message. On the
 * order there is NO `customerPhone` field at all; `address.contactPhone` and
 * `deliveryAddress.contactPhone` are EMPTY STRINGS, and so are both
 * `contactName`s; `customerId` and `userId` carry the Firebase uid; `store.phone`
 * is set. `dispatch.router.ts` read only `order.customerPhone`, and the customer
 * app writes no such field — so no delivery order could ever be booked.
 *
 * The customer signed in by phone, so the number is known server-side. The fix
 * resolves the drop contact in ONE shared helper, in this order:
 *   order.customerPhone -> deliveryAddress.contactPhone -> address.contactPhone
 *   -> the VERIFIED phone on the Firebase Auth user (admin.auth().getUser),
 *      never a client-supplied value.
 * Name: contactName -> profile name -> "Customer". Nothing resolvable = a typed
 * 4xx refusal with staff copy, never a 500.
 *
 * The resolved phone is persisted on the order (only when the order carries
 * none) so a rebook and the partner app's rider call need no second Auth lookup.
 * A value the customer entered is never overwritten.
 *
 * Fixtures use the REAL shape: empty-string contacts, absent customerPhone.
 */

const { mockDb, savedDocs, mockAuth } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const mergeSet = (colName: string, docId: string, data: any) => {
    savedDocs[`${colName}/${docId}`] = {
      ...(savedDocs[`${colName}/${docId}`] || {}),
      ...data,
    };
  };
  const readDoc: any = (colName: string, docId: string) => {
    const rec = savedDocs[`${colName}/${docId}`];
    return {
      exists: !!rec,
      id: docId,
      data: () => (rec ? rec : undefined),
      ref: {
        get: vi.fn(async () => readDoc(colName, docId)),
        set: vi.fn(async (data: any) => mergeSet(colName, docId, data)),
      },
    };
  };
  const mockDb: any = {
    collection: (colName: string) => ({
      doc: (docId: string) => ({
        id: docId,
        set: vi.fn(async (data: any) => mergeSet(colName, docId, data)),
        get: vi.fn(async () => readDoc(colName, docId)),
      }),
      where: () => ({
        limit: () => ({ get: async () => ({ empty: true, docs: [] }) }),
      }),
    }),
    runTransaction: vi.fn(async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
      })
    ),
  };
  const mockAuth: any = {
    getUser: vi.fn(async (uid: string) => ({
      uid,
      phoneNumber: "+919825012345",
      displayName: "Aarav Shah",
    })),
  };
  return { mockDb, savedDocs, mockAuth };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TIMESTAMP",
    increment: (n: number) => n,
    arrayUnion: (item: any) => [item],
  };
  const firestoreFn: any = vi.fn(() => mockDb);
  firestoreFn.FieldValue = FieldValue;
  const authFn: any = vi.fn(() => mockAuth);
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

import { dispatchBook, dispatchRebook } from "../src/modules/dispatch/dispatch.router";
import { bookPorterRider } from "../src/modules/porter/porter.service";
import { config } from "../src/config/env";

const okJson = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const originalFetch = globalThis.fetch;
let fetchCalls: Array<{ url: string; init: any }> = [];
let fetchHandler: ((url: string) => Response) | null = null;
let saved: any = {};

beforeAll(() => {
  globalThis.fetch = vi.fn(async (url: any, init: any) => {
    fetchCalls.push({ url: String(url), init });
    if (fetchHandler) return fetchHandler(String(url));
    return okJson({ message: "no fetch handler registered" }, 404);
  }) as any;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  saved = {
    borzo: { ...config.borzo },
    shadowfax: { ...config.shadowfax },
    porter: { ...config.porter },
    mock: { ...config.mock },
    dispatch: { ...config.dispatch },
  };
  config.borzo.enabled = true;
  config.borzo.apiKey = "k_borzo_test";
  config.borzo.customerId = "c_borzo_test";
  config.borzo.webhookSecret = "test_borzo_whsec_vitest_only";
  config.mock.borzoDispatch = false;
  config.shadowfax.enabled = false;
  config.shadowfax.apiKey = "";
  config.shadowfax.clientCode = "";
  config.mock.shadowfaxDispatch = false;
  config.porter.enabled = false;
  config.porter.apiKey = "";
  config.mock.porterDispatch = false;
  config.dispatch.fareConfirmDeltaInr = 1000;
  config.dispatch.requireLive = false;

  for (const k of Object.keys(savedDocs)) delete savedDocs[k];
  fetchCalls = [];
  fetchHandler = null;
  mockAuth.getUser.mockClear();
  mockAuth.getUser.mockImplementation(async (uid: string) => ({
    uid,
    phoneNumber: "+919825012345",
    displayName: "Aarav Shah",
  }));
});

afterEach(() => {
  config.borzo = { ...saved.borzo };
  config.shadowfax = { ...saved.shadowfax };
  config.porter = { ...saved.porter };
  config.mock = { ...saved.mock };
  config.dispatch = { ...saved.dispatch };
});

/**
 * The REAL customer-app order shape from the live failure. `contactPhone` and
 * `contactName` are present-but-EMPTY strings (the address form allows that),
 * `customerPhone` is absent entirely, and `customerId`/`userId` carry the uid.
 */
function seedRealOrder(id: string, extra: Record<string, any> = {}) {
  savedDocs[`orders/${id}`] = {
    branchId: "branch_ahmedabad_1",
    branchName: "Burgonomics CG Road",
    store: {
      name: "Burgonomics CG Road",
      phone: "+91 98250 12345",
      city: "Ahmedabad",
      state: "Gujarat",
    },
    branchCoordinates: { lat: 23.0131, lng: 72.5085 },
    orderType: "delivery",
    fulfillment: "delivery",
    customerId: "uid_customer_live_1",
    userId: "uid_customer_live_1",
    customerName: "Aarav Shah",
    address: {
      label: "Home",
      contactName: "",
      contactPhone: "",
      line1: "102, Shivalik Highstreet",
      city: "Ahmedabad",
      state: "Gujarat",
      pincode: "380015",
      lat: 23.0338,
      lng: 72.5262,
    },
    deliveryAddress: {
      label: "Home",
      contactName: "",
      contactPhone: "",
      line1: "102, Shivalik Highstreet",
      full: "102, Shivalik Highstreet, Vastrapur",
      city: "Ahmedabad",
      state: "Gujarat",
      pincode: "380015",
      lat: 23.0338,
      lng: 72.5262,
    },
    status: "ready",
    paymentStatus: "paid",
    ...extra,
  };
}

function docOf(id: string): any {
  return savedDocs[`orders/${id}`];
}

/** Live Borzo wire that records the create-order body for contact assertions. */
function borzoWire(providerOrderId: string) {
  fetchHandler = (url) => {
    if (url.includes("/calculate-order")) {
      return okJson({ is_successful: true, order: { payment_amount: "50.00" } });
    }
    if (url.includes("/create-order")) {
      return okJson({
        is_successful: true,
        order: {
          order_id: providerOrderId,
          points: [
            { tracking_url: `https://track.borzodelivery.com/t/${providerOrderId}` },
          ],
        },
      });
    }
    return okJson({ message: "not found" }, 404);
  };
}

const createOrderCall = () => fetchCalls.find((c) => c.url.includes("/create-order"));

describe("P1-F: the drop contact is resolved server-side from the verified profile", () => {
  it("books the real live order shape by resolving the phone from Firebase Auth, and persists it", async () => {
    borzoWire("BZ-P1F-1");
    seedRealOrder("ord_1793599121207_hJvkYS");

    const res: any = await dispatchBook({
      orderId: "ord_1793599121207_hJvkYS",
      staffName: "Ops",
    });

    expect(res).toMatchObject({ provider: "borzo", providerOrderId: "BZ-P1F-1" });

    // The uid on the order was the ONLY phone source — looked up server-side.
    expect(mockAuth.getUser).toHaveBeenCalledWith("uid_customer_live_1");

    // The courier is given a real, correctly normalised drop number.
    const body = JSON.parse(createOrderCall()!.init.body);
    const dropPoint = body.points[1];
    expect(dropPoint.contact_person.phone).toBe("919825012345");
    expect(dropPoint.contact_person.name).toBe("Aarav Shah");

    // Persisted so a rebook / the partner rider-call needs no second lookup.
    const doc = docOf("ord_1793599121207_hJvkYS");
    expect(doc.customerPhone).toBe("+919825012345");
    expect(doc.customerPhoneSource).toBe("firebase_auth");
    expect(doc.customerPhoneResolvedAt).toBe("MOCK_TIMESTAMP");
  });

  it("uses a non-empty address contact before touching Firebase Auth, and never overwrites a customer-entered phone", async () => {
    borzoWire("BZ-P1F-2");
    seedRealOrder("ord_p1f_address", {
      deliveryAddress: {
        label: "Home",
        contactName: "Riya",
        contactPhone: "9825011111",
        line1: "102, Shivalik Highstreet",
        full: "102, Shivalik Highstreet, Vastrapur",
        city: "Ahmedabad",
        state: "Gujarat",
        pincode: "380015",
        lat: 23.0338,
        lng: 72.5262,
      },
    });

    await dispatchBook({ orderId: "ord_p1f_address" });

    expect(mockAuth.getUser).not.toHaveBeenCalled();
    const body = JSON.parse(createOrderCall()!.init.body);
    expect(body.points[1].contact_person.phone).toBe("919825011111");
    expect(body.points[1].contact_person.name).toBe("Riya");
    // No `customerPhone` existed, so the resolved value is recorded.
    expect(docOf("ord_p1f_address").customerPhone).toBe("+919825011111");
    expect(docOf("ord_p1f_address").customerPhoneSource).toBe(
      "deliveryAddress.contactPhone"
    );

    // A customer-entered `customerPhone` wins over everything and is untouched.
    borzoWire("BZ-P1F-3");
    seedRealOrder("ord_p1f_entered", { customerPhone: "+91 90000 00001" });
    await dispatchBook({ orderId: "ord_p1f_entered" });
    expect(mockAuth.getUser).not.toHaveBeenCalled();
    expect(docOf("ord_p1f_entered").customerPhone).toBe("+91 90000 00001");
    expect(docOf("ord_p1f_entered").customerPhoneSource).toBeUndefined();
  });

  it("refuses with a typed 4xx and staff copy when nothing can be resolved — never a 500", async () => {
    borzoWire("BZ-NEVER-BOOKED");
    seedRealOrder("ord_p1f_none");
    mockAuth.getUser.mockRejectedValueOnce(Object.assign(new Error("no user"), { code: "auth/user-not-found" }));

    const err: any = await dispatchBook({ orderId: "ord_p1f_none" }).catch((e) => e);

    expect(err).toMatchObject({
      statusCode: 422,
      code: "DISPATCH_CONTACT_MISSING",
    });
    expect(err.message).toMatch(/customer phone/i);
    // Fail closed: no booking, no created order, nothing half-written.
    expect(createOrderCall()).toBeUndefined();
    expect(docOf("ord_p1f_none").dispatchOrderId ?? null).toBeNull();
  });

  it("rebook resolves the contact for a stored order that still has no phone", async () => {
    borzoWire("BZ-P1F-REBOOK");
    seedRealOrder("ord_p1f_rebook", {
      deliveryStatus: "rider_cancelled",
      dispatchStatus: "cancelled_by_store",
      dispatchProvider: null,
      dispatchOrderId: null,
      needsRebook: true,
      rebookTrigger: "carrier_cancelled",
    });

    const res: any = await dispatchRebook({ orderId: "ord_p1f_rebook", staffName: "Ops" });

    expect(res).toMatchObject({ provider: "borzo", providerOrderId: "BZ-P1F-REBOOK" });
    const body = JSON.parse(createOrderCall()!.init.body);
    expect(body.points[1].contact_person.phone).toBe("919825012345");
    expect(docOf("ord_p1f_rebook").customerPhone).toBe("+919825012345");
  });

  it("the Porter booking path resolves the same contact instead of refusing", async () => {
    config.porter.enabled = true;
    config.porter.apiKey = "porter_key_test";
    config.porter.customerId = "porter_customer_test";
    config.porter.webhookSecret = "porter_whsec_test";
    config.mock.porterDispatch = false;
    seedRealOrder("ord_p1f_porter");
    fetchHandler = (url) => {
      if (url.includes("quote")) {
        return okJson({ estimated_fare: 55, estimated_distance_km: 2.1, estimated_pickup_minutes: 4 });
      }
      return okJson({
        order_id: "POR-P1F-1",
        driver_name: "Ramesh Patel",
        driver_mobile: "9825011223",
        vehicle_number: "GJ-01-EE-8821",
        tracking_url: "https://tracking.porter.in/track/POR-P1F-1",
        estimate: "55",
      });
    };

    const res: any = await bookPorterRider("ord_p1f_porter", "Ops");

    expect(res.porterOrderId).toBe("POR-P1F-1");
    expect(mockAuth.getUser).toHaveBeenCalledWith("uid_customer_live_1");
    // The live Porter payload carries the resolved number, not an empty string.
    const booked = fetchCalls.find((c) => c.init?.method === "POST" && c.url.includes("porter"));
    expect(String(booked?.init?.body)).toContain("919825012345");
    expect(docOf("ord_p1f_porter").customerPhone).toBe("+919825012345");
  });
});
