import { config, isDeclaredProduction } from "../../config/env";
import { getPetpoojaConfig } from "./client";

/**
 * MT-01 — Petpooja Sandbox 5-Scenario Relay (POST /petpooja/testRunner).
 *
 * Exercises the five POS integration paths against the Petpooja sandbox
 * (or the local mock sandbox when MOCK_PETPOOJA_POS="true"):
 *
 *   1. dinein-basic-kot        (alias: items_tax)       — burger + fries, dine-in table T-01
 *   2. takeaway-with-modifiers (alias: addons)          — burger + extra cheese + brioche bun
 *   3. delivery-gst-fee        (alias: variations)      — delivery order, 5% GST + delivery fee
 *   4. cancel-refund-sync      (alias: discounts)       — cancelled order, discount before GST
 *   5. bulk-party-order        (alias: addon_variation) — 12-line stress order (POS load)
 *
 * Relay policy (fail-closed, mirrors orderPush.ts): a live POS call happens
 * ONLY when mock mode is off AND credentials are configured AND a branchId is
 * supplied (the branchId doubles as the sandbox resID — no fabricated resID
 * fallback chain). Anything else — or any transport/POS rejection — falls
 * back to a deterministic sandbox order id so a QA relay never hard-fails.
 *
 * This module deliberately imports NO Firestore code: it is a self-contained
 * sandbox relay, unit-testable without firebase-admin mocks.
 */

export interface PetpoojaTestRunnerParams {
  scenarioId: string;
  branchId?: string;
}

export interface PetpoojaTestRunnerResult {
  success: true;
  scenarioId: string;
  petpoojaOrderId: string;
}

export interface ScenarioModifier {
  id: string;
  name: string;
  price: number;
}

export interface ScenarioItem {
  id: string;
  name: string;
  price: number;
  quantity: number;
  isVeg: boolean;
  modifiers?: ScenarioModifier[];
}

export interface ScenarioPricing {
  itemTotal: number;
  discount: number;
  gst: number;
  deliveryFee: number;
  packagingFee: number;
  grandTotal: number;
}

export type ScenarioOrderType = "dinein" | "takeaway" | "delivery";

export interface PetpoojaTestScenario {
  id: string;
  aliases: string[];
  description: string;
  orderType: ScenarioOrderType;
  tableNumber?: string;
  items: ScenarioItem[];
  /** GST as a fraction of the discounted item total (0.05 = 5%). */
  gstRate: number;
  deliveryFee: number;
  packagingFee: number;
  /** Flat rupee discount applied to items BEFORE GST. */
  discount: number;
  status: "placed" | "cancelled";
}

export interface PetpoojaTestOrder {
  scenarioId: string;
  orderType: ScenarioOrderType;
  tableNumber?: string;
  status: "placed" | "cancelled";
  items: ScenarioItem[];
  pricing: ScenarioPricing;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The 5 MT-01 sandbox scenarios (canonical ids, legacy aliases attached). */
export const PETPOOJA_TEST_SCENARIOS: ReadonlyArray<PetpoojaTestScenario> = [
  {
    id: "dinein-basic-kot",
    aliases: ["items_tax"],
    description: "Single veg burger + fries, dine-in table T-01",
    orderType: "dinein",
    tableNumber: "T-01",
    items: [
      { id: "itm_veg_burger", name: "Veg Smash Burger", price: 199, quantity: 1, isVeg: true },
      { id: "itm_peri_fries", name: "Peri Peri Fries", price: 99, quantity: 1, isVeg: true },
    ],
    gstRate: 0.05,
    deliveryFee: 0,
    packagingFee: 0,
    discount: 0,
    status: "placed",
  },
  {
    id: "takeaway-with-modifiers",
    aliases: ["addons"],
    description: "Burger with extra cheese + brioche bun modifiers, takeaway",
    orderType: "takeaway",
    items: [
      {
        id: "itm_classic_burger",
        name: "Classic Smash Burger",
        price: 219,
        quantity: 1,
        isVeg: false,
        modifiers: [
          { id: "mod_extra_cheese", name: "Extra Cheese", price: 30 },
          { id: "mod_brioche_bun", name: "Brioche Bun Upgrade", price: 40 },
        ],
      },
    ],
    gstRate: 0.05,
    deliveryFee: 0,
    packagingFee: 20,
    discount: 0,
    status: "placed",
  },
  {
    id: "delivery-gst-fee",
    aliases: ["variations"],
    description: "Delivery order with 5% GST + delivery fee math",
    orderType: "delivery",
    items: [
      { id: "itm_classic_burger", name: "Classic Smash Burger", price: 249, quantity: 2, isVeg: false },
    ],
    gstRate: 0.05,
    deliveryFee: 49,
    packagingFee: 0,
    discount: 0,
    status: "placed",
  },
  {
    id: "cancel-refund-sync",
    aliases: ["discounts"],
    description: "Cancelled order with discount — cancel + refund relay to POS",
    orderType: "delivery",
    items: [
      { id: "itm_veg_burger", name: "Veg Smash Burger", price: 199, quantity: 1, isVeg: true },
    ],
    gstRate: 0.05,
    deliveryFee: 0,
    packagingFee: 0,
    discount: 50,
    status: "cancelled",
  },
  {
    id: "bulk-party-order",
    aliases: ["addon_variation"],
    description: "High-quantity stress order (12 lines) for POS load testing",
    orderType: "takeaway",
    items: [
      { id: "itm_veg_burger", name: "Veg Smash Burger", price: 199, quantity: 2, isVeg: true },
      { id: "itm_classic_burger", name: "Classic Smash Burger", price: 219, quantity: 2, isVeg: false },
      { id: "itm_cheese_burger", name: "Cheese Smash Burger", price: 249, quantity: 1, isVeg: false },
      { id: "itm_bacon_burger", name: "Bacon Smash Burger", price: 299, quantity: 1, isVeg: false },
      { id: "itm_peri_fries", name: "Peri Peri Fries", price: 99, quantity: 2, isVeg: true },
      { id: "itm_cheese_fries", name: "Cheese Garlic Fries", price: 119, quantity: 1, isVeg: true },
      { id: "itm_loaded_fries", name: "Loaded Nacho Fries", price: 149, quantity: 1, isVeg: true },
      { id: "itm_coleslaw", name: "Creamy Coleslaw", price: 69, quantity: 1, isVeg: true },
      { id: "itm_choco_shake", name: "Chocolate Shake", price: 129, quantity: 2, isVeg: true },
      { id: "itm_vanilla_shake", name: "Vanilla Shake", price: 119, quantity: 1, isVeg: true },
      { id: "itm_iced_tea", name: "Iced Lemon Tea", price: 89, quantity: 1, isVeg: true },
      { id: "itm_brownie", name: "Choco Lava Brownie", price: 99, quantity: 2, isVeg: true },
    ],
    gstRate: 0.05,
    deliveryFee: 0,
    packagingFee: 40,
    discount: 0,
    status: "placed",
  },
];

/**
 * Case-insensitive, whitespace-tolerant match on canonical id or legacy
 * alias. Returns null for unknown ids — callers decide whether that throws.
 */
export function resolvePetpoojaTestScenario(
  scenarioId: string
): PetpoojaTestScenario | null {
  const key = scenarioId.trim().toLowerCase();
  return (
    PETPOOJA_TEST_SCENARIOS.find(
      (s) => s.id === key || s.aliases.includes(key)
    ) || null
  );
}

function itemLineTotal(item: ScenarioItem): number {
  const modifierTotal = (item.modifiers || []).reduce(
    (sum, mod) => sum + mod.price,
    0
  );
  return (item.price + modifierTotal) * item.quantity;
}

function computePricing(scenario: PetpoojaTestScenario): ScenarioPricing {
  const itemTotal = round2(
    scenario.items.reduce((sum, item) => sum + itemLineTotal(item), 0)
  );
  // Discount applies to items only; GST is charged on the discounted base.
  const discount = round2(Math.min(scenario.discount, itemTotal));
  const gst = round2((itemTotal - discount) * scenario.gstRate);
  const grandTotal = round2(
    itemTotal - discount + gst + scenario.deliveryFee + scenario.packagingFee
  );
  return {
    itemTotal,
    discount,
    gst,
    deliveryFee: scenario.deliveryFee,
    packagingFee: scenario.packagingFee,
    grandTotal,
  };
}

/** Builds the synthetic sandbox order for a scenario (canonical id or alias). */
export function buildPetpoojaTestOrder(scenarioId: string): PetpoojaTestOrder {
  const scenario = resolvePetpoojaTestScenario(scenarioId);
  if (!scenario) {
    throw new Error(
      `Unknown Petpooja test scenario "${scenarioId}". Valid ids: ` +
        PETPOOJA_TEST_SCENARIOS.map((s) => s.id).join(", ")
    );
  }
  return {
    scenarioId: scenario.id,
    orderType: scenario.orderType,
    ...(scenario.tableNumber ? { tableNumber: scenario.tableNumber } : {}),
    status: scenario.status,
    items: scenario.items,
    pricing: computePricing(scenario),
  };
}

/** Petpooja order_type codes (same mapping as formatPetpoojaOrderPayload). */
function petpoojaOrderType(orderType: ScenarioOrderType): string {
  if (orderType === "delivery") return "1";
  if (orderType === "takeaway") return "2";
  return "3";
}

/**
 * Best-effort live relay to the Petpooja sandbox. Returns the POS-issued
 * order id on an accepted push, or null on ANY skip/failure so the caller
 * falls back to a deterministic sandbox id (a QA relay must never hard-fail).
 */
async function relayScenarioToPetpooja(
  order: PetpoojaTestOrder,
  branchId: string,
  clientOrderID: string
): Promise<string | null> {
  const petpoojaConfig = getPetpoojaConfig();
  try {
    const response = await fetch(petpoojaConfig.orderUrl, {
      method: "POST",
      signal: AbortSignal.timeout(5_000),
      headers: {
        "Content-Type": "application/json",
        Content_key: petpoojaConfig.appKey,
        Authorization: `Bearer ${petpoojaConfig.accessToken}`,
      },
      body: JSON.stringify({
        app_key: petpoojaConfig.appKey,
        app_secret: petpoojaConfig.appSecret,
        access_token: petpoojaConfig.accessToken,
        orderinfo: {
          orderID: clientOrderID,
          clientOrderID,
          resID: branchId,
          order_type: petpoojaOrderType(order.orderType),
          // Dine-in KOTs carry their table (spec `table_no`).
          ...(order.tableNumber ? { table_no: order.tableNumber } : {}),
          payment_type: "COD",
          total: order.pricing.grandTotal,
          tax: order.pricing.gst,
          discount: order.pricing.discount,
          delivery_charges: order.pricing.deliveryFee,
          packing_charges: order.pricing.packagingFee,
          customer_name: "Petpooja Sandbox Tester",
          // Never invent a phone number (orderPush policy) — the sandbox
          // relay does not dispatch a rider, an empty string fails visibly.
          customer_phone: "",
          customer_address:
            order.orderType === "delivery" ? "Sandbox Test Address" : "",
          // Cancelled-order relay carries the refund amount so POS can close it.
          ...(order.status === "cancelled"
            ? {
                cancel_reason: "MT-01 sandbox cancel/refund relay",
                refund_amount: order.pricing.grandTotal,
              }
            : {}),
          tax_details: [
            {
              tax_name: "CGST",
              tax_percent: 2.5,
              tax_amount: round2(order.pricing.gst / 2),
            },
            {
              tax_name: "SGST",
              tax_percent: 2.5,
              tax_amount: round2(order.pricing.gst / 2),
            },
          ],
          order_items: order.items.map((item) => ({
            item_id: item.id,
            item_name: item.name,
            price: item.price,
            quantity: item.quantity,
            final_price: itemLineTotal(item),
            addons: (item.modifiers || []).map((mod) => ({
              addon_id: mod.id,
              addon_name: mod.name,
              price: mod.price,
            })),
            item_attribute: item.isVeg ? "1" : "2",
          })),
        },
      }),
    });
    if (!response.ok) return null;
    const result: any = await response.json().catch(() => null);
    if (!result) return null;
    const ok =
      result.success === "1" ||
      result.success === 1 ||
      result.success === true ||
      result.status === "success";
    if (!ok) return null;
    const liveId = result.petpooja_order_id || result.order_id;
    return typeof liveId === "string" && liveId ? liveId : null;
  } catch (err: any) {
    console.warn(
      `[Petpooja TestRunner] Live relay for "${order.scenarioId}" failed (${err?.message}) — falling back to sandbox order id`
    );
    return null;
  }
}

/**
 * Runs one sandbox scenario and returns the relayed (or sandbox-fallback)
 * Petpooja order id. `caller` is accepted for signature parity with the other
 * petpooja entrypoints; the sandbox relay touches no branch-scoped data.
 */
export async function runPetpoojaTestScenario(
  params: PetpoojaTestRunnerParams,
  caller?: any
): Promise<PetpoojaTestRunnerResult> {
  void caller; // no branch-scoped reads — sandbox relay only
  // ZERO-MOCK policy: this runner fabricates a synthetic order BY DESIGN. In
  // a declared-production process the relay would fire that synthetic KOT at
  // a LIVE outlet — and, when credentials are missing, hand back a fake
  // `pp_test_*` id as if something had synced. Refuse instead; MT-01 runs
  // against the sandbox from staging/dev.
  if (isDeclaredProduction()) {
    const err: any = new Error(
      "Petpooja test runner is disabled in production (zero-mock policy) — run MT-01 against the sandbox from staging/dev"
    );
    err.statusCode = 403;
    throw err;
  }
  const order = buildPetpoojaTestOrder(params.scenarioId);
  const clientOrderID = `pp_test_${order.scenarioId}_${Date.now()}`;

  // Fail-closed live relay: mock mode off, real credentials present, and an
  // explicit branch mapping (branchId doubles as the sandbox resID — no
  // fallback chain that could fire a KOT at a real outlet). Any skip or
  // rejection falls back to the deterministic sandbox id.
  const petpoojaConfig = getPetpoojaConfig();
  const relayEligible =
    !config.mock.petpoojaPos &&
    !!params.branchId &&
    !!petpoojaConfig.appKey &&
    !!petpoojaConfig.appSecret &&
    !!petpoojaConfig.accessToken;

  const liveId = relayEligible
    ? await relayScenarioToPetpooja(order, params.branchId as string, clientOrderID)
    : null;

  return {
    success: true,
    scenarioId: params.scenarioId,
    petpoojaOrderId: liveId || clientOrderID,
  };
}
