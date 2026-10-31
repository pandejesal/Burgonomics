import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// PII-01 (SEC-02) — Firestore rules pin: franchise applicant PII is
// BRAND-level data only.
//
// `isBranchOwner()` contains `branch_staff` and carries NO branch scoping, so
// `isBrandOwner() || isBranchOwner()` let any cashier read every applicant's
// name, phone, email and investment budget. Read and update are brand-only;
// create is unchanged so applicants can still submit.
//
// NOTE (mirrors): this file is the canonical ROOT copy. The byte-identical
// customer/partner mirrors must be re-synced by the owner; behavioural coverage
// lives in the customer repo's emulator rules suite (this lane may not edit
// that repo or run firebase/gcloud).
const source = readFileSync(resolve(__dirname, "../../firestore.rules"), "utf8");

function block(matchPath: string): string {
  const start = source.indexOf(`match /${matchPath}/{leadId}`);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("match /", start + 10);
  return source.slice(start, end === -1 ? source.length : end);
}

describe("PII-01 franchise applicant PII is brand-only", () => {
  for (const collection of ["franchise_leads", "franchise_inquiries"]) {
    it(`${collection}: read and update are isBrandOwner() only`, () => {
      const rules = block(collection);
      expect(rules).toContain("allow read: if isBrandOwner();");
      expect(rules).toContain("allow update: if isBrandOwner();");
      // The leak arm must be gone, in either spelling.
      expect(rules).not.toContain("isBranchOwner()");
      expect(rules).not.toContain("isStaff()");
    });

    it(`${collection}: create is unchanged so applicants can still submit`, () => {
      const rules = block(collection);
      expect(rules).toContain("allow create: if isAuthenticated()");
      expect(rules).toContain("request.resource.data.customerId == request.auth.uid");
    });
  }

  it("isBranchOwner really does include branch_staff (the reason for this pin)", () => {
    const start = source.indexOf("function isBranchOwner()");
    const body = source.slice(start, source.indexOf("}", start));
    expect(body).toContain("branch_staff");
  });
});
