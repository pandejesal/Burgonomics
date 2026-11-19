import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// SEC-04 — Firestore rules pin: branch staff may not write an order's status
// directly (POST /orders/bumpStatus owns the branch check + audit).
//
// The behavioural rules suite lives in the customer repo
// (tests/rules/firestore.rules.test.ts, run by `npm run test:rules` through the
// Firestore emulator against burgonomics-foundation-core/firestore.rules), and
// this lane may not edit that repo or run firebase/gcloud. When the mirrors are
// re-synced from this canonical root file, that suite covers the arm
// behaviourally; this is a narrow source pin so a regression in THIS file
// cannot land silently.
const source = readFileSync(resolve(__dirname, "../../firestore.rules"), "utf8");

describe("SEC-04 orders update: branch staff cannot write status directly", () => {
  it("denies status in the branch_owner/branch_staff update arm", () => {
    const start = source.indexOf("allow update: if (");
    expect(start).toBeGreaterThan(-1);
    const branchArmStart = source.indexOf("isBranchOwner() &&", start);
    expect(branchArmStart).toBeGreaterThan(start);
    const arm = source.slice(branchArmStart, branchArmStart + 1200);
    expect(arm).toContain(
      "!request.resource.data.diff(resource.data).affectedKeys().hasAny(['status'])"
    );
  });

  it("DENIES the direct customer cancellation arm (F24: the server path owns cancel side effects)", () => {
    // F24: a client `{status: CANCELLED}` write skipped the server-owned
    // obligations (durable rider-cancel intent + idempotent Grill-Coins
    // restore). The arm is gone; POST /orders/customerCancel owns it.
    expect(source).not.toContain("// Customers may cancel their own pre-terminal orders");
    const ordersBlock = source.slice(
      source.indexOf("match /orders/{orderId}"),
      source.indexOf("match /branches/{branchId}")
    );
    expect(ordersBlock).not.toContain("request.resource.data.status.code == 'CANCELLED'");
    // The customer whatsapp opt-in arm must SURVIVE the removal.
    expect(ordersBlock).toContain("hasOnly(['whatsappOptIn', 'updatedAt'])");
  });
});
