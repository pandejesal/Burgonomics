import * as dotenv from "dotenv";
dotenv.config();

export const config = {
  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID || "burgonomics-7faa8",
    region: process.env.FIREBASE_REGION || "asia-south1",
  },
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID || "rzp_test_mockKey123",
    keySecret: process.env.RAZORPAY_KEY_SECRET || "mockSecretKey456",
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || "whsec_mockSecret789",
  },
  petpooja: {
    enabled: process.env.PETPOOJA_ENABLED !== "false",
    appKey: process.env.PETPOOJA_APP_KEY || "mockPetpoojaAppKey",
    appSecret: process.env.PETPOOJA_APP_SECRET || "mockPetpoojaSecret",
    accessToken: process.env.PETPOOJA_ACCESS_TOKEN || "mockPetpoojaToken",
    menuUrl:
      process.env.PETPOOJA_MENU_URL ||
      "https://qle1yy2ydc.execute-api.ap-southeast-1.amazonaws.com/V1/mapped_restaurant_menus",
    orderUrl:
      process.env.PETPOOJA_ORDER_URL ||
      "https://47pfzh5sf2.execute-api.ap-southeast-1.amazonaws.com/V1/save_order",
    stockUrl:
      process.env.PETPOOJA_STOCK_URL ||
      "https://qle1yy2ydc.execute-api.ap-southeast-1.amazonaws.com/V1/update_item_stock",
    callbackUrl:
      process.env.PETPOOJA_CALLBACK_URL ||
      `https://asia-south1-${process.env.FIREBASE_PROJECT_ID || "burgonomics-7faa8"}.cloudfunctions.net/api/petpooja/webhook`,
  },
  porter: {
    enabled: process.env.PORTER_ENABLED !== "false",
    apiKey: process.env.PORTER_API_KEY || "prt_live_mockKey",
    customerId: process.env.PORTER_CUSTOMER_ID || "cust_mock123",
    webhookSecret: process.env.PORTER_WEBHOOK_SECRET || "prt_whsec_mockSecret",
    baseUrl: process.env.PORTER_BASE_URL || "https://api.porter.in",
  },
  alerts: {
    slackWebhookUrl: process.env.SLACK_DEV_WEBHOOK_URL || "",
    discordWebhookUrl: process.env.DISCORD_DEV_WEBHOOK_URL || "",
  },
  appCheck: {
    enforcement: process.env.APP_CHECK_ENFORCEMENT === "true",
  },
  mock: {
    paymentGateway:
      process.env.MOCK_PAYMENT_GATEWAY === "true" ||
      !process.env.RAZORPAY_KEY_ID ||
      process.env.RAZORPAY_KEY_ID.includes("mock"),
    porterDispatch:
      process.env.MOCK_PORTER_DISPATCH === "true" ||
      !process.env.PORTER_API_KEY ||
      process.env.PORTER_API_KEY.includes("mock"),
    petpoojaPos:
      process.env.MOCK_PETPOOJA_POS === "true" ||
      !process.env.PETPOOJA_APP_KEY ||
      process.env.PETPOOJA_APP_KEY.includes("mock"),
    },
};

// Fail-fast guard for India production: never silently run live payments,
// dispatch, or POS sync in mock mode. (Mock Porter/Petpooja in prod means
// fake riders and phantom KOTs — worse than refusing to boot.)
export function assertProductionKeys(): void {
  if (process.env.NODE_ENV === "production") {
    if (!process.env.RAZORPAY_KEY_ID || process.env.RAZORPAY_KEY_ID.includes("mock")) {
      throw new Error("FATAL: RAZORPAY_KEY_ID missing or mock in production — set live Razorpay keys in functions/.env (dotenv file, not functions:config)");
    }
    if (!process.env.PORTER_API_KEY || process.env.PORTER_API_KEY.includes("mock")) {
      throw new Error("FATAL: PORTER_API_KEY missing or mock in production — complete Porter onboarding and set functions/.env before going live");
    }
    if (!process.env.PETPOOJA_APP_KEY || process.env.PETPOOJA_APP_KEY.includes("mock")) {
      throw new Error("FATAL: PETPOOJA_APP_KEY missing or mock in production — set live Petpooja keys in functions/.env before going live");
    }
  }
}
