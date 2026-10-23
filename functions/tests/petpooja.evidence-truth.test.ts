import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Evidence-truth pins for the Petpooja five-case record. These are ARTIFACT
// tests, not runtime/provider tests: they stop a future edit from re-inflating
// "received" into "fulfilled". Vendor "fulfilled" is not a documented state
// (its terminal state is 10 Delivered); the historical probes are 5/5 received,
// 0/5 fulfilment verified, with case 2 cancelled and case 3 merely Food Ready.

const readRepoFile = (relativeToRepoRoot: string): string =>
  readFileSync(fileURLToPath(new URL(`../../${relativeToRepoRoot}`, import.meta.url)), "utf8");

const reconciliation = JSON.parse(
  readRepoFile("scripts/petpooja-sandbox-fulfillment-reconciliation.json")
);
const reference = readRepoFile("references/petpooja_save_order_api.md");
const harness = readRepoFile("scripts/petpooja-sandbox-5scenarios.mjs");

describe("Petpooja five-case evidence stays received, not fulfilled", () => {
  it("reconciliation verdict records 5 received / 0 fulfilment verified", () => {
    expect(reconciliation.verdict.received).toBe(5);
    expect(reconciliation.verdict.required).toBe(5);
    expect(reconciliation.verdict.fulfilmentVerified).toBe(0);
    expect(reconciliation.verdict.result).toMatch(/0\/5 fulfilment VERIFIED/i);
  });

  it("no scenario row claims fulfilment; the listing status stays verbatim", () => {
    expect(reconciliation.scenarios).toHaveLength(5);
    for (const scenario of reconciliation.scenarios) {
      expect(scenario.received).toBe(true);
      expect(scenario.fulfilmentVerified).toBe(false);
      expect(scenario).not.toHaveProperty("fulfilled");
      expect(typeof scenario.orderListStatus).toBe("string");
      expect(scenario.match).toBe(true);
    }
  });

  it("preserves the superseded 5/5 verdict as dated history", () => {
    expect(Array.isArray(reconciliation.history)).toBe(true);
    const history = JSON.stringify(reconciliation.history);
    expect(history).toMatch(/5\/5 FULFILLED/);
    expect(history).toMatch(/2026-10-20/);
  });

  it("reference §16.8 no longer claims the five scenarios are fulfilled", () => {
    expect(reference).not.toMatch(/The five scenarios are FULFILLED/i);
    expect(reference).toMatch(/### 16\.8 Received, not fulfilled/);
    expect(reference).toMatch(/0\/5 fulfilments are VERIFIED/i);
    // §19.2 remains the authoritative callback table.
    expect(reference).toMatch(/fulfilment NOT VERIFIED/);
    expect(reference).toMatch(/cancelled at POS; NOT fulfilled/);
    expect(reference).toMatch(/progressed; NOT fulfilled/);
    // The listing is not a fulfilment oracle, and the callback-id contract is
    // recorded next to the documented status table.
    expect(reference).not.toMatch(/only the dashboard Order List does/);
    expect(reference).not.toMatch(/fulfilment oracle/i);
    expect(reference.replace(/>/g, " ").replace(/\s+/g, " ")).toMatch(
      /Unique client order id which is used to update order status at client side/
    );
    expect(reference).toMatch(/petpoojaCallbackAck/);
    expect(reference).not.toMatch(/the order stores `petpoojaOrderId`/);
  });

  it("reference provenance cites surviving evidence, not machine-local paths", () => {
    // The original provenance block pointed at a Temp file that no longer
    // exists; a clean checkout must not inherit a dangling machine-local path.
    // Pins: no absolute local filesystem pointer survives, and the replacement
    // honestly discloses that the source material lives outside the repo.
    expect(reference).not.toMatch(/[A-Za-z]:\\/); // C:\... style windows paths
    expect(reference).not.toMatch(/\/(?:Users|home)\//); // /Users/... , /home/...
    expect(reference).toMatch(/never committed to this repo/);
    expect(reference).toMatch(/local scratch copies outside the repository/);
    expect(reference).toMatch(/NOT independent vendor confirmation/);
  });

  it("reconciliation describes the listing as a receipt oracle, not fulfilment", () => {
    expect(reconciliation.method.whyNotApi).not.toMatch(/only fulfilment oracle/i);
    expect(JSON.stringify(reconciliation.verdict)).toMatch(/0\/5 fulfilment VERIFIED/);
  });

  it("probe harness labels relay acceptance, never fulfilment", () => {
    expect(harness).toMatch(/relay accepted; fulfilment NOT verified/i);
    expect(harness).toMatch(/fulfilment NOT verified — confirm on the outlet's Order List/i);
    expect(harness).toMatch(/fulfilmentVerified: false/);
    expect(harness).not.toMatch(/fulfilledIds/);
    expect(harness).not.toMatch(/FULFILLED \(POS accepted/);
    expect(harness).not.toMatch(/FULFILLED \(petpooja order id/);
  });
});
