import { describe, it, expect } from "vitest";
import "./wire.env.setup";
import { borzoAdapter } from "../src/modules/dispatch/providers/borzo.adapter";
import { config } from "../src/config/env";
import type { DispatchQuoteContext } from "../src/modules/dispatch/types";

/**
 * LIVE wire probes — not part of the hermetic suite (skipped unless requested).
 * Exercise the exact production adapter paths against the Borzo TEST env:
 *   quote: POST /calculate-order  (read-only)
 *   book:  POST /create-order     (creates a real TEST-env order)
 *
 * Run quote:  $env:WIRE_BORZO="1";       npx vitest run tests/dispatch.wire.test.ts
 * Run book:   $env:WIRE_BORZO="1"; $env:WIRE_BORZO_BOOK="1"; npx vitest run tests/dispatch.wire.test.ts
 */
function wireCtx(): DispatchQuoteContext {
  return {
    pickup: { lat: 23.0131, lng: 72.5085 },
    drop: { lat: 23.0338, lng: 72.5262 },
    customerName: "Aarav Shah",
    customerPhone: "+91 99999 88888",
    orderId: `WIRE-${Date.now()}`,
    order: {
      branchName: "Burgonomics CG Road",
      branchAddress: "Ground Floor, CG Road",
      branchCity: "Ahmedabad",
      branchState: "Gujarat",
      branchPincode: "380009",
      branchPhone: "+91 99999 88888",
      deliveryAddress: {
        full: "102, Shivalik Highstreet, Vastrapur",
        city: "Ahmedabad",
        pincode: "380015",
      },
      customerName: "Aarav Shah",
      customerPhone: "+91 99999 88888",
    },
  };
}

function wireGuards(): void {
  expect(
    config.borzo.baseUrl,
    "refusing to probe a non-test Borzo base",
  ).toContain("robotapitest");
  expect(config.borzo.apiKey, "BORZO_API_KEY empty").toBeTruthy();
  expect(
    config.mock.borzoDispatch,
    "mock flag would fake the probe",
  ).toBeFalsy();
}

describe.runIf(process.env.WIRE_BORZO === "1")("borzo wire probe (test env)", () => {
  it(
    "quotes a live fare via calculate-order",
    { timeout: 30000 },
    async () => {
      wireGuards();

      const quote = await borzoAdapter.quote(wireCtx());

      console.log("[wire] borzo quote:", JSON.stringify(quote));
      expect(quote.outcome).toBe("ok");
      expect(quote.provider).toBe("borzo");
      expect(quote.fare).toBeGreaterThan(0);
      expect(quote.source).toBe("borzo_api_live");
    },
  );

  it.runIf(process.env.WIRE_BORZO_BOOK === "1")(
    "books a live TEST-env order via create-order",
    { timeout: 30000 },
    async () => {
      wireGuards();

      const ctx = wireCtx();
      const quote = await borzoAdapter.quote(ctx);
      expect(quote.outcome).toBe("ok");

      const booked = await borzoAdapter.book({ ...ctx, quote });

      console.log("[wire] borzo book:", JSON.stringify(booked));
      expect(booked.kind).toBe("booked");
      if (booked.kind === "booked") {
        expect(booked.provider).toBe("borzo");
        expect(booked.providerOrderId).toBeTruthy();
        expect(booked.source).toBe("borzo_api_live");
      }
    },
  );
});
