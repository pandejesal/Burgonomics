import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { mockDb } = vi.hoisted(() => {
  const mockDb = {
    collection: (col: string) => ({
      where: (field: string, op: string, val: any) => ({
        limit: (n: number) => ({
          get: async () => {
            if (col === "stores" && field === "petpoojaRestId" && val === "pp_store_b") {
              return { docs: [{ data: () => ({ partnerBranchId: "branch_b" }) }] };
            }
            if (col === "branches" && field === "petpoojaStoreId" && val === "pp_code_b") {
              return { docs: [{ id: "branch_b", data: () => ({ petpoojaStoreId: "pp_code_b" }) }] };
            }
            return { docs: [] };
          },
        }),
      }),
      doc: (id: string) => ({
        get: async () => {
          if (id === "branch_a" || id === "branch_b") {
            return { exists: true, id, data: () => ({}) };
          }
          return { exists: false, id, data: () => ({}) };
        },
      }),
    }),
  };
  return { mockDb };
});

vi.mock("firebase-admin", () => {
  const FieldValue = { serverTimestamp: () => "MOCK_TIMESTAMP" };
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

import {
  runPetpoojaTestScenario,
  resolvePetpoojaTestScenario,
  buildPetpoojaTestOrder,
  assertPetpoojaRelayAccess,
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

    it(`echoes ${scenarioId}'s client reference for support reconciliation`, async () => {
      // Support reconciliation key: the vendor's Order List displays OUR
      // clientOrderID in its Order No. column and exposes no POS id through
      // the API, so the replay must carry it back regardless of whether the
      // POS returned an id.
      const result = await runPetpoojaTestScenario({
        scenarioId,
        branchId: "branch_test_1",
      });
      expect(result.clientOrderID).toMatch(
        new RegExp(`^pp_test_${scenarioId}_\\d+$`)
      );
      expect(result.petpoojaOrderIdReturned).toBe(true);
      // The echo and the id are the same value in mock mode; in the live
      // sandbox the id is empty while the echo is real — the field must be
      // carried independently, not derived from petpoojaOrderId.
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

  describe("live relay — the client reference echo is independent of the POS id", () => {
    // §16.8 evidence class: Petpooja's live save_order answers
    // success:"1" with an EMPTY orderID while still registering the order
    // (Order List shows our clientOrderID as the Order No.). The echo must
    // survive exactly that response — deriving clientOrderID from
    // petpoojaOrderId (the one silent-reduction regression) would make every
    // real sandbox relay un-reconcilable and copy lists stay empty.
    let savedCreds: { appKey: string; appSecret: string; accessToken: string };
    const fetchMock = vi.fn();

    beforeEach(() => {
      config.mock.petpoojaPos = false; // live path — the POS POST is stubbed
      savedCreds = {
        appKey: config.petpooja.appKey,
        appSecret: config.petpooja.appSecret,
        accessToken: config.petpooja.accessToken,
      };
      config.petpooja.appKey = "test_app_key";
      config.petpooja.appSecret = "test_app_secret";
      config.petpooja.accessToken = "test_access_token";
      fetchMock.mockReset();
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            success: "1",
            message: "Your order is saved.",
            restID: "",
            clientOrderID: "",
            orderID: "",
            code: 200,
          }),
        json: async () => ({
          success: "1",
          message: "Your order is saved.",
          restID: "",
          clientOrderID: "",
          orderID: "",
          code: 200,
        }),
      });
      vi.stubGlobal("fetch", fetchMock);
    });

    afterEach(() => {
      config.mock.petpoojaPos = true;
      config.petpooja.appKey = savedCreds.appKey;
      config.petpooja.appSecret = savedCreds.appSecret;
      config.petpooja.accessToken = savedCreds.accessToken;
      vi.unstubAllGlobals();
    });

    it("accepted with no id: petpoojaOrderId stays null while clientOrderID carries our reference", async () => {
      const result = await runPetpoojaTestScenario({
        scenarioId: "dinein-basic-kot",
        branchId: "branch_test_1",
      });
      expect(result.success).toBe(true);
      expect(result.petpoojaOrderId).toBeNull();
      expect(result.petpoojaOrderIdReturned).toBe(false);
      expect(result.clientOrderID).toMatch(/^pp_test_dinein-basic-kot_\d+$/);
      // The reference echoed is exactly the one sent in the payload.
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const sentRef = body?.orderinfo?.OrderInfo?.Order?.details?.orderID;
      expect(typeof sentRef).toBe("string");
      expect(result.clientOrderID).toBe(sentRef);
    });
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

describe("Petpooja QA relay branch scope", () => {
  const branchOwnerA = { uid: "u1", role: "branch_owner", branchIds: ["branch_a"] };

  beforeEach(() => {
    config.mock.petpoojaPos = true;
  });

  it("allows the caller's own mapped branch", () => {
    expect(() => assertPetpoojaRelayAccess(branchOwnerA, "branch_a")).not.toThrow();
  });

  it("refuses another outlet's mapped branch", () => {
    expect(() => assertPetpoojaRelayAccess(branchOwnerA, "branch_b")).toThrow(
      /outside your assigned branches/
    );
    try {
      assertPetpoojaRelayAccess(branchOwnerA, "branch_b");
    } catch (err: any) {
      expect(err.statusCode).toBe(403);
    }
  });

  it("refuses an outlet that is not linked to any branch", () => {
    expect(() => assertPetpoojaRelayAccess(branchOwnerA, null)).toThrow(
      /not linked to a branch/
    );
  });

  it("allows a brand admin to relay to any mapped outlet", () => {
    expect(() =>
      assertPetpoojaRelayAccess({ uid: "u2", role: "brand_owner", branchIds: [] }, "branch_b")
    ).not.toThrow();
  });

  it("branch_staff of branch A cannot relay to branch B", () => {
    const staffA = {
      uid: "staff_1",
      email: "staff@brancha.com",
      role: "branch_staff",
      branchIds: ["branch_a"],
    };
    expect(() => assertPetpoojaRelayAccess(staffA, "branch_b")).toThrow(
      /outside your assigned branches/
    );
    expect(() => assertPetpoojaRelayAccess(staffA, "branch_a")).not.toThrow();
  });
});
