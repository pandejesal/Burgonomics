import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";

/**
 * DEMO HOTFIX — "borzo returned an unparseable branch phone" (paid phone order
 * `ord_1793619336679_6okyas`, branchId `demo`, READY_FOR_PICKUP).
 *
 * The order carried NO `store.phone` snapshot (the installed client app cached
 * a store record written before the phone existed), while the canonical
 * `branches/demo.phone` is present and normalises to a valid Indian number.
 * `dispatch.router.ts` resolved the pickup GPS from the branch document but
 * took the pickup CONTACT only from the order snapshot, so Borzo's
 * `buildPoints` threw `unparseable("borzo", "branch phone")` pre-transport:
 * staff saw a 502 with a provider-shaped message, the claim had ALREADY been
 * taken (dispatchStatus dispatch_pending → transient_failure, needsRebook true,
 * generation 3) and no create-order ever happened.
 *
 * Contract pinned here (through the PUBLIC dispatchBook/dispatchRebook entry
 * points, with the REAL Borzo adapter and only the provider transport mocked):
 *   - the pickup contact is resolved SERVER-SIDE from the canonical
 *     `branches/{order.branchId}` document BEFORE the per-order claim and any
 *     provider request;
 *   - the canonical branch number WINS over a client-supplied/store snapshot
 *     number (a spoofed or stale snapshot can never redirect the courier);
 *   - the drop (customer) contact is untouched — still the verified/entered
 *     number, never substituted into the pickup point;
 *   - nothing resolvable anywhere = typed 422 DISPATCH_PICKUP_PHONE_MISSING
 *     with staff copy, BEFORE the claim (no lease) and before any provider
 *     request (no calculate-order, no create-order, no correlation stamp);
 *   - an order without a branch document still dispatches from its own real
 *     snapshot (legacy fixtures / pre-snapshot branch records);
 *   - /dispatch/quote without an order stays usable (no branch lookup, the
 *     pickup phone is simply omitted as before).
 */

const { mockDb, savedDocs, mockAuth, reads } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const reads: string[] = [];
  const mergeSet = (colName: string, docId: string, data: any) => {
    savedDocs[`${colName}/${docId}`] = {
      ...(savedDocs[`${colName}/${docId}`] || {}),
      ...data,
    };
  };
  const readDoc: any = (colName: string, docId: string) => {
    reads.push(`${colName}/${docId}`);
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
  return { mockDb, savedDocs, mockAuth, reads };
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

import {
  dispatchBook,
  dispatchQuote,
  dispatchRebook,
} from "../src/modules/dispatch/dispatch.router";
import { config } from "../src/config/env";

const okJson = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const originalFetch = globalThis.fetch;
let fetchCalls: Array<{ url: string; init: any }> = [];
let fetchHandler: ((url: string) => Response) | null = null;

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

let saved: any = {};

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
  reads.length = 0;
  mockAuth.getUser.mockClear();
});

afterEach(() => {
  config.borzo = { ...saved.borzo };
  config.shadowfax = { ...saved.shadowfax };
  config.porter = { ...saved.porter };
  config.mock = { ...saved.mock };
  config.dispatch = { ...saved.dispatch };
});

/**
 * The LIVE failure shape: branchId `demo`, READY_FOR_PICKUP, paid, phone order.
 * `store` exists (the installed client cached it) but carries NO phone.
 */
function seedDemoOrder(id: string, extra: Record<string, any> = {}) {
  savedDocs[`orders/${id}`] = {
    branchId: "demo",
    branchName: "Burgonomics Demo",
    store: { name: "Burgonomics Demo", city: "Ahmedabad", state: "Gujarat" },
    branchCoordinates: { lat: 23.0131, lng: 72.5085 },
    orderType: "delivery",
    fulfillment: "delivery",
    deliveryStatus: "ready_for_pickup",
    status: "ready",
    paymentStatus: "paid",
    customerId: "uid_demo_customer",
    userId: "uid_demo_customer",
    customerName: "Demo Customer",
    // The customer's own number — deliberately DIFFERENT from the branch
    // number, so a customer-phone substitution can never look like a pass.
    customerPhone: "+91 99999 88888",
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
    ...extra,
  };
}

function seedBranchPhone(id: string, phone: unknown) {
  savedDocs[`branches/${id}`] = {
    name: "Burgonomics Demo",
    city: "Ahmedabad",
    ...(phone === undefined ? {} : { phone }),
    coordinates: { lat: 23.0131, lng: 72.5085 },
  };
}

function borzoWire(providerOrderId: string) {
  fetchHandler = (url) => {
    if (url.includes("/calculate-order")) {
      return okJson({ is_successful: true, order: { payment_amount: "48.00" } });
    }
    if (url.includes("/create-order")) {
      return okJson({
        is_successful: true,
        order: {
          order_id: providerOrderId,
          points: [{ tracking_url: `https://track.borzodelivery.com/t/${providerOrderId}` }],
        },
      });
    }
    return okJson({ message: "not found" }, 404);
  };
}

const createOrderCalls = () => fetchCalls.filter((c) => c.url.includes("/create-order"));
const quoteCalls = () => fetchCalls.filter((c) => c.url.includes("/calculate-order"));
const createOrderBody = () => JSON.parse(createOrderCalls()[0]!.init.body);

describe("pickup contact is resolved from the CANONICAL branch before book/claim", () => {
  it("books the live demo order: empty store snapshot + valid branches/demo phone", async () => {
    seedDemoOrder("ord_1793619336679_6okyas");
    seedBranchPhone("demo", "+91 98250 12345");
    borzoWire("BRZ-DEMO-1");

    const res: any = await dispatchBook({
      orderId: "ord_1793619336679_6okyas",
      staffName: "Ops",
    });

    expect(res).toMatchObject({ provider: "borzo", providerOrderId: "BRZ-DEMO-1" });
    const body = createOrderBody();
    expect(body.points[0].contact_person.phone).toBe("919825012345");
    // The drop point stays the customer's own number — the branch number is
    // never substituted into it.
    expect(body.points[1].contact_person.phone).toBe("919999988888");
    expect(JSON.stringify(body)).not.toContain("919000011111");
  });

  it("prefers the canonical branch number over a stale/spoofed store snapshot", async () => {
    seedDemoOrder("ord_spoof_snapshot", {
      // A client-cached snapshot naming a DIFFERENT number (the wrong-recipient
      // hazard: the courier would ring someone who is not at the store).
      store: { name: "Burgonomics Demo", phone: "+91 90000 11111" },
    });
    seedBranchPhone("demo", "+91 98250 12345");
    borzoWire("BRZ-SPOOF-1");

    await dispatchBook({ orderId: "ord_spoof_snapshot" });

    const body = createOrderBody();
    expect(body.points[0].contact_person.phone).toBe("919825012345");
    expect(JSON.stringify(body)).not.toContain("919000011111");
  });

  it("keeps the drop contact verified/entered (never the pickup number)", async () => {
    seedDemoOrder("ord_drop_kept", {
      // No order-level customerPhone: the address contact is the drop source.
      customerPhone: undefined,
      deliveryAddress: {
        contactName: "Riya",
        contactPhone: "9825011111",
        full: "102, Shivalik Highstreet, Vastrapur",
        city: "Ahmedabad",
        lat: 23.0338,
        lng: 72.5262,
      },
    });
    seedBranchPhone("demo", "+91 98250 12345");
    borzoWire("BRZ-DROP-1");

    await dispatchBook({ orderId: "ord_drop_kept" });

    const body = createOrderBody();
    expect(body.points[0].contact_person.phone).toBe("919825012345");
    expect(body.points[1].contact_person.phone).toBe("919825011111");
    expect(body.points[1].contact_person.name).toBe("Riya");
  });

  it("fails with a typed, operator-actionable 422 BEFORE the claim and any provider request", async () => {
    seedDemoOrder("ord_no_branch_phone");
    // The branch document exists (canonical record) but has no phone, and the
    // order snapshot has none either.
    seedBranchPhone("demo", undefined);
    borzoWire("BRZ-NEVER");

    const err: any = await dispatchBook({ orderId: "ord_no_branch_phone" }).catch((e) => e);

    expect(err).toMatchObject({
      statusCode: 422,
      code: "DISPATCH_PICKUP_PHONE_MISSING",
    });
    expect(err.message).toMatch(/store|branch/i);
    expect(err.message).toMatch(/phone/i);
    // Fail closed BEFORE the lease and before any provider traffic.
    const doc = savedDocs["orders/ord_no_branch_phone"];
    expect(doc.dispatchStatus).toBeUndefined();
    expect(doc.dispatchClaimedAt).toBeUndefined();
    expect(doc.dispatchGeneration).toBeUndefined();
    expect(doc.dispatchAttempts).toBeUndefined();
    expect(doc.needsRebook).not.toBe(true);
    expect(Object.keys(savedDocs).filter((k) => k.startsWith("dispatch_correlation_map/"))).toHaveLength(0);
    expect(fetchCalls).toHaveLength(0);
  });

  it("refuses an invalid (un-normalisable) canonical branch phone instead of inventing one", async () => {
    seedDemoOrder("ord_bad_branch_phone");
    seedBranchPhone("demo", "0000");
    borzoWire("BRZ-NEVER");

    const err: any = await dispatchBook({ orderId: "ord_bad_branch_phone" }).catch((e) => e);

    expect(err).toMatchObject({ statusCode: 422, code: "DISPATCH_PICKUP_PHONE_MISSING" });
    expect(fetchCalls).toHaveLength(0);
    expect(savedDocs["orders/ord_bad_branch_phone"].dispatchStatus).toBeUndefined();
  });

  it("REFUSES a valid-looking snapshot when the branch document is missing (client-writable store is not authority)", async () => {
    // `orders.store` is an allowed key of the customer order-create allowlist
    // (firestore.rules), so a customer can stamp ANY phone at placement. A
    // hostile-but-valid snapshot with no canonical branch record must be a
    // typed 422, never a booking to that number.
    seedDemoOrder("ord_legacy_snapshot", {
      store: { name: "Burgonomics Legacy", phone: "+91 98250 12345" },
    });
    // No branches/demo document at all.
    borzoWire("BRZ-NEVER");

    const err: any = await dispatchBook({ orderId: "ord_legacy_snapshot" }).catch((e) => e);

    expect(err).toMatchObject({ statusCode: 422, code: "DISPATCH_PICKUP_PHONE_MISSING" });
    expect(fetchCalls).toHaveLength(0);
    const doc = savedDocs["orders/ord_legacy_snapshot"];
    expect(doc.dispatchStatus).toBeUndefined();
    expect(doc.dispatchGeneration).toBeUndefined();
    expect(
      Object.keys(savedDocs).filter((k) => k.startsWith("dispatch_correlation_map/"))
    ).toHaveLength(0);
  });

  it("REFUSES a hostile valid snapshot when the canonical phone is absent", async () => {
    seedDemoOrder("ord_hostile_no_canonical", {
      store: { name: "Burgonomics Demo", phone: "+91 90000 11111" },
    });
    seedBranchPhone("demo", undefined); // document exists, no phone
    borzoWire("BRZ-NEVER");

    const err: any = await dispatchBook({ orderId: "ord_hostile_no_canonical" }).catch((e) => e);

    expect(err).toMatchObject({ statusCode: 422, code: "DISPATCH_PICKUP_PHONE_MISSING" });
    expect(fetchCalls).toHaveLength(0);
    expect(savedDocs["orders/ord_hostile_no_canonical"].dispatchStatus).toBeUndefined();
  });

  it("REFUSES a hostile valid snapshot when the canonical phone is invalid", async () => {
    seedDemoOrder("ord_hostile_bad_canonical", {
      store: { name: "Burgonomics Demo", phone: "+91 90000 11111" },
    });
    seedBranchPhone("demo", "0000");
    borzoWire("BRZ-NEVER");

    const err: any = await dispatchBook({ orderId: "ord_hostile_bad_canonical" }).catch((e) => e);

    expect(err).toMatchObject({ statusCode: 422, code: "DISPATCH_PICKUP_PHONE_MISSING" });
    expect(fetchCalls).toHaveLength(0);
    expect(savedDocs["orders/ord_hostile_bad_canonical"].dispatchStatus).toBeUndefined();
  });

  it("REFUSES a hostile valid snapshot when the branch READ throws", async () => {
    seedDemoOrder("ord_branch_read_throws", {
      store: { name: "Burgonomics Demo", phone: "+91 90000 11111" },
    });
    seedBranchPhone("demo", "+91 98250 12345");
    borzoWire("BRZ-NEVER");
    // Simulate a Firestore failure for THIS branch document only.
    const originalCollection = mockDb.collection;
    const spy = vi.spyOn(mockDb, "collection").mockImplementation((colName: string) => {
      if (colName !== "branches") return originalCollection(colName);
      return {
        doc: (docId: string) => ({
          id: docId,
          set: vi.fn(async () => {}),
          get: vi.fn(async () => {
            if (docId === "demo") throw new Error("PERMISSION_DENIED (simulated)");
            return originalCollection(colName).doc(docId).get();
          }),
        }),
        where: () => ({ limit: () => ({ get: async () => ({ empty: true, docs: [] }) }) }),
      };
    });

    try {
      const err: any = await dispatchBook({ orderId: "ord_branch_read_throws" }).catch((e) => e);
      expect(err).toMatchObject({ statusCode: 422, code: "DISPATCH_PICKUP_PHONE_MISSING" });
      expect(fetchCalls).toHaveLength(0);
      expect(savedDocs["orders/ord_branch_read_throws"].dispatchStatus).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("REFUSES an unsafe/absent branchId even with a valid snapshot", async () => {
    seedDemoOrder("ord_unsafe_branch", {
      branchId: "demo/../evil",
      store: { name: "Burgonomics Demo", phone: "+91 90000 11111" },
    });
    borzoWire("BRZ-NEVER");

    const err: any = await dispatchBook({ orderId: "ord_unsafe_branch" }).catch((e) => e);

    expect(err).toMatchObject({ statusCode: 422, code: "DISPATCH_PICKUP_PHONE_MISSING" });
    expect(fetchCalls).toHaveLength(0);
    expect(savedDocs["orders/ord_unsafe_branch"].dispatchStatus).toBeUndefined();
  });

  it("rebook resolves the same canonical contact for the failed demo order", async () => {
    seedDemoOrder("ord_demo_rebook", {
      dispatchStatus: "dispatch_failed",
      dispatchAttempts: [{ provider: "borzo", outcome: "transient_failure", error: "borzo returned an unparseable branch phone", at: 1 }],
      dispatchGeneration: 3,
      needsRebook: true,
      rebookTrigger: "dispatch_failed",
    });
    seedBranchPhone("demo", "+91 98250 12345");
    borzoWire("BRZ-REBOOK-1");

    const res: any = await dispatchRebook({ orderId: "ord_demo_rebook", staffName: "Ops" });

    expect(res).toMatchObject({ provider: "borzo", providerOrderId: "BRZ-REBOOK-1" });
    expect(createOrderBody().points[0].contact_person.phone).toBe("919825012345");
    expect(savedDocs["orders/ord_demo_rebook"].needsRebook).toBe(false);
  });

  it("writes NO store fields for a new booking (no stale-store spread, no merge collision)", async () => {
    // The only consumer of a persisted store.phone was the retired Porter leg;
    // writing it also spread the stale snapshot over concurrent corrections.
    // The canonical number reaches every live adapter through ctx instead, so a
    // new booking must leave the order's store object byte-identical.
    seedDemoOrder("ord_no_store_write");
    seedBranchPhone("demo", "+91 98250 12345");
    borzoWire("BRZ-NO-WRITE-1");

    await dispatchBook({ orderId: "ord_no_store_write" });

    const doc = savedDocs["orders/ord_no_store_write"];
    expect(doc.store).toEqual({ name: "Burgonomics Demo", city: "Ahmedabad", state: "Gujarat" });
    expect(doc.storePhoneSource).toBeUndefined();
    // The canonical number still reached the provider on the wire.
    expect(createOrderBody().points[0].contact_person.phone).toBe("919825012345");
  });

  it("an idempotent replay of a live booking is unchanged: no provider call, no write from the resolver", async () => {
    seedDemoOrder("ord_replay_live", {
      dispatchStatus: "dispatched",
      deliveryStatus: "dispatched",
      dispatchProvider: "borzo",
      dispatchOrderId: "BRZ-LIVE-1",
      borzoOrderId: "BRZ-LIVE-1",
      riderName: "Borzo Rider Kiran",
    });
    seedBranchPhone("demo", "+91 98250 12345");
    borzoWire("BRZ-NEVER");

    const res: any = await dispatchBook({ orderId: "ord_replay_live" });

    expect(res).toMatchObject({ provider: "borzo", providerOrderId: "BRZ-LIVE-1", reused: true });
    expect(fetchCalls).toHaveLength(0);
    // The live booking is not rewritten; the resolver adds nothing to it.
    expect(savedDocs["orders/ord_replay_live"].store.phone).toBeUndefined();
    expect(savedDocs["orders/ord_replay_live"].dispatchGeneration).toBeUndefined();
  });

  it("P2: an authentic live booking is replayed even when branch metadata is now invalid", async () => {
    // Regression for Sol's finding: validating the NEW-booking pickup contact
    // before the reuse check turned a healthy replay into a 422 whenever the
    // branch phone was later removed/typo'd. Staff tapping dispatch on an
    // already-dispatched order must get the rider they already have.
    seedDemoOrder("ord_replay_bad_meta", {
      dispatchStatus: "dispatched",
      deliveryStatus: "dispatched",
      dispatchProvider: "borzo",
      dispatchOrderId: "BRZ-LIVE-2",
      borzoOrderId: "BRZ-LIVE-2",
      riderName: "Borzo Rider Mehul",
    });
    seedBranchPhone("demo", "0000"); // canonical metadata is now unusable
    borzoWire("BRZ-NEVER");

    const res: any = await dispatchBook({ orderId: "ord_replay_bad_meta" });

    expect(res).toMatchObject({
      provider: "borzo",
      providerOrderId: "BRZ-LIVE-2",
      riderName: "Borzo Rider Mehul",
      reused: true,
    });
    // Read-only replay: no lease, no provider request, no rewrite.
    expect(fetchCalls).toHaveLength(0);
    const doc = savedDocs["orders/ord_replay_bad_meta"];
    expect(doc.dispatchStatus).toBe("dispatched");
    expect(doc.dispatchGeneration).toBeUndefined();
    expect(doc.dispatchClaimedAt).toBeUndefined();
  });

  it("P2: reuse is denied for a released/cancelled booking, so the metadata gate still applies", async () => {
    // needsRebook means the binding is dead; that order must NOT be handed a
    // rider summary, and must still fail closed on invalid canonical metadata.
    seedDemoOrder("ord_released_binding", {
      dispatchStatus: "dispatched",
      deliveryStatus: "needs_review",
      dispatchProvider: "borzo",
      dispatchOrderId: "BRZ-DEAD-1",
      borzoOrderId: "BRZ-DEAD-1",
      needsRebook: true,
      rebookTrigger: "carrier_cancelled",
    });
    seedBranchPhone("demo", "0000");
    borzoWire("BRZ-NEVER");

    const err: any = await dispatchBook({ orderId: "ord_released_binding" }).catch((e) => e);

    expect(err).toMatchObject({ statusCode: 422, code: "DISPATCH_PICKUP_PHONE_MISSING" });
    expect(fetchCalls).toHaveLength(0);
  });

  it("P2: a terminal order is never replayed as an active booking", async () => {
    seedDemoOrder("ord_terminal_replay", {
      dispatchStatus: "dispatched",
      deliveryStatus: "delivered",
      dispatchProvider: "borzo",
      dispatchOrderId: "BRZ-DONE-1",
      borzoOrderId: "BRZ-DONE-1",
    });
    seedBranchPhone("demo", "+91 98250 12345");
    borzoWire("BRZ-NEVER");

    const err: any = await dispatchBook({ orderId: "ord_terminal_replay" }).catch((e) => e);

    expect(err).toMatchObject({ statusCode: 409, code: "DISPATCH_LOCKED" });
    expect(fetchCalls).toHaveLength(0);
  });

  it("P2: an active in-house assignment is never replayed as a provider booking", async () => {
    seedDemoOrder("ord_inhouse_replay", {
      dispatchType: "manual_branch_terminal",
      dispatchStatus: "dispatched",
      deliveryStatus: "dispatched",
      dispatchProvider: "borzo",
      dispatchOrderId: "BRZ-STALE-1",
      borzoOrderId: "BRZ-STALE-1",
    });
    seedBranchPhone("demo", "+91 98250 12345");
    borzoWire("BRZ-NEVER");

    const err: any = await dispatchBook({ orderId: "ord_inhouse_replay" }).catch((e) => e);

    expect(err).toMatchObject({ statusCode: 409, code: "DISPATCH_EXISTS" });
    expect(fetchCalls).toHaveLength(0);
  });

  it("keeps /dispatch/quote usable without an order (pickup phone simply omitted)", async () => {
    fetchHandler = (url) =>
      url.includes("/calculate-order")
        ? okJson({ is_successful: true, order: { payment_amount: "55.00" } })
        : okJson({ message: "not found" }, 404);

    const res: any = await dispatchQuote({
      pickupLat: 23.0131,
      pickupLng: 72.5085,
      dropLat: 23.0338,
      dropLng: 72.5262,
    });

    expect(res.serviceable).toBe(true);
    expect(quoteCalls()).toHaveLength(1);
    const quoteBody = JSON.parse(quoteCalls()[0]!.init.body);
    expect(quoteBody.points[0].contact_person.phone).toBeUndefined();
    expect(quoteBody.points[1].contact_person.phone).toBeUndefined();
  });
});

describe("pickup-contact resolution stays multi-tenant safe", () => {
  it("denies an out-of-branch caller BEFORE the branch lookup or any claim/provider write", async () => {
    seedDemoOrder("ord_other_branch", { branchId: "branch_other" });
    seedBranchPhone("branch_other", "+91 98250 99999");
    seedBranchPhone("demo", "+91 98250 12345");
    borzoWire("BRZ-NEVER");

    const err: any = await dispatchBook({
      orderId: "ord_other_branch",
      caller: { uid: "uid_staff", role: "branch_staff", branchIds: ["demo"] },
    }).catch((e) => e);

    expect(String(err?.message || "")).toMatch(/outside your assigned branches/i);
    // Authorization ran first: no branch doc was read for a refused caller.
    expect(reads.filter((r) => r.startsWith("branches/"))).toHaveLength(0);
    expect(fetchCalls).toHaveLength(0);
    expect(savedDocs["orders/ord_other_branch"].dispatchStatus).toBeUndefined();
  });

  it("never uses another branch's phone when the order's branch document is missing", async () => {
    // The order points at branchId `demo` (no branches/demo doc). A sibling
    // branch's number exists and must NOT leak across tenants.
    seedDemoOrder("ord_no_branch_doc");
    seedBranchPhone("branch_other", "+91 98250 99999");
    borzoWire("BRZ-NEVER");

    const err: any = await dispatchBook({ orderId: "ord_no_branch_doc" }).catch((e) => e);

    expect(err).toMatchObject({ statusCode: 422, code: "DISPATCH_PICKUP_PHONE_MISSING" });
    expect(fetchCalls).toHaveLength(0);
  });
});

describe("pickup-contact resolution under a concurrent staff burst", () => {
  it("every concurrent tap resolves the canonical number — no spoofed/customer phone ever reaches the wire", async () => {
    seedDemoOrder("ord_burst", {
      store: { name: "Burgonomics Demo", phone: "+91 90000 11111" },
    });
    seedBranchPhone("demo", "+91 98250 12345");
    borzoWire("BRZ-BURST-1");

    // The claim guard is what serialises real bookings; here the provider
    // transport is shared, so the assertion is on the CONTACT of every request
    // that did leave the process: canonical only, never the snapshot/ customer.
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => dispatchBook({ orderId: "ord_burst", staffName: "Ops" }))
    );

    expect(createOrderCalls().length).toBeGreaterThan(0);
    for (const call of createOrderCalls()) {
      const body = JSON.parse(call.init.body);
      expect(body.points[0].contact_person.phone).toBe("919825012345");
      expect(JSON.stringify(body)).not.toContain("919000011111");
      // The drop side keeps the customer's own number.
      expect(body.points[1].contact_person.phone).toBe("919999988888");
    }
    // No call may fail with the old provider-shaped unparseable-branch-phone 502.
    for (const r of results) {
      if (r.status === "rejected") {
        expect(String(r.reason?.message || "")).not.toMatch(/unparseable branch phone/i);
        expect(r.reason?.code).not.toBe("DISPATCH_FAILED");
      }
    }
  });
});
