import { describe, expect, it } from "vitest";

import {
  assertCashOnDeliveryAllowed,
  defaultCashOnDeliveryConfig,
  resolveCashOnDeliveryConfig,
} from "../src/modules/payments/branchPricing";
import {
  assertCourierCodProviderReady,
  borzoMoneyString,
  codReadyQuotes,
  courierCashDuePaise,
  courierCodReady,
  resolveCourierCodReadiness,
} from "../src/modules/dispatch/providers/cashCollection";

const baseOrder = (extra: Record<string, any> = {}) => ({
  orderType: "delivery",
  branchId: "branch_a",
  paymentChannel: "cash",
  paymentMethod: "cod",
  payment: { method: "cod" },
  cashDuePaise: 12345,
  pricing: { grandTotal: 999 },
  ...extra,
});

describe("courier COD readiness (off until the owner confirms)", () => {
  it("is OFF by default for every provider and refuses delivery COD with a takeaway-only message", () => {
    const readiness = resolveCourierCodReadiness(undefined);
    expect(readiness.enabled).toBe(false);
    expect(courierCodReady(readiness, "borzo")).toBe(false);
    expect(courierCodReady(readiness, "shadowfax")).toBe(false);

    const config = { ...defaultCashOnDeliveryConfig(), courierCod: readiness };
    expect(() => assertCashOnDeliveryAllowed(config, 12345, "takeaway")).not.toThrow();
    expect(() => assertCashOnDeliveryAllowed(config, 12345, "delivery")).toThrowError(
      expect.objectContaining({
        code: "COURIER_COD_DISABLED",
        statusCode: 409,
      })
    );
    expect(() => assertCashOnDeliveryAllowed(config, 12345, "delivery")).toThrow(
      /takeaway only/i
    );
  });

  it("is per provider: a Borzo-only branch still refuses Shadowfax COD", () => {
    const readiness = resolveCourierCodReadiness({ enabled: true, providers: { borzo: true } });
    expect(courierCodReady(readiness, "borzo")).toBe(true);
    expect(courierCodReady(readiness, "shadowfax")).toBe(false);

    const order = baseOrder({ cashOnDelivery: { courierCod: readiness } });
    expect(() => assertCourierCodProviderReady(order, "borzo")).not.toThrow();
    // A typed not_serviced refusal is what lets the router walk to Borzo.
    expect(() => assertCourierCodProviderReady(order, "shadowfax")).toThrowError(
      expect.objectContaining({ provider: "shadowfax", kind: "not_serviced" })
    );

    const config = { ...defaultCashOnDeliveryConfig(), courierCod: readiness };
    expect(() => assertCashOnDeliveryAllowed(config, 12345, "delivery")).not.toThrow();
  });

  it("stops a booking when readiness was revoked after checkout", () => {
    const readyReadiness = resolveCourierCodReadiness({ enabled: true, providers: { borzo: true } });
    const order = baseOrder({ cashOnDelivery: { courierCod: readyReadiness } });
    expect(() => assertCourierCodProviderReady(order, "borzo", readyReadiness)).not.toThrow();
    // Snapshot still says yes, but the branch's current approval is OFF.
    expect(() =>
      assertCourierCodProviderReady(order, "borzo", resolveCourierCodReadiness(undefined))
    ).toThrowError(expect.objectContaining({ provider: "borzo", kind: "not_serviced" }));
  });

  it("filters Porter and unready quotes before ranking, fare confirm and booking", () => {
    const quotes = [
      { provider: "shadowfax", fare: 1 },
      { provider: "borzo", fare: 2 },
      { provider: "porter", fare: 0 },
    ];
    const borzoOnly = resolveCourierCodReadiness({ enabled: true, providers: { borzo: true } });
    expect(codReadyQuotes(quotes, borzoOnly).map((q) => q.provider)).toEqual(["borzo"]);
    // Revoked after checkout: no quote may be ranked, so no fare is confirmed.
    expect(codReadyQuotes(quotes, resolveCourierCodReadiness(undefined))).toEqual([]);
  });

  it("disables only delivery COD when the stored readiness is malformed", () => {
    const parsed = resolveCashOnDeliveryConfig(
      { enabled: true, maxOrderValuePaise: 500000, courierCod: { enabled: "yes" } },
      "branch_a"
    );
    // Prepaid pricing and takeaway cash keep working: no 503 is thrown.
    expect(parsed.enabled).toBe(true);
    expect(courierCodReady(parsed.courierCod, "borzo")).toBe(false);
    expect(() => assertCashOnDeliveryAllowed(parsed, 12345, "takeaway")).not.toThrow();
    expect(() => assertCashOnDeliveryAllowed(parsed, 12345)).not.toThrow();
    expect(() => assertCashOnDeliveryAllowed(parsed, 12345, "delivery")).toThrowError(
      expect.objectContaining({ code: "COURIER_COD_DISABLED", statusCode: 409 })
    );
  });

  it("fails closed on malformed readiness config instead of assuming a ready courier", () => {
    expect(() => resolveCourierCodReadiness({ enabled: "yes" })).toThrow(/courier/i);
    expect(() => resolveCourierCodReadiness({ enabled: true, providers: { porter: true } })).toThrow(
      /provider/i
    );
    const parsed = resolveCashOnDeliveryConfig(
      { enabled: true, courierCod: { enabled: true, providers: { shadowfax: true } } },
      "branch_a"
    );
    expect(parsed.courierCod?.enabled).toBe(true);
    expect(courierCodReady(parsed.courierCod, "shadowfax")).toBe(true);
  });
});

describe("server cash amount for courier collection", () => {
  it("uses the order's server cashDuePaise, never the displayed grand total", () => {
    expect(courierCashDuePaise(baseOrder())).toBe(12345);
    // A fully discounted COD order has a real zero due, not a missing one.
    expect(courierCashDuePaise(baseOrder({ cashDuePaise: 0 }))).toBe(0);
    expect(courierCashDuePaise(baseOrder({ paymentChannel: "razorpay", payment: { method: "upi" } }))).toBeNull();
    expect(() => courierCashDuePaise(baseOrder({ cashDuePaise: undefined }))).toThrow(/cashDuePaise/i);
    expect(() => courierCashDuePaise(baseOrder({ cashDuePaise: null }))).toThrow(/cashDuePaise/i);
    expect(() => courierCashDuePaise(baseOrder({ cashDuePaise: "" }))).toThrow(/cashDuePaise/i);
    expect(() => courierCashDuePaise(baseOrder({ cashDuePaise: "12345" }))).toThrow(/cashDuePaise/i);
    expect(() => courierCashDuePaise(baseOrder({ cashDuePaise: 1.5 }))).toThrow(/cashDuePaise/i);
  });

  it("formats Borzo money with integer rupees and a padded remainder", () => {
    expect(borzoMoneyString(12345)).toBe("123.45");
    expect(borzoMoneyString(5)).toBe("0.05");
    expect(borzoMoneyString(1)).toBe("0.01");
    expect(borzoMoneyString(0)).toBe("0.00");
    expect(borzoMoneyString(500000)).toBe("5000.00");
    expect(() => borzoMoneyString(1.5)).toThrow(/Invalid Borzo money/);
  });
});
