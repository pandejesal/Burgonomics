import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * F9 (owner decision 2026-11-01) — rules pins for the monthly fee, the
 * server-owned payment markers, and catalog pricing data.
 *
 * Tests 19-21 and 22i. Textual pins like the other rules suites: this lane may
 * not edit the customer/partner mirrors or run firebase/gcloud, so the
 * behavioural cases below are noted for the customer repo's emulator suite.
 */
const source = readFileSync(resolve(__dirname, "../../firestore.rules"), "utf8");

function fnBody(name: string): string {
  const start = source.indexOf(`function ${name}()`);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("\n    }", start);
  return source.slice(start, end === -1 ? start + 800 : end);
}

function matchBlock(path: string): string {
  const start = source.indexOf(`match /${path}`);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("match /", start + 10);
  return source.slice(start, end === -1 ? source.length : end);
}

describe("F9 rules pins", () => {
  it("19: a branch owner cannot move monthlyFee or packaging; brand owner can", () => {
    const branches = matchBlock("branches/{branchId}");
    expect(branches).toMatch(/isBrandOwner\(\)\s*\|\|/);
    for (const key of [
      "monthlyFee",
      "packaging",
      "packagingFee",
      "royaltyPercentage",
      "brandRoyaltyPercent",
    ]) {
      expect(branches).toContain(`'${key}'`);
    }
    // The branch arm is the denied-key arm; the brand arm is unrestricted.
    const branchArm = branches.slice(branches.indexOf("ownsBranch(branchId)"));
    for (const key of ["monthlyFee", "packagingFee", "packaging"]) {
      expect(branchArm).toContain(`'${key}'`);
    }
    // An unrelated field is still writable by the branch (not denied).
    expect(branchArm).not.toContain("'name'");
  });

  it("20: clients can never write the payment markers on an order", () => {
    const create = fnBody("orderCreateForbiddenKeys");
    const update = fnBody("orderServerOwnedKeys");
    for (const key of [
      "paymentChannel",
      "monthlyFeeHold",
      "routeTransferNeedsManualSettlement",
      "routeTransferRetryCount",
      "routeTransferClaimedAt",
    ]) {
      expect(create).toContain(`'${key}'`);
      expect(update).toContain(`'${key}'`);
    }
    // 22i: refund accounting is protected at CREATE too (a later refund claim
    // trusts it).
    for (const key of [
      "refundLedger",
      "refundedTotalPaise",
      "refundOverCapturedPaise",
      "refundNeedsReview",
    ]) {
      expect(create).toContain(`'${key}'`);
    }
  });

  it("21: branch_monthly_fees is server-write-only and tenant-scoped for reads", () => {
    const block = matchBlock("branch_monthly_fees/{docId}");
    expect(block).toContain(
      "allow read: if isBrandOwner() || ownsBranch(resource.data.branchId);"
    );
    expect(block).toContain("allow write: if false;");
  });

  it("22i: priced catalog data is protected for branch staff; the 86 toggle is not", () => {
    const products = matchBlock("products/{productId}");
    const createArm = products.slice(products.indexOf("allow create"), products.indexOf("allow update"));
    const updateArm = products.slice(products.indexOf("allow update"), products.indexOf("allow delete"));
    for (const key of ["customizations", "packingCharge", "priceAvailable"]) {
      expect(createArm).toContain(`'${key}'`);
      expect(updateArm).toContain(`'${key}'`);
    }
    // Stock toggling (the partner's only product write) stays allowed.
    expect(updateArm).not.toContain("'inStock'");
    expect(createArm).not.toContain("'inStock'");
  });
});
