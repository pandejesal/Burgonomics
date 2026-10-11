import { describe, it, expect } from "vitest";
import {
  createPaymentOrderSchema,
  verifyPaymentSchema,
  refundSchema,
  pushOrderSchema,
  syncMenuSchema,
  pushStockSchema,
  porterBookSchema,
  porterCancelSchema,
  verifyDeliveryOtpSchema,
  manualDispatchSchema,
} from "../src/core/validation";

describe("route request validation", () => {
  it("accepts valid money-route bodies", () => {
    expect(
      createPaymentOrderSchema.safeParse({
        items: [{ id: "a", price: 199, quantity: 1 }],
        branchId: "b1",
        orderType: "delivery",
        orderId: "ord_1", // REQUIRED since PAYMENTS_CONTRACT_SPEC §1
      }).success
    ).toBe(true);
    // Legacy alias: `fulfillment` stands in for orderType (incl. pickup).
    expect(
      createPaymentOrderSchema.safeParse({
        items: [{ id: "a", price: 199, quantity: 1 }],
        branchId: "b1",
        fulfillment: "pickup",
        orderId: "ord_2",
      }).success
    ).toBe(true);
    expect(
      verifyPaymentSchema.safeParse({
        orderId: "o",
        razorpayOrderId: "r",
        razorpayPaymentId: "p",
        razorpaySignature: "s",
      }).success
    ).toBe(true);
    // Legacy checkout-shim verify body (spec §2): paymentId/signature/method.
    expect(
      verifyPaymentSchema.safeParse({
        orderId: "r",
        paymentId: "p",
        signature: "s",
        method: "card",
      }).success
    ).toBe(true);
    expect(pushStockSchema.safeParse({ branchId: "b", itemId: "i", inStock: false }).success).toBe(
      true
    );
  });

  it("rejects createPaymentOrder without orderId and without any order-type", () => {
    const base = {
      items: [{ id: "a", price: 199, quantity: 1 }],
      branchId: "b1",
    };
    // No internal order id — no checkout (spec §1).
    expect(createPaymentOrderSchema.safeParse({ ...base, orderType: "delivery" }).success).toBe(false);
    // Neither orderType nor fulfillment alias.
    expect(createPaymentOrderSchema.safeParse({ ...base, orderId: "ord_3" }).success).toBe(false);
    // fulfillment + orderId together are valid.
    expect(
      createPaymentOrderSchema.safeParse({ ...base, fulfillment: "dine-in", orderId: "ord_4" })
        .success
    ).toBe(true);
  });

  it("rejects empty items, bad enums, and wrong types", () => {
    expect(
      createPaymentOrderSchema.safeParse({ items: [], branchId: "b", orderType: "delivery", orderId: "ord_5" })
        .success
    ).toBe(false);
    expect(
      createPaymentOrderSchema.safeParse({ items: [{ id: "a", price: 10, quantity: 1 }], branchId: "b", orderType: "drone", orderId: "ord_6" })
        .success
    ).toBe(false);
    // Unpriceable items never reach pricing (qty 0 → phantom +1, price "abc" → free).
    expect(
      createPaymentOrderSchema.safeParse({ items: [{ id: "a", price: 10, quantity: 0 }], branchId: "b", orderType: "delivery", orderId: "ord_7" })
        .success
    ).toBe(false);
    expect(
      createPaymentOrderSchema.safeParse({ items: [{ id: "a", price: "abc", quantity: 1 }], branchId: "b", orderType: "delivery", orderId: "ord_8" })
        .success
    ).toBe(false);
    expect(pushStockSchema.safeParse({ branchId: "b", itemId: "i", inStock: "yes" }).success).toBe(
      false
    );
    expect(verifyDeliveryOtpSchema.safeParse({ orderId: "o", otp: "12" }).success).toBe(false);
    expect(verifyDeliveryOtpSchema.safeParse({ orderId: "o", otp: "1234" }).success).toBe(true);
    // Legacy verify body missing paymentId/signature is still rejected.
    expect(verifyPaymentSchema.safeParse({ orderId: "r", method: "card" }).success).toBe(false);
  });

  it("rejects missing required fields on dispatch routes", () => {
    expect(pushOrderSchema.safeParse({}).success).toBe(false);
    expect(syncMenuSchema.safeParse({}).success).toBe(false);
    expect(porterBookSchema.safeParse({ staffName: "x" }).success).toBe(false);
    expect(porterCancelSchema.safeParse({}).success).toBe(false);
    expect(porterCancelSchema.safeParse({ orderId: "o" }).success).toBe(true);
    expect(
      manualDispatchSchema.safeParse({ orderId: "o", riderName: "r", riderPhone: "p" }).success
    ).toBe(true);
    expect(refundSchema.safeParse({ orderId: "o", razorpayPaymentId: "p" }).success).toBe(true);
    expect(
      refundSchema.safeParse({ orderId: "o", razorpayPaymentId: "p", amountRupees: -5 }).success
    ).toBe(false);
  });
});
