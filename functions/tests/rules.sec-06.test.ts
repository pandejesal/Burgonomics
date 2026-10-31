import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// SEC-06 — Firestore rules pin: branches/* (restIDs, razorpayAccountId) is
// readable by operator roles only, never by an arbitrary signed-in customer.
//
// The customer app never reads branches/* (grep: only stores/*), so the only
// readers are partner hooks whose callers all hold a staff role. Behavioural
// coverage lives in the customer-repo emulator suite once the mirrors are
// re-synced from this canonical root file (this lane may not edit that repo or
// run firebase/gcloud).
const source = readFileSync(resolve(__dirname, "../../firestore.rules"), "utf8");

describe("SEC-06 branches read: operator roles only", () => {
  it("requires isStaff() (not any signed-in customer)", () => {
    const start = source.indexOf("match /branches/{branchId}");
    expect(start).toBeGreaterThan(-1);
    const block = source.slice(start, source.indexOf("match /products/", start));
    expect(block).toContain("allow read: if isStaff();");
    expect(block).not.toContain("allow read: if isAuthenticated();");
  });
});
