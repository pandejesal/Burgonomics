import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CASH-FLOWS: the checkout screen must not offer a cash lane the server will
 * refuse. `POST /checkout/fees` already resolves the branch's money config, so
 * it also returns the branch's COD switch + ceiling. Advisory only — the
 * create route re-reads and enforces the same branch document.
 */
const { docs, db } = vi.hoisted(() => {
  const docs: Record<string, any> = {};
  const db: any = {
    collection: (name: string) => ({
      doc: (id: string) => ({
        id,
        path: `${name}/${id}`,
        get: async () => ({ exists: Object.hasOwn(docs, `${name}/${id}`), data: () => docs[`${name}/${id}`] }),
      }),
    }),
  };
  return { docs, db };
});

vi.mock("../src/core/firebase", () => ({ db }));
vi.mock("firebase-admin", () => ({
  firestore: { FieldValue: { serverTimestamp: () => "ts" } },
  default: { firestore: { FieldValue: { serverTimestamp: () => "ts" } } },
}));

import { resolveCheckoutFees } from "../src/modules/payments/checkoutFees";
import { clearBranchPricingCache } from "../src/modules/payments/branchPricing";

const ask = (branchId = "branch_a") =>
  resolveCheckoutFees({ branchId, orderType: "takeaway", customerId: "customer_a" });

beforeEach(() => {
  for (const key of Object.keys(docs)) delete docs[key];
  clearBranchPricingCache();
  docs["branches/branch_a"] = { name: "Surat Adajan", packagingFee: 15 };
});

describe("checkout fees carry the branch's cash-on-delivery config", () => {
  it("defaults to COD on with the documented ceiling when the branch is silent", async () => {
    await expect(ask()).resolves.toMatchObject({
      serviceable: true,
      packagingFee: 15,
      cashOnDelivery: { enabled: true, maxOrderValuePaise: 500000 },
    });
  });

  it("reports a branch that has switched COD off", async () => {
    docs["branches/branch_a"] = {
      name: "Surat Adajan",
      packagingFee: 15,
      cashOnDelivery: { enabled: false },
    };
    clearBranchPricingCache();
    await expect(ask()).resolves.toMatchObject({
      cashOnDelivery: { enabled: false, maxOrderValuePaise: 500000 },
    });
  });

  it("reports a branch's own ceiling", async () => {
    docs["branches/branch_a"] = {
      name: "Surat Adajan",
      packagingFee: 15,
      cashOnDelivery: { enabled: true, maxOrderValuePaise: 25000 },
    };
    clearBranchPricingCache();
    await expect(ask()).resolves.toMatchObject({
      cashOnDelivery: { enabled: true, maxOrderValuePaise: 25000 },
    });
  });

  it("fails closed when the stored switch is malformed", async () => {
    docs["branches/branch_a"] = {
      name: "Surat Adajan",
      packagingFee: 15,
      cashOnDelivery: { enabled: "no" },
    };
    clearBranchPricingCache();
    await expect(ask()).rejects.toMatchObject({ statusCode: 503 });
  });
});
