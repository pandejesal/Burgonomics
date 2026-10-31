import { describe, it, expect } from "vitest";
import fixture from "./fixtures/e2e-isolated-test-records.json";

/**
 * Contract guard for the E2E isolated-record fixture.
 *
 * This fixture is the artifact handed to whoever writes the E2E runner, and it
 * was already wrong once: products were keyed by `branchId` when the customer
 * menu keys them by `restId` (menuService.ts:213, via
 * stores/{id}.petpoojaRestId at :191-196), and the branch doc was missing the
 * fields pricing fail-closes on (pricing.engine.ts:206-230). Both mistakes
 * produce a run that LOOKS healthy and proves nothing - an empty menu, or a 503
 * before any gateway order exists.
 *
 * The fixture is a JSON document, so nothing in the type system defends it.
 * These assertions do, and they also pin the safety property that matters most:
 * no id-valued field may point at the real demo outlet, because a clone that
 * keeps a real restId appears in a real outlet's live customer menu.
 */
describe("E2E isolated test-record fixture (contract + safety)", () => {
  const store = fixture.store.doc;
  const branch = fixture.branch.doc;
  const product = fixture.products.example;

  it("keys products by the store's restId, which is the only field the menu reads", () => {
    expect(store.petpoojaRestId).toBe(fixture.restIdIsTheMenuKey.testRestId);
    expect(product.restId).toBe(store.petpoojaRestId);
    // The exact shape of the original mistake: a branch-keyed product is
    // invisible to the menu, so checkout would pass with nothing in the cart.
    expect(product).not.toHaveProperty("branchId");
  });

  it("links store to branch through partnerBranchId, the value the order carries", () => {
    // ordersService.ts:465 - the ORDER's branchId is stores/{id}.partnerBranchId,
    // so this one equality is what makes the store doc and the branch doc the
    // same outlet to pricing and to the KDS.
    expect(store.partnerBranchId).toBe(branch.id);
  });

  it("gives the branch the fields pricing fail-closes without", () => {
    const rp = branch.royaltyPercentage;
    expect(typeof rp).toBe("number");
    expect(Number.isFinite(rp)).toBe(true);
    expect(rp).toBeGreaterThanOrEqual(0);
    expect(rp).toBeLessThanOrEqual(100);
    expect(typeof branch.packagingFee).toBe("number");
    expect(Number.isFinite(branch.packagingFee)).toBe(true);
  });

  it("gives the store finite coordinates and explicit fulfillment modes", () => {
    // storesService.ts:94 drops a store without finite coords; :60-64 grants a
    // fulfillment mode only when the doc says so.
    expect(Number.isFinite(store.lat)).toBe(true);
    expect(Number.isFinite(store.lng)).toBe(true);
    for (const mode of ["delivery", "takeaway", "dineIn"]) {
      expect(typeof (store.supports as Record<string, unknown>)[mode]).toBe("boolean");
    }
  });

  it("authors availability explicitly instead of inheriting a vendor in_stock value", () => {
    expect(product.inStock).toBe(true);
    expect(typeof product.price).toBe("number");
    expect(product.price).toBeGreaterThan(0);
  });

  it("cannot reach a vendor or a real payout account", () => {
    expect(branch.petpoojaStoreId).toBeNull();
    expect(branch.razorpayAccountId).toBeNull();
  });

  it("keeps every id-valued field off the real outlet", () => {
    const realOutlet = "31z58ciw0h";
    const idValued = [
      store.id,
      store.petpoojaRestId,
      store.partnerBranchId,
      branch.id,
      product.id,
      product.restId,
      product.categoryId,
    ];
    for (const id of idValued) {
      expect(String(id)).not.toContain(realOutlet);
    }
  });

  it("covers every id it generates with an exact cleanup prefix", () => {
    const prefixes = fixture.cleanup.matchPrefixes as string[];
    const generated = [store.id, branch.id, product.id, product.restId, product.categoryId];
    for (const id of generated) {
      expect(prefixes.some((p) => id.startsWith(p))).toBe(true);
    }
    // Cleanup must never be a broad delete.
    expect(fixture.cleanup.never.join(" ")).toMatch(/unscoped/);
  });
});
