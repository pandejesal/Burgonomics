import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// /auth/migrateGuest ROUTE WIRING pin (M4).
//
// Why a source-contract test: there is no HTTP harness in this repo, and the
// Functions lane's route-schema suite drives the SERVICE with a hand-built
// payload (it passes `caller` INSIDE the input object), so it cannot catch the
// actual regression this commit fixed: the route calling migrateGuestAccount
// with no second argument at all, which made the service's caller/target bind
// and OTP-verified-phone contradiction guard dead code.
//
// This pin is deliberately narrow: it asserts the wiring shape of the real
// handler in src/index.ts. It is NOT behavioural proof of the guards - those
// are proven by the service suite - and it is labelled as such rather than
// counted as end-to-end coverage.

const source = readFileSync(resolve(__dirname, "../src/index.ts"), "utf8");

function migrateGuestRouteBlock(): string {
  const start = source.lastIndexOf('"/auth/migrateGuest"');
  const end = source.lastIndexOf('"/auth/verifyBonusEligibility"');
  const block = source.slice(start, end);
  if (start < 0 || end < 0 || !block.includes("migrateGuestAccount(")) {
    throw new Error("Could not locate the /auth/migrateGuest route block");
  }
  return block;
}

describe("/auth/migrateGuest route wiring (M4)", () => {
  it("passes the verified caller as the SECOND argument to the service", () => {
    const block = migrateGuestRouteBlock();
    const call = block.match(/migrateGuestAccount\(([\s\S]*?)\);/);
    expect(call).toBeTruthy();
    // Strip line comments so the assertion is about code, not prose.
    const args = call![1].replace(/\/\/[^\n]*/g, "").trim();
    expect(args.startsWith("{")).toBe(true);
    expect(args).toMatch(/,\s*req\.user\s*$/);
  });

  it("never smuggles the caller into the payload (strict schema would reject it)", () => {
    const block = migrateGuestRouteBlock();
    const call = block.match(/migrateGuestAccount\(([\s\S]*?)\);/);
    expect(call).toBeTruthy();
    expect(call![1]).not.toMatch(/\bcaller\s*:/);
  });

  it("maps typed 4xx refusals through and keeps everything else fail-closed at 500", () => {
    const block = migrateGuestRouteBlock();
    // Typed status is only honoured inside the 400-499 band...
    expect(block).toMatch(/statusCode\s*>=\s*400/);
    expect(block).toMatch(/statusCode\s*<\s*500/);
    // ...and the fallback is still a 500, never a 2xx.
    expect(block).toMatch(/:\s*500\s*;/);
    // The old flatten-everything handler is gone.
    expect(block).not.toMatch(/res\.status\(500\)\.json\(\{\s*error:\s*err\.message \|\| "Failed to migrate guest session"\s*\}\)/);
  });

  it("keeps the server-verified uid as the migration target", () => {
    const block = migrateGuestRouteBlock();
    expect(block).toMatch(/const permanentUid = req\.user\?\.uid \|\| req\.body\.permanentUid/);
  });
});
