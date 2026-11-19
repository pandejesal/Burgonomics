import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * F06 — `users/{uid}.active` is an AUTHORIZATION input, and it is SERVER-OWNED.
 *
 * Source pin over the canonical rules copy in this worktree. Behavioural proof
 * (assertFails/assertSucceeds under the emulator) lives in the customer worktree
 * rules suite, which is the only tree with a rules-emulator lane.
 *
 * Before F06: `hasRole` read only `admins/{uid}` + token claims, so a suspended
 * operator kept every branch read/write; and the brand `users/{uid}` update arm
 * was `isBrandOwner() && fcmTokensRemovalOnly()`, which admits ANY non-fcmTokens
 * key — including `active`. That is how the partner "Suspend" button wrote the
 * flag the rules then ignored.
 */

const source = readFileSync(resolve(__dirname, "../../firestore.rules"), "utf8");

describe("F06 — suspension is an authorization input, and is server-owned", () => {
  it("defines a single activation predicate reading users/{uid}.active", () => {
    expect(source).toContain("function staffProfile()");
    expect(source).toContain("function staffActive()");
    expect(source).toContain("documents/users/$(request.auth.uid)");
    expect(source).toMatch(/get\('active', false\)|data\.get\('active', false\)/);
  });

  it("every hasRole branch requires activation (stale claims cannot override a suspension)", () => {
    const hasRole = source.slice(
      source.indexOf("function hasRole"),
      source.indexOf("function isAdmin")
    );
    // Both arms (admins registry + token claim) carry the gate.
    const arms = hasRole.split("||").filter((part) => part.includes("staffActive()"));
    expect(arms.length).toBeGreaterThanOrEqual(2);
    // `staffActive()` is the LAST conjunct in each arm: a caller whose role test
    // already fails performs no extra document read.
    expect(hasRole).toMatch(/staffActive\(\)\s*\)\s*\)/);
  });

  it("orders: privileged writes are gated, the customer arm is not", () => {
    const orders = source.slice(
      source.indexOf("match /orders/{orderId}"),
      source.indexOf("match /branches/{branchId}")
    );
    // Gate reaches orders through isBrandOwner()/isBranchOwner()/hasRole().
    expect(orders).toContain("isBrandOwner()");
    expect(orders).toContain("isBranchOwner()");
    // The customer arm stays claim-free (no staff-profile prerequisite). Slice
    // from its own comment so the preceding ownsBranch() arm is excluded.
    const customerArm = orders.slice(orders.indexOf("// F24: customers may NOT write"));
    expect(customerArm).toContain("request.auth.uid");
    expect(customerArm).not.toContain("staffActive()");
    expect(customerArm).not.toContain("hasRole(");
  });

  it("users/{uid}.active is server-owned for every client path", () => {
    const users = source.slice(
      source.indexOf("match /users/{userId}"),
      source.indexOf("// SALES: ORDERS")
    );
    // No client allow-arm may carry `active` in an allowlist.
    expect(users).not.toMatch(/allow[^;]*hasOnly\([^)]*active[^)]*\)/);
    // Both existing denylists keep naming it on create + self-update.
    const activeDenials = users.match(/'active'/g) ?? [];
    expect(activeDenials.length).toBeGreaterThanOrEqual(2);
    // The brand update arm names the suspension fields in its hasAny diff guard.
    const brandArm = users.slice(users.indexOf("allow update: if (isBrandOwner()"));
    expect(brandArm).toContain("suspendedAt");
    expect(brandArm).toContain("suspendedBy");
  });

  it("customer profile paths do not require a staff profile (no customer lockout)", () => {
    // `match /customers/{customerId}` and self-profile reads stay on isUser().
    const customers = source.slice(
      source.indexOf("match /customers/{customerId}"),
      source.indexOf("match /users/{userId}")
    );
    expect(customers).toContain("isUser(customerId)");
    expect(customers).not.toContain("staffActive()");
  });
});
