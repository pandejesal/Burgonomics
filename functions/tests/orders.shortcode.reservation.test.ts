import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Source-level guards for two things a unit test of one creator cannot see:
 *
 *  1. `shorts/{code}` is written by the Admin SDK only. A client lane in
 *     firestore.rules could let anyone free another order's code and re-book it.
 *  2. No creator may read inside a transaction AFTER it has started writing —
 *     Firestore refuses that at runtime, so the A2 #4 reservation is PLANNED
 *     (read) before the coupon/quote writes and CLAIMED with the order create.
 */
const rules = readFileSync(resolve(__dirname, "../../firestore.rules"), "utf8");

describe("shorts reservation is server-owned in firestore.rules", () => {
  it("does not grant any client read or write on shorts/", () => {
    expect(rules).not.toMatch(/match\s+\/shorts\//);
  });

  it("still denies every default path (unmatched collections are refused)", () => {
    // The rules file has no wildcard allow; an unmatched collection is denied by
    // default. Guard the absence of a broad grant as well.
    expect(rules).not.toMatch(/match\s+\/\{collection=\*\*\}/);
    expect(rules).not.toMatch(/match\s+\/\{document=\*\*\}/);
  });
});

describe("short-code reservation is planned before every transaction write", () => {
  it.each([
    ["createCashOrder.ts"],
    ["createWalkIn.ts"],
    ["createOnlineDraft.ts"],
  ])("%s plans the reservation before its first write and claims it after", (file) => {
    const source = readFileSync(resolve(__dirname, "../src/modules/orders", file), "utf8");
    const planAt = source.indexOf("planShortCodeReservation");
    const claimAt = source.indexOf("shortCodePlan.reserve()");
    expect(planAt).toBeGreaterThan(-1);
    expect(claimAt).toBeGreaterThan(planAt);

    // The FIRST transaction write in the file must come after the plan (a read)
    // and the plan must be the last read before it.
    const writes = ["tx.set(", "tx.create(", "tx.update("]
      .map((call) => source.indexOf(call))
      .filter((index) => index >= 0);
    expect(writes.length).toBeGreaterThan(0);
    expect(planAt).toBeLessThan(Math.min(...writes));
  });
});
