import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// PAYMENTS RECOVERY — Firestore rules pin: capture-fulfilment recovery state is
// server-owned.
//
// `captureFulfillment` / `captureFulfillmentState` decide whether an order may be
// confirmed, refunded or escalated, and `captureStall` records how long a paid
// order has been stuck. If a branch or brand owner could write them through a
// normal order update, they could wipe a stall record (hiding a paid customer
// from the recovery sweep) or forge a `fulfillable`/`refunded` state.
//
// Like rules.sec-04, this is a narrow SOURCE pin on the canonical root file; the
// behavioural rules suite lives in the customer repo and this lane may not edit
// it or run the emulator.
const source = readFileSync(resolve(__dirname, "../../firestore.rules"), "utf8");

describe("orders update: capture-fulfilment recovery keys are server-owned", () => {
  const serverOwnedSlice = () => {
    const start = source.indexOf("function orderServerOwnedKeys()");
    expect(start).toBeGreaterThan(-1);
    return source.slice(start, start + 4000);
  };

  it.each(["captureFulfillment", "captureFulfillmentState", "captureStall"])(
    "lists %s in orderServerOwnedKeys()",
    (key) => {
      expect(serverOwnedSlice()).toContain(`'${key}'`);
    }
  );

  it("keeps both update arms enforcing the whole server-owned list", () => {
    // staff arm and branch-owner arm must BOTH diff against the shared list,
    // otherwise adding a key to the list would only protect one of them.
    const diffChecks = source.match(
      /affectedKeys\(\)\.hasAny\(orderServerOwnedKeys\(\)\)/g
    );
    expect(diffChecks?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});
