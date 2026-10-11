import { config, isDeclaredProduction, isRazorpayTestKeyId } from "../../config/env";

/**
 * Single owning module for the Razorpay SDK client (Batch 1 S1 — H-R3/H11).
 *
 * Fail-closed: any attempt to reach the live gateway without real keys
 * throws instead of returning a mock client. Mock-mode callers never reach
 * here — `razorpay.service.ts` and `routeTransfers.ts` short-circuit on
 * `config.mock.paymentGateway` before calling `getRazorpayClient()`.
 */

let cachedClient: any = null;

function assertLiveKeys(): { keyId: string; keySecret: string } {
  const keyId = config.razorpay.keyId;
  const keySecret = config.razorpay.keySecret;
  const looksMock = (v: string) => !v || v.includes("mock");
  if (looksMock(keyId) || looksMock(keySecret)) {
    throw new Error(
      "Razorpay live keys missing — refusing gateway call (fail-closed). " +
        "Set RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET in functions/.env."
    );
  }
  // Production + test-mode key: refuse at the last possible moment (the boot
  // assert is the primary gate; this one catches a post-boot env swap).
  if (isDeclaredProduction() && isRazorpayTestKeyId(keyId)) {
    throw new Error(
      "Razorpay test-mode key (rzp_test_*) configured in production — refusing gateway call (fail-closed)."
    );
  }
  return { keyId, keySecret };
}

/**
 * Returns the shared live Razorpay SDK client. Throws when keys are
 * missing/mock or when mock-gateway mode is active — never a stub.
 */
export function getRazorpayClient(): any {
  if (config.mock.paymentGateway) {
    throw new Error(
      "Refusing live Razorpay call while mock payment gateway is active (fail-closed)."
    );
  }
  assertLiveKeys();
  if (!cachedClient) {
    // require() keeps this import lazy (cold-start safe) and avoids a hard
    // dependency on the SDK's bundled type surface.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Razorpay = require("razorpay");
    cachedClient = new Razorpay({
      key_id: config.razorpay.keyId,
      key_secret: config.razorpay.keySecret,
    });
  }
  return cachedClient;
}

/**
 * Publishable key id for checkout. Safe to return the mock id in mock mode
 * (it only identifies the gateway order to Razorpay.js, never authorizes).
 *
 * Belt-and-braces on the same fail-closed rule as the boot assert and
 * `assertLiveKeys()`: the idempotency-reuse and claim-race paths hand a key
 * id back WITHOUT ever building the SDK client, so an rzp_test_* id could
 * otherwise reach a production checkout (customers would open Razorpay.js
 * against the test realm and "pay" into nothing).
 */
export function getRazorpayKeyId(): string {
  if (isDeclaredProduction() && isRazorpayTestKeyId(config.razorpay.keyId)) {
    throw new Error(
      "Razorpay test-mode key (rzp_test_*) configured in production — refusing to hand it to checkout (fail-closed)."
    );
  }
  return config.razorpay.keyId;
}

/** Test seam: drop the cached SDK instance between tests. */
export function __resetRazorpayClientForTests(): void {
  cachedClient = null;
}
