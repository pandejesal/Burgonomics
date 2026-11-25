import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Rules pins for the settlement collections (owner decision 2026-11-20).
 *
 * Textual, like the sibling rules suites: this lane may not edit the customer /
 * partner mirror files or run firebase/gcloud, so the behavioural cases are
 * noted for the customer repo's emulator suite.
 */
const source = readFileSync(resolve(__dirname, "../../firestore.rules"), "utf8");

function matchBlock(path: string): string {
  const start = source.indexOf(`match /${path}`);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("match /", start + 10);
  return source.slice(start, end === -1 ? source.length : end);
}

function fnBody(name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("\n    }", start);
  return source.slice(start, end === -1 ? start + 800 : end);
}

describe("settlement rules pins", () => {
  it("branch_settlements: server-write-only, brand-only read (a branch owner uses the projected API view)", () => {
    const block = matchBlock("branch_settlements/{docId}");
    // The raw statement carries the brand operator's e-mail and internal control
    // notes; a franchisee reads the projected API view instead, so the document
    // itself is brand-only and the projection cannot be bypassed. RULES-NOTES §9
    // records the change and the owner-facing consequence.
    expect(block).toContain("allow read: if isBrandOwner();");
    expect(block).not.toContain("ownsBranchAsOwner(resource.data.branchId)");
    expect(block).toContain("allow write: if false;");
    // No client create/update arm may sneak in (immutability is structural).
    expect(block).not.toMatch(/allow (create|update|delete)/);
  });

  it("A1: ownsBranchAsOwner requires branch_owner, and the staff arm never sees owner statements", () => {
    const strict = fnBody("ownsBranchAsOwner");
    expect(strict).toContain("hasRole(['branch_owner'])");
    expect(strict).not.toContain("branch_staff");
    const loose = fnBody("ownsBranch");
    expect(loose).toContain("isBranchOwner()");
  });

  it("A1: settlementFee is protected beside monthlyFee in the branch write mask", () => {
    const branches = matchBlock("branches/{branchId}");
    const branchArm = branches.slice(branches.indexOf("ownsBranch(branchId)"));
    for (const key of ["monthlyFee", "settlementFee"]) {
      expect(branchArm).toContain(`'${key}'`);
    }
  });

  it("M7/A1: the authoritative capture stamp is a server-owned order field", () => {
    const create = fnBody("orderCreateForbiddenKeys");
    const update = fnBody("orderServerOwnedKeys");
    for (const key of ["settlementEffectiveAtMs", "settlementCaptureUnresolved", "settlementProcessedRefunds"]) {
      expect(update).toContain(`'${key}'`);
      expect(create).toContain(`'${key}'`);
    }
  });

  it("settlement_versions: brand read only, never client-writable", () => {
    const block = matchBlock("settlement_versions/{docId}");
    expect(block).toContain("allow read: if isBrandOwner();");
    expect(block).toContain("allow write: if false;");
  });

  it("cycle 11: a correction job document is server-only like the interlock", () => {
    const block = matchBlock("settlement_corrections/{docId}");
    expect(block).toContain("allow read, write: if false;");
  });
});
