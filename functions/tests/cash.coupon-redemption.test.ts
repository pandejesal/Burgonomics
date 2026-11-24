import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F9 (staging cycle 6, 2026-11-22): every cash order carrying a coupon returned
 * HTTP 503 CASH_ORDER_UNAVAILABLE and wrote no order, while /coupons/quote was
 * healthy (₹54 off). The cash transaction claimed the courier quote with tx.set
 * BEFORE it read the coupon with tx.get; real Firestore rejects a read after a
 * write inside one transaction, and the generic route catch called that a 503.
 *
 * This suite pins the whole coupon-on-cash contract with a transaction double
 * that ENFORCES the real read-before-write rule (the F8 double queued writes and
 * let the invalid order through). Coupons must be held in the SAME transaction
 * as the order, committed when the cash order is created, released on a cancel
 * before preparation, and refused with typed coupon codes at the limits.
 */
const h = vi.hoisted(() => {
  process.env.BURGONOMICS_ENV = "dev";
  const docs = new Map<string, any>();
  const copy = (value: any) => (value === undefined ? undefined : structuredClone(value));
  const apply = (path: string, data: any, merge?: boolean) => {
    docs.set(path, merge ? { ...(docs.get(path) ?? {}), ...copy(data) } : copy(data));
  };
  const ref = (collection: string, id: string) => ({
    id,
    path: `${collection}/${id}`,
    collection: (name: string) => ({ doc: (childId: string) => ref(`${collection}/${id}/${name}`, childId) }),
    get: async () => ({
      exists: docs.has(`${collection}/${id}`),
      id,
      data: () => copy(docs.get(`${collection}/${id}`)),
    }),
    set: async (data: any, options?: { merge?: boolean }) =>
      apply(`${collection}/${id}`, data, options?.merge),
    create: async (data: any) => {
      if (docs.has(`${collection}/${id}`)) throw new Error("already exists");
      apply(`${collection}/${id}`, data, false);
    },
  });
  const db: any = {
    collection: (name: string) => ({ doc: (id: string) => ref(name, id) }),
    runTransaction: async (callback: (tx: any) => Promise<any>) => {
      const pending: Array<() => void> = [];
      let wrote = false;
      const forbidLateRead = () => {
        if (wrote) throw new Error("FIRESTORE_READ_AFTER_WRITE");
      };
      const result = await callback({
        get: async (reference: any) => {
          forbidLateRead();
          return reference.get();
        },
        set: (reference: any, data: any, options?: { merge?: boolean }) => {
          wrote = true;
          pending.push(() => apply(reference.path, data, options?.merge));
        },
        create: (reference: any, data: any) => {
          wrote = true;
          pending.push(() => apply(reference.path, data, false));
        },
        update: (reference: any, data: any) => {
          wrote = true;
          pending.push(() => apply(reference.path, data, true));
        },
      });
      for (const write of pending) write();
      return result;
    },
  };
  return {
    docs,
    db,
    reset: () => docs.clear(),
  };
});

vi.mock("../src/core/firebase", () => ({ db: h.db }));
vi.mock("firebase-admin", () => {
  const firestore: any = vi.fn(() => h.db);
  firestore.FieldValue = {
    serverTimestamp: () => "SERVER_TS",
    increment: (n: number) => n,
    arrayUnion: (item: any) => [item],
    delete: () => "SERVER_DELETE",
  };
  return {
    default: { firestore: vi.fn(() => h.db), auth: vi.fn(() => ({})), initializeApp: vi.fn(), apps: [{ name: "mock" }] },
    firestore,
    auth: vi.fn(() => ({})),
    initializeApp: vi.fn(),
    apps: [{ name: "mock" }],
  };
});

import { createCashOrder, createCashOrderSchema } from "../src/modules/orders/createCashOrder";
import { handleCreateCashOrder } from "../src/modules/orders/createCashOrderRoute";
import { createWalkIn } from "../src/modules/orders/createWalkIn";
import { handleCreateWalkIn } from "../src/modules/orders/createWalkInRoute";
import { formatPetpoojaOrderPayload } from "../src/modules/petpooja/orderPush";
import { checkoutCookingNoteBody } from "./helpers/checkoutCookingNotes";
import { cancelOrderAsCustomer } from "../src/modules/orders/customerCancel";
import { bumpOrderStatus } from "../src/modules/orders/orderStatus";

const CUSTOMER = "customer_a";
const ORDER = "ord_cash_coupon_1";
const CODE = "QA20";

function seedCoupon(overrides: Record<string, any> = {}) {
  h.docs.set(`coupons/${CODE}`, {
    code: CODE,
    active: true,
    discountType: "percent",
    value: 20,
    maxDiscount: 200,
    minOrder: 0,
    validFromMs: null,
    validToMs: null,
    perCustomerLimit: null,
    totalCap: null,
    branchScope: ["branch_a"],
    customerScope: null,
    ...overrides,
  });
}

function seedQuote(id = "dfq_coupon_1") {
  h.docs.set(`delivery_fee_quotes/${id}`, {
    uid: CUSTOMER,
    branchId: "branch_a",
    dropLat: 21.2,
    dropLng: 72.8,
    fee: 50,
    expiresAt: Date.now() + 600_000,
    usedByOrderId: null,
  });
}

const deliveryAddress = { lat: 21.2, lng: 72.8, city: "Surat", line1: "1 Main Road" };

function input(extra: Record<string, any> = {}) {
  return {
    orderId: ORDER,
    storeId: "s1",
    orderType: "takeaway" as const,
    items: [{ productId: "p1", quantity: 1 }],
    expectedTotalPaise: 9500,
    couponCode: CODE,
    promo: { code: CODE, discount: 20 },
    ...extra,
  };
}

function deliveryInput(extra: Record<string, any> = {}) {
  return input({
    orderType: "delivery",
    address: deliveryAddress,
    deliveryAddress,
    deliveryQuoteId: "dfq_coupon_1",
    expectedTotalPaise: 14500,
    ...extra,
  });
}

const redemptionId = "ord_cash_coupon_1";
const redemptionDoc = () => h.docs.get(`coupon_redemptions/${redemptionId}`);
const statsDoc = () => h.docs.get(`coupon_stats/${CODE}`);
const usageDoc = () => h.docs.get(`coupon_customer_usage/${CODE}__${CUSTOMER}`);

beforeEach(() => {
  h.reset();
  h.docs.set("branches/branch_a", {
    name: "Surat Adajan",
    city: "Surat",
    packagingFee: 15,
    cashOnDelivery: {
      enabled: true,
      maxOrderValuePaise: 500000,
      courierCod: { enabled: true, providers: { borzo: true, shadowfax: true } },
    },
  });
  h.docs.set("products/p1", {
    name: "Paneer Makhani Burger",
    branchId: "branch_a",
    price: 100,
    inStock: true,
    petpoojaItemId: "PP-1",
  });
  h.docs.set("stores/s1", { partnerBranchId: "branch_a" });
  h.docs.set("admins/staff_1", { role: "brand_owner", branchIds: ["branch_a"] });
  h.docs.set("users/staff_1", { active: true });
  seedCoupon();
  seedQuote();
});

describe("Customer cash checkout → staff kitchen admission", () => {
  const staff = { uid: "staff_1", role: "branch_staff", branchIds: ["branch_a"] };

  it.each([['accepted', 'CONFIRMED'], ['preparing', 'PREPARING']] as const)(
    "admits server-created counter cash on a fresh %s bump without claiming payment",
    async (target, code) => {
      const body = createCashOrderSchema.parse({
        orderId: ORDER,
        attemptId: "checkout_attempt_01",
        storeId: "s1",
        orderType: "takeaway",
        items: [{ productId: "p1", quantity: 1 }],
        expectedTotalPaise: 11500,
      });
      const status = vi.fn().mockReturnThis();
      const json = vi.fn();
      await handleCreateCashOrder({ user: { uid: CUSTOMER }, body } as any, { status, json } as any);
      expect(status).toHaveBeenCalledWith(201);
      const path = `orders/${ORDER}`;
      expect(h.docs.get(path)).toMatchObject({
        orderType: "takeaway", paymentChannel: "cash", paymentStatus: "pending",
        payment: { method: "cod", status: "pending" }, cashDuePaise: 11500,
      });
      await bumpOrderStatus({ orderId: ORDER, status: target, expectedStatus: "pending", caller: staff });
      expect(h.docs.get(path)).toMatchObject({ status: { code }, paymentStatus: "pending" });
      expect(h.docs.get(path)).not.toHaveProperty("cashCollectedPaise");
      expect(h.docs.get(path)).not.toHaveProperty("receiptEvidence");
    },
  );

  it.each([
    { method: "cod", status: "PAY_AT_STORE", label: "Pay at Pickup Counter" },
    { method: "online", status: "pending" },
  ])("refuses $method without server payment evidence", async (payment) => {
    const path = `orders/${ORDER}`;
    const order = {
      branchId: "branch_a", customerId: CUSTOMER, fulfillment: "takeaway",
      status: { code: "PLACED" }, payment,
    };
    h.docs.set(path, order);
    for (const target of ["accepted", "preparing"] as const) {
      await expect(bumpOrderStatus({ orderId: ORDER, status: target, caller: staff }))
        .rejects.toMatchObject({ code: "ORDER_NOT_PAID", statusCode: 409 });
    }
    expect(h.docs.get(path)).toEqual(order);
  });
});

describe("zero-due online checkout via the cash order handler", () => {
  async function submit(body: unknown) {
    const status = vi.fn().mockReturnThis();
    const json = vi.fn();
    await handleCreateCashOrder({ user: { uid: CUSTOMER }, body } as any, { status, json } as any);
    return { status: status.mock.calls[0]?.[0], body: json.mock.calls[0]?.[0] };
  }

  it("places a catalog-priced zero-due order at an outlet that does not take COD", async () => {
    h.docs.set("branches/branch_a", { packagingFee: 0, cashOnDelivery: { enabled: false } });
    seedCoupon({ value: 100 });
    const cash = input({ attemptId: "ordinary_cash", expectedTotalPaise: 0 });
    expect(await submit(cash)).toMatchObject({ status: 409, body: { code: "COD_UNAVAILABLE" } });
    expect(h.docs.has(`orders/${ORDER}`)).toBe(false);

    const online = { ...cash, attemptId: "zero_due_online", zeroDueOnly: true };
    expect(await submit(online)).toMatchObject({ status: 201, body: { cashDuePaise: 0 } });
    expect(h.docs.get(`orders/${ORDER}`)).toMatchObject({ cashDuePaise: 0, paymentChannel: "cash" });
    expect(redemptionDoc()).toMatchObject({ status: "committed" });
    expect(await submit(online)).toMatchObject({ status: 200, body: { cashDuePaise: 0, replayed: true } });
    expect(statsDoc().committed).toBe(1);
  });

  it.each([0, 14500])("never writes a newly positive zero-due order even with expected total %i", async (expectedTotalPaise) => {
    // Coupon/menu changes now give this delivery a positive bill. In the
    // second case the client has already recalculated the new positive price.
    h.docs.set(`users/${CUSTOMER}/addresses/saved_home`, deliveryAddress);
    const checkout = deliveryInput({ attemptId: "zero_due_stale", addressId: "saved_home", expectedTotalPaise });
    const before = new Map(h.docs);
    const result = await submit({ ...checkout, zeroDueOnly: true });
    // No order, attempt, redemption, counter or quote claim.
    expect(h.docs).toEqual(before);
    expect(result).toMatchObject({
      status: 409, body: { code: "PRICE_CHANGED", totals: { split: { totalAmountPaise: 14500 } } },
    });
    // Positive cash remains valid only through the ordinary cash lane.
    expect(await submit({ ...checkout, expectedTotalPaise: 14500 })).toMatchObject({
      status: 201, body: { cashDuePaise: 14500 },
    });
    expect(await submit({ ...checkout, zeroDueOnly: true })).toMatchObject({
      status: 409, body: { code: "IDEMPOTENCY_CONFLICT" },
    });
  });
});

describe("cooking notes on cash kitchen tickets", () => {
  const note = "Toast both sides";
  function assertNote(orderId: string, unitPrice: number) {
    const order = h.docs.get(`orders/${orderId}`);
    expect(order.items[0].notes).toBe(note);
    const payload = formatPetpoojaOrderPayload(order, { name: "Surat" }, "PP_B1", "branch_a", orderId,
      undefined, [{ posItemId: "PP-1", unitPrice, addons: [] }]);
    expect(payload.orderinfo.OrderInfo.OrderItem.details[0].description).toBe(note);
  }

  it.each(["cash", "zero-due", "dinein", "delivery"])("preserves the %s cash line note from request to order and KOT", async (mode) => {
    const zeroDueOnly = mode === "zero-due";
    h.docs.set("branches/branch_a", { ...h.docs.get("branches/branch_a"), packagingFee: 0,
      ...(zeroDueOnly ? { cashOnDelivery: { enabled: false } } : {}) });
    h.docs.set("stores/str_fulfill", { partnerBranchId: "branch_a" });
    h.docs.set("products/burger_1", { ...h.docs.get("products/p1"), price: 109 });
    h.docs.set("coupons/FREE", { ...h.docs.get(`coupons/${CODE}`), code: "FREE", value: 100 });
    h.docs.set(`users/${CUSTOMER}/addresses/saved_home`, deliveryAddress);
    const direct = {
      orderId: ORDER, attemptId: "cash_note_attempt", storeId: "str_fulfill",
      orderType: mode === "dinein" || mode === "delivery" ? mode : "takeaway",
      items: [{ productId: "burger_1", quantity: 1, notes: note }],
      expectedTotalPaise: zeroDueOnly ? 0 : mode === "delivery" ? 15900 : 10900,
      ...(zeroDueOnly ? { zeroDueOnly: true, couponCode: "FREE" } : {}),
      ...(mode === "dinein" ? { tableNumber: "5" } : {}),
      ...(mode === "delivery" ? { addressId: "saved_home", deliveryQuoteId: "dfq_coupon_1" } : {}),
    };
    const body = mode === "cash" || zeroDueOnly
      ? checkoutCookingNoteBody(mode, "/orders/createCashOrder", direct)
      : direct;
    const status = vi.fn().mockReturnThis();
    await handleCreateCashOrder({ user: { uid: CUSTOMER }, body } as any, { status, json: vi.fn() } as any);
    expect(status).toHaveBeenCalledWith(201);
    assertNote(body.orderId, 109);
    const replay = { ...body, items: body.items.map(({ notes: _notes, ...line }) => line) };
    await expect(createCashOrder(CUSTOMER, replay)).resolves.toMatchObject({ orderId: body.orderId, replayed: true });
    assertNote(body.orderId, 109);
  });

  it("preserves an optional walk-in item note without replacing the order note", async () => {
    const status = vi.fn().mockReturnThis();
    const json = vi.fn();
    await handleCreateWalkIn({ user: { uid: "staff_1" }, body: {
      requestId: "walkin_note_request", branchId: "branch_a", orderType: "takeaway", tender: "cash",
      items: [{ productId: "p1", quantity: 1, notes: note }], expectedTotalPaise: 11500,
      notes: "Counter order note",
    } } as any, { status, json } as any);
    expect(status).toHaveBeenCalledWith(201);
    const { orderId } = json.mock.calls[0][0];
    expect(h.docs.get(`orders/${orderId}`).notes).toBe("Counter order note");
    assertNote(orderId, 100);
  });
});

describe("F9 — coupon redemption on cash orders", () => {
  it("keeps all reads before writes and prices a delivery COD coupon with the right bill fields", async () => {
    // 100 food − 20 coupon + 15 packing + 50 quoted delivery = ₹145.
    const receipt = await createCashOrder(CUSTOMER, deliveryInput());
    expect(receipt).toMatchObject({
      orderId: ORDER,
      replayed: false,
      cashDuePaise: 14500,
      totals: {
        foodSubtotal: 100,
        discount: 20,
        packagingFee: 15,
        deliveryFee: 50,
        grandTotal: 145,
        split: { totalAmountPaise: 14500 },
      },
    });
    const doc = h.docs.get(`orders/${ORDER}`);
    expect(doc).toMatchObject({
      couponCode: CODE,
      promo: { code: CODE, discount: 20 },
      subtotal: 100,
      tax: 3.81,
      total: 145,
      cashDuePaise: 14500,
      totals: {
        subtotal: 100,
        promoDiscount: 20,
        taxes: 3.81,
        packingFee: 15,
        deliveryFee: 50,
        grandTotal: 145,
        discount: 20,
      },
    });
    expect(h.docs.get("delivery_fee_quotes/dfq_coupon_1").usedByOrderId).toBe(ORDER);
    // Committed at creation: there is no payment step to wait for.
    expect(redemptionDoc()).toMatchObject({ code: CODE, orderId: ORDER, status: "committed", discount: 20 });
    expect(statsDoc()).toMatchObject({ code: CODE, committed: 1 });
    expect(usageDoc()).toMatchObject({ code: CODE, customerId: CUSTOMER, committed: 1 });
  });

  it("prices a takeaway cash coupon without a courier quote", async () => {
    const receipt = await createCashOrder(CUSTOMER, input());
    expect(receipt.cashDuePaise).toBe(9500);
    expect(receipt.totals.grandTotal).toBe(95);
    expect(h.docs.get(`orders/${ORDER}`).totals.promoDiscount).toBe(20);
    expect(redemptionDoc().status).toBe("committed");
  });

  it("refuses a coupon whose total cap is reached with a typed coupon code", async () => {
    seedCoupon({ totalCap: 1 });
    await createCashOrder(CUSTOMER, input());
    await expect(
      createCashOrder(CUSTOMER, input({ orderId: "ord_cash_coupon_2" }))
    ).rejects.toMatchObject({ statusCode: 400, code: "COUPON_EXHAUSTED" });
    expect(h.docs.has("orders/ord_cash_coupon_2")).toBe(false);
    expect(h.docs.has("coupon_redemptions/ord_cash_coupon_2")).toBe(false);
  });

  it("enforces the per-customer limit exactly as the online path does", async () => {
    seedCoupon({ perCustomerLimit: 1 });
    await createCashOrder(CUSTOMER, input());
    await expect(
      createCashOrder(CUSTOMER, input({ orderId: "ord_cash_coupon_2" }))
    ).rejects.toMatchObject({ statusCode: 400, code: "COUPON_PER_CUSTOMER_LIMIT" });
  });

  it("returns the coupon slot when a cash order is cancelled before preparation", async () => {
    await createCashOrder(CUSTOMER, input());
    expect(redemptionDoc().status).toBe("committed");
    await expect(
      cancelOrderAsCustomer({ orderId: ORDER, uid: CUSTOMER, reason: "changed my mind" })
    ).resolves.toMatchObject({ orderId: ORDER, alreadyCancelled: false });
    expect(redemptionDoc()).toMatchObject({ status: "released", releaseReason: expect.any(String) });
    expect(statsDoc().committed).toBe(0);
    expect(usageDoc().committed).toBe(0);
    // A second cancel is a no-op, never a second decrement.
    await cancelOrderAsCustomer({ orderId: ORDER, uid: CUSTOMER, reason: "again" });
    expect(statsDoc().committed).toBe(0);
  });

  it("uses the coupon once on a double submit of the same order", async () => {
    const first = await createCashOrder(CUSTOMER, input());
    // Move the catalog price: a replay must return the stored bill, not reprice.
    h.docs.set("products/p1", { ...h.docs.get("products/p1"), price: 999 });
    const replay = await createCashOrder(CUSTOMER, input());
    expect(replay).toEqual({ ...first, replayed: true });
    expect([...h.docs.keys()].filter((path) => path.startsWith("orders/"))).toHaveLength(1);
    expect([...h.docs.keys()].filter((path) => path.startsWith("coupon_redemptions/"))).toHaveLength(1);
    expect(statsDoc().committed).toBe(1);
    expect(redemptionDoc().status).toBe("committed");
  });

  it("refuses an unknown coupon with the authority's code, never a bare 503", async () => {
    await expect(
      createCashOrder(CUSTOMER, input({ couponCode: "NOPE" }))
    ).rejects.toMatchObject({ statusCode: 400, code: "COUPON_INVALID" });
    expect(h.docs.has(`orders/${ORDER}`)).toBe(false);
  });

  it("passes typed coupon refusals through the HTTP route instead of masking them", async () => {
    seedCoupon({ totalCap: 1 });
    await createCashOrder(CUSTOMER, input());
    const status = vi.fn().mockReturnThis();
    const json = vi.fn();
    await handleCreateCashOrder(
      { user: { uid: CUSTOMER }, body: input({ orderId: "ord_cash_coupon_2" }) } as any,
      { status, json } as any
    );
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: "COUPON_EXHAUSTED" }));
  });

  it("regresses: a cash order without a coupon is unchanged", async () => {
    const { couponCode: _unused, ...noCoupon } = input();
    const receipt = await createCashOrder(CUSTOMER, { ...noCoupon, expectedTotalPaise: 11500 });
    expect(receipt.cashDuePaise).toBe(11500);
    expect(receipt.totals.discount).toBe(0);
    expect(h.docs.get(`orders/${ORDER}`).totals.promoDiscount).toBe(0);
    expect(h.docs.has(`coupon_redemptions/${redemptionId}`)).toBe(false);
  });

  it("refuses a coupon on a Partner walk-in till, which offers no coupon control", async () => {
    await expect(
      createWalkIn("staff_1", {
        requestId: "walkin_req_1",
        branchId: "branch_a",
        orderType: "takeaway",
        tender: "cash",
        items: [{ productId: "p1", quantity: 1 }],
        expectedTotalPaise: 11500,
        couponCode: CODE,
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "COUPON_NOT_SUPPORTED_FOR_WALKIN",
    });
    expect([...h.docs.keys()].filter((path) => path.startsWith("orders/"))).toHaveLength(0);
  });
});
