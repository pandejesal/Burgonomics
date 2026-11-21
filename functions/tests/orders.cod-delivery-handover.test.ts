import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F6 (integration-truth 2026-11-20, cycle 3, finding 8):
 * "A COD *delivery* order can never be handed over — `createCashOrder` mints no
 * hand-over code; only the paid-capture confirm path does."
 *
 * The owner decision of 2026-11-20 made cash on delivery a launch lane, so the
 * hand-over code has to exist at the SAME lifecycle point a paid order's does:
 * the moment the order becomes CONFIRMED. A COD order has no gateway capture to
 * mint from, so the proof is the server-owned `paymentChannel: "cash"` marker
 * plus the server-computed `cashDuePaise`.
 *
 * This suite is the RED-first contract for that fix:
 *   - COD delivery: the code is minted in the SAME write as CONFIRMED,
 *   - COD takeaway / walk-in / client-typed "cod" without the server marker,
 *   - an already-collected order is never re-minted,
 *   - the existing lockout rules still hold end to end,
 *   - the paid lane is not affected at all.
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
      ref: ref(collection, id),
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
  return { docs, db, reset: () => docs.clear() };
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
vi.mock("../src/core/errors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core/errors")>()),
  captureErrorSnapshot: vi.fn(async () => "hermetic_error_snapshot"),
}));

import { createCashOrder } from "../src/modules/orders/createCashOrder";
import { bumpOrderStatus } from "../src/modules/orders/orderStatus";
import { manualBranchDispatch } from "../src/modules/porter/porter.service";
import { verifyDeliveryOtp } from "../src/modules/orders/deliveryHandover.service";
import {
  computeDeliveryOtpHash,
  deriveDeliveryOtp,
  hasDeliveryOtpHash,
} from "../src/modules/orders/deliveryOtp";

const CUSTOMER = "customer_a";
const STAFF = { uid: "staff_a", role: "branch_staff", branchIds: ["branch_a"] };
const ORDER = "ord_cod_delivery_1";

beforeEach(() => {
  h.reset();
  vi.stubEnv("OTP_HMAC_SECRET", "hermetic_cod_handover_secret");
  h.docs.set("branches/branch_a", {
    name: "Surat Adajan",
    city: "Surat",
    packagingFee: 15,
    cashOnDelivery: { enabled: true, maxOrderValuePaise: 500000 },
  });
  h.docs.set("products/p1", {
    name: "Paneer Makhani Burger",
    branchId: "branch_a",
    price: 100,
    inStock: true,
  });
  h.docs.set("stores/s1", { partnerBranchId: "branch_a" });
});

/** A real COD delivery order created through the server's own entry point. */
async function createCodDelivery(orderId = ORDER, extra: Record<string, any> = {}) {
  h.docs.set("delivery_fee_quotes/dfq_cod_1", {
    uid: CUSTOMER,
    branchId: "branch_a",
    dropLat: 21.2,
    dropLng: 72.8,
    fee: 50,
    expiresAt: Date.now() + 600_000,
    usedByOrderId: null,
  });
  return createCashOrder(CUSTOMER, {
    orderId,
    storeId: "s1",
    orderType: "delivery",
    items: [{ productId: "p1", quantity: 1 }],
    deliveryQuoteId: "dfq_cod_1",
    address: { lat: 21.2, lng: 72.8, city: "Surat" },
    deliveryAddress: { lat: 21.2, lng: 72.8, city: "Surat" },
    expectedTotalPaise: 16500,
    ...extra,
  });
}

function documentOf(orderId = ORDER) {
  return h.docs.get(`orders/${orderId}`);
}

describe("F6: a COD delivery order gets its hand-over code at confirmation", () => {
  it("mints the v2 code in the SAME write as the kitchen accept (PLACED -> CONFIRMED)", async () => {
    await createCodDelivery();
    expect(documentOf().orderType).toBe("delivery");
    expect(documentOf().paymentChannel).toBe("cash");
    expect(hasDeliveryOtpHash(documentOf())).toBe(false);

    await bumpOrderStatus({ orderId: ORDER, status: "accepted", caller: STAFF });

    const order = documentOf();
    expect(order.status).toMatchObject({ code: "CONFIRMED", terminal: false });
    expect(order.deliveryOtpVersion).toBe(2);
    expect(order.deliveryOtpHash).toBe(
      computeDeliveryOtpHash(deriveDeliveryOtp(ORDER), ORDER, 2)
    );
    // The customer's own screen can now reopen the code.
    expect(order.deliveryOtp).toBeUndefined();
    expect(order.deliveryOtpConsumedAt).toBeUndefined();
  });

  it("is idempotent: a repeated accept never rewrites or reissues the code", async () => {
    await createCodDelivery();
    await bumpOrderStatus({ orderId: ORDER, status: "accepted", caller: STAFF });
    const first = documentOf().deliveryOtpHash;
    await bumpOrderStatus({ orderId: ORDER, status: "accepted", caller: STAFF });
    expect(documentOf().deliveryOtpHash).toBe(first);
    expect(documentOf().deliveryOtpVersion).toBe(2);
  });

  it("backfills a COD delivery confirmed before this fix on its next kitchen move", async () => {
    await createCodDelivery();
    // Simulate a pre-fix confirmation: CONFIRMED with no hand-over code.
    h.docs.set(`orders/${ORDER}`, {
      ...documentOf(),
      status: { code: "CONFIRMED", label: "Order confirmed", kind: "upcoming", terminal: false },
      dispatchType: "manual_branch_terminal",
      deliveryStatus: "dispatched",
      riderName: "In-house rider",
      riderPhone: "9999999999",
    });
    await bumpOrderStatus({ orderId: ORDER, status: "out_for_delivery", caller: STAFF });
    expect(documentOf().status.code).toBe("OUT_FOR_DELIVERY");
    expect(documentOf().deliveryOtpHash).toBe(
      computeDeliveryOtpHash(deriveDeliveryOtp(ORDER), ORDER, 2)
    );
  });

  it("leaves COD takeaway, walk-in and a client-typed 'cod' without the server marker alone", async () => {
    await createCodDelivery(ORDER, { orderType: "takeaway", deliveryQuoteId: undefined, expectedTotalPaise: 11500, address: undefined, deliveryAddress: undefined });
    await bumpOrderStatus({ orderId: ORDER, status: "accepted", caller: STAFF });
    expect(documentOf().status.code).toBe("CONFIRMED");
    expect(hasDeliveryOtpHash(documentOf())).toBe(false);

    h.docs.set("orders/ord_walkin_cod", {
      customerId: "cust_walkin", branchId: "branch_a", orderType: "takeaway",
      status: { code: "PLACED", terminal: false },
      paymentMethod: "cash", paymentStatus: "pending", payment: { method: "cash", status: "pending" },
    });
    await bumpOrderStatus({ orderId: "ord_walkin_cod", status: "accepted", caller: STAFF });
    expect(h.docs.get("orders/ord_walkin_cod").deliveryOtpHash).toBeUndefined();

    // A doc that merely CLAIMS cod is not a server cash order: no marker, no amount.
    h.docs.set("orders/ord_client_cod", {
      customerId: CUSTOMER, branchId: "branch_a", orderType: "delivery",
      status: { code: "PLACED", terminal: false },
      paymentMethod: "cod", paymentStatus: "pending", payment: { method: "cod", status: "pending" },
    });
    await bumpOrderStatus({ orderId: "ord_client_cod", status: "accepted", caller: STAFF });
    expect(h.docs.get("orders/ord_client_cod").deliveryOtpHash).toBeUndefined();
  });

  it("never mints for an already-collected or gateway-paid order", async () => {
    await createCodDelivery();
    h.docs.set(`orders/${ORDER}`, {
      ...documentOf(),
      cashCollectedPaise: 16500,
      paymentStatus: "paid",
      payment: { method: "cod", status: "completed", cashCollectedPaise: 16500 },
    });
    await bumpOrderStatus({ orderId: ORDER, status: "accepted", caller: STAFF });
    expect(documentOf().deliveryOtpHash).toBeUndefined();
  });

  it("mints at in-house dispatch when the accept came from the POS and wrote no code", async () => {
    await createCodDelivery();
    // A POS-accepted COD delivery: CONFIRMED, still no hand-over code.
    h.docs.set(`orders/${ORDER}`, {
      ...documentOf(),
      status: { code: "CONFIRMED", label: "Order confirmed", kind: "upcoming", terminal: false },
      petpoojaStatus: "synced",
    });
    await manualBranchDispatch({
      orderId: ORDER,
      riderName: "In-house rider",
      riderPhone: "9999999999",
      caller: STAFF,
    });
    const order = documentOf();
    expect(order.deliveryStatus).toBe("dispatched");
    expect(order.dispatchType).toBe("manual_branch_terminal");
    expect(order.deliveryOtpHash).toBe(
      computeDeliveryOtpHash(deriveDeliveryOtp(ORDER), ORDER, 2)
    );
    expect(order.deliveryOtpVersion).toBe(2);
  });
});

describe("F6 end to end: dispatch, lockout, then the correct code completes the COD delivery", () => {
  it("mints, locks out three wrong guesses, and marks the cash collected on the right code", async () => {
    await createCodDelivery();
    await bumpOrderStatus({ orderId: ORDER, status: "accepted", caller: STAFF });
    const code = deriveDeliveryOtp(ORDER);

    // The branch terminal assigns its in-house rider, then tells the customer
    // the food is on the way (the dispatch lanes themselves are unchanged).
    h.docs.set(`orders/${ORDER}`, {
      ...documentOf(),
      dispatchType: "manual_branch_terminal",
      deliveryStatus: "dispatched",
      riderName: "In-house rider",
      riderPhone: "9999999999",
    });
    await bumpOrderStatus({ orderId: ORDER, status: "out_for_delivery", caller: STAFF });
    const dispatched = documentOf();
    expect(dispatched.status.code).toBe("OUT_FOR_DELIVERY");
    expect(dispatched.cashCollectedPaise).toBeUndefined();

    for (const guess of ["0000", "1111"]) {
      await expect(
        verifyDeliveryOtp({ orderId: ORDER, otp: guess, caller: STAFF })
      ).rejects.toMatchObject({ code: "DELIVERY_OTP_INVALID", statusCode: 400 });
    }
    await expect(
      verifyDeliveryOtp({ orderId: ORDER, otp: "2222", caller: STAFF })
    ).rejects.toMatchObject({ code: "DELIVERY_OTP_LOCKED", statusCode: 429 });
    expect(documentOf().deliveryOtpAttempts).toBe(3);
    expect(Number(documentOf().deliveryOtpLockedUntil)).toBeGreaterThan(Date.now());
    // The correct code is refused while the lock holds (existing rule, kept).
    await expect(
      verifyDeliveryOtp({ orderId: ORDER, otp: code, caller: STAFF })
    ).rejects.toMatchObject({ code: "DELIVERY_OTP_LOCKED", statusCode: 429 });
    expect(documentOf().status.code).toBe("OUT_FOR_DELIVERY");
    expect(documentOf().cashCollectedPaise).toBeUndefined();

    // The lockout is time-based; this test only moves the clock forward.
    h.docs.set(`orders/${ORDER}`, { ...documentOf(), deliveryOtpLockedUntil: Date.now() - 1 });

    await expect(
      verifyDeliveryOtp({ orderId: ORDER, otp: code, caller: STAFF })
    ).resolves.toMatchObject({ success: true, orderId: ORDER });

    const delivered = documentOf();
    expect(delivered.status).toMatchObject({ code: "DELIVERED", terminal: true });
    expect(delivered.deliveryStatus).toBe("delivered");
    expect(delivered.cashCollectedPaise).toBe(16500);
    expect(delivered.cashCollectedAt).toBe("SERVER_TS");
    expect(delivered.paymentStatus).toBe("paid");
    expect(delivered.payment).toMatchObject({
      method: "cod",
      status: "completed",
      cashCollectedPaise: 16500,
    });
    // Cash is never dressed up as a gateway capture.
    expect(delivered.paymentChannel).toBe("cash");
    expect(delivered.payment.capturedAmountPaise).toBeUndefined();
    expect(delivered["payment.capturedAmountPaise"]).toBeUndefined();
    // The code is burnt exactly like a paid order's.
    expect(delivered.deliveryOtpHash).toBeNull();
    expect(delivered.deliveryOtpConsumedAt).toBe("SERVER_TS");
  });

  it("refuses a customer-typed code path and another outlet's staff, as before", async () => {
    await createCodDelivery();
    await bumpOrderStatus({ orderId: ORDER, status: "accepted", caller: STAFF });
    h.docs.set(`orders/${ORDER}`, {
      ...documentOf(),
      dispatchType: "manual_branch_terminal",
      deliveryStatus: "dispatched",
    });
    await bumpOrderStatus({ orderId: ORDER, status: "out_for_delivery", caller: STAFF });
    await expect(
      verifyDeliveryOtp({
        orderId: ORDER,
        otp: deriveDeliveryOtp(ORDER),
        caller: { uid: "staff_b", role: "branch_staff", branchIds: ["branch_b"] },
      })
    ).rejects.toThrow(/outside your assigned branches/);
  });
});

describe("F6 regression: the paid delivery lane is untouched", () => {
  const PAID = "ord_paid_delivery_1";

  function seedPaidDelivery() {
    h.docs.set(`orders/${PAID}`, {
      customerId: CUSTOMER,
      userId: CUSTOMER,
      branchId: "branch_a",
      orderType: "delivery",
      fulfillment: "delivery",
      status: { code: "PLACED", terminal: false },
      paymentChannel: "razorpay",
      paymentStatus: "completed",
      payment: { status: "completed", capturedAmountPaise: 15900, razorpayPaymentId: "pay_hermetic" },
      deliveryOtpHash: computeDeliveryOtpHash(deriveDeliveryOtp(PAID), PAID, 2),
      deliveryOtpVersion: 2,
    });
  }

  it("keeps the code a gateway capture minted and adds no cash fields", async () => {
    seedPaidDelivery();
    await bumpOrderStatus({ orderId: PAID, status: "accepted", caller: STAFF });
    const order = h.docs.get(`orders/${PAID}`);
    expect(order.status.code).toBe("CONFIRMED");
    expect(order.deliveryOtpHash).toBe(computeDeliveryOtpHash(deriveDeliveryOtp(PAID), PAID, 2));
    expect(order.cashCollectedPaise).toBeUndefined();
    expect(order.cashCycle).toBeUndefined();
    expect(order.paymentChannel).toBe("razorpay");
    expect(order.payment.capturedAmountPaise).toBe(15900);
  });

  it("still completes through the same hand-over and marks no cash", async () => {
    seedPaidDelivery();
    await bumpOrderStatus({ orderId: PAID, status: "accepted", caller: STAFF });
    h.docs.set(`orders/${PAID}`, {
      ...h.docs.get(`orders/${PAID}`),
      dispatchType: "manual_branch_terminal",
      deliveryStatus: "dispatched",
    });
    await bumpOrderStatus({ orderId: PAID, status: "out_for_delivery", caller: STAFF });
    await verifyDeliveryOtp({
      orderId: PAID,
      otp: deriveDeliveryOtp(PAID),
      caller: STAFF,
    });
    const order = h.docs.get(`orders/${PAID}`);
    expect(order.status).toMatchObject({ code: "DELIVERED", terminal: true });
    expect(order.cashCollectedPaise).toBeUndefined();
    expect(order.paymentStatus).toBe("completed");
    expect(order.paymentChannel).toBe("razorpay");
  });
});
