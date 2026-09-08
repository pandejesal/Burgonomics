import { config } from "../../config/env";

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
 */
export function getRazorpayKeyId(): string {
  return config.razorpay.keyId;
}

/** Test seam: drop the cached SDK instance between tests. */
export function __resetRazorpayClientForTests(): void {
  cachedClient = null;
}
