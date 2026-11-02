import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * R6b — bind the courier quote for CASH delivery orders.
 *
 * A cash order never calls createPaymentOrder, so nothing bound its quote; the
 * KOT repricing then failed closed and the kitchen never saw the order. Now the
 * cash push path binds the quote itself, with ONE deliberate difference from
 * the checkout rule: expiry is judged at the order's server-readable createdAt
 * (+ small grace), because staff may accept long after the quote's TTL.
 *
 * A missing or invalid quote must never cost the kitchen the ticket: the order
 * relays with delivery_charges 0 and `deliveryFeeUnverified: true`. A
 * client-written delivery fee is never used as money.
 *
 * Mock-only, in-memory store: no network, no Firestore, no real provider.
 */

const { savedDocs, mockDb } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};

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
          opts?.merge && savedDocs[path] ? { ...savedDocs[path], ...data } : data;
      },
    };
    return ref;
  };

  const mockDb: any = {
    collection: (col: string) => ({
      doc: (id: string) => docRef(col, id),
      where: (field: string, _op: string, value: any) => {
        const query: any = {
          limit: () => query,
          get: async () => {
            const docs = Object.keys(savedDocs)
              .filter((k) => k.startsWith(`${col}/`))
              .filter((k) => savedDocs[k]?.[field] === value)
              .map((k) => {
                const id = k.slice(col.length + 1);
                return { id, data: () => savedDocs[k], ref: docRef(col, id) };
              });
            return { empty: docs.length === 0, docs };
          },
        };
        return query;
      },
    }),
    runTransaction: async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
      }),
  };

  return { savedDocs, mockDb };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TIMESTAMP",
    increment: (n: number) => n,
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

import { pushOrderToPetpooja } from "../src/modules/petpooja/orderPush";
import { config } from "../src/config/env";

const BRANCH = "b1";
const UID = "uid_cash_1";
const DROP = { lat: 23.0338, lng: 72.5262 };
const FEE = 60;
const CREATED_AT = Date.now() - 60 * 60_000; // one hour ago

let prevMock: boolean;
const fetchMock = vi.fn();

function seedOrder(id: string, extra: Record<string, any> = {}) {
  savedDocs[`orders/${id}`] = {
    id,
    branchId: BRANCH,
    customerId: UID,
    userId: UID,
    fulfillmentType: "DELIVERY",
    paymentMethod: "COD",
    createdAtMs: CREATED_AT,
    deliveryAddress: { lat: DROP.lat, lng: DROP.lng },
    items: [{ id: "l1", petpoojaItemId: "101", name: "Burger", price: 235, quantity: 1 }],
    pricing: {
      foodSubtotal: 235,
      gst: 11.19,
      packagingFee: 15,
      deliveryFee: 0,
      discount: 0,
      loyaltyDiscount: 0,
      grandTotal: 250,
    },
    ...extra,
  };
}

function seedQuote(id: string, extra: Record<string, any> = {}) {
  savedDocs[`delivery_fee_quotes/${id}`] = {
    uid: UID,
    branchId: BRANCH,
    storeId: "demo",
    dropLat: DROP.lat,
    dropLng: DROP.lng,
    fee: FEE,
    provider: "borzo",
    providerQuoteId: "QTE-BORZO-CASH",
    createdAt: "MOCK_TIMESTAMP",
    createdAtMs: CREATED_AT,
    expiresAt: CREATED_AT + 15 * 60_000,
    usedByOrderId: null,
    ...extra,
  };
}

function deliveredPayload(): any {
  const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  expect(call).toBeTruthy();
  return JSON.parse(call[1].body);
}

beforeEach(() => {
  for (const key of Object.keys(savedDocs)) delete savedDocs[key];
  prevMock = config.mock.petpoojaPos;
  config.mock.petpoojaPos = false;
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ success: "1", orderID: "pp_cash_1" }),
  });
  vi.stubGlobal("fetch", fetchMock);
  savedDocs[`branches/${BRANCH}`] = {
    petpoojaStoreId: "PP_B1",
    petpoojaTaxes: [
      { id: "11", name: "CGST", rate: 2.5 },
      { id: "12", name: "SGST", rate: 2.5 },
    ],
  };
  // POS-11: POS lines are priced from the catalog. P1-J: the POS IDENTITY must
  // come from this document too, never from the cart line.
  savedDocs["products/l1"] = {
    id: "l1",
    branchId: BRANCH,
    price: 235,
    inStock: true,
    petpoojaItemId: "101",
  };
});

afterEach(() => {
  config.mock.petpoojaPos = prevMock;
  vi.unstubAllGlobals();
});

describe("R6b cash delivery KOT — quote binding", () => {
  it("parks a client-claimed online payment without a verified capture", async () => {
    seedOrder("ord_unverified_online", { fulfillmentType: "TAKEAWAY", paymentMethod: "razorpay" });
    expect(await pushOrderToPetpooja("ord_unverified_online")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(savedDocs["orders/ord_unverified_online"].petpoojaStatus).toBe("blocked_configuration");
    expect(savedDocs["orders/ord_unverified_online"].lastPetpoojaError).toMatch(/unverified payment type/);
  });

  it("does not flag a customer-app takeaway as an unverified delivery", async () => {
    seedOrder("ord_takeaway", { fulfillmentType: undefined, fulfillment: "takeaway", paymentMethod: undefined, payment: { method: "cod", status: "PAY_AT_STORE" }, status: { code: "PICKED_UP", kind: "completed", terminal: true } });
    expect(await pushOrderToPetpooja("ord_takeaway")).toBe(true);
    const details = deliveredPayload().orderinfo.OrderInfo.Order.details;
    expect(details.delivery_charges).toBe("0.00");
    expect(details.total).toBe("250.00");
    expect(savedDocs["orders/ord_takeaway"].deliveryFeeUnverified).toBe(false);
    expect(savedDocs["orders/ord_takeaway"].deliveryFeeUnverifiedReason).toBeNull();
  });

  it("binds a valid quote and charges its fee", async () => {
    seedOrder("ord_cash_1", { deliveryQuoteId: "dfq_cash_1" });
    seedQuote("dfq_cash_1");

    const pushed = await pushOrderToPetpooja("ord_cash_1");
    expect(pushed).toBe(true);
    expect(savedDocs["delivery_fee_quotes/dfq_cash_1"].usedByOrderId).toBe("ord_cash_1");

    const details = deliveredPayload().orderinfo.OrderInfo.Order.details;
    expect(details.delivery_charges).toBe("60.00");
    // Ruling 2026-11-02: the courier fee is part of the amount collected.
    expect(details.total).toBe("310.00");
    expect(details.collect_cash).toBe("310.00");
    // Inclusive menu: no food GST asserted, no charge GST.
    expect(details.tax_total).toBe("0.00");
    expect(savedDocs["orders/ord_cash_1"].deliveryFeeUnverified).toBe(false);
  });

  it("cannot reuse one quote for a second order, but still relays the KOT", async () => {
    savedDocs["delivery_fee_quotes/dfq_shared"] = {
      ...savedDocs["delivery_fee_quotes/dfq_shared"],
    };
    seedQuote("dfq_shared", { usedByOrderId: "ord_first" });
    seedOrder("ord_second", { deliveryQuoteId: "dfq_shared" });

    const pushed = await pushOrderToPetpooja("ord_second");
    expect(pushed).toBe(true); // the kitchen still cooks
    const details = deliveredPayload().orderinfo.OrderInfo.Order.details;
    expect(details.delivery_charges).toBe("0.00");
    expect(savedDocs["orders/ord_second"].deliveryFeeUnverified).toBe(true);
    expect(String(savedDocs["orders/ord_second"].deliveryFeeUnverifiedReason)).toMatch(
      /already used|rejected/i
    );
    // The first order's claim is untouched.
    expect(savedDocs["delivery_fee_quotes/dfq_shared"].usedByOrderId).toBe("ord_first");
  });

  it("refuses a quote from another uid, flags it, and still relays", async () => {
    seedQuote("dfq_other_uid", { uid: "uid_someone_else" });
    seedOrder("ord_other_uid", { deliveryQuoteId: "dfq_other_uid" });

    expect(await pushOrderToPetpooja("ord_other_uid")).toBe(true);
    expect(deliveredPayload().orderinfo.OrderInfo.Order.details.delivery_charges).toBe("0.00");
    expect(savedDocs["orders/ord_other_uid"].deliveryFeeUnverified).toBe(true);
    expect(savedDocs["delivery_fee_quotes/dfq_other_uid"].usedByOrderId).toBeNull();
  });

  it("refuses a quote from another branch, flags it, and still relays", async () => {
    seedQuote("dfq_other_branch", { branchId: "branch_other" });
    seedOrder("ord_other_branch", { deliveryQuoteId: "dfq_other_branch" });

    expect(await pushOrderToPetpooja("ord_other_branch")).toBe(true);
    expect(deliveredPayload().orderinfo.OrderInfo.Order.details.delivery_charges).toBe("0.00");
    expect(savedDocs["orders/ord_other_branch"].deliveryFeeUnverified).toBe(true);
  });

  it("refuses a quote that had expired before the order was created", async () => {
    seedQuote("dfq_expired_before", { expiresAt: CREATED_AT - 10 * 60_000 });
    seedOrder("ord_expired_before", { deliveryQuoteId: "dfq_expired_before" });

    expect(await pushOrderToPetpooja("ord_expired_before")).toBe(true);
    expect(deliveredPayload().orderinfo.OrderInfo.Order.details.delivery_charges).toBe("0.00");
    expect(savedDocs["orders/ord_expired_before"].deliveryFeeUnverified).toBe(true);
    expect(String(savedDocs["orders/ord_expired_before"].deliveryFeeUnverifiedReason)).toMatch(
      /expired when this order was placed/i
    );
  });

  it("accepts a quote that was valid at creation but has expired since", async () => {
    // Expired 45 minutes ago, but the order was placed while it was live.
    seedQuote("dfq_expired_after", { expiresAt: CREATED_AT + 15 * 60_000 });
    seedOrder("ord_expired_after", { deliveryQuoteId: "dfq_expired_after" });

    expect(await pushOrderToPetpooja("ord_expired_after")).toBe(true);
    expect(deliveredPayload().orderinfo.OrderInfo.Order.details.delivery_charges).toBe("60.00");
    expect(savedDocs["orders/ord_expired_after"].deliveryFeeUnverified).toBe(false);
    expect(savedDocs["delivery_fee_quotes/dfq_expired_after"].usedByOrderId).toBe(
      "ord_expired_after"
    );
  });

  it("relays with a flag when the order carries no quote at all", async () => {
    seedOrder("ord_no_quote");
    expect(await pushOrderToPetpooja("ord_no_quote")).toBe(true);
    const details = deliveredPayload().orderinfo.OrderInfo.Order.details;
    expect(details.delivery_charges).toBe("0.00");
    expect(details.total).toBe("250.00");
    expect(savedDocs["orders/ord_no_quote"].deliveryFeeUnverified).toBe(true);
    expect(String(savedDocs["orders/ord_no_quote"].deliveryFeeUnverifiedReason)).toMatch(
      /no deliveryQuoteId/i
    );
  });

  it("does not double-bind on redelivery", async () => {
    seedOrder("ord_redeliver", { deliveryQuoteId: "dfq_redeliver" });
    seedQuote("dfq_redeliver");

    expect(await pushOrderToPetpooja("ord_redeliver")).toBe(true);
    expect(savedDocs["delivery_fee_quotes/dfq_redeliver"].usedByOrderId).toBe("ord_redeliver");

    // A redelivery of the SAME order: clear the POS ids so the dedupe lets it
    // through, then push again.
    delete savedDocs["orders/ord_redeliver"].petpoojaOrderId;
    delete savedDocs["orders/ord_redeliver"].petpoojaAcceptedNoId;
    expect(await pushOrderToPetpooja("ord_redeliver")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(deliveredPayload().orderinfo.OrderInfo.Order.details.delivery_charges).toBe("60.00");
    expect(savedDocs["delivery_fee_quotes/dfq_redeliver"].usedByOrderId).toBe("ord_redeliver");
    expect(savedDocs["orders/ord_redeliver"].deliveryFeeUnverified).toBe(false);
  });

  it("never uses a client-written delivery fee when the quote is missing", async () => {
    seedOrder("ord_client_fee", {
      deliveryFee: 999,
      pricing: {
        foodSubtotal: 235,
        gst: 11.19,
        packagingFee: 15,
        deliveryFee: 999,
        discount: 0,
        loyaltyDiscount: 0,
        grandTotal: 1249,
      },
    });
    expect(await pushOrderToPetpooja("ord_client_fee")).toBe(true);
    const details = deliveredPayload().orderinfo.OrderInfo.Order.details;
    expect(details.delivery_charges).toBe("0.00");
    expect(details.total).toBe("250.00");
    expect(savedDocs["orders/ord_client_fee"].deliveryFeeUnverified).toBe(true);
  });
});
