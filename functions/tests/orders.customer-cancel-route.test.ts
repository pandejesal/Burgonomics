import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * F24 — route wiring pin. The customer cancellation path must be
 * `requireAuth` ONLY (ownership is proved inside the service transaction); the
 * staff status API must keep its staff-only role stack so customers never
 * inherit branch scope / OTP gates.
 */
const src = readFileSync(resolve(__dirname, "../src/index.ts"), "utf8").replace(/\r\n/g, "\n");

describe("F24 route wiring", () => {
  it("registers /orders/customerCancel with requireAuth only (never requireRole)", () => {
    const start = src.indexOf('app.post(\n  "/orders/customerCancel"');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, start + 400);
    expect(block).toContain("requireAuth");
    expect(block).not.toContain("requireRole");
    expect(block).toContain("validateBody(customerCancelSchema)");
  });

  it("is NOT enrolled in the App Check route allowlist until its client sends a token", () => {
    const listStart = src.indexOf("app.use(\n  [");
    expect(listStart).toBeGreaterThan(-1);
    const listEnd = src.indexOf("],\n  requireAppCheck", listStart);
    expect(listEnd).toBeGreaterThan(listStart);
    const allowlist = src.slice(listStart, listEnd);
    // `ordersService.cancelOrder` posts through `httpClient` with the bearer
    // token only (no X-Firebase-AppCheck), so enrolling this path would 403
    // every cancellation once APP_CHECK_ENFORCEMENT flips to true.
    expect(allowlist).not.toContain('"/orders/customerCancel"');
    // The rationale comment must say so, so a future enrolment cannot be
    // written without also fixing the client.
    const header = src.slice(src.lastIndexOf("// App Check attestation"), listStart);
    expect(header).toContain("DELIBERATELY NOT ENROLLED: `/orders/customerCancel`");
  });

  it("enrols /orders/deliveryOtp, whose client already sends the App Check header", () => {
    const listStart = src.indexOf("app.use(\n  [");
    const listEnd = src.indexOf("],\n  requireAppCheck", listStart);
    const allowlist = src.slice(listStart, listEnd);
    expect(allowlist).toContain('"/orders/deliveryOtp"');
    // Grouped with the other customer /orders entries, not appended after /auth.
    expect(allowlist.indexOf('"/orders/deliveryOtp"')).toBeLessThan(allowlist.indexOf('"/auth/setClaims"'));
    // The route itself stays requireAuth-only for a customer-owned read: check
    // the middleware stack (up to the handler body), so the explanatory comment
    // that merely names `requireRole` cannot mask a real role gate.
    const routeStart = src.indexOf('app.post("/orders/deliveryOtp"');
    expect(routeStart).toBeGreaterThan(-1);
    const stackEnd = src.indexOf("async (req", routeStart);
    expect(stackEnd).toBeGreaterThan(routeStart);
    const stack = src.slice(routeStart, stackEnd);
    expect(stack).toContain("requireAuth");
    expect(stack).not.toContain("requireRole(");
  });

  it("keeps the staff status API staff-only", () => {
    // The App Check allowlist also names the path, so anchor on the ROUTE
    // registration, not the first textual occurrence.
    const start = src.indexOf('app.post(\n  "/orders/bumpStatus"');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, start + 300);
    expect(block).toContain('requireRole(["brand_owner", "developer", "branch_owner", "branch_staff"])');
    expect(block).not.toContain('"customer"');
  });
});
