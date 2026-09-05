import { describe, it, expect } from "vitest";
import {
  createPaymentOrderSchema,
  verifyPaymentSchema,
  refundSchema,
  pushOrderSchema,
  syncMenuSchema,
  pushStockSchema,
  porterBookSchema,
  verifyDeliveryOtpSchema,
  manualDispatchSchema,
} from "../src/core/validation";

describe("route request validation", () => {
  it("accepts valid money-route bodies", () => {
    expect(
      createPaymentOrderSchema.safeParse({
        items: [{ id: "a" }],
        branchId: "b1",
        orderType: "delivery",
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
    expect(pushStockSchema.safeParse({ branchId: "b", itemId: "i", inStock: false }).success).toBe(
      true
    );
  });

  it("rejects empty items, bad enums, and wrong types", () => {
    expect(
      createPaymentOrderSchema.safeParse({ items: [], branchId: "b", orderType: "delivery" })
        .success
    ).toBe(false);
    expect(
      createPaymentOrderSchema.safeParse({ items: [{ id: "a" }], branchId: "b", orderType: "drone" })
        .success
    ).toBe(false);
    expect(pushStockSchema.safeParse({ branchId: "b", itemId: "i", inStock: "yes" }).success).toBe(
      false
    );
    expect(verifyDeliveryOtpSchema.safeParse({ orderId: "o", otp: "12" }).success).toBe(false);
    expect(verifyDeliveryOtpSchema.safeParse({ orderId: "o", otp: "1234" }).success).toBe(true);
  });

  it("rejects missing required fields on dispatch routes", () => {
    expect(pushOrderSchema.safeParse({}).success).toBe(false);
    expect(syncMenuSchema.safeParse({}).success).toBe(false);
    expect(porterBookSchema.safeParse({ staffName: "x" }).success).toBe(false);
    expect(
      manualDispatchSchema.safeParse({ orderId: "o", riderName: "r", riderPhone: "p" }).success
    ).toBe(true);
    expect(refundSchema.safeParse({ orderId: "o", razorpayPaymentId: "p" }).success).toBe(true);
    expect(
      refundSchema.safeParse({ orderId: "o", razorpayPaymentId: "p", amountRupees: -5 }).success
    ).toBe(false);
  });
});
