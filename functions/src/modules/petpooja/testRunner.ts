import { config, isDeclaredProduction } from "../../config/env";
import { getPetpoojaConfig } from "./client";

/**
 * MT-01 — Petpooja Sandbox 5-Scenario Relay (POST /petpooja/testRunner).
 *
 * Exercises the five POS integration paths against the Petpooja sandbox
 * (or the local mock sandbox when MOCK_PETPOOJA_POS="true"):
 *
 *   1. dinein-basic-kot        (alias: items_tax)       — two real items, dine-in table T-01
 *   2. takeaway-with-modifiers (alias: addons)          — real item + two addon lines
 *   3. delivery-gst-fee        (alias: variations)      — delivery, 5% GST + delivery fee
 *   4. cancel-refund-sync      (alias: discounts)       — cancelled order, discount before GST
 *   5. bulk-party-order        (alias: addon_variation) — 12 real lines / high quantity (POS load)
 *
 * Every item id, name and price below comes from the outlet's own menu push
 * (`itemid` 30652–30816) and the tax rows come from the outlet's `taxes[]`
 * (3928 CGST + 3929 SGST). Nothing is copied from the API guide's illustrative
 * examples — doing that was the original defect: the runner sent item id "101"
 * and tax ids "11213"/"20375"/"301"/"302", none of which names anything in
 * this outlet.
 *
 * Scenarios 2 and 5 cannot be matched by the POS as the outlet is currently
 * configured: it publishes `addongroups: []`, sets `itemallowaddon: "0"` on all
 * 166 items, and sets `itemallowvariation: "1"` on 81 items while defining no
 * variation. The lines are still emitted so the relay is exercised, but the
 * outlet needs addon/variation configuration before they can resolve.
 *
 * Relay policy (fail-closed, mirrors orderPush.ts): a live POS call happens
 * ONLY when mock mode is off AND credentials are configured AND a branchId is
 * supplied (the branchId doubles as the sandbox resID — no fabricated resID
 * fallback chain). When mock mode is off and any of those is missing the relay
 * THROWS; only mock mode may hand back a synthetic `pp_test_*` id.
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
  /**
   * The POS-issued order id, or `null` when Petpooja accepted the order but
   * omitted the id from its response — which is what it normally does. `null`
   * does NOT mean the relay failed; read `petpoojaOrderIdReturned`.
   */
  petpoojaOrderId: string | null;
  /** Whether the POS response actually carried an order id. */
  petpoojaOrderIdReturned: boolean;
  /**
   * OUR client reference (`pp_test_<scenario>_<ts>`), sent as Order.orderID.
   * The vendor's Order List displays it in the Order No. column and no POS id
   * is reachable through the API, so this echo is the only key a support
   * request can be reconciled against (evidence §16.2/§16.8). Carried even
   * when `petpoojaOrderId` is null — it is our say, independent of the id.
   */
  clientOrderID: string | null;
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
    description: "Two real outlet items, dine-in table T-01",
    orderType: "dinein",
    tableNumber: "T-01",
    items: [
      // Real ids and prices from the outlet's own menu push (itemid 30791 /
      // 30787). The previous scenario shipped `itm_veg_burger`, an identifier
      // that exists only in this file — no POS could ever match it.
      { id: "30791", name: "Tandoori Dahi Kebab", price: 350, quantity: 1, isVeg: true },
      { id: "30787", name: "French Fries", price: 220, quantity: 1, isVeg: true },
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
    description: "Real item plus two addon lines, takeaway",
    orderType: "takeaway",
    items: [
      {
        id: "30674",
        name: "Paneer Achari Tikka [8 Pieces]",
        price: 310,
        quantity: 1,
        isVeg: true,
        // NOT EXPRESSIBLE AS CAPTURED: the demo outlet publishes
        // `addongroups: []` and sets `itemallowaddon: "0"` on all 166 items, so
        // it defines no addon that these ids could resolve to. The lines are
        // kept because "Addons + Tax" is a required scenario, but Petpooja must
        // configure at least one addon group on this outlet before the POS can
        // match them. See the escalation notes in
        // references/petpooja_save_order_api.md §13.
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
    description: "Two real items, delivery, 5% GST + delivery fee math",
    orderType: "delivery",
    items: [
      { id: "30672", name: "Tandoori Paneer Tikka [8 Pieces]", price: 270, quantity: 2, isVeg: true },
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
    description: "Cancelled order with a flat discount — cancel + refund relay",
    orderType: "delivery",
    items: [
      { id: "30673", name: "Paneer Malai Tikka [8 Pieces]", price: 290, quantity: 1, isVeg: true },
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
    description: "High-quantity stress order (12 real lines) for POS load testing",
    orderType: "takeaway",
    items: [
      { id: "30791", name: "Tandoori Dahi Kebab", price: 350, quantity: 2, isVeg: true },
      { id: "30778", name: "Tandoori Dahi Ke Sholey", price: 350, quantity: 2, isVeg: true },
      { id: "30674", name: "Paneer Achari Tikka [8 Pieces]", price: 310, quantity: 1, isVeg: true },
      { id: "30789", name: "Crispy Corn Salt And Pepper", price: 300, quantity: 1, isVeg: true },
      { id: "30673", name: "Paneer Malai Tikka [8 Pieces]", price: 290, quantity: 2, isVeg: true },
      { id: "30790", name: "Corn Salt And Pepper", price: 280, quantity: 1, isVeg: true },
      { id: "30672", name: "Tandoori Paneer Tikka [8 Pieces]", price: 270, quantity: 1, isVeg: true },
      { id: "30676", name: "Paneer Kali Mirch Tikka [8 Pieces]", price: 249, quantity: 1, isVeg: true },
      // One non-veg line, so `item_attribute` "2" is exercised rather than
      // assumed — the catalog carries 37 non-veg items but the old scenario
      // only ever sent veg.
      {
        id: "30663",
        name: "Butter Chicken + Boondi Raita + Choice Of Breads [1 Piece]",
        price: 249,
        quantity: 2,
        isVeg: false,
      },
      { id: "30787", name: "French Fries", price: 220, quantity: 1, isVeg: true },
      { id: "30786", name: "Cheese Balls", price: 200, quantity: 1, isVeg: true },
      { id: "30785", name: "Onion Rings", price: 160, quantity: 1, isVeg: true },
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

/**
 * "yyyy-mm-dd H:i:s" — the exact `created_on` / preorder format Petpooja wants,
 * rendered in IST.
 *
 * These are Indian wall-clock fields. The runtime's local zone is UTC, so the
 * previous `getHours()` version wrote a UTC time into an IST column and shifted
 * every relayed order by 5h30m — a late-evening order landed on the POS dated
 * the previous day.
 */
function petpoojaTimestamp(at: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const g = (t: string) => parts.find((x) => x.type === t)?.value ?? "00";
  return (
    `${g("year")}-${g("month")}-${g("day")} ` +
    `${g("hour")}:${g("minute")}:${g("second")}`
  );
}

/**
 * The outlet's own tax rows, exactly as Petpooja publishes them in the menu
 * push for this restaurant (`taxes[]` in the captured catalog).
 *
 * The API guide's illustrative numbers were shipped verbatim in this file for
 * months — `11213`/`20375` on item lines and `301`/`302` under `tax_details` —
 * and none of them names a tax row that exists in the outlet. Every relay
 * therefore declared taxes the POS had never heard of. Read the real ones from
 * the outlet's catalog; do not copy figures out of the guide.
 */
const OUTLET_TAX = {
  cgst: { id: "3928", name: "CGST", rate: "2.5" },
  sgst: { id: "3929", name: "SGST", rate: "2.5" },
} as const;

/**
 * Builds the save_order body the published Orders API expects.
 *
 * VERIFIED 2026-10-15 against the live API (references/petpooja_save_order_api.md §12):
 *   - The body MUST carry a lower-case `orderinfo` object. A FLAT body is
 *     rejected outright: `{"success":"0","message":"Invalid order relay payload "}`.
 *   - Inside `orderinfo` there is a REQUIRED `OrderInfo` level, and every member
 *     is a `{ details: ... }` wrapper: `orderinfo.OrderInfo.{Restaurant,
 *     Customer,Order,OrderItem,Tax,Discount}`. The previous builder omitted the
 *     `OrderInfo` level entirely, so the endpoint answered `success:"1"` while
 *     parsing nothing and echoing empty `restID`/`clientOrderID` — which is what
 *     the earlier, wrong "the endpoint is a stub" reading was based on.
 *   - The response's `orderID` is EMPTY even for a correctly parsed POST that
 *     registers fine, so it says nothing about fulfilment. Confirm fulfilment
 *     on the outlet's dashboard Order List, not in the response body.
 *   - Unknown keys are ignored, so both the published names AND the legacy
 *     spellings are emitted — the POS reads whichever it implements, and
 *     neither spelling can point at a different outlet.
 *
 * `restID` is a verified branch mapping code and is sent at the top level, in
 * `orderinfo.OrderInfo.Restaurant.details`, and inside `orderinfo.Order`:
 * never a fallback chain, so no spelling can target another restaurant.
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
      // The outlet's catalog declares `tax_inclusive: false` on its items and
      // the totals here add GST on top of the item price, so the payload must
      // say the same. It previously claimed `true`, which tells the POS the
      // price already contains the tax and lets it back the GST out a second
      // time.
      tax_inclusive: false,
      tax_percentage: String(gstRatePct),
      item_discount: money(0),
      item_tax: [
        {
          id: OUTLET_TAX.cgst.id,
          name: OUTLET_TAX.cgst.name,
          tax_percentage: OUTLET_TAX.cgst.rate,
          amount: money(lineHalf),
        },
        {
          id: OUTLET_TAX.sgst.id,
          name: OUTLET_TAX.sgst.name,
          tax_percentage: OUTLET_TAX.sgst.rate,
          amount: money(lineHalf),
        },
      ],
      variation_id: item.variation?.id || "",
      variation_name: item.variation?.name || "",
      // The documented OrderItem carries its add-ons as `AddonItem.details`.
      AddonItem: { details: addons },
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
      id: OUTLET_TAX.cgst.id,
      title: OUTLET_TAX.cgst.name,
      type: "P",
      price: `${OUTLET_TAX.cgst.rate}%`,
      tax: money(halfGst),
      restaurant_liable_amt: money(halfGst),
    },
    {
      id: OUTLET_TAX.sgst.id,
      title: OUTLET_TAX.sgst.name,
      type: "P",
      price: `${OUTLET_TAX.sgst.rate}%`,
      tax: money(halfGst),
      restaurant_liable_amt: money(halfGst),
    },
  ];

  return {
    // Credentials are added by the caller (see relayScenarioToPetpooja).
    //
    // The published Orders API carries every member under
    // `orderinfo.OrderInfo`, and wraps each member in a `details` object —
    // OrderItem / Tax / Discount holding a `details` ARRAY:
    //
    //   orderinfo.OrderInfo.{Restaurant,Customer,Order,OrderItem,Tax,Discount}
    //
    // BOTH levels are REQUIRED to be PARSED. Without them the endpoint still
    // answers `success:"1"` but parses nothing and echoes empty
    // restID/clientOrderID. Whether an unparsed POST still registers an order
    // is UNPROVEN and must not be asserted either way: an empty echo is not
    // evidence of non-registration, because the endpoint returns an empty
    // `orderID` even when the order DOES register (see orderPush.ts). See §12
    // of references/petpooja_save_order_api.md.
    restID: restId,
    res_name: "Burgonomics",
    address: "Burgonomics, Ahmedabad",
    Contact_information: "",
    // The API guide's flat contract marks the customer `name` and `address`
    // as REQUIRED top-level fields. They are also emitted inside
    // orderinfo.OrderInfo.Customer.details; unknown keys are ignored by the
    // live API, so both spellings are safe and only one can be read.
    name: "Petpooja Sandbox Tester",
    phone: "",
    email: "",
    latitude: "",
    longitude: "",
    orderinfo: {
      OrderInfo: {
        Restaurant: {
          details: {
            restID: restId,
            resID: restId,
            res_name: "Burgonomics",
            address: "Burgonomics, Ahmedabad",
            contact_information: "",
          },
        },
        Customer: {
          details: {
            email: "",
            name: "Petpooja Sandbox Tester",
            address: isDelivery ? "Sandbox Test Address, Ahmedabad" : "",
            phone: "",
            latitude: "",
            longitude: "",
          },
        },
        Order: {
          details: {
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
            service_charge: money(0),
            advanced_order: "N",
            preorder_date: stamp.slice(0, 10),
            preorder_time: stamp.slice(11),
            created_on: stamp,
            // Delivery/packing charges carry no separate tax in our pricing
            // engine; production sends "0" here. The runner sent "5", claiming a
            // 5% tax on charges the totals never included.
            dc_tax_percentage: "0",
            pc_tax_percentage: "0",
            min_prep_time: "0",
            description: `MT-01 sandbox relay — ${order.scenarioId}`,
            // Riders are always third-party, so this is "0" for every order type,
            // matching orderPush.ts. The previous version inverted it and told
            // the POS to self-deliver non-delivery orders.
            enable_delivery: "0",
            callback_url: callbackUrl,
            ...(order.tableNumber ? { table_no: order.tableNumber } : {}),
            // legacy flat customer keys
            customer_name: "Petpooja Sandbox Tester",
            customer_phone: "",
            customer_address: isDelivery ? "Sandbox Test Address, Ahmedabad" : "",
          },
        },
        OrderItem: { details: orderItems },
        // The official Tax[] shape is id / title / type / price / tax /
        // restaurant_liable_amt. The previous destructure dropped
        // `restaurant_liable_amt`, so the POS was told the restaurant owed no
        // GST on any line while the item lines claimed otherwise.
        Tax: { details: taxLines },
        // The contract carries discounts as `discount_type` + `discount_total`
        // scalars on Order (spec §8) and defines no `Discount` object. A stray
        // object carrying a `price` sits in the same namespace as Tax and can be
        // read as a charge, so it stays empty.
        Discount: { details: [] },
      },
      // ---- legacy aliases ----
      // The members directly under `orderinfo` (the shape this builder used
      // before the missing OrderInfo level was found) plus the flat-PDF
      // spellings the POS parser may still read.
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
        // Mirrors the authoritative Order details above so callers reading the
        // legacy path (the 5-scenario harness prints `orderinfo.Order.total`)
        // see real figures rather than `undefined`.
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
        dc_tax_percentage: "0",
        pc_tax_percentage: "0",
        enable_delivery: "0",
        callback_url: callbackUrl,
        ...(order.tableNumber ? { table_no: order.tableNumber } : {}),
        customer_name: "Petpooja Sandbox Tester",
        customer_phone: "",
        customer_address: isDelivery ? "Sandbox Test Address, Ahmedabad" : "",
      },
      OrderItem: orderItems,
      Tax: taxLines,
      tax_details: taxLines.map((t) => ({
        tax_name: t.title,
        // `t.price` is already a percentage ("2.5%"). The previous version
        // divided it by two, so the legacy contract advertised 1.25% CGST
        // against a 2.5% tax row.
        tax_percent: Number(String(t.price).replace("%", "")),
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
 *
 * `ok: true` means the POS ACCEPTED the order. It deliberately does NOT mean
 * the response carried an id: Petpooja answers `success:"1"` with an empty
 * `orderID` even though the order registers at the outlet (proven against the
 * live Order List — see orderPush.ts). Callers must read `petpoojaOrderId`
 * (id present) separately from `ok` (order accepted).
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
      // Accepted, id not returned. This is the normal Petpooja response, not a
      // failure — the order is at the outlet (Order List proof) and re-sending
      // it would duplicate the KOT. Report acceptance and say the id is absent.
      return { ok: true, detail: result ?? raw };
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
 *  - mock mode OFF + credentials + branch mapping → the relay is LIVE. Any POS
 *    rejection or transport failure THROWS with the POS response attached, so a
 *    QA relay can never report a "fulfilled" scenario that Petpooja never
 *    accepted.
 *  - Acceptance WITHOUT an id does NOT throw: the order is at the outlet, and
 *    reporting that as a failure (the old behaviour) was itself dishonest — it
 *    claimed nothing had synced when the POS had the order. It returns
 *    `petpoojaOrderId: null` with `petpoojaOrderIdReturned: false`.
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
    // Mock/emulator path only. `clientOrderID` is synthesised here and exists
    // nowhere on the POS, so returning it from a live process would report a
    // fulfilled scenario that Petpooja never accepted. Only mock mode may do
    // that; anything else fails loudly and names what is missing.
    if (!config.mock.petpoojaPos) {
      const missing = [
        !params.branchId && "branchId (the outlet's menu sharing code)",
        !petpoojaConfig.appKey && "PETPOOJA_APP_KEY",
        !petpoojaConfig.appSecret && "PETPOOJA_APP_SECRET",
        !petpoojaConfig.accessToken && "PETPOOJA_ACCESS_TOKEN",
      ].filter(Boolean) as string[];
      const err: any = new Error(
        `Petpooja test runner cannot relay scenario "${order.scenarioId}" — refusing to report a fabricated order id. Missing: ${missing.join(", ")}`
      );
      err.statusCode = 400;
      throw err;
    }
    return {
      success: true,
      scenarioId: params.scenarioId,
      petpoojaOrderId: clientOrderID,
      petpoojaOrderIdReturned: true,
      clientOrderID,
    };
  }

  const outcome = await relayScenarioToPetpooja(
    order,
    params.branchId as string,
    clientOrderID
  );
  if (!outcome.ok) {
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
    petpoojaOrderId: outcome.petpoojaOrderId ?? null,
    petpoojaOrderIdReturned: !!outcome.petpoojaOrderId,
    clientOrderID,
  };
}
