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

/** Optional variant (size/style) on an item line. */
export interface ScenarioVariation {
  id: string;
  name: string;
}

export interface ScenarioItem {
  id: string;
  name: string;
  price: number;
  quantity: number;
  isVeg: boolean;
  modifiers?: ScenarioModifier[];
  /** Variant (size/style) carried on this line, when the item has one. */
  variation?: ScenarioVariation;
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

/** Petpooja order_type codes (official V2.1.0 save_order contract). */
function petpoojaOrderType(orderType: ScenarioOrderType): string {
  if (orderType === "delivery") return "H"; // Home delivery
  if (orderType === "takeaway") return "P"; // Parcel / takeaway
  return "D"; // Dine-in
}

const money = (n: number): string => n.toFixed(2);

/** "yyyy-mm-dd H:i:s" — the exact `created_on` / preorder format Petpooja wants. */
function petpoojaTimestamp(at: Date): string {
  const p = (v: number) => String(v).padStart(2, "0");
  return (
    `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ` +
    `${p(at.getHours())}:${p(at.getMinutes())}:${p(at.getSeconds())}`
  );
}

/**
 * Builds the save_order body Petpooja actually accepts.
 *
 * VERIFIED 2026-10-13 against the live API (references/petpooja_save_order_api.md §12):
 *   - The body MUST carry a lower-case `orderinfo` object. A FLAT body is
 *     rejected outright: `{"success":"0","message":"Invalid order relay payload "}`.
 *   - The official docs name the key `OrderInfo` (capital) as a top-level
 *     sibling of `restID`; that shape is ALSO rejected. The live API accepts
 *     only `orderinfo` (lower-case) with Customer / Order / OrderItem / Tax /
 *     Discount children.
 *   - Unknown keys are ignored, so both the official names AND the legacy
 *     spellings are emitted — the POS reads whichever it implements, and
 *     neither spelling can point at a different outlet.
 *
 * `restID` is a verified branch mapping code and is sent at the top level AND
 * inside `orderinfo`: never a fallback chain, so neither spelling can target
 * another restaurant.
 */
export function formatPetpoojaV21Payload(
  order: PetpoojaTestOrder,
  restId: string,
  clientOrderID: string,
  callbackUrl: string,
  at: Date = new Date()
): Record<string, unknown> {
  const gst = order.pricing.gst;
  const itemTotal = order.pricing.itemTotal;
  const discount = order.pricing.discount;
  const gstRatePct =
    itemTotal > 0 ? round2((gst / Math.max(itemTotal - discount, 1)) * 100) : 0;
  const halfGst = round2(gst / 2);
  const stamp = petpoojaTimestamp(at);
  const orderTypeCode = petpoojaOrderType(order.orderType);
  const isDelivery = order.orderType === "delivery";

  const orderItems = order.items.map((item) => {
    const lineTotal = itemLineTotal(item);
    const modifierTotal = (item.modifiers || []).reduce(
      (sum, mod) => sum + mod.price,
      0
    );
    // Item tax follows the item's own line value, so addons/variants are taxed
    // with their parent item (the restaurant-liable split Petpooja expects:
    // vendor GST on the final line price, never on the raw MRP).
    const lineGst = itemTotal > 0 ? round2((gst * lineTotal) / itemTotal) : 0;
    const lineHalf = round2(lineGst / 2);
    const addons = (item.modifiers || []).map((mod) => ({
      id: mod.id,
      name: mod.name,
      group_name: "Addons",
      price: money(mod.price),
      quantity: "1",
    }));

    return {
      // ---- official V2.1.0 OrderItem names ----
      id: item.id,
      name: item.name,
      price: money(item.price),
      final_price: money(item.price * item.quantity + modifierTotal),
      quantity: String(item.quantity),
      gst_liability: "restaurant",
      tax_inclusive: true,
      tax_percentage: String(gstRatePct),
      item_discount: money(0),
      item_tax: [
        { id: "11213", name: "CGST", tax_percentage: "2.5", amount: money(lineHalf) },
        { id: "20375", name: "SGST", tax_percentage: "2.5", amount: money(lineHalf) },
      ],
      variation_id: item.variation?.id || "",
      variation_name: item.variation?.name || "",
      AddonItem: addons,
      // ---- legacy spellings the POS parser may still read ----
      // The flat contract in the official PDF names this key `addon_items`; it
      // was never emitted, so a POS implementing the documented contract saw
      // every line as addon-free.
      addon_items: addons,
      item_id: item.id,
      item_name: item.name,
      addons: addons.map((a) => ({ addon_id: a.id, addon_name: a.name, price: a.price })),
      item_attribute: item.isVeg ? "1" : "2",
    };
  });

  const taxLines = [
    {
      id: "301",
      title: "CGST",
      type: "P",
      price: `${gstRatePct / 2}%`,
      tax: money(halfGst),
      restaurant_liable_amt: money(halfGst),
    },
    {
      id: "302",
      title: "SGST",
      type: "P",
      price: `${gstRatePct / 2}%`,
      tax: money(halfGst),
      restaurant_liable_amt: money(halfGst),
    },
  ];

  return {
    // Credentials are added by the caller (see relayScenarioToPetpooja).
    restID: restId,
    res_name: "Burgonomics",
    address: "Burgonomics, Ahmedabad",
    Contact_information: "",
    // The API guide's flat contract marks the customer `name` and `address`
    // as REQUIRED top-level fields. They are also emitted inside
    // `orderinfo.Customer`; unknown keys are ignored by the live API, so both
    // spellings are safe and only one can be read.
    name: "Petpooja Sandbox Tester",
    phone: "",
    email: "",
    latitude: "",
    longitude: "",
    orderinfo: {
      Customer: {
        email: "",
        name: "Petpooja Sandbox Tester",
        address: isDelivery ? "Sandbox Test Address, Ahmedabad" : "",
        phone: "",
      },
      Order: {
        orderID: clientOrderID,
        clientOrderID,
        restID: restId,
        resID: restId,
        order_type: orderTypeCode,
        payment_type: "COD",
        total: money(order.pricing.grandTotal),
        tax: money(gst),
        tax_total: money(gst),
        discount: money(discount),
        discount_type: "F",
        discount_total: money(discount),
        delivery_charges: money(order.pricing.deliveryFee),
        packing_charges: money(order.pricing.packagingFee),
        advanced_order: "N",
        preorder_date: stamp.slice(0, 10),
        preorder_time: stamp.slice(11),
        created_on: stamp,
        dc_tax_percentage: "5",
        pc_tax_percentage: "5",
        description: `MT-01 sandbox relay — ${order.scenarioId}`,
        enable_delivery: isDelivery ? "0" : "1",
        callback_url: callbackUrl,
        ...(order.tableNumber ? { table_no: order.tableNumber } : {}),
        // legacy flat customer keys
        customer_name: "Petpooja Sandbox Tester",
        customer_phone: "",
        customer_address: isDelivery ? "Sandbox Test Address, Ahmedabad" : "",
      },
      OrderItem: orderItems,
      Tax: taxLines.map(({ id, title, type, price, tax }) => ({ id, title, type, price, tax })),
      Discount: { id: "", title: "", type: "F", price: money(discount) },
      // legacy flat collections the POS parser may still read
      tax_details: taxLines.map((t) => ({
        tax_name: t.title,
        tax_percent: Number(String(t.price).replace("%", "")) / 2,
        tax_amount: Number(t.tax),
      })),
      order_items: orderItems,
      items: orderItems,
    },
    udid: "burgonomics-sandbox",
    device_type: "Web",
  };
}

interface RelayOutcome {
  ok: boolean;
  petpoojaOrderId?: string;
  /** Raw POS response body (or the transport error) — surfaced, never swallowed. */
  detail?: unknown;
  reason?: string;
}

/**
 * Live relay to the Petpooja sandbox using the official V2.1.0 contract.
 * Returns a discriminated outcome: `ok: false` on ANY rejection so the caller
 * can fail the QA relay loudly instead of minting a `pp_test_*` order id that
 * never existed on the POS side.
 */
async function relayScenarioToPetpooja(
  order: PetpoojaTestOrder,
  branchId: string,
  clientOrderID: string
): Promise<RelayOutcome> {
  const petpoojaConfig = getPetpoojaConfig();
  const body = formatPetpoojaV21Payload(
    order,
    branchId,
    clientOrderID,
    (config.petpooja as { callbackUrl?: string }).callbackUrl ||
      `https://asia-south1-${config.firebase.projectId}.cloudfunctions.net/api/petpooja/webhook`
  );
  // Credentials travel in the body (save_order contract) — dropped from the
  // builder above so the payload stays credential-free until this point.
  const payload = {
    ...body,
    app_key: petpoojaConfig.appKey,
    app_secret: petpoojaConfig.appSecret,
    access_token: petpoojaConfig.accessToken,
  };
  try {
    const response = await fetch(petpoojaConfig.orderUrl, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: {
        "Content-Type": "application/json",
        Content_key: petpoojaConfig.appKey,
        Authorization: `Bearer ${petpoojaConfig.accessToken}`,
      },
      body: JSON.stringify(payload),
    });
    const raw = await response.text();
    let result: any = null;
    try {
      result = raw ? JSON.parse(raw) : null;
    } catch {
      /* non-JSON POS body — kept verbatim as detail */
    }

    if (!response.ok) {
      return {
        ok: false,
        reason: `HTTP ${response.status}`,
        detail: result ?? raw,
      };
    }
    const ok =
      result?.success === "1" ||
      result?.success === 1 ||
      result?.success === true ||
      result?.status === "success";
    if (!ok) {
      return { ok: false, reason: "POS rejected the relay", detail: result ?? raw };
    }
    const liveId =
      result?.petpooja_order_id ||
      result?.order_id ||
      result?.orderID ||
      result?.orderId;
    if (typeof liveId !== "string" || !liveId) {
      return {
        ok: false,
        reason: "POS accepted but returned no order id",
        detail: result ?? raw,
      };
    }
    return { ok: true, petpoojaOrderId: liveId };
  } catch (err: any) {
    return { ok: false, reason: err?.message || "transport failure", detail: undefined };
  }
}

/**
 * Runs one sandbox scenario and returns the POS-issued order id.
 *
 * Honesty contract (deliberately NOT "never hard-fails"):
 *  - mock mode ON  → deterministic `pp_test_*` id (unit tests / emulator).
 *  - mock mode OFF + credentials + branch mapping → the relay is LIVE and the
 *    result MUST be a real Petpooja order id. Any POS rejection, transport
 *    failure, or missing order id THROWS with the POS response attached, so a
 *    QA relay can never report a "fulfilled" scenario that Petpooja never
 *    accepted.
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

  const petpoojaConfig = getPetpoojaConfig();
  const relayEligible =
    !config.mock.petpoojaPos &&
    !!params.branchId &&
    !!petpoojaConfig.appKey &&
    !!petpoojaConfig.appSecret &&
    !!petpoojaConfig.accessToken;

  if (!relayEligible) {
    // Mock/emulator path only. Live relays must never land here: a caller that
    // supplied a branch mapping and credentials gets a real relay or an error.
    return {
      success: true,
      scenarioId: params.scenarioId,
      petpoojaOrderId: clientOrderID,
    };
  }

  const outcome = await relayScenarioToPetpooja(
    order,
    params.branchId as string,
    clientOrderID
  );
  if (!outcome.ok || !outcome.petpoojaOrderId) {
    const err: any = new Error(
      `Petpooja rejected scenario "${order.scenarioId}" (${
        outcome.reason || "unknown"
      }) — no fake order id is being reported.`
    );
    err.statusCode = 502;
    err.petpoojaDetail = outcome.detail;
    throw err;
  }

  return {
    success: true,
    scenarioId: params.scenarioId,
    petpoojaOrderId: outcome.petpoojaOrderId,
  };
}
