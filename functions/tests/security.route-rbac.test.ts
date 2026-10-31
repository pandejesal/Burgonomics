import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// SEC-08 — route-level RBAC on the role-mutation endpoints.
//
// /auth/setClaims already carried requireRole(["brand_owner","developer"]),
// but /auth/assignRole and /auth/revokeRole relied ONLY on the in-function
// assertCallerCanAssignRole. That inner check is correct (and stays), but a
// single layer is one refactor away from a privilege-escalation endpoint: any
// authenticated caller could reach the handler.
//
// Source-contract pin (there is no HTTP harness in this repo): the route
// middleware stack must name the brand roles, and the defence-in-depth check
// inside claimsManager must still exist.

const source = readFileSync(resolve(__dirname, "../src/index.ts"), "utf8");
const claimsManager = readFileSync(
  resolve(__dirname, "../src/modules/auth/claimsManager.ts"),
  "utf8"
);

function routeBlock(path: string): string {
  const start = source.lastIndexOf(`app.post(\n  "${path}"`);
  const startInline = start === -1 ? source.lastIndexOf(`"${path}"`) : start;
  expect(startInline).toBeGreaterThan(-1);
  return source.slice(startInline, startInline + 600);
}

describe("SEC-08 role-mutation routes require a brand-level role", () => {
  for (const path of ["/auth/assignRole", "/auth/revokeRole", "/auth/setClaims"]) {
    it(`${path} stacks requireAuth + requireRole(brand roles)`, () => {
      const block = routeBlock(path);
      expect(block).toContain("requireAuth");
      expect(block).toMatch(
        /requireRole\(\["brand_owner",\s*"developer"\]\)/
      );
    });
  }

  it("keeps the in-function caller check as defence in depth", () => {
    expect(claimsManager).toContain("assertCallerCanAssignRole");
    expect(claimsManager).toContain("Only Superadmins / Brand Owners can assign RBAC roles.");
  });
});
