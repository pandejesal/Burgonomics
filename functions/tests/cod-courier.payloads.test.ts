import { describe, expect, it } from "vitest";

import { buildBorzoBookingPayload } from "../src/modules/dispatch/providers/borzo.adapter";
import {
  buildShadowfaxOrderDetails,
  buildShadowfaxServiceabilityPayload,
} from "../src/modules/dispatch/providers/shadowfax.adapter";

const ready = { enabled: true, providers: { borzo: true, shadowfax: true } };

const order = (cash: boolean) => ({
  orderType: "delivery",
  branchId: "branch_a",
  branchName: "Burgonomics Surat",
  branchAddress: "Adajan",
  branchCity: "Surat",
  branchState: "Gujarat",
  branchPincode: "395009",
  store: { name: "Burgonomics Surat", phone: "02612222222", city: "Surat" },
  customerPhone: "9999988888",
  deliveryAddress: { full: "12 Test Street", city: "Surat", contactPhone: "9999988888" },
  paymentChannel: cash ? "cash" : "razorpay",
  paymentMethod: cash ? "cod" : "upi",
  payment: { method: cash ? "cod" : "upi", status: cash ? "pending" : "completed" },
  paymentStatus: cash ? "pending" : "completed",
  cashDuePaise: cash ? 12345 : 0,
  pricing: { grandTotal: 999 },
  cashOnDelivery: { courierCod: ready },
  items: [],
});

const ctx = (cash: boolean): any => ({
  orderId: "order_cod_1",
  order: order(cash),
  customerName: "Asha",
  customerPhone: "9999988888",
  pickup: { lat: 21.18, lng: 72.81 },
  drop: { lat: 21.19, lng: 72.82 },
});

// The wire body is what the vendor sees; assert the SERIALIZED POST, not just
// an in-memory builder result.
const posted = (cash: boolean) => JSON.parse(JSON.stringify(buildBorzoBookingPayload(ctx(cash))));

describe("Borzo COD fields sit on the customer drop point", () => {
  it("posts taking_amount and is_cod_cash_voucher_required on the drop point for COD", () => {
    const payload = posted(true);
    expect(payload.points).toHaveLength(2);
    expect(payload.points[0]).not.toHaveProperty("taking_amount");
    expect(payload.points[0]).not.toHaveProperty("is_cod_cash_voucher_required");
    expect(payload.points[1]).toMatchObject({
      taking_amount: "123.45",
      is_cod_cash_voucher_required: true,
    });
    // Not at the top level, and not the old non-COD switch.
    expect(payload).not.toHaveProperty("taking_amount");
    expect(payload).not.toHaveProperty("is_order_payment_here");
    expect(payload.points[1]).not.toHaveProperty("is_order_payment_here");
  });

  it("posts no COD keys anywhere for a prepaid order", () => {
    const payload = posted(false);
    for (const point of payload.points) {
      expect(point).not.toHaveProperty("taking_amount");
      expect(point).not.toHaveProperty("is_cod_cash_voucher_required");
      expect(point).not.toHaveProperty("is_order_payment_here");
    }
  });
});

describe("Shadowfax booking uses the documented paid/order_value pair", () => {
  it("sends paid false and the server cash due as order_value for COD", () => {
    const serviceability = buildShadowfaxServiceabilityPayload(ctx(true));
    const details = buildShadowfaxOrderDetails(ctx(true));
    expect(serviceability.paid).toBe("false");
    expect(serviceability.order_value).toBe(123.45);
    expect(details).toMatchObject({ paid: "false", order_value: 123.45, client_order_id: "order_cod_1" });
    expect(details).not.toHaveProperty("cod_amount");
    expect(details.order_value).not.toBe(999);
  });

  it("keeps prepaid semantics: paid true and the priced order value", () => {
    expect(buildShadowfaxServiceabilityPayload(ctx(false))).toMatchObject({
      paid: "true",
      order_value: 999,
    });
    expect(buildShadowfaxOrderDetails(ctx(false))).toMatchObject({
      paid: "true",
      order_value: 999,
    });
  });
});
