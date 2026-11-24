import { beforeEach, describe, expect, it, vi } from "vitest";

/** Server-created online drafts: no client-priced order may reach Razorpay. */
const h = vi.hoisted(() => {
  process.env.BURGONOMICS_ENV = "dev";
  const docs = new Map<string, any>();
  const copy = (value: any) => value === undefined ? undefined : structuredClone(value);
  const apply = (path: string, data: any, merge = false) =>
    docs.set(path, merge ? { ...(docs.get(path) ?? {}), ...copy(data) } : copy(data));
  const ref = (collection: string, id: string) => {
    const path = `${collection}/${id}`;
    return {
      id, path,
      get: async () => ({ exists: docs.has(path), id, data: () => copy(docs.get(path)) }),
      set: async (data: any, options?: { merge?: boolean }) => apply(path, data, options?.merge),
      create: async (data: any) => {
        if (docs.has(path)) throw new Error("already exists");
        apply(path, data);
      },
    };
  };
  const collection = (name: string) => ({
    doc: (id: string) => ({ ...ref(name, id), collection: (child: string) => collection(`${name}/${id}/${child}`) }),
  });
  let tail: Promise<unknown> = Promise.resolve();
  const db: any = {
    collection,
    runTransaction: (callback: (tx: any) => Promise<any>) => {
      const run = tail.then(async () => {
        const pending: Array<() => void> = [];
        let wrote = false;
        const result = await callback({
          get: async (reference: any) => {
            if (wrote) throw new Error("FIRESTORE_READ_AFTER_WRITE");
            return reference.get();
          },
          set: (reference: any, data: any, options?: { merge?: boolean }) => {
            wrote = true;
            pending.push(() => apply(reference.path, data, options?.merge));
          },
          create: (reference: any, data: any) => {
            wrote = true;
            pending.push(() => {
              if (docs.has(reference.path)) throw new Error("already exists");
              apply(reference.path, data);
            });
          },
          update: (reference: any, data: any) => {
            wrote = true;
            pending.push(() => apply(reference.path, data, true));
          },
        });
        for (const write of pending) write();
        return result;
      });
      tail = run.catch(() => undefined);
      return run;
    },
  };
  const gatewayCreate = vi.fn(async () => ({ id: "rzp_order_server_draft" }));
  return { docs, db, gatewayCreate };
});
vi.mock("../src/core/firebase", () => ({ db: h.db }));
vi.mock("firebase-admin", () => {
  const firestore: any = vi.fn(() => h.db);
  firestore.FieldValue = { serverTimestamp: () => "SERVER_TS", increment: (n: number) => n, arrayUnion: (v: any) => [v], delete: () => "DELETE" };
  return {
    default: { firestore, auth: vi.fn(() => ({})), messaging: vi.fn(() => ({})), initializeApp: vi.fn(), apps: [{ name: "mock" }] },
    firestore, auth: vi.fn(() => ({})), messaging: vi.fn(() => ({})), initializeApp: vi.fn(), apps: [{ name: "mock" }],
  };
});
vi.mock("../src/modules/payments/razorpayClient", () => ({
  getRazorpayClient: () => ({ orders: { create: h.gatewayCreate } }),
  getRazorpayKeyId: () => "rzp_live_unittest",
}));

import { createOnlineDraft } from "../src/modules/orders/createOnlineDraft";
import { handleCreateOnlineDraft } from "../src/modules/orders/createOnlineDraftRoute";
import { createPaymentOrder } from "../src/modules/payments/razorpay.service";
import { bumpOrderStatus } from "../src/modules/orders/orderStatus";
import { config } from "../src/config/env";
import { formatPetpoojaOrderPayload } from "../src/modules/petpooja/orderPush";

const CUSTOMER = "customer_online";
const OTHER = "customer_other";
const ORDER = "ord_online_draft_1";
const staff = { uid: "staff_1", role: "branch_staff", branchIds: ["branch_a"] };

function request(extra: Record<string, any> = {}) {
  return {
    orderId: ORDER,
    attemptId: "attempt_online_1",
    storeId: "s1",
    orderType: "takeaway" as const,
    items: [{ productId: "p1", quantity: 1 }],
    notes: "No onions",
    ...extra,
  };
}

beforeEach(() => {
  h.docs.clear();
  h.gatewayCreate.mockClear();
  config.mock.paymentGateway = false;
  config.razorpay.keyId = "rzp_live_unittest";
  config.razorpay.keySecret = "live_secret_unittest";
  h.docs.set("branches/branch_a", { name: "Surat", packagingFee: 15 });
  h.docs.set("products/p1", { name: "Burger", branchId: "branch_a", price: 100, inStock: true });
  h.docs.set("stores/s1", { id: "s1", name: "Demo", partnerBranchId: "branch_a", isOpen: true, pickupEtaMinutes: 17, etaMinutes: 45 });
  h.docs.set("admins/staff_1", { role: "branch_owner", branchId: "branch_a", active: true });
  h.docs.set("users/staff_1", { active: true });
  h.docs.set("coupons/QA20", {
    code: "QA20", active: true, discountType: "percent", value: 20, maxDiscount: 200,
    minOrder: 0, validFromMs: null, validToMs: null, perCustomerLimit: null,
    totalCap: null, branchScope: ["branch_a"], customerScope: null,
  });
});

async function create(body: unknown = request()) {
  const status = vi.fn().mockReturnThis();
  const json = vi.fn();
  await handleCreateOnlineDraft(
    { user: { uid: CUSTOMER }, body } as any,
    { status, json } as any,
  );
  return { status, json };
}

describe("server online draft creation", () => {
  it("sends the line note to the KOT and allows a privacy-minimal replay without that note", async () => {
    await create(request({ items: [{ productId: "p1", quantity: 1, notes: "Toast both sides" }] }));
    const retry = await create();
    expect(retry.status).toHaveBeenCalledWith(200);
    const order = h.docs.get(`orders/${ORDER}`);
    expect(order.items[0].notes).toBe("Toast both sides");
    const captured = { ...order, paymentChannel: "razorpay", paymentStatus: "completed" };
    const payload = formatPetpoojaOrderPayload(captured, { name: "Surat" }, "PP_B1", "branch_a", ORDER,
      undefined, [{ posItemId: "PP-1", unitPrice: 100, addons: [] }]);
    expect(payload.orderinfo.OrderInfo.OrderItem.details[0].description).toBe("Toast both sides");
  });

  it("fences a rejected attempt against late retries before using a corrected coupon", async () => {
    const invalid = await create(request({ couponCode: "BAD" }));
    expect(invalid.status).toHaveBeenCalledWith(400);
    expect(h.docs.has(`orders/${ORDER}`)).toBe(false);
    const retired = await create({ operation: "retire", orderId: ORDER, attemptId: "attempt_online_1" });
    expect(retired.status).toHaveBeenCalledWith(200);
    const late = await create();
    expect(late.status).toHaveBeenCalledWith(409);
    expect(late.json.mock.calls[0][0]).toMatchObject({ code: "DRAFT_RETIRED" });
    expect(h.docs.has(`orders/${ORDER}`)).toBe(false);
    expect((await create(request({ orderId: "ord_coupon_fixed", attemptId: "attempt_coupon_fixed", couponCode: "QA20" }))).status)
      .toHaveBeenCalledWith(201);
  });

  it("replaces an unpayable delivery draft using the refreshed quote and refuses its predecessor", async () => {
    const original = request({ orderType: "delivery", addressId: "addr_1", deliveryQuoteId: "quote_stale_123" });
    h.docs.set(`users/${CUSTOMER}/addresses/addr_1`, { lat: 21.2, lng: 72.8, line1: "1 Main" });
    const quote = { uid: CUSTOMER, branchId: "branch_a", dropLat: 21.2, dropLng: 72.8, fee: 50,
      expiresAt: Date.now() + 600_000, usedByOrderId: null };
    h.docs.set("delivery_fee_quotes/quote_stale_123", quote);
    expect((await create(original)).status).toHaveBeenCalledWith(201);
    h.docs.set("delivery_fee_quotes/quote_stale_123", { ...quote, usedByOrderId: ORDER, expiresAt: 1 });
    const pay = (orderId: string, deliveryQuoteId?: string) => createPaymentOrder({
      orderId, customerId: CUSTOMER, orderType: "delivery", deliveryQuoteId, items: [],
    });
    h.docs.set("delivery_fee_quotes/quote_fresh_123", { ...quote, fee: 65 });
    await expect(pay(ORDER, "quote_fresh_123")).rejects.toMatchObject({ code: "DELIVERY_QUOTE_EXPIRED" });
    expect((await create({ operation: "retire", orderId: ORDER, attemptId: original.attemptId })).status)
      .toHaveBeenCalledWith(200);
    expect(h.docs.get(`orders/${ORDER}`).status).toMatchObject({ code: "CANCELLED", terminal: true });
    expect(h.docs.get("delivery_fee_quotes/quote_stale_123").usedByOrderId).toBeNull();
    await expect(pay(ORDER)).rejects.toMatchObject({ statusCode: 409 });
    expect(h.gatewayCreate).not.toHaveBeenCalled();
    const refreshedId = "ord_quote_refreshed";
    const refreshed = await create({ ...original, orderId: refreshedId, attemptId: "attempt_refreshed_1", deliveryQuoteId: "quote_fresh_123" });
    expect(refreshed.status).toHaveBeenCalledWith(201);
    await expect(pay(refreshedId)).resolves.toMatchObject({ amountPaise: 18000 });
    const fenced = await create({ operation: "retire", orderId: refreshedId, attemptId: "attempt_refreshed_1" });
    expect(fenced.json.mock.calls[0][0]).toMatchObject({ code: "DRAFT_PAYMENT_IN_PROGRESS" });
    expect(h.gatewayCreate).toHaveBeenCalledTimes(1);
  });

  it("resolves owner, store, branch, price and coupon in the real handler", async () => {
    const { status, json } = await create(request({ couponCode: "QA20" }));
    expect(status).toHaveBeenCalledWith(201);
    expect(json.mock.calls[0][0]).toMatchObject({ orderId: ORDER, replayed: false, amountPaise: 9500 });
    expect(h.docs.get(`orders/${ORDER}`)).toMatchObject({
      customerId: CUSTOMER, userId: CUSTOMER, branchId: "branch_a", storeId: "s1",
      orderType: "takeaway", fulfillment: "takeaway",
      paymentMethod: "online", paymentStatus: "pending", payment: { method: "online", status: "pending" },
      status: { code: "PLACED" },
      pricing: { grandTotal: 95, discount: 20 }, totals: { grandTotal: 95, promoDiscount: 20 },
      couponCode: "QA20", notes: "No onions",
      onlineDraft: { version: 1, source: "server_online_draft", orderId: ORDER, customerId: CUSTOMER, attemptId: "attempt_online_1" },
    });
    expect(h.docs.get(`orders/${ORDER}`).items[0]).toMatchObject({ productId: "p1", quantity: 1, unitPrice: 100 });
    expect(h.docs.get(`orders/${ORDER}`)).not.toHaveProperty("paymentChannel");
    expect(h.docs.get(`orders/${ORDER}`)).not.toHaveProperty("cashDuePaise");
  });

  function etaRequest(orderType: "delivery" | "takeaway" | "dinein") {
    if (orderType === "delivery") {
      h.docs.set(`users/${CUSTOMER}/addresses/addr_1`, { lat: 21.2, lng: 72.8 });
      h.docs.set("delivery_fee_quotes/quote_eta_123", { uid: CUSTOMER, branchId: "branch_a", dropLat: 21.2,
        dropLng: 72.8, fee: 50, expiresAt: Date.now() + 600_000, usedByOrderId: null });
    }
    return request({ orderType, ...(orderType === "delivery" ? { addressId: "addr_1", deliveryQuoteId: "quote_eta_123" } : {}),
      ...(orderType === "dinein" ? { tableNumber: "7" } : {}) });
  }

  it.each([["delivery", 45], ["takeaway", 17], ["dinein", 17]] as const)("stores and returns the storefront's %s ETA", async (mode, minutes) => {
    const before = Date.now();
    const result = await create(etaRequest(mode));
    expect(result.status).toHaveBeenCalledWith(201);
    const stored = h.docs.get(`orders/${ORDER}`).estimatedAt;
    expect(result.json).toHaveBeenCalledWith(expect.objectContaining({ estimatedAt: stored }));
    expect(Date.parse(stored)).toBeGreaterThanOrEqual(before + minutes * 60_000);
    expect(Date.parse(stored)).toBeLessThanOrEqual(Date.now() + minutes * 60_000);
  });

  it.each([undefined, null, 0, -1, NaN, Infinity])("omits an unknown/invalid ETA (%s) in both the receipt and document", async (eta) => {
    h.docs.set("stores/s1", { ...h.docs.get("stores/s1"), etaMinutes: eta, pickupEtaMinutes: eta });
    for (const mode of ["delivery", "takeaway", "dinein"] as const) {
      const orderId = `ord_eta_${mode}`;
      const result = await create({ ...etaRequest(mode), orderId, attemptId: `attempt_eta_${mode}` });
      expect(result.status).toHaveBeenCalledWith(201);
      expect(result.json.mock.calls[0][0]).not.toHaveProperty("estimatedAt");
      expect(h.docs.get(`orders/${orderId}`)).not.toHaveProperty("estimatedAt");
    }
  });

  it("replays the same attempt from a second tab without a second order", async () => {
    const first = await create();
    const second = await create(request({ notes: undefined, fulfillmentInstructions: undefined }));
    expect(first.status).toHaveBeenCalledWith(201);
    expect(second.status).toHaveBeenCalledWith(200);
    expect(second.json.mock.calls[0][0]).toMatchObject({ orderId: ORDER, replayed: true, amountPaise: 11500 });
    expect([...h.docs.keys()].filter((path) => path.startsWith("orders/"))).toHaveLength(1);
  });

  it("refuses a different basket on the same attempt", async () => {
    await create();
    const { status, json } = await create(request({ items: [{ productId: "p1", quantity: 2 }] }));
    expect(status).toHaveBeenCalledWith(409);
    expect(json.mock.calls[0][0]).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect([...h.docs.keys()].filter((path) => path.startsWith("orders/"))).toHaveLength(1);
  });

  it("persists a retry fingerprint and refuses the same delivery attempt for a different address", async () => {
    const original = etaRequest("delivery");
    expect((await create(original)).status).toHaveBeenCalledWith(201);
    const before = h.docs.get(`orders/${ORDER}`);
    expect(before.checkoutFingerprint).toMatch(/^[a-f0-9]{64}$/);
    const response = await create({ ...original, addressId: "different_address" });
    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json.mock.calls[0][0]).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(h.docs.get(`orders/${ORDER}`)).toEqual(before);
  });

  it("fails closed without a checkout fingerprint, even with a matching sidecar receipt", async () => {
    expect((await create()).status).toHaveBeenCalledWith(201);
    const { checkoutFingerprint: _removed, ...stored } = h.docs.get(`orders/${ORDER}`);
    h.docs.set(`orders/${ORDER}`, stored);
    const response = await create();
    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json.mock.calls[0][0]).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(h.docs.get(`orders/${ORDER}`)).toEqual(stored);
  });

  it("reads the saved address and courier quote for delivery inside the transaction", async () => {
    h.docs.set(`users/${CUSTOMER}/addresses/addr_1`, { lat: 21.2, lng: 72.8, line1: "1 Main", city: "Surat" });
    h.docs.set("delivery_fee_quotes/quote_12345", {
      uid: CUSTOMER, branchId: "branch_a", dropLat: 21.2, dropLng: 72.8,
      fee: 50, expiresAt: Date.now() + 600_000, usedByOrderId: null,
    });
    const { status } = await create(request({
      orderId: "ord_online_delivery", orderType: "delivery", addressId: "addr_1", deliveryQuoteId: "quote_12345",
    }));
    expect(status).toHaveBeenCalledWith(201);
    expect(h.docs.get("orders/ord_online_delivery")).toMatchObject({
      address: { line1: "1 Main", lat: 21.2, lng: 72.8 }, deliveryQuoteId: "quote_12345",
      pricing: { grandTotal: 165, deliveryFee: 50 },
    });
    expect(h.docs.get("delivery_fee_quotes/quote_12345").usedByOrderId).toBe("ord_online_delivery");
  });

  it("refuses an invalid coupon before writing a draft", async () => {
    h.docs.set("coupons/BAD", { ...h.docs.get("coupons/QA20"), active: false });
    const { status, json } = await create(request({ couponCode: "BAD" }));
    expect(status).toHaveBeenCalledWith(400);
    expect(json.mock.calls[0][0].code).toBe("COUPON_INACTIVE");
    expect(h.docs.has(`orders/${ORDER}`)).toBe(false);
  });

  it("refuses a closed storefront before writing", async () => {
    h.docs.set("stores/s1", { id: "s1", partnerBranchId: "branch_a", isOpen: false });
    const { status, json } = await create();
    expect(status).toHaveBeenCalledWith(409);
    expect(json.mock.calls[0][0].code).toBe("STORE_CLOSED");
    expect(h.docs.has(`orders/${ORDER}`)).toBe(false);
  });
});

describe("server draft → real payment handler", () => {
  const payment = () => createPaymentOrder({
    orderId: ORDER, customerId: CUSTOMER, orderType: "takeaway", items: [],
    idempotencyKey: "pay_attempt_online_1",
  });

  it("creates and replays one gateway order, while kitchen admission waits for capture", async () => {
    await create(request({ couponCode: "QA20" }));
    await expect(bumpOrderStatus({ orderId: ORDER, status: "preparing", caller: staff }))
      .rejects.toMatchObject({ code: "ORDER_NOT_PAID" });
    const first = await payment();
    const replay = await payment();
    expect(first.amountPaise).toBe(9500);
    expect(replay.id).toBe(first.id);
    expect(h.gatewayCreate).toHaveBeenCalledTimes(1);
    expect(h.docs.get(`orders/${ORDER}`).pricing.grandTotal).toBe(95);
    await expect(bumpOrderStatus({ orderId: ORDER, status: "preparing", caller: staff }))
      .rejects.toMatchObject({ code: "ORDER_NOT_PAID" });
    h.docs.set(`orders/${ORDER}`, {
      ...h.docs.get(`orders/${ORDER}`), paymentChannel: "razorpay", paymentStatus: "completed",
      payment: { ...h.docs.get(`orders/${ORDER}`).payment, status: "completed" },
    });
    await bumpOrderStatus({ orderId: ORDER, status: "preparing", caller: staff });
    expect(h.docs.get(`orders/${ORDER}`).status.code).toBe("PREPARING");
  });

  it("ignores a body-only coupon that the server draft never validated", async () => {
    await create();
    const result = await createPaymentOrder({
      orderId: ORDER, customerId: CUSTOMER, orderType: "takeaway", items: [],
      couponCode: "QA20", idempotencyKey: "pay_body_coupon",
    });
    expect(result.pricing.discount).toBe(0);
    expect(h.docs.get(`orders/${ORDER}`).couponCode).toBeUndefined();
    expect(h.docs.has(`coupon_redemptions/${ORDER}`)).toBe(false);
  });

  it("refuses a draft owned by another customer", async () => {
    await create();
    await expect(createPaymentOrder({ orderId: ORDER, customerId: OTHER, orderType: "takeaway", items: [] }))
      .rejects.toMatchObject({ code: "ORDER_NOT_OWNED" });
    expect(h.gatewayCreate).not.toHaveBeenCalled();
  });

  it("refuses a draft whose server binding or basket was tampered with", async () => {
    await create();
    const original = h.docs.get(`orders/${ORDER}`);
    h.docs.set(`orders/${ORDER}`, { ...original, items: [{ ...original.items[0], quantity: 9 }] });
    await expect(payment()).rejects.toMatchObject({ code: "ORDER_DRAFT_INVALID" });
    expect(h.gatewayCreate).not.toHaveBeenCalled();
  });

  it("refuses a client-created lookalike with no server draft proof", async () => {
    h.docs.set(`orders/${ORDER}`, {
      customerId: CUSTOMER, userId: CUSTOMER, branchId: "branch_a", orderType: "takeaway",
      status: { code: "PLACED" }, paymentMethod: "online", paymentStatus: "pending",
      payment: { method: "online", status: "pending" }, items: [{ productId: "p1", quantity: 1 }],
    });
    await expect(payment()).rejects.toMatchObject({ code: "ORDER_DRAFT_INVALID" });
    expect(h.gatewayCreate).not.toHaveBeenCalled();
  });
});
