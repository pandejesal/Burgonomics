import { config, isDeclaredProduction } from "../../config/env";
import { getPetpoojaConfig } from "./client";
import { db } from "../../core/firebase";
import { assertBranchAccess } from "../../core/middleware";
import { allocatePetpoojaTax, sumPetpoojaItemTax } from "./taxAmounts";
import { petpoojaFinancials, petpoojaGstLiability, restaurantLiableItemTax } from "./financials";
import { resolveTrustedProductSnapshots } from "./orderPush";

/**
 * Branch-scope the QA relay. The request's `branchId` is the outlet's
 * Petpooja menu-sharing code (resID), not a Firestore branch id, so it must be
 * resolved through the authoritative stores/{id} mapping before access is
 * checked. An unmapped outlet is refused: relaying a synthetic KOT into an
 * outlet the caller does not own is a cross-branch write.
 */
export function assertPetpoojaRelayAccess(
  caller: any,
  mappedPartnerBranchId: string | null | undefined
): void {
  if (!mappedPartnerBranchId) {
    const err: any = new Error(
      "Forbidden: this Petpooja outlet is not linked to a branch — cannot authorize the relay"
    );
    err.statusCode = 403;
    throw err;
  }
  try {
    assertBranchAccess(caller, mappedPartnerBranchId);
  } catch (err: any) {
    err.statusCode = 403;
    throw err;
  }
}

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
 * Live relay metadata is read from the mapped branch's captured catalog.
 * Synthetic scenario records are not authority for current GST ownership.
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
  /** M4 — the REAL numeric Petpooja add-on GROUP id (integer > 0). A ::0
   *  placeholder exists ONLY for a payload print of a scenario the sendability
   *  gate BLOCKED (never relayed); a sendable scenario always carries the true
   *  integer. */
  groupId: number;
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
  /** From the captured item menu row, never inferred from a tax percentage. */
  gstType?: string;
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
        // it defines no addon and no GROUP these ids could resolve to (M4:
        // groupId intentionally UNCONFIGURED here — the sendability gate must
        // report the addon gaps AND missing group; never relayed).
        modifiers: [
          { id: "mod_extra_cheese", name: "Extra Cheese", price: 30, groupId: 0 },
          { id: "mod_brioche_bun", name: "Brioche Bun Upgrade", price: 40, groupId: 0 },
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
 * H2 (testRunner form) — the sandbox relay's tax rows come from the
 * MAPPED BRANCH's captured catalogue (`branches.petpoojaTaxes`, provenance-
 * written by menuSyncWebhook), never from a universal default: the hardcoded
 * 3928/3929 pair used before silently invented configuration for an arbitrary
 * outlet. A subset of the captured rows must represent the scenario's GST
 * rate; otherwise the relay blocks (BLOCKED_CONFIGURATION).
 */
export interface OutletTaxRow {
  id: string;
  name: string;
  rate: string;
}

/** Pure subset search: which captured rows sum to the scenario's GST rate. */
export function resolveSandboxTaxRows(
  catalogue: unknown,
  gstRatePct: number
): { rows: OutletTaxRow[]; gap: string | null } {
  const valid = (Array.isArray(catalogue) ? catalogue : []).filter(
    (t: any) =>
      t &&
      typeof t === "object" &&
      String(t.id ?? "").trim() !== "" &&
      Number.isFinite(Number(t.rate)) &&
      Number(t.rate) > 0
  );
  if (valid.length === 0) {
    return {
      rows: [],
      gap: "no captured Petpooja tax catalogue for this branch (menu push pending/invalid) — re-run the branch's menu sync",
    };
  }
  const rows: OutletTaxRow[] = valid.map((t: any) => ({
    id: String(t.id).trim(),
    name: String(t.name ?? ""),
    rate: String(Number(t.rate)),
  }));
  // Exhaustive subset search over the captured rows (catalogues are tiny —
  // mathematical, not heuristic): any exact representation of the rate works.
  const eps = 1e-9;
  for (let mask = 1; mask < 1 << rows.length; mask++) {
    const subset = rows.filter((_, i) => mask & (1 << i));
    const sum = subset.reduce((s, r) => s + Number(r.rate), 0);
    if (Math.abs(sum - gstRatePct) <= 0.05 + eps) {
      return { rows: subset, gap: null };
    }
  }
  return {
    rows: [],
    gap: `captured tax catalogue ${rows
      .map((r) => `${r.id}@${r.rate}%`)
      .join(", ")} cannot represent the scenario's ${gstRatePct}% GST — vendor decision needed`,
  };
}

/**
 * Builds the save_order body the vendor's corrected sample expects.
 *
 * LOCKED 2026-10-26 to the sample Petpooja sent after rejecting the first five
 * sandbox relays as structurally wrong:
 *   - Root: `app_key` / `app_secret` / `access_token` (added by the caller).
 *   - One lower-case `orderinfo` envelope containing ONLY:
 *       `OrderInfo` (Restaurant / Customer / Order / OrderItem / Tax, each a
 *       `{ details: ... }` wrapper), `udid`, and `device_type`.
 *   - No legacy duplicate members under `orderinfo`, and no `Discount` object.
 *   - `final_price` is a UNIT figure (`price - item_discount`), not the line
 *     total; `Tax[].price` is a numeric percentage string.
 *
 * Earlier notes claimed `orderinfo.OrderInfo` alone was enough and that
 * "unknown keys are ignored". The vendor has now shown the opposite for the
 * five acceptance cases: extra/misplaced members are what it calls structural
 * issues, so nothing outside the sample is emitted.
 *
 * `restID` is a verified branch mapping code and appears only inside
 * `orderinfo.OrderInfo.Restaurant.details` — never a fallback chain, so no
 * spelling can target another restaurant.
 */
export function formatPetpoojaV21Payload(
  order: PetpoojaTestOrder,
  restId: string,
  clientOrderID: string,
  callbackUrl: string,
  at: Date = new Date(),
  // H2 — the MAPPED branch's captured tax catalogue (validated by
  // resolveSandboxTaxRows); no universal default exists.
  taxCatalogue?: unknown
): Record<string, unknown> {
  const gst = order.pricing.gst;
  const itemTotal = order.pricing.itemTotal;
  const discount = order.pricing.discount;
  const stamp = petpoojaTimestamp(at);
  const orderTypeCode = petpoojaOrderType(order.orderType);
  const isDelivery = order.orderType === "delivery";

  // Resolve the tax rows from the CAPTURED catalogue: a subset summing to the
  // scenario's actual effective GST rate. Unrepresentable → this builder
  // throws (the relay gates BEFORE calling it; pure-format callers see the
  // honest error).
  const gstBase = itemTotal - discount;
  const effectiveRatePct = gstBase > 0 ? round2((gst / gstBase) * 100) : 0;
  const taxResolution = resolveSandboxTaxRows(taxCatalogue, effectiveRatePct);
  if (taxResolution.gap || taxResolution.rows.length === 0) {
    throw new Error(
      `BLOCKED_CONFIGURATION: ${taxResolution.gap || "no representable tax rows"}`
    );
  }
  const taxRows = taxResolution.rows;
  const itemGstAmounts = allocatePetpoojaTax(gst, order.items.map(itemLineTotal));

  const orderItems = order.items.map((item, itemIndex) => {
    const liability = petpoojaGstLiability(item.gstType);
    const modifierTotal = (item.modifiers || []).reduce(
      (sum, mod) => sum + mod.price,
      0
    );
    // `price` is the all-in UNIT figure (base + add-ons), which is how
    // Petpooja defines it and how this runner's scenario totals are built.
    const unitPrice = item.price + modifierTotal;
    // Allocate the authoritative GST using integer paise, including the odd
    // residual, instead of independently rounding both halves down/up.
    const itemTaxAmounts = allocatePetpoojaTax(itemGstAmounts[itemIndex], taxRows.map((row) => Number(row.rate)));
    // M4 — the real integer add-on GROUP id is REQUIRED on every modifier
    // line and emitted verbatim. Vendor sample types group_id as an integer.
    // This outlet publishes NO addon configuration (`addongroups: []`,
    // `itemallowaddon: "0"`), so its scenarios carry groupId 0 ONLY as a
    // scoreboard placeholder for the never-relayed print; the sendability
    // gate refuses any non-positive group and the relay REFUSES to POST —
    // a fabricated group id is never shipped.
    const addons = (item.modifiers || []).map((mod) => ({
      id: mod.id,
      name: mod.name,
      group_name: "Addons",
      price: money(mod.price),
      group_id: mod.groupId,
      quantity: "1",
    }));

    return {
      id: item.id,
      name: item.name,
      // The runner adds GST ON TOP of its item prices, so this must be false.
      tax_inclusive: false,
      gst_liability: liability,
      // The item's tax rows come from the CAPTURED catalogue subset (H2).
      item_tax: taxRows.map((t, taxIndex) => ({
        id: t.id,
        name: t.name,
        tax_percentage: t.rate,
        amount: money(itemTaxAmounts[taxIndex]),
      })),
      item_discount: money(0),
      price: money(unitPrice),
      // Vendor sample: final_price = price - item_discount, a UNIT figure.
      // The old line-total form exceeded `price` for qty > 1 and add-ons.
      final_price: money(unitPrice),
      quantity: String(item.quantity),
      description: "",
      variation_name: item.variation?.name || "",
      variation_id: item.variation?.id || "",
      AddonItem: { details: addons },
    };
  });

  // H2 — same captured rows, summing their exact serialized item amounts.
  const taxLines = taxRows.map((t) => ({
    id: t.id,
    title: t.name,
    type: "P",
    // Numeric percentage string, matching the vendor sample ("2.5", not "2.5%").
    price: t.rate,
    tax: money(sumPetpoojaItemTax(orderItems, t.id)),
    restaurant_liable_amt: money(restaurantLiableItemTax(orderItems, t.id)),
  }));
  const financials = petpoojaFinancials({
    items: orderItems, discount, packagingFee: order.pricing.packagingFee,
    deliveryFee: order.pricing.deliveryFee, customerTotal: order.pricing.grandTotal,
    isDelivery, restaurantDelivery: false, paymentType: "COD",
  });

  // Clearly-synthetic test contacts (test-only, sandbox dry-run fixture):
  // the relay fabricates an order BY DESIGN and must keep the sample's
  // non-empty contact expectations satisfied with values that no production
  // customer could ever be confused with.
  const SANDBOX_CONTACT = {
    resName: "Burgonomics DEMO",
    address: "Sandbox Outlet, Ahmedabad, Gujarat, India",
    contactInformation: "9000000000", // clearly fictional, test-only
    customerName: "Petpooja Sandbox Tester",
    customerEmail: "sandbox.tester@example.com", // RFC 2606 reserved, test-only
    customerPhone: "9000000000",
    customerAddress: "Sandbox Test Address, Ahmedabad",
    customerLat: "23.022500",
    customerLng: "72.571400",
  };

  return {
    // Structure is LOCKED to the vendor's corrected sample (2026-10-26):
    // app credentials at the root, one `orderinfo` envelope, `OrderInfo` plus
    // `udid`/`device_type` as its only members. No legacy duplicate members
    // and no `Discount` object. The earlier "unknown keys are ignored" reading
    // (~§12 of the reference) is dead: extra/misplaced members are exactly
    // what the vendor called structural issues.
    orderinfo: {
      OrderInfo: {
        Restaurant: {
          details: {
            res_name: SANDBOX_CONTACT.resName,
            address: SANDBOX_CONTACT.address,
            contact_information: SANDBOX_CONTACT.contactInformation,
            restID: restId,
          },
        },
        Customer: {
          details: {
            email: SANDBOX_CONTACT.customerEmail,
            name: SANDBOX_CONTACT.customerName,
            address: isDelivery ? SANDBOX_CONTACT.customerAddress : "",
            phone: SANDBOX_CONTACT.customerPhone,
            latitude: isDelivery ? SANDBOX_CONTACT.customerLat : "",
            longitude: isDelivery ? SANDBOX_CONTACT.customerLng : "",
          },
        },
        Order: {
          details: {
            // `orderID` is the CLIENT reference the POS echoes to our
            // order-status callback (resolves `orders/{orderID}`); on the
            // production path that is the Firestore document id, here the
            // MT-01 client order id.
            orderID: clientOrderID,
            preorder_date: stamp.slice(0, 10),
            preorder_time: stamp.slice(11),
            service_charge: money(0),
            sc_tax_amount: money(0),
            delivery_charges: money(order.pricing.deliveryFee),
            // Delivery/packing charges carry no separate tax in our pricing
            // model. The sample's dc/pc tax figures are ITS OWN arithmetic —
            // illustrative, never a totals oracle for our engine.
            dc_tax_percentage: "0",
            dc_tax_amount: money(0),
            dc_gst_details: [
              { gst_liable: "vendor", amount: money(0) },
              { gst_liable: "restaurant", amount: money(0) },
            ],
            packing_charges: money(order.pricing.packagingFee),
            pc_tax_amount: money(0),
            pc_tax_percentage: "0",
            pc_gst_details: [
              { gst_liable: "vendor", amount: money(0) },
              { gst_liable: "restaurant", amount: money(0) },
            ],
            order_type: orderTypeCode,
            ondc_bap: "",
            advanced_order: "N",
            urgent_order: false,
            urgent_time: 0,
            payment_type: "COD",
            table_no: order.tableNumber || "",
            no_of_persons: "0",
            discount_total: money(discount),
            tax_total: money(gst),
            discount_type: "F",
            total: financials.total,
            description: `MT-01 sandbox relay — ${order.scenarioId}`,
            created_on: stamp,
            // These sandbox cases do not assign a merchant rider.
            enable_delivery: financials.enable_delivery,
            min_prep_time: 0,
            callback_url: callbackUrl,
            collect_cash: financials.collect_cash,
            // Empty on purpose: the delivery OTP is the customer/rider
            // verification secret — never printed on a kitchen ticket.
            otp: "",
          },
        },
        OrderItem: { details: orderItems },
        Tax: { details: taxLines },
      },
      // Vendor sample: siblings of OrderInfo inside the `orderinfo` envelope
      // (they used to sit at the root, where the POS ignores them).
      udid: "",
      device_type: "Web",
    },
  };
}

/**
 * Sendability gates for the QA relay (STRUCTURAL TRUTH, mirroring
 * orderPush.ts's fail-closed builder gates). Returns every provable reason a
 * scenario's payload could NOT structurally register at the POS:
 *   - missing / non-numeric item id
 *   - add-on lines with no numeric Petpooja addon id / group id
 *   - variation lines with no numeric Petpooja variation id
 * A NON-EMPTY result is reported as BLOCKED_CONFIGURATION and the relay NEVER
 * fires the POST — vendor-side configuration is the cure, not a fabricated id.
 */
export function evaluatePetpoojaTestOrderSendability(
  order: PetpoojaTestOrder
): Array<{ field: string; reason: string }> {
  const gaps: Array<{ field: string; reason: string }> = [];
  const isPosNumericId = (v: unknown): boolean => /^\d+$/.test(String(v ?? "").trim());
  for (const item of order.items) {
    const id = String(item.id ?? "").trim();
    if (id === "") {
      gaps.push({
        field: "OrderItem.details[].id",
        reason: `item "${item.name || "(unnamed)"}" carries no Petpooja item id`,
      });
    } else if (!isPosNumericId(id)) {
      gaps.push({
        field: "OrderItem.details[].id",
        reason: `item "${item.name}" id "${id}" is not a verified numeric Petpooja item id`,
      });
    }
    for (const mod of item.modifiers || []) {
      if (!isPosNumericId(mod.id)) {
        gaps.push({
          field: "OrderItem.details[].AddonItem",
          reason: `add-on "${mod.name}" id "${mod.id}" is not a verified numeric Petpooja addon id (the outlet publishes no addon configuration)`,
        });
      }
      // M4 — the add-on GROUP id is mandatory vendor configuration, not an
      // optional nicety: a numeric addon id with no (positive) group blocks.
      if (
        !Number.isInteger(mod.groupId) ||
        (mod.groupId as number) <= 0
      ) {
        gaps.push({
          field: "OrderItem.details[].AddonItem",
          reason: `add-on "${mod.name}" carries no positive Petpooja add-on GROUP id (groupId=${String(
            mod.groupId
          )}) — the outlet publishes no addon group; configuring one at the POS is the cure`,
        });
      }
    }
    if (item.variation && !isPosNumericId(item.variation.id)) {
      gaps.push({
        field: "OrderItem.details[].variation_id",
        reason: `variation "${item.variation.name}" id "${item.variation.id}" is not a verified numeric Petpooja variation id (this outlet defines no variations)`,
      });
    }
  }
  return gaps;
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
  outlet: RelayOutletMapping | null,
  clientOrderID: string,
  directBranchId?: string
): Promise<RelayOutcome> {
  // M6 — the outlet code travels as the MAPPED petpoojaStoreId (verbatim
  // request arguments never target the vendor).
  const outletCode = outlet ? outlet.petpoojaStoreId : (directBranchId || "");

  // H2 — load the MAPPED branch's captured tax catalogue (the mapped partner
  // branch when a caller was resolved, else the direct sandbox branch id). A
  // blocked catalogue is BLOCKED_CONFIGURATION before anything is built.
  let taxCatalogue: unknown = undefined;
  const partnerBranch = outlet ? outlet.partnerBranchId : directBranchId;
  try {
    if (partnerBranch) {
      const branchSnap = await (db.collection("branches") as any).doc(partnerBranch).get();
      taxCatalogue = branchSnap?.exists ? branchSnap.data()?.petpoojaTaxes : undefined;
      const snapshots = await resolveTrustedProductSnapshots(
        order.items.map((item) => ({ productId: `prod_${partnerBranch}_${item.id}` })),
        partnerBranch
      );
      order = { ...order, items: order.items.map((item) => {
        const snapshot = snapshots.find((row) => row.petpoojaItemId === item.id);
        if (!snapshot || snapshot.taxInclusive !== false || snapshot.taxUnsupported) {
          throw new Error(`item ${item.id} has no representable captured tax metadata`);
        }
        petpoojaGstLiability(snapshot.gstType); // Unknown must block, never default.
        return { ...item, gstType: snapshot.gstType! };
      }) };
    }
  } catch (err: any) {
    return {
      ok: false,
      reason: "BLOCKED_CONFIGURATION",
      detail: [
        {
          field: "branch.menuMetadata",
          reason: `captured menu/tax metadata unavailable for branch ${partnerBranch}: ${err?.message || err}`,
        },
      ],
    };
  }
  if (!partnerBranch) {
    return { ok: false, reason: "BLOCKED_CONFIGURATION", detail: [{ field: "branch.petpoojaTaxes", reason: "no mapped partner branch — relay requires a real branch mapping" }] };
  }

  // STRUCTURAL GATE (mirrors orderPush.ts): an unverified-mapping payload is
  // never POSTed. Reported BLOCKED_CONFIGURATION is the honest product of the
  // relay — never a fabricated id reaching the vendor.
  const sendability = evaluatePetpoojaTestOrderSendability(order);
  const taxGate = resolveSandboxTaxRows(
    taxCatalogue,
    order.pricing.itemTotal - order.pricing.discount > 0
      ? round2((order.pricing.gst / (order.pricing.itemTotal - order.pricing.discount)) * 100)
      : 0
  );
  if (taxGate.gap) {
    sendability.push({ field: "Tax[].id", reason: taxGate.gap });
  }
  if (sendability.length > 0) {
    return {
      ok: false,
      reason: "BLOCKED_CONFIGURATION",
      detail: sendability,
    };
  }
  const petpoojaConfig = getPetpoojaConfig();
  let body: Record<string, unknown>;
  try {
    body = formatPetpoojaV21Payload(
      order, outletCode, clientOrderID,
      (config.petpooja as { callbackUrl?: string }).callbackUrl ||
        `https://asia-south1-${config.firebase.projectId}.cloudfunctions.net/api/petpooja/webhook`,
      new Date(), taxCatalogue
    );
  } catch (error: any) {
    return { ok: false, reason: "BLOCKED_CONFIGURATION", detail: error?.message };
  }
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
        // Headers the tested sandbox relay used (all five scenarios returned
        // HTTP 200 with them); `Content_key` is kept for the older gateway
        // build that reads that spelling.
        "Content-Type-Override": "application/json",
        "app-key": petpoojaConfig.appKey,
        "app-secret": petpoojaConfig.appSecret,
        "access-token": petpoojaConfig.accessToken,
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
/**
 * M6 — RESOLVED MAPPING ONLY. The supplied branchId (internal branch id or
 * the outlet's Petpooja store ID / menu-sharing code) must resolve through
 * the authoritative stores/branches mapping. There is NO verbatim fallback:
 * an unmapped outlet resolves to null and is DENIED — relaying a synthetic
 * KOT to an arbitrary id (even a brand admin's) is a cross-outlet write.
 * Returns the partner branch id (for RBAC) plus the canonical Petpooja
 * store id (the ONLY value used as the payload's restID — never the raw
 * request argument).
 */
export interface RelayOutletMapping {
  partnerBranchId: string;
  petpoojaStoreId: string;
}

export async function resolveRelayOutletMapping(
  rawBranchId?: string
): Promise<RelayOutletMapping | null> {
  if (!rawBranchId || typeof rawBranchId !== "string") return null;
  const trimmed = rawBranchId.trim();
  if (!trimmed) return null;

  try {
    if (db && typeof db.collection === "function") {
      // 1. stores mapping (petpoojaRestId -> partnerBranchId); the matched
      //    doc's own petpoojaRestId is the canonical outlet code.
      const storeCol = db.collection("stores") as any;
      if (typeof storeCol.where === "function") {
        const storeSnap = await storeCol.where("petpoojaRestId", "==", trimmed).limit(1).get();
        const storeDoc = storeSnap.docs?.[0];
        const partnerBranchId = storeDoc?.data()?.partnerBranchId;
        if (partnerBranchId) {
          return {
            partnerBranchId: String(partnerBranchId),
            petpoojaStoreId: String(storeDoc?.data()?.petpoojaRestId ?? trimmed),
          };
        }
      }

      // 2. branches mapping (petpoojaStoreId -> branch doc id).
      const branchCol = db.collection("branches") as any;
      if (typeof branchCol.where === "function") {
        const branchSnap = await branchCol.where("petpoojaStoreId", "==", trimmed).limit(1).get();
        const branchDoc = branchSnap.docs?.[0];
        if (branchDoc) {
          return {
            partnerBranchId: branchDoc.id,
            petpoojaStoreId: String(branchDoc.data()?.petpoojaStoreId ?? trimmed),
          };
        }
      }
      // No verbatim fallback: unmapped is UNMAPPED, whatever the caller is.
    }
  } catch {
    // non-Firestore test environment
  }

  return null;
}

/**
 * Back-compat helper for RBAC callers: resolves to the partner branch id or
 * null (never the raw request string — an unmapped outlet is null).
 */
export async function resolveRelayBranchId(rawBranchId?: string): Promise<string | null> {
  const mapping = await resolveRelayOutletMapping(rawBranchId);
  return mapping ? mapping.partnerBranchId : null;
}

export async function runPetpoojaTestScenario(
  params: PetpoojaTestRunnerParams,
  caller?: any
): Promise<PetpoojaTestRunnerResult> {
  // Branch-scoping & cross-outlet denial:
  // When an authenticated caller is present, resolve the supplied branchId
  // through the authoritative stores/branches mapping and enforce that the
  // caller owns or has access to the MAPPED partner branch, before any
  // vendor save_order POST. An unmapped outlet is denied for EVERY caller
  // role (brand admins included) — no fetch, no socket, nothing (M6).
  let resolvedOutlet: RelayOutletMapping | null = null;
  if (caller) {
    resolvedOutlet = await resolveRelayOutletMapping(params.branchId);
    assertPetpoojaRelayAccess(caller, resolvedOutlet?.partnerBranchId ?? null);
  }
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

  // M6 — the POST's restID is the MAPPED outlet code, never the raw request
  // argument: a mapped-but-renamed store keeps its canonical code, and a raw
  // cosmetic argument can never retarget the vendor POST.
  const outcome = await relayScenarioToPetpooja(
    order,
    resolvedOutlet,
    clientOrderID,
    caller ? undefined : (params.branchId as string)
  );
  if (!outcome.ok) {
    const err: any = new Error(
      `Petpooja rejected scenario "${order.scenarioId}" (${
        outcome.reason || "unknown"
      }) — no fake order id is being reported.`
    );
    // A structural block is NOT a gateway failure: it is our own gate refusing
    // to send unverified mapping data, so the API surfaces it distinctly.
    err.statusCode =
      outcome.reason === "BLOCKED_CONFIGURATION" ? 409 : 502;
    if (outcome.reason === "BLOCKED_CONFIGURATION") {
      err.code = "BLOCKED_CONFIGURATION";
      err.petpoojaDetail = outcome.detail;
    } else {
      err.petpoojaDetail = outcome.detail;
    }
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
