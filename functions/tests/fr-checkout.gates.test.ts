import { describe, expect, it, vi } from "vitest";

/**
 * fr-checkout A2/A4: a client-writable cash label never admits a kitchen order,
 * and the close gate rejects a storefront/branch mismatch and a closed outlet.
 */
const h = vi.hoisted(() => {
  process.env.BURGONOMICS_ENV = "dev";
  const docs = new Map<string, any>();
  const ref = (collection: string, id: string) => ({
    id,
    path: `${collection}/${id}`,
    get: async () => ({ exists: docs.has(`${collection}/${id}`), data: () => docs.get(`${collection}/${id}`) }),
  });
  const db: any = { collection: (name: string) => ({ doc: (id: string) => ref(name, id) }) };
  return { docs, db };
});

vi.mock("../src/core/firebase", () => ({ db: h.db }));
vi.mock("firebase-admin", () => {
  const firestore: any = vi.fn(() => h.db);
  firestore.FieldValue = { serverTimestamp: () => "TS", delete: () => "DEL" };
  return {
    default: { firestore: vi.fn(() => h.db), auth: vi.fn(() => ({})), initializeApp: vi.fn(), apps: [{ name: "mock" }] },
    firestore,
    auth: vi.fn(() => ({})),
    initializeApp: vi.fn(),
    apps: [{ name: "mock" }],
  };
});

import {
  assertKitchenAdmissionPaid,
  hasServerCashChannel,
  requiresServerCaptureForKitchen,
} from "../src/modules/orders/paymentGate";
import { assertStorefrontOpenAndMatching, resolveCanonicalStorefront } from "../src/modules/payments/outletStatus";

describe("A2 kitchen admission uses the server cash marker", () => {
  it("refuses a client-writable cod label", () => {
    const fake = { payment: { method: "cod" }, paymentMethod: "cod" };
    expect(hasServerCashChannel(fake)).toBe(false);
    expect(requiresServerCaptureForKitchen(fake)).toBe(true);
    expect(() => assertKitchenAdmissionPaid(fake)).toThrow();
  });

  it("admits a real server-marked cash order", () => {
    const real = { payment: { method: "cod" }, paymentMethod: "cod", paymentChannel: "cash" };
    expect(hasServerCashChannel(real)).toBe(true);
    expect(requiresServerCaptureForKitchen(real)).toBe(false);
    expect(() => assertKitchenAdmissionPaid(real)).not.toThrow();
  });

  it("still admits authorised counter orders", () => {
    const walkin = { customerId: "cust_walkin", payment: { method: "upi" } };
    expect(requiresServerCaptureForKitchen(walkin)).toBe(false);
  });
});

describe("A4 canonical storefront gate", () => {
  it("rejects a closed storefront and a store/branch mismatch", () => {
    expect(() =>
      assertStorefrontOpenAndMatching({ isOpen: false, partnerBranchId: "b1" }, "s1", "b1")
    ).toThrow();
    expect(() =>
      assertStorefrontOpenAndMatching({ isOpen: true, partnerBranchId: "b2" }, "s1", "b1")
    ).toThrow();
    expect(() =>
      assertStorefrontOpenAndMatching({ isOpen: true, partnerBranchId: "b1" }, "s1", "b1")
    ).not.toThrow();
  });

  it("resolves the explicit storefront and rejects a branch mismatch", async () => {
    h.docs.clear();
    h.docs.set("stores/s1", { isOpen: true, partnerBranchId: "b1" });
    const resolved = await resolveCanonicalStorefront({ storeId: "s1", branchId: "b1" });
    expect(resolved?.storeId).toBe("s1");
    await expect(resolveCanonicalStorefront({ storeId: "s1", branchId: "b2" })).rejects.toMatchObject({
      code: "STOREFRONT_BRANCH_MISMATCH",
    });
  });
});
