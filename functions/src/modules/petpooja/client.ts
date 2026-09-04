import { config } from "../../config/env";
import * as crypto from "crypto";
import { timingSafeEqual } from "../../core/security";

export interface PetpoojaClientConfig {
  appKey: string;
  appSecret: string;
  accessToken: string;
  menuUrl: string;
  orderUrl: string;
  stockUrl: string;
}

export function getPetpoojaConfig(): PetpoojaClientConfig {
  return {
    appKey: config.petpooja.appKey || "mock_app_key",
    appSecret: config.petpooja.appSecret || "mock_app_secret",
    accessToken: config.petpooja.accessToken || "mock_access_token",
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
 */
export function verifyPetpoojaSignature(
  rawBody: string,
  signature: string,
  appSecret?: string
): boolean {
  if (config.mock.petpoojaPos) {
    return true; // Bypass signature verification in mock mode
  }
  const secret = appSecret || config.petpooja.appSecret;
  if (!secret || !signature) return false;

  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  return timingSafeEqual(signature, expectedSignature);
}
