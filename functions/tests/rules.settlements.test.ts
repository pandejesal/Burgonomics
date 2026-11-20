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

describe("settlement rules pins", () => {
  it("branch_settlements: server-write-only, brand reads all, a branch owner only its own", () => {
    const block = matchBlock("branch_settlements/{docId}");
    expect(block).toContain(
      "allow read: if isBrandOwner() || ownsBranch(resource.data.branchId);"
    );
    expect(block).toContain("allow write: if false;");
    // No client create/update arm may sneak in (immutability is structural).
    expect(block).not.toMatch(/allow (create|update|delete)/);
  });

  it("settlement_versions: brand read only, never client-writable", () => {
    const block = matchBlock("settlement_versions/{docId}");
    expect(block).toContain("allow read: if isBrandOwner();");
    expect(block).toContain("allow write: if false;");
  });
});
