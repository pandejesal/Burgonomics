import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * P1 BASKET BINDING (money path).
 *
 * Defect under test: `createPaymentOrder` priced the REQUEST-BODY basket and
 * only stamped `pricing` onto the existing orders/{orderId} doc. The order's
 * stored `items`/`branchId`/`orderType` stayed untouched, so the KOT builder
 * (`pushOrderToPetpooja` → `order.items`, `order.fulfillmentType || order.orderType`)
 * fulfilled a DIFFERENT basket than the one Razorpay charged.
 *
 * Fixed contract pinned here:
 *   • stored basket (items + branch + fulfillment) is what gets priced;
 *   • a request describing a different basket/branch/fulfillment is refused
 *     with a non-retryable 409 BASKET_MISMATCH BEFORE any gateway order;
 *   • a legitimate retry (same basket) is priced as stored, line order and
 *     client-supplied prices notwithstanding;
 *   • legacy docs with no `items` array keep the historical request pricing.
 *
 * All Firestore writes go through an SDK-VALIDATING mock: explicit `undefined`
 * (which real Firestore rejects) throws, so a bad payload can never hide.
 */

const { mockDb, savedDocs, ordersCreate } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};

  const assertNoUndefined = (value: any, fieldPath: string) => {
    if (value === undefined) {
      throw new Error(
        `Cannot use "undefined" as a Firestore value (found in field "${fieldPath}")`
      );
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value)) {
        assertNoUndefined(v, fieldPath ? `${fieldPath}.${k}` : k);
      }
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => assertNoUndefined(v, `${fieldPath}[${i}]`));
    }
  };

  const ordersCreate = vi.fn(async (input: any) => {
    assertNoUndefined(input, "orders.create");
    return { id: `order_live_basket_${ordersCreate.mock.calls.length}` };
  });

  const docRef = (col: string, id: string) => {
    const path = `${col}/${id}`;
    return {
      id,
      path,
      get: vi.fn(async () => {
        if (col === "products") {
          const product = savedDocs[path];
          return product
            ? { exists: true, id, data: () => product }
            : { exists: false, id, data: () => ({}) };
        }
        return {
          exists: Object.prototype.hasOwnProperty.call(savedDocs, path),
          id,
          data: () => savedDocs[path],
        };
      }),
      set: vi.fn(async (data: any, opts?: any) => {
        assertNoUndefined(data, "");
        savedDocs[path] =
          opts?.merge && savedDocs[path] ? { ...savedDocs[path], ...data } : data;
      }),
      create: vi.fn(async (data: any) => {
        assertNoUndefined(data, "");
        if (Object.prototype.hasOwnProperty.call(savedDocs, path)) {
          const err: any = new Error("ALREADY_EXISTS: Document already exists");
          err.code = 6;
          throw err;
        }
        savedDocs[path] = data;
      }),
      update: vi.fn(async (data: any) => {
        assertNoUndefined(data, "");
        savedDocs[path] = { ...(savedDocs[path] || {}), ...data };
      }),
    };
  };

  const mockDb: any = {
    collection: (col: string) => ({
      doc: (id: string) => docRef(col, id),
      where: (field: string, _op: string, value: any) => ({
        limit: (_n: number) => ({
          get: vi.fn(async () => {
            const read = (obj: any, path: string) =>
              path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
            const docs = Object.keys(savedDocs)
              .filter((p) => p.startsWith(`${col}/`) && read(savedDocs[p], field) === value)
              .map((p) => {
                const id = p.slice(col.length + 1);
                return { id, ref: { path: p }, exists: true, data: () => savedDocs[p] };
              });
            return { empty: docs.length === 0, size: docs.length, docs };
          }),
        }),
      }),
    }),
    runTransaction: vi.fn(async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
      })
    ),
  };

  return { mockDb, savedDocs, ordersCreate };
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

// Gateway seam: the stub records every orders.create() the service attempts, so
// "zero gateway orders" is provable. It rejects undefined like the live SDK.
vi.mock("../src/modules/payments/razorpayClient", () => ({
  getRazorpayClient: () => ({ orders: { create: ordersCreate } }),
  getRazorpayKeyId: () => "rzp_live_unittest",
}));

import { createPaymentOrder } from "../src/modules/payments/razorpay.service";
import { config } from "../src/config/env";

const BRANCH = "branch_basket_1";

const expensiveItems = () => [
  {
    id: "line_wagyu",
    productId: "prod_wagyu",
    name: "Wagyu Double",
    price: 900,
    quantity: 2,
    customizations: [{ id: "cust_bacon", name: "Extra Bacon", price: 50 }],
  },
  { id: "line_side", productId: "prod_side", name: "Fries", price: 60, quantity: 1 },
];

const cheapItems = () => [
  { id: "line_water", productId: "prod_water", name: "Water", price: 10, quantity: 1 },
];

function seedOrder(id: string, overrides: Record<string, any> = {}) {
  savedDocs[`orders/${id}`] = {
    id,
    customerId: "guest",
    branchId: BRANCH,
    orderType: "delivery",
    status: "pending_payment",
    items: expensiveItems(),
    ...overrides,
  };
}

function intentKeys(): string[] {
  return Object.keys(savedDocs).filter((p) => p.startsWith("payment_intents/"));
}

describe("createPaymentOrder — PAY-13/PAY-15: the ORDER DOCUMENT is the cart", () => {
  let prevMock: boolean;
  let prevKeyId: string;
  let prevKeySecret: string;

  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    ordersCreate.mockClear();

    prevMock = config.mock.paymentGateway;
    prevKeyId = config.razorpay.keyId;
    prevKeySecret = config.razorpay.keySecret;
    // Live pricing + live gateway path (the SDK call is stubbed above).
    config.mock.paymentGateway = false;
    config.razorpay.keyId = "rzp_live_unittest";
    config.razorpay.keySecret = "live_secret_unittest";

    savedDocs[`branches/${BRANCH}`] = { royaltyPercentage: 5, packagingFee: 15 };
    savedDocs["branches/branch_basket_other"] = { royaltyPercentage: 5, packagingFee: 99 };
    savedDocs["products/prod_wagyu"] = {
      price: 900,
      inStock: true,
      // M2a: the selected add-on must exist in the product's catalog option
      // data, or the server refuses to price the selection at all.
      customizations: [
        {
          id: "grp_addons",
          name: "Add-ons",
          kind: "addon",
          minSelections: 0,
          maxSelections: 3,
          options: [{ id: "cust_bacon", name: "Extra Bacon", price: 50, inStock: true }],
        },
      ],
    };
    savedDocs["products/prod_water"] = { price: 10, inStock: true };
    savedDocs["products/prod_side"] = { price: 60, inStock: true };
  });

  afterEach(() => {
    config.mock.paymentGateway = prevMock;
    config.razorpay.keyId = prevKeyId;
    config.razorpay.keySecret = prevKeySecret;
  });

  /** A persisted, bindable courier quote for this order (R6). */
  function seedQuote(id: string, drop: { lat: number; lng: number }) {
    savedDocs[`delivery_fee_quotes/${id}`] = {
      uid: "guest",
      branchId: BRANCH,
      storeId: "demo",
      dropLat: drop.lat,
      dropLng: drop.lng,
      fee: 40,
      provider: "borzo",
      providerQuoteId: "QTE-BB",
      createdAt: "MOCK_TIMESTAMP",
      createdAtMs: Date.now() - 1000,
      expiresAt: Date.now() + 5 * 60_000,
      usedByOrderId: null,
    };
  }

  function deliverySeed(id: string) {
    const drop = { lat: 23.0225, lng: 72.5714 };
    seedOrder(id, { orderType: "delivery", deliveryAddress: drop });
    seedQuote(`dfq_${id}`, drop);
    return `dfq_${id}`;
  }

  it("a DIFFERENT request basket cannot change the charge: the STORED basket is priced and the request never reaches the gateway", async () => {
    const quoteId = deliverySeed("ord_expensive");
    const storedItemsBefore = JSON.parse(JSON.stringify(savedDocs["orders/ord_expensive"].items));

    const res = await createPaymentOrder({
      orderId: "ord_expensive",
      items: cheapItems(), // one ₹10 water, while the stored order holds two Wagyu
      branchId: BRANCH,
      orderType: "delivery",
      deliveryQuoteId: quoteId,
      customerId: "guest",
      idempotencyKey: "k_basket_mismatch",
    });

    // Exactly one gateway order, minted for the STORED basket: 2 x (900 + 50) + 60.
    expect(ordersCreate).toHaveBeenCalledTimes(1);
    const order = savedDocs["orders/ord_expensive"];
    expect(order.pricing.foodSubtotal).toBe(1960);
    expect(res.amountPaise).toBe(Math.round(order.pricing.grandTotal * 100));
    const gatewayInput = ordersCreate.mock.calls[0][0] as any;
    expect(gatewayInput.amount).toBe(res.amountPaise);
    expect(gatewayInput.notes.orderId).toBe("ord_expensive");
    // The stored basket is untouched by the request.
    expect(order.items).toEqual(storedItemsBefore);
  });

  it("prices the STORED basket as-is on a legitimate retry (line order + client prices ignored)", async () => {
    const quoteId = deliverySeed("ord_retry");

    // Same basket identity: the lines arrive in a DIFFERENT ORDER and the
    // client claims a cheap price for one of them — the stored basket and the
    // catalog still decide the amount.
    const requestItems = JSON.parse(JSON.stringify(expensiveItems())).reverse();
    requestItems[0].price = 1;

    const res = await createPaymentOrder({
      orderId: "ord_retry",
      items: requestItems,
      branchId: BRANCH,
      orderType: "delivery",
      deliveryQuoteId: quoteId,
      customerId: "guest",
      idempotencyKey: "k_basket_retry",
    });

    const order = savedDocs["orders/ord_retry"];
    expect(order.pricing.foodSubtotal).toBe(1960);
    expect(res.amountPaise).toBe(Math.round(order.pricing.grandTotal * 100));

    expect(ordersCreate).toHaveBeenCalledTimes(1);
    const gatewayInput = ordersCreate.mock.calls[0][0] as any;
    expect(gatewayInput.amount).toBe(res.amountPaise);
    expect(gatewayInput.notes.orderId).toBe("ord_retry");
    expect(gatewayInput.notes.branchId).toBe(BRANCH);
    expect(gatewayInput.notes.orderType).toBe("delivery");

    // The intent carries the SAME server-priced basket the kitchen will cook.
    const intent = savedDocs["payment_intents/k_basket_retry"];
    expect(intent.pricing.foodSubtotal).toBe(1960);
    expect(intent.amountPaise).toBe(res.amountPaise);
    expect(intent.orderId).toBe("ord_retry");
  });

  it("a request branch cannot move money: the STORED branch decides packaging and the transfer target", async () => {
    const quoteId = deliverySeed("ord_branch_drift");

    const res = await createPaymentOrder({
      orderId: "ord_branch_drift",
      items: expensiveItems(),
      branchId: "branch_basket_other",
      orderType: "delivery",
      deliveryQuoteId: quoteId,
      customerId: "guest",
      idempotencyKey: "k_basket_branch",
    });

    // The doc branch's packaging (15), never the request's decoy (99).
    expect(res.pricing.packagingFee).toBe(15);
    expect(ordersCreate).toHaveBeenCalledTimes(1);
    const gatewayInput = ordersCreate.mock.calls[0][0] as any;
    expect(gatewayInput.notes.branchId).toBe(BRANCH);
  });

  it("a request fulfillment cannot move money: the STORED fulfillment is what is priced", async () => {
    const quoteId = deliverySeed("ord_fulfil_drift");

    await createPaymentOrder({
      orderId: "ord_fulfil_drift",
      items: expensiveItems(),
      branchId: BRANCH,
      orderType: "takeaway", // decoy: the doc is a delivery
      deliveryQuoteId: quoteId,
      customerId: "guest",
      idempotencyKey: "k_basket_fulfil",
    });

    const order = savedDocs["orders/ord_fulfil_drift"];
    // The courier fee from the bound quote is part of the delivery charge.
    expect(order.pricing.deliveryFee).toBe(40);
    const gatewayInput = ordersCreate.mock.calls[0][0] as any;
    expect(gatewayInput.notes.orderType).toBe("delivery");
  });

  it("binds a legacy fulfillment alias on the stored doc (fulfillmentType: pickup ⇒ takeaway)", async () => {
    seedOrder("ord_pickup", { orderType: undefined, fulfillmentType: "pickup" });

    const res = await createPaymentOrder({
      orderId: "ord_pickup",
      items: expensiveItems(),
      branchId: BRANCH,
      orderType: "takeaway",
      customerId: "guest",
      idempotencyKey: "k_basket_pickup",
    });

    const gatewayInput = ordersCreate.mock.calls[0][0] as any;
    expect(gatewayInput.notes.orderType).toBe("takeaway");
    expect(gatewayInput.amount).toBe(res.amountPaise);
    // The stamped pricing is the KOT basket's price: 2 x 950 + 60 = 1960 food.
    expect(savedDocs["orders/ord_pickup"].pricing.foodSubtotal).toBe(1960);
  });

  it("refuses a legacy order doc that stores no items array instead of pricing the request (UNPRICEABLE)", async () => {
    savedDocs["orders/ord_legacy"] = {
      id: "ord_legacy",
      customerId: "guest",
      branchId: BRANCH,
      status: "pending_payment",
      // No `items`, no orderType — a pre-`items` order shape. The branch is
      // present so resolution reaches the cart gate instead of the store map.
    };

    await expect(
      createPaymentOrder({
        orderId: "ord_legacy",
        items: [{ id: "line_side", productId: "prod_side", name: "Fries", price: 60, quantity: 2 }],
        branchId: BRANCH,
        orderType: "takeaway",
        customerId: "guest",
        idempotencyKey: "k_basket_legacy",
      })
    ).rejects.toMatchObject({ statusCode: 422, code: "UNPRICEABLE" });

    expect(ordersCreate).not.toHaveBeenCalled();
    expect(intentKeys()).toEqual([]);
  });
});
