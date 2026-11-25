import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// SEC-06 — Firestore rules pin: branches/* is readable by operator roles only,
// never by an arbitrary signed-in customer.
//
// SEC-11 (A3 finding 1) keeps that read grant but removes what made it
// dangerous: the POS/payment identifiers now live in `branch_secrets/{id}`,
// which only the brand roles can read. This file pins BOTH halves so a later
// edit cannot quietly put a secret back on the branch document.
const source = readFileSync(resolve(__dirname, "../../firestore.rules"), "utf8");

function branchBlock(): string {
  const start = source.indexOf("match /branches/{branchId}");
  expect(start).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf("match /branch_secrets/", start));
}

describe("SEC-06 branches read: operator roles only", () => {
  it("requires isStaff() (not any signed-in customer)", () => {
    const block = branchBlock();
    expect(block).toContain("allow read: if isStaff();");
    expect(block).not.toContain("allow read: if isAuthenticated();");
  });
});

describe("SEC-11 the identifiers are not on the branch document", () => {
  it("refuses petpooja / petpoojaStoreId / restIDs / razorpayAccountId on a branch write", () => {
    const block = branchBlock();
    for (const key of ["'petpooja'", "'petpoojaStoreId'", "'restIDs'", "'razorpayAccountId'"]) {
      expect(block).toContain(key);
    }
  });

  it("has a brand-only branch_secrets collection", () => {
    const start = source.indexOf("match /branch_secrets/{branchId}");
    expect(start).toBeGreaterThan(-1);
    const block = source.slice(start, start + 200);
    expect(block).toContain("allow read, write: if isBrandOwner();");
  });

  it("never grants branch_secrets to isStaff()/any staff helper", () => {
    const start = source.indexOf("match /branch_secrets/{branchId}");
    const block = source.slice(start, source.indexOf("}", start));
    expect(block).not.toContain("isStaff()");
    expect(block).not.toContain("ownsBranch");
    expect(block).not.toContain("isBranchOwner()");
  });
});
