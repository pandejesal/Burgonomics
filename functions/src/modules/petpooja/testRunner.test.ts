import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  runPetpoojaTestScenario,
  resolvePetpoojaTestScenario,
  buildPetpoojaTestOrder,
  PETPOOJA_TEST_SCENARIOS,
} from "./testRunner";
import { config } from "../../config/env";
import { petpoojaTestRunnerSchema } from "../../core/validation";

/** Canonical ids (MT-01) and their legacy Petpooja-column aliases. */
const CANONICAL_SCENARIOS = [
  "dinein-basic-kot",
  "takeaway-with-modifiers",
  "delivery-gst-fee",
  "cancel-refund-sync",
  "bulk-party-order",
] as const;

const ALIASES: Record<string, string> = {
  items_tax: "dinein-basic-kot",
  addons: "takeaway-with-modifiers",
  variations: "delivery-gst-fee",
  discounts: "cancel-refund-sync",
  addon_variation: "bulk-party-order",
};

describe("runPetpoojaTestScenario (MT-01 sandbox relay)", () => {
  const originalMockFlag = config.mock.petpoojaPos;

  beforeEach(() => {
    // Sandbox determinism: a unit test must never reach the live POS, even on
    // a developer box with real PETPOOJA_* credentials exported.
    config.mock.petpoojaPos = true;
  });

  afterEach(() => {
    config.mock.petpoojaPos = originalMockFlag;
  });

  it("exposes exactly the 5 MT-01 scenarios", () => {
    expect(PETPOOJA_TEST_SCENARIOS.map((s) => s.id)).toEqual([
      ...CANONICAL_SCENARIOS,
    ]);
  });

  for (const scenarioId of CANONICAL_SCENARIOS) {
    it(`runs ${scenarioId} with success, matching scenarioId and order id`, async () => {
      const result = await runPetpoojaTestScenario({
        scenarioId,
        branchId: "branch_test_1",
      });

      expect(result.success).toBe(true);
      expect(result.scenarioId).toBe(scenarioId);
      expect(typeof result.petpoojaOrderId).toBe("string");
      expect(result.petpoojaOrderId.length).toBeGreaterThan(0);
      expect(result.petpoojaOrderId).toMatch(/^pp_test_/);
    });
  }

  for (const [alias, canonical] of Object.entries(ALIASES)) {
    it(`resolves alias "${alias}" to ${canonical} and echoes the caller's scenarioId`, async () => {
      const result = await runPetpoojaTestScenario({ scenarioId: alias });

      expect(result.success).toBe(true);
      expect(result.scenarioId).toBe(alias);
      expect(result.petpoojaOrderId.length).toBeGreaterThan(0);
      expect(resolvePetpoojaTestScenario(alias)?.id).toBe(canonical);
    });
  }

  it("rejects an unknown scenario instead of minting a fake pass", async () => {
    await expect(
      runPetpoojaTestScenario({ scenarioId: "definitely-not-a-scenario" })
    ).rejects.toThrow(/Unknown Petpooja test scenario/);
  });

  it("works without a branchId (relay-less sandbox path)", async () => {
    const result = await runPetpoojaTestScenario({ scenarioId: "dinein-basic-kot" });
    expect(result.success).toBe(true);
    expect(result.petpoojaOrderId.length).toBeGreaterThan(0);
  });

  describe("scenario order shapes", () => {
    it("dine-in basic KOT: table T-01 with burger + fries", () => {
      const order = buildPetpoojaTestOrder("dinein-basic-kot");
      expect(order.orderType).toBe("dinein");
      expect(order.tableNumber).toBe("T-01");
      expect(order.items).toHaveLength(2);
      expect(order.pricing.deliveryFee).toBe(0);
      expect(order.pricing.grandTotal).toBeGreaterThan(0);
    });

    it("takeaway with modifiers: extra cheese + brioche bun priced in", () => {
      const order = buildPetpoojaTestOrder("takeaway-with-modifiers");
      expect(order.orderType).toBe("takeaway");
      const modifiers = order.items[0].modifiers || [];
      expect(modifiers.map((m) => m.name)).toEqual(
        expect.arrayContaining(["Extra Cheese", "Brioche Bun Upgrade"])
      );
      // 310 base + 30 extra cheese + 40 brioche = 380, + 20 packaging + 5% GST.
      expect(order.pricing.itemTotal).toBe(380);
      expect(order.pricing.gst).toBe(19);
      expect(order.pricing.grandTotal).toBe(419);
    });

    it("delivery: 5% GST and delivery fee math", () => {
      const order = buildPetpoojaTestOrder("delivery-gst-fee");
      const { itemTotal, gst, deliveryFee, grandTotal } = order.pricing;
      expect(itemTotal).toBe(540); // 270 x 2
      expect(gst).toBe(27); // 5% of 540
      expect(deliveryFee).toBe(49);
      expect(grandTotal).toBe(616); // 540 + 27 + 49
    });

    it("cancel/refund: discount is applied before GST", () => {
      const order = buildPetpoojaTestOrder("cancel-refund-sync");
      const { itemTotal, discount, gst, grandTotal } = order.pricing;
      expect(itemTotal).toBe(290);
      expect(discount).toBe(50);
      expect(gst).toBe(12); // 5% of (290 - 50)
      expect(grandTotal).toBe(252); // 240 + 12
    });

    it("bulk party order: 12 lines for POS load", () => {
      const order = buildPetpoojaTestOrder("bulk-party-order");
      expect(order.items.length).toBeGreaterThanOrEqual(10);
      expect(order.pricing.grandTotal).toBeGreaterThan(0);
    });
  });

  it("petpoojaTestRunnerSchema accepts the relay body and rejects an empty one", () => {
    expect(
      petpoojaTestRunnerSchema.safeParse({ scenarioId: "dinein-basic-kot" }).success
    ).toBe(true);
    expect(
      petpoojaTestRunnerSchema.safeParse({
        scenarioId: "dinein-basic-kot",
        branchId: "branch_test_1",
      }).success
    ).toBe(true);
    expect(petpoojaTestRunnerSchema.safeParse({}).success).toBe(false);
    expect(petpoojaTestRunnerSchema.safeParse({ scenarioId: "" }).success).toBe(false);
  });
});
