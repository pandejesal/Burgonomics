import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { computeDeliveryOtpHash, deriveDeliveryOtp, mintDeliveryOtp } from "../src/modules/orders/deliveryOtp";

describe("version 2 delivery mint", () => {
  beforeEach(() => vi.stubEnv("OTP_HMAC_SECRET", "hermetic_delivery_mint_secret"));
  afterEach(() => vi.unstubAllEnvs());

  it("derives stable genuine four digits from the canonical ID, domain separated from the verifier", () => {
    const digest = createHmac("sha256", "hermetic_delivery_mint_secret")
      .update("burgonomics:delivery-otp:v2\0canonical_order")
      .digest();
    const expected = String(1000 + digest.readUInt32BE(0) % 9000);
    expect(deriveDeliveryOtp("canonical_order")).toBe(expected);
    expect(deriveDeliveryOtp("canonical_order")).toBe(expected);
    const minted = mintDeliveryOtp({ orderType: "delivery", id: "untrusted_copy" }, "canonical_order");
    const expectedHash = createHmac("sha256", "hermetic_delivery_mint_secret")
      .update(`v2:canonical_order:${expected}`)
      .digest("hex");
    expect(minted).toEqual({
      otp: expected,
      deliveryOtpVersion: 2,
      deliveryOtpHash: expectedHash,
    });
    expect(minted?.deliveryOtpHash).not.toBe(expected);
  });

  it("binds canonical order ID into v2 verifier hash to block cross-order rainbow tables", () => {
    const code = "4321";
    const hashA = computeDeliveryOtpHash(code, "order_alpha", 2);
    const hashB = computeDeliveryOtpHash(code, "order_beta", 2);
    const legacyHash = computeDeliveryOtpHash(code);

    // (a) same order id + code yields expected v2 hash
    const expectedHashA = createHmac("sha256", "hermetic_delivery_mint_secret")
      .update(`v2:order_alpha:${code}`)
      .digest("hex");
    expect(hashA).toBe(expectedHashA);

    // (b) a v2 hash from order A does not equal order B (cross-order inversion blocked)
    expect(hashA).not.toBe(hashB);
    expect(hashA).not.toBe(legacyHash);

    // (c) legacy hash still computes unsalted code byte-for-byte
    const expectedLegacy = createHmac("sha256", "hermetic_delivery_mint_secret")
      .update(code)
      .digest("hex");
    expect(legacyHash).toBe(expectedLegacy);
  });

  it("never emits a leading zero across a broad deterministic sample", () => {
    for (let index = 0; index < 2000; index++) {
      expect(deriveDeliveryOtp(`canonical_${index}`)).toMatch(/^[1-9][0-9]{3}$/);
    }
  });

  it.each([
    { orderType: "takeaway" },
    { orderType: "dinein" },
    { deliveryOtpHash: "legacy_random_hash" },
    { deliveryOtp: "1357" },
    { deliveryOtpVersion: 2 },
    { deliveryOtpVersion: 99 },
    { deliveryOtpConsumedAt: "already_consumed" },
  ])("does not replace or silently reissue %j", (order) => {
    const before = structuredClone(order);
    expect(mintDeliveryOtp(order, "canonical_order")).toBeUndefined();
    expect(order).toEqual(before);
  });

  it("fails closed on a missing dedicated secret or a noncanonical ID", () => {
    vi.stubEnv("OTP_HMAC_SECRET", "");
    expect(() => deriveDeliveryOtp("canonical_order")).toThrow(/OTP_HMAC_SECRET is unset/);
    vi.stubEnv("OTP_HMAC_SECRET", "hermetic_delivery_mint_secret");
    for (const id of ["", "../order", "order/child", " order "]) {
      expect(() => deriveDeliveryOtp(id)).toThrow(/order ID/);
    }
  });

  it("pins all three actual writers to the canonical reference and versioned persistence", () => {
    const verify = readFileSync(resolve(__dirname, "../src/modules/payments/razorpay.service.ts"), "utf8");
    const webhook = readFileSync(resolve(__dirname, "../src/modules/payments/webhookHandler.ts"), "utf8");
    expect(verify.match(/mintDeliveryOtp\(fresh, orderRef.id\)/g)).toHaveLength(2);
    expect(webhook).toContain("mintDeliveryOtp(fresh, orderRef.id)");
    expect(verify).toContain("updatePayload.deliveryOtpVersion = mintedOtp.deliveryOtpVersion");
    expect(verify).toContain("deliveryOtpVersion: minted.deliveryOtpVersion");
    expect(webhook).toContain("deliveryOtpVersion: mintedOtp.deliveryOtpVersion");
  });
});
