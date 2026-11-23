import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * r2 P1 — every POS-cancel queue field is server-only. A branch/brand client
 * must not be able to plant or clear a lease, attempt count, outcome or reason
 * on an order document. The emulator rules suites remain runnable; this static
 * contract pins the key list in the canonical rules file.
 */
const rules = readFileSync(resolve(__dirname, "../..", "firestore.rules"), "utf8");
const block = rules.slice(
  rules.indexOf("function orderServerOwnedKeys()"),
  rules.indexOf("function ", rules.indexOf("function orderServerOwnedKeys()") + 10)
);

const QUEUE_KEYS = [
  "petpoojaCancelStatus",
  "petpoojaCancelReason",
  "petpoojaCancelReasonClass",
  "petpoojaCancelRequestedBy",
  "petpoojaCancelRequestedAtMs",
  "petpoojaCancelRequestedAt",
  "petpoojaCancelNextRetryAtMs",
  "petpoojaCancelClaimedAt",
  "petpoojaCancelAttemptCount",
  "petpoojaCancelCompletedAt",
  "petpoojaCancelAckMessage",
  "petpoojaCancelPosOrderId",
  "petpoojaCancelSkippedReason",
  "lastPetpoojaCancelError",
  "kotCancelFailed",
];

describe("r2 P1 — rules: POS cancel queue is server-owned", () => {
  it("lists every queue field in orderServerOwnedKeys()", () => {
    for (const key of QUEUE_KEYS) {
      expect(block, `missing ${key}`).toContain(`'${key}'`);
    }
  });
});
