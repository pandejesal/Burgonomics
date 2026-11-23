import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// M8 r3 — the two fields the customer receipt treats as PROOF OF MONEY must be
// server-owned in the canonical rules. `payment` is already named, but
// Firestore `diff().affectedKeys()` reports LEAF paths, so a dotted
// `payment.capturedAmountPaise` patch is not covered by the `payment` entry.
// `cashCollectedPaise` (cash hand-over) was never named at all.
const source = readFileSync(resolve(__dirname, "../../firestore.rules"), "utf8");

describe("orders update: receipt money evidence is server-owned", () => {
  const serverOwnedSlice = () => {
    const start = source.indexOf("function orderServerOwnedKeys()");
    expect(start).toBeGreaterThan(-1);
    return source.slice(start, start + 6000);
  };

  it.each(["cashCollectedPaise", "payment.capturedAmountPaise"])(
    "lists %s in orderServerOwnedKeys()",
    (key) => {
      expect(serverOwnedSlice()).toContain(`'${key}'`);
    },
  );

  it("keeps both client update arms enforcing the whole server-owned list", () => {
    const diffChecks = source.match(
      /affectedKeys\(\)\.hasAny\(orderServerOwnedKeys\(\)\)/g,
    );
    expect(diffChecks?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});
