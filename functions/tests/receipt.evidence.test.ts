import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cashCollectedPatch } from "../src/modules/orders/deliveryHandover.service";

// M8 r4 — a receipt may claim money PAID/COLLECTED only when the server stamped
// a receiptEvidence object in the same write as the money field. Legacy orders
// without the stamp must never make that claim.
describe("server receiptEvidence stamp", () => {
  it("cash collection writes a server stamp with the collected paise", () => {
    const patch = cashCollectedPatch({ cashDuePaise: 25900, payment: { method: "cod" } });
    const stamp = (patch as any).receiptEvidence;
    expect(stamp).toBeTruthy();
    expect(stamp.kind).toBe("cash");
    expect(stamp.paise).toBe(25900);
    expect(stamp.by).toBe("server");
    expect(Number.isFinite(stamp.stampedAtMs)).toBe(true);
    expect((patch as any).cashCollectedPaise).toBe(25900);
  });

  it("capture and cash write paths both include receiptEvidence", () => {
    const capture = readFileSync(
      resolve(__dirname, "../src/modules/payments/razorpay.service.ts"),
      "utf8",
    );
    const webhook = readFileSync(
      resolve(__dirname, "../src/modules/payments/webhookHandler.ts"),
      "utf8",
    );
    const cash = readFileSync(
      resolve(__dirname, "../src/modules/orders/deliveryHandover.service.ts"),
      "utf8",
    );
    for (const [name, source] of [
      ["verify capture", capture],
      ["webhook confirm", webhook],
      ["cash hand-over", cash],
    ] as const) {
      expect(source, `${name} must stamp receiptEvidence`).toContain("receiptEvidence");
    }
  });
});
