import { config } from "../../config/env";
import * as crypto from "crypto";
import { timingSafeEqual } from "../../core/security";

export interface PetpoojaClientConfig {
  appKey: string;
  appSecret: string;
  accessToken: string;
  webhookSecret: string;
  menuUrl: string;
  orderUrl: string;
  stockUrl: string;
}

export function getPetpoojaConfig(): PetpoojaClientConfig {
  // Fail-closed (H-M2/C3): no mock literals. Unset secrets stay "" and every
  // verifier below denies on empty — never verify against a well-known value.
  // webhookSecret is INBOUND-ONLY (HMAC verify): it is never placed in an
  // outbound body/header — grep webhookSecret to audit (only this file +
  // .env wiring may reference it).
  return {
    appKey: config.petpooja.appKey || "",
    appSecret: config.petpooja.appSecret || "",
    accessToken: config.petpooja.accessToken || "",
    webhookSecret: config.petpooja.webhookSecret || "",
    menuUrl:
      config.petpooja.menuUrl ||
      "https://qle1yy2ydc.execute-api.ap-southeast-1.amazonaws.com/V1/mapped_restaurant_menus",
    orderUrl:
      config.petpooja.orderUrl ||
      "https://47pfzh5sf2.execute-api.ap-southeast-1.amazonaws.com/V1/save_order",
    stockUrl:
      config.petpooja.stockUrl ||
      "https://qle1yy2ydc.execute-api.ap-southeast-1.amazonaws.com/V1/update_item_stock",
  };
}

/**
 * Validates HMAC SHA256 signature for incoming Petpooja webhooks.
 * Fail-closed: no mock bypass — empty secret or empty signature denies.
 * Secret precedence: explicit arg → dedicated PETPOOJA_WEBHOOK_SECRET →
 * legacy APP_SECRET fallback (Petpooja signs with the issued secret until
 * ops sets the dedicated one; the fallback is logged once per process).
 */
let webhookFallbackWarned = false;

export function verifyPetpoojaSignature(
  rawBody: string,
  signature: string,
  appSecret?: string
): boolean {
  const dedicated = appSecret || config.petpooja.webhookSecret;
  const secret = dedicated || config.petpooja.appSecret;
  if (!secret || !signature) return false;
  if (!dedicated && !webhookFallbackWarned) {
    webhookFallbackWarned = true;
    console.warn(
      "[Petpooja] PETPOOJA_WEBHOOK_SECRET unset — verifying inbound HMAC against APP_SECRET. Set the dedicated secret to split inbound/outbound trust."
    );
  }

  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  return timingSafeEqual(signature, expectedSignature);
}
