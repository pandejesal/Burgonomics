import { describe, expect, it } from "vitest";

import {
  defaultCashOnDeliveryConfig,
  effectiveCashOnDeliveryForCheckout,
} from "../src/modules/payments/branchPricing";

describe("checkout advertises the server's courier-COD decision", () => {
  it("disables delivery cash by default and returns the server's own reason", () => {
    const cashOnDelivery = effectiveCashOnDeliveryForCheckout(
      defaultCashOnDeliveryConfig(),
      "delivery"
    );
    expect(cashOnDelivery.enabled).toBe(false);
    expect(cashOnDelivery.maxOrderValuePaise).toBe(500_000);
    expect(cashOnDelivery.reason).toMatch(/takeaway only/i);
  });

  it("leaves takeaway cash enabled with no reason", () => {
    expect(effectiveCashOnDeliveryForCheckout(defaultCashOnDeliveryConfig(), "takeaway")).toEqual({
      enabled: true,
      maxOrderValuePaise: 500_000,
    });
  });

  it("enables delivery cash only when an explicit courier is ready", () => {
    const config = {
      ...defaultCashOnDeliveryConfig(),
      courierCod: { enabled: true, providers: { borzo: true, shadowfax: false } },
    };
    expect(effectiveCashOnDeliveryForCheckout(config, "delivery")).toEqual({
      enabled: true,
      maxOrderValuePaise: 500_000,
    });
  });
});
