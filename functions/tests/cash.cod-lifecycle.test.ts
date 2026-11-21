import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CASH-FLOWS (owner decision 2026-11-20): cash on delivery and counter cash are
 * both in the launch. This suite is the backend contract for the COD lane:
 *
 *   - the SERVER creates the order and computes every rupee (a client price
 *     cannot reach the doc),
 *   - the branch's own COD switch + per-order ceiling are enforced,
 *   - a delivery is priced from the persisted courier quote, claimed once,
 *   - the server-only `paymentChannel: "cash"` marker is what the rest of the
 *     system keys on (KOT-on-create, hand-over, cash stream),
 *   - cash is collected AT HAND-OFF through the delivery OTP,
 *   - cancelling a COD order owes no refund (F24 + the refund planner).
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
    get: async () => ({
      exists: docs.has(`${collection}/${id}`),
      id,
      data: () => copy(docs.get(`${collection}/${id}`)),
    }),
    set: async (data: any, options?: { merge?: boolean }) => apply(`${collection}/${id}`, data, options?.merge),
  });
  const db: any = {
    collection: (name: string) => ({ doc: (id: string) => ref(name, id) }),
    runTransaction: async (callback: (tx: any) => Promise<any>) => {
      const pending: Array<() => void> = [];
      const result = await callback({
        get: async (reference: any) => reference.get(),
        set: (reference: any, data: any, options?: { merge?: boolean }) =>
          pending.push(() => apply(reference.path, data, options?.merge)),
        create: (reference: any, data: any) => {
          if (docs.has(reference.path)) throw new Error("already exists");
          pending.push(() => apply(reference.path, data, false));
        },
        update: (reference: any, data: any) =>
          pending.push(() => apply(reference.path, data, true)),
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
    delete: () => "DELETE",
  };
  return {
    default: { firestore: vi.fn(() => h.db), auth: vi.fn(() => ({})), initializeApp: vi.fn(), apps: [{ name: "mock" }] },
    firestore,
    auth: vi.fn(() => ({})),
    initializeApp: vi.fn(),
    apps: [{ name: "mock" }],
  };
});

import { createCashOrder, createCashOrderSchema, CashOrderError } from "../src/modules/orders/createCashOrder";
import { cancelOrderAsCustomer } from "../src/modules/orders/customerCancel";
import { planCancelRefundObligation } from "../src/modules/orders/cancelRefundObligation";
import { computeDeliveryOtpHash, deriveDeliveryOtp } from "../src/modules/orders/deliveryOtp";
import { verifyDeliveryOtp } from "../src/modules/orders/deliveryHandover.service";

const CUSTOMER = "customer_a";
const ORDER = "ord_cash_1";

function seed(overrides: Record<string, any> = {}) {
  h.docs.set("branches/branch_a", {
    name: "Surat Adajan",
    city: "Surat",
    packagingFee: 15,
    cashOnDelivery: { enabled: true, maxOrderValuePaise: 500000 },
    ...overrides,
  });
  h.docs.set("branches/branch_b", {
    name: "Rajkot Yagnik Road",
    city: "Rajkot",
    packagingFee: 20,
  });
  h.docs.set("products/p1", {
    name: "Paneer Makhani Burger",
    branchId: "branch_a",
    price: 100,
    inStock: true,
    petpoojaItemId: "PP-1",
  });
  h.docs.set("stores/s1", { partnerBranchId: "branch_a" });
}

/** 100 food + 15 packaging; GST is included in the menu price. */
const baseInput = (extra: Record<string, any> = {}) => ({
  orderId: ORDER,
  storeId: "s1",
  orderType: "takeaway" as const,
  items: [{ productId: "p1", quantity: 1 }],
  expectedTotalPaise: 11500,
  ...extra,
});

beforeEach(() => {
  h.reset();
  seed();
});

describe("COD order creation — the server owns the money", () => {
  it("creates the order with catalog prices and the server cash marker", async () => {
    const receipt = await createCashOrder(CUSTOMER, baseInput());
    const doc = h.docs.get(`orders/${ORDER}`);

    expect(receipt).toMatchObject({
      orderId: ORDER,
      replayed: false,
      paymentMethod: "cod",
      paymentChannel: "cash",
      cashDuePaise: 11500,
      totals: { foodSubtotal: 100, packagingFee: 15, grandTotal: 115 },
    });
    expect(doc).toMatchObject({
      customerId: CUSTOMER,
      userId: CUSTOMER,
      branchId: "branch_a",
      orderType: "takeaway",
      status: { code: "PLACED", terminal: false },
      paymentMethod: "cod",
      paymentStatus: "pending",
      payment: { method: "cod", status: "pending" },
      // THE marker every cash-aware reader keys on.
      paymentChannel: "cash",
      cashDuePaise: 11500,
      // Flat mirrors the Partner lists/reports read without normalising.
      subtotal: 100,
      tax: 4.76,
      deliveryFee: 0,
      total: 115,
      pricing: { grandTotal: 115 },
      totals: { grandTotal: 115 },
      items: [expect.objectContaining({ productId: "p1", price: 100, quantity: 1 })],
    });
    // No gateway shape may ever appear on a cash order.
    expect(doc.payment.capturedAmountPaise).toBeUndefined();
    expect(doc.capturedPaymentId).toBeUndefined();
    expect(doc.cashCollectedAt).toBeUndefined();
  });

  it("refuses a bill the customer did not see, and returns the server total", async () => {
    await expect(
      createCashOrder(CUSTOMER, baseInput({ expectedTotalPaise: 1 }))
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "PRICE_CHANGED",
      totals: { grandTotal: 115 },
    });
    expect(h.docs.has(`orders/${ORDER}`)).toBe(false);
  });

  it("prices from the catalog, never from a client-supplied price", async () => {
    // The schema is strict: a price field is a refusal, not a hint.
    expect(
      createCashOrderSchema.safeParse({
        ...baseInput(),
        items: [{ productId: "p1", quantity: 1, price: 1 }],
      }).success
    ).toBe(false);
    for (const field of ["total", "pricing", "paymentChannel", "status", "paymentStatus"]) {
      expect(createCashOrderSchema.safeParse({ ...baseInput(), [field]: 1 }).success).toBe(false);
    }
    // And the stored price is the catalogue's, not the cart's.
    h.docs.set("products/p1", { ...h.docs.get("products/p1"), price: 250 });
    await expect(createCashOrder(CUSTOMER, baseInput())).rejects.toMatchObject({
      code: "PRICE_CHANGED",
      totals: { grandTotal: 265 },
    });
    const receipt = await createCashOrder(CUSTOMER, baseInput({ expectedTotalPaise: 26500 }));
    expect(receipt.totals.foodSubtotal).toBe(250);
  });

  it("refuses an unavailable item and an unlinked store", async () => {
    h.docs.set("products/p1", { ...h.docs.get("products/p1"), inStock: false });
    await expect(createCashOrder(CUSTOMER, baseInput())).rejects.toMatchObject({
      statusCode: 409,
      code: "ITEM_UNAVAILABLE",
    });
    h.reset();
    seed();
    await expect(
      createCashOrder(CUSTOMER, baseInput({ storeId: "s_missing" }))
    ).rejects.toMatchObject({ statusCode: 409, code: "STORE_NOT_LINKED" });
  });

  it("refuses a branch that disagrees with the store link", async () => {
    await expect(
      createCashOrder(CUSTOMER, baseInput({ branchId: "branch_b" }))
    ).rejects.toMatchObject({ statusCode: 409, code: "STORE_NOT_LINKED" });
    expect(h.docs.has(`orders/${ORDER}`)).toBe(false);
  });
});

describe("customer-readable document shape for server-created cash orders", () => {
  const STORE_SNAPSHOT = {
    partnerBranchId: "branch_a",
    name: "Surat Adajan",
    address: "1 Main Road",
    area: "Adajan",
    city: "Surat",
    phone: "+919876543210",
    lat: 21.2,
    lng: 72.8,
  };

  it("writes the body id, store snapshot and ISO placedAt the customer service reads", async () => {
    h.docs.set("stores/s1", { ...STORE_SNAPSHOT });
    const snapshot = { id: "s1", name: "Surat Adajan", address: "1 Main Road" };
    await createCashOrder(CUSTOMER, baseInput({ store: snapshot }));

    const doc = h.docs.get(`orders/${ORDER}`);
    expect(doc).toMatchObject({
      // The Firestore ref id is the customer app's key. Without this body field
      // listOrders quarantines the doc and tracking says "Order not found".
      id: ORDER,
      shortCode: `BG-${ORDER.slice(-6).toUpperCase()}`,
      store: snapshot,
      customerId: CUSTOMER,
      userId: CUSTOMER,
      branchId: "branch_a",
      fulfillment: "takeaway",
      status: { code: "PLACED", label: "Order placed", kind: "upcoming", terminal: false },
      payment: { method: "cod", label: "Pay at Store", status: "pending" },
      items: [expect.objectContaining({ productId: "p1", price: 100, quantity: 1 })],
      totals: expect.objectContaining({ grandTotal: 115 }),
    });
    // A Firestore serverTimestamp becomes a Timestamp object on read; the
    // customer history filter only accepts an ISO string. The paid path writes
    // a string, and cash must have the same customer-readable shape.
    expect(typeof doc.placedAt).toBe("string");
    expect(Number.isNaN(Date.parse(doc.placedAt))).toBe(false);
  });

  it("writes a store snapshot and body id when an API caller omits the display store", async () => {
    h.docs.set("stores/s1", { ...STORE_SNAPSHOT });
    await createCashOrder(CUSTOMER, baseInput());

    const doc = h.docs.get(`orders/${ORDER}`);
    expect(doc.id).toBe(ORDER);
    expect(doc.store).toMatchObject({
      id: "s1",
      name: "Surat Adajan",
      address: "1 Main Road",
      city: "Surat",
    });
    expect(typeof doc.placedAt).toBe("string");
  });
});

describe("per-branch COD switch and ceiling", () => {
  it("refuses when the branch has switched COD off", async () => {
    seed({ cashOnDelivery: { enabled: false } });
    await expect(createCashOrder(CUSTOMER, baseInput())).rejects.toMatchObject({
      statusCode: 409,
      code: "COD_UNAVAILABLE",
    });
    expect(h.docs.has(`orders/${ORDER}`)).toBe(false);
  });

  it("refuses an order above the branch's cash ceiling", async () => {
    seed({ cashOnDelivery: { enabled: true, maxOrderValuePaise: 10000 } });
    await expect(createCashOrder(CUSTOMER, baseInput())).rejects.toMatchObject({
      statusCode: 409,
      code: "COD_LIMIT_EXCEEDED",
    });
    expect(h.docs.has(`orders/${ORDER}`)).toBe(false);
  });

  it("fails closed on a malformed switch instead of guessing", async () => {
    seed({ cashOnDelivery: { enabled: "yes" } });
    await expect(createCashOrder(CUSTOMER, baseInput())).rejects.toMatchObject({
      statusCode: 503,
      code: "BRANCH_UNAVAILABLE",
    });
  });
});

describe("idempotency and ownership", () => {
  it("replays the stored receipt instead of creating or repricing a second order", async () => {
    const first = await createCashOrder(CUSTOMER, baseInput());
    h.docs.set("products/p1", { ...h.docs.get("products/p1"), price: 999 });
    const replay = await createCashOrder(CUSTOMER, baseInput());
    expect(replay).toEqual({ ...first, replayed: true });
    expect([...h.docs.keys()].filter((path) => path.startsWith("orders/"))).toHaveLength(1);
  });

  it("refuses the same order id for a different basket", async () => {
    await createCashOrder(CUSTOMER, baseInput());
    await expect(
      createCashOrder(CUSTOMER, baseInput({ items: [{ productId: "p1", quantity: 2 }], expectedTotalPaise: 23000 }))
    ).rejects.toMatchObject({ statusCode: 409, code: "IDEMPOTENCY_CONFLICT" });
  });

  it("refuses an order id owned by another account", async () => {
    await createCashOrder(CUSTOMER, baseInput());
    await expect(createCashOrder("customer_b", baseInput())).rejects.toMatchObject({
      statusCode: 403,
      code: "ORDER_NOT_OWNED",
    });
  });

  it("requires an authenticated caller", async () => {
    await expect(createCashOrder("", baseInput())).rejects.toBeInstanceOf(CashOrderError);
    await expect(createCashOrder("", baseInput())).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe("delivery COD is priced from the persisted courier quote", () => {
  const deliveryInput = (extra: Record<string, any> = {}) =>
    baseInput({
      orderType: "delivery",
      address: { lat: 21.2, lng: 72.8, city: "Surat" },
      deliveryAddress: { lat: 21.2, lng: 72.8, city: "Surat" },
      deliveryQuoteId: "dfq_cash_1",
      expectedTotalPaise: 16500,
      ...extra,
    });

  it("refuses a delivery without a quote — never a default fee", async () => {
    await expect(
      createCashOrder(CUSTOMER, deliveryInput({ deliveryQuoteId: undefined }))
    ).rejects.toMatchObject({ statusCode: 409, code: "DELIVERY_QUOTE_REQUIRED" });
    expect(h.docs.has(`orders/${ORDER}`)).toBe(false);
  });

  it("charges the quoted fee and claims the quote exactly once", async () => {
    h.docs.set("delivery_fee_quotes/dfq_cash_1", {
      uid: CUSTOMER,
      branchId: "branch_a",
      dropLat: 21.2,
      dropLng: 72.8,
      fee: 50,
      expiresAt: Date.now() + 600_000,
      usedByOrderId: null,
    });
    const receipt = await createCashOrder(CUSTOMER, deliveryInput());
    expect(receipt.totals.deliveryFee).toBe(50);
    expect(receipt.cashDuePaise).toBe(16500);
    expect(h.docs.get("delivery_fee_quotes/dfq_cash_1").usedByOrderId).toBe(ORDER);
  });

  it("refuses another customer's quote and an expired one", async () => {
    h.docs.set("delivery_fee_quotes/dfq_cash_1", {
      uid: "customer_b",
      branchId: "branch_a",
      dropLat: 21.2,
      dropLng: 72.8,
      fee: 50,
      expiresAt: Date.now() + 600_000,
      usedByOrderId: null,
    });
    await expect(createCashOrder(CUSTOMER, deliveryInput())).rejects.toBeInstanceOf(CashOrderError);

    h.docs.set("delivery_fee_quotes/dfq_cash_1", {
      uid: CUSTOMER,
      branchId: "branch_a",
      dropLat: 21.2,
      dropLng: 72.8,
      fee: 50,
      expiresAt: Date.now() - 1,
      usedByOrderId: null,
    });
    await expect(createCashOrder(CUSTOMER, deliveryInput())).rejects.toBeInstanceOf(CashOrderError);
    expect(h.docs.has(`orders/${ORDER}`)).toBe(false);
  });
});

describe("cash is collected at hand-off through the delivery OTP", () => {
  const STAFF = { uid: "staff_a", role: "branch_staff", branchIds: ["branch_a"] };

  function seedOutForDelivery(extra: Record<string, any> = {}) {
    vi.stubEnv("OTP_HMAC_SECRET", "hermetic_cash_handover_secret");
    const otp = deriveDeliveryOtp(ORDER);
    h.docs.set(`orders/${ORDER}`, {
      id: ORDER,
      customerId: CUSTOMER,
      userId: CUSTOMER,
      branchId: "branch_a",
      orderType: "delivery",
      fulfillment: "delivery",
      status: { code: "OUT_FOR_DELIVERY", label: "Out for delivery", kind: "in_progress", terminal: false },
      deliveryStatus: "dispatched",
      paymentMethod: "cod",
      paymentStatus: "pending",
      payment: { method: "cod", status: "pending" },
      paymentChannel: "cash",
      cashDuePaise: 16500,
      total: 165,
      deliveryOtpHash: computeDeliveryOtpHash(otp, ORDER, 2),
      deliveryOtpVersion: 2,
      ...extra,
    });
    return otp;
  }

  it("marks the cash collected with the server's own amount", async () => {
    const otp = seedOutForDelivery();
    await expect(verifyDeliveryOtp({ orderId: ORDER, otp, caller: STAFF })).resolves.toMatchObject({
      success: true,
      orderId: ORDER,
    });
    const doc = h.docs.get(`orders/${ORDER}`);
    expect(doc.status).toMatchObject({ code: "DELIVERED", terminal: true });
    expect(doc.paymentStatus).toBe("paid");
    expect(doc.cashCollectedPaise).toBe(16500);
    expect(doc.payment).toMatchObject({ method: "cod", status: "completed", cashCollectedPaise: 16500 });
    // Never a gateway shape: a collected banknote is not a captured card.
    expect(doc.paymentChannel).toBe("cash");
    expect(doc.payment.capturedAmountPaise).toBeUndefined();
    expect(doc["payment.capturedAmountPaise"]).toBeUndefined();
  });

  it("refuses a client-typed cod order with no server cash marker", async () => {
    const otp = seedOutForDelivery({ paymentChannel: undefined, cashDuePaise: undefined });
    await expect(verifyDeliveryOtp({ orderId: ORDER, otp, caller: STAFF })).rejects.toMatchObject({
      code: "ORDER_NOT_PAID",
    });
    expect(h.docs.get(`orders/${ORDER}`).status.code).toBe("OUT_FOR_DELIVERY");
  });

  it("refuses a cash order that was already collected", async () => {
    const otp = seedOutForDelivery({ cashCollectedPaise: 16500 });
    await expect(verifyDeliveryOtp({ orderId: ORDER, otp, caller: STAFF })).rejects.toMatchObject({
      code: "ORDER_NOT_PAID",
    });
  });
});

describe("cancellation follows F24 and owes no refund on cash", () => {
  it("cancels a COD order and plans no refund", async () => {
    await createCashOrder(CUSTOMER, baseInput());
    await expect(
      cancelOrderAsCustomer({ orderId: ORDER, uid: CUSTOMER, reason: "changed my mind" })
    ).resolves.toMatchObject({ orderId: ORDER, alreadyCancelled: false });
    const doc = h.docs.get(`orders/${ORDER}`);
    expect(doc.status).toMatchObject({ code: "CANCELLED", terminal: true });
    expect(doc.cancellationReason).toBe("changed my mind");
    // The refund planner accepts ONLY the gateway marker: cash owes nothing.
    expect(planCancelRefundObligation(doc)).toEqual({
      eligible: false,
      reason: "no_server_channel",
    });
  });

  it("still refuses a foreign account's cancel", async () => {
    await createCashOrder(CUSTOMER, baseInput());
    await expect(
      cancelOrderAsCustomer({ orderId: ORDER, uid: "customer_b" })
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});
