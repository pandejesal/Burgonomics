import { db } from "../../core/firebase";
import { config, assertLivePetpoojaContext } from "../../config/env";
import { captureErrorSnapshot } from "../../core/errors";
import { getPetpoojaConfig } from "./client";
import * as admin from "firebase-admin";
import { randomUUID } from "crypto";
import { assertOrderBranchAccess, type StaffCaller } from "../../core/middleware";

function getCallbackUrl(): string {
  return (
    (config.petpooja as { callbackUrl?: string }).callbackUrl ||
    `https://asia-south1-${config.firebase.projectId}.cloudfunctions.net/api/petpooja/webhook`
  );
}

/**
 * Normalizes a customer contact to what the Petpooja Save Order API accepts
 * (10-digit Indian mobile, or an E.164 `+<country><number>`).
 * NEVER invents a number: unknown shapes and obvious dummies collapse to ""
 * so the push fails visibly (snapshot below) instead of dispatching a rider
 * to a fabricated contact. Valid inputs pass through unchanged — the
 * normalization is idempotent.
 */
const DUMMY_PHONES = new Set(["1234567890", "9876543210", "0000000000", "1111111111"]);

/** Petpooja's save_order payload prices are strings with 2 decimals. */
const money = (n: number): string => (Number.isFinite(n) ? Number(n).toFixed(2) : "0.00");

/** Money is compared and allocated in integer paise, never in rupee floats. */
const toPaise = (rupees: number): number => Math.round(rupees * 100);
const fromPaise = (paise: number): string => (paise / 100).toFixed(2);

/**
 * A payload we cannot represent truthfully. Thrown by the pure formatter,
 * which `pushOrderToPetpooja` calls BEFORE it marks transmission as attempted,
 * so this is classified `pre_send_terminal` (never a possibly-sent ambiguity).
 *
 * TERMINAL, not retryable: every one of these failures is missing/corrupt ORDER
 * DATA (no tender, no server pricing, add-ons that do not sum to the priced
 * food subtotal, an outlet tax mapping we cannot stand behind). Re-POSTing the
 * identical document later cannot succeed, so parking it in `pending_retry`
 * would burn the retry budget and then dead-letter it, hiding a data defect
 * behind a transport failure. It is parked `failed` for a human instead.
 */
function invalidPayload(detail: string, code = "PETPOOJA_PAYLOAD_INVALID"): Error {
  const err: any = new Error(`Petpooja payload cannot be represented: ${detail}`);
  err.code = code;
  err.petpoojaFailureClass = "pre_send_terminal";
  return err;
}

/**
 * Reads a money field only when it is PRESENT. A stored `0` is authoritative
 * data and stops the fallback chain; a present-but-corrupt value throws instead
 * of silently falling through to a legacy field.
 */
function presentMoney(source: any, key: string, label: string): number | undefined {
  if (source === null || typeof source !== "object") return undefined;
  if (!Object.prototype.hasOwnProperty.call(source, key)) return undefined;
  const raw = (source as Record<string, unknown>)[key];
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw invalidPayload(`${label} (${key}) must be a finite number, got ${String(raw)}`);
  }
  return raw;
}

function firstPresentMoney(
  candidates: ReadonlyArray<{ source: any; key: string }>,
  label: string
): number | undefined {
  for (const { source, key } of candidates) {
    const value = presentMoney(source, key, label);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Largest-remainder split so the parts sum EXACTLY to `totalPaise`
 * (0.01 ₹ tax never becomes 0.02 ₹ across two rows). Returns null when a
 * positive total has no positive weight — the caller fails pre-send rather
 * than inventing a split.
 */
function allocatePaise(totalPaise: number, weights: readonly number[]): number[] | null {
  if (weights.length === 0) return totalPaise === 0 ? [] : null;
  if (totalPaise === 0) return weights.map(() => 0);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (!(totalWeight > 0)) return null;
  const exact = weights.map((weight) => (totalPaise * weight) / totalWeight);
  const parts = exact.map((value) => Math.floor(value));
  const remaining = totalPaise - parts.reduce((sum, value) => sum + value, 0);
  const byRemainder = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let k = 0; k < remaining; k++) parts[byRemainder[k].index] += 1;
  return parts;
}

/**
 * Per-line / per-order tax rows for the KOT.
 *
 * Petpooja needs tax ids that exist on the OUTLET. The old payload sent
 * `id: "cgst"` / `"sgst"` — labels that name no tax row — and omitted
 * `item_tax` from the lines entirely, so every line arrived untaxed while the
 * order still declared a tax total.
 *
 * AUTHORITY ORDER (fail-closed, never a silent substitution):
 *   1. `branch.petpoojaTaxes` — the outlet's own `taxes[]`, written by the menu
 *      webhook (`menuSyncWebhook.ts`) with its provenance (`petpoojaTaxesRestId`,
 *      `petpoojaTaxesCapturedAt`). Rows captured for a DIFFERENT outlet are
 *      refused, never applied.
 *   2. The demo fallback behind an EXPLICIT per-branch opt-in
 *      (`branch.petpoojaTaxFallback = { enabled: true, restId, capturedAt }`).
 *      The opt-in is a claim that THIS branch is the outlet the fallback ids
 *      were verified against; a provenance restId that disagrees with
 *      `branch.petpoojaStoreId` is refused.
 *   3. Otherwise the push is refused pre-send. The old code applied 3928/3929
 *      silently to every outlet, which is a fabricated tax liability on a
 *      different restaurant's chart of accounts.
 *
 * OPERATIONAL PREREQUISITE: live outlets must either receive a menu push that
 * carries `taxes[]`, or be explicitly opted in to the demo rows. See
 * references/petpooja_save_order_api.md §20.
 */
const DEMO_OUTLET_TAXES = [
  { id: "3928", name: "CGST", rate: 2.5 },
  { id: "3929", name: "SGST", rate: 2.5 },
];

interface OutletTaxRow {
  id: string;
  name: string;
  rate: number;
}

/** Reads `capturedAt` provenance: string / millis / Firestore Timestamp. */
function isRecordedTimestamp(raw: any): boolean {
  if (typeof raw === "string") return raw.trim() !== "" && Number.isFinite(Date.parse(raw));
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0;
  if (raw && typeof raw.toMillis === "function") {
    const millis = Number(raw.toMillis());
    return Number.isFinite(millis) && millis > 0;
  }
  return false;
}

function outletTaxes(branch: any, resId: string): OutletTaxRow[] {
  const declared = branch?.petpoojaTaxes;
  if (declared !== undefined && declared !== null) {
    if (!Array.isArray(declared) || declared.length === 0) {
      throw invalidPayload("branch.petpoojaTaxes is declared but is not a non-empty array");
    }
    const capturedFor = branch?.petpoojaTaxesRestId;
    if (
      capturedFor !== undefined &&
      capturedFor !== null &&
      String(capturedFor).trim() !== String(resId ?? "").trim()
    ) {
      throw invalidPayload(
        `branch.petpoojaTaxes was captured for outlet ${String(capturedFor)}, not ${String(
          resId
        )} — refusing to apply another outlet's tax rows`,
        "PETPOOJA_TAXES_OUTLET_MISMATCH"
      );
    }
    const rows: OutletTaxRow[] = [];
    const seenIds = new Set<string>();
    declared.forEach((row: any, index: number) => {
      if (!row || typeof row !== "object" || row.id === undefined || row.id === null) {
        throw invalidPayload(`branch.petpoojaTaxes[${index}] has no outlet tax id`);
      }
      const id = String(row.id).trim();
      if (!id) throw invalidPayload(`branch.petpoojaTaxes[${index}] has an empty outlet tax id`);
      if (seenIds.has(id)) {
        throw invalidPayload(`branch.petpoojaTaxes declares duplicate outlet tax id ${id}`);
      }
      seenIds.add(id);
      const rate = typeof row.rate === "number" ? row.rate : Number(row.rate);
      if (!Number.isFinite(rate) || rate < 0) {
        throw invalidPayload(
          `branch.petpoojaTaxes[${index}] (${id}) has an invalid rate ${String(row.rate)}`
        );
      }
      rows.push({ id, name: String(row.name || ""), rate });
    });
    return rows;
  }

  const optIn = branch?.petpoojaTaxFallback;
  if (optIn && typeof optIn === "object") {
    if (optIn.enabled !== true) {
      throw invalidPayload(
        "branch.petpoojaTaxFallback is present but not enabled — refusing the demo tax rows",
        "PETPOOJA_OUTLET_TAXES_UNKNOWN"
      );
    }
    const provenancedRestId = typeof optIn.restId === "string" ? optIn.restId.trim() : "";
    if (!provenancedRestId) {
      throw invalidPayload(
        "branch.petpoojaTaxFallback has no restId provenance — refusing the demo tax rows",
        "PETPOOJA_OUTLET_TAXES_UNKNOWN"
      );
    }
    if (!isRecordedTimestamp(optIn.capturedAt)) {
      throw invalidPayload(
        "branch.petpoojaTaxFallback has no valid capturedAt provenance — refusing the demo tax rows",
        "PETPOOJA_OUTLET_TAXES_UNKNOWN"
      );
    }
    const storeId = typeof branch?.petpoojaStoreId === "string" ? branch.petpoojaStoreId.trim() : "";
    if (!storeId || storeId !== String(resId ?? "").trim() || storeId !== provenancedRestId) {
      throw invalidPayload(
        `branch.petpoojaTaxFallback was verified against outlet ${provenancedRestId} but this branch pushes to ${
          storeId || "(no store id)"
        } — refusing to apply the demo tax rows to a different outlet`,
        "PETPOOJA_TAXES_OUTLET_MISMATCH"
      );
    }
    return DEMO_OUTLET_TAXES.map((t) => ({ ...t }));
  }

  throw invalidPayload(
    `no outlet tax rows captured for outlet ${String(
      resId
    )} and no explicit demo-tax opt-in (branch.petpoojaTaxFallback) — refusing to apply the demo ids 3928/3929 to an unverified outlet`,
    "PETPOOJA_OUTLET_TAXES_UNKNOWN"
  );
}

export function normalizeCustomerPhone(raw: any): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const digits = trimmed.replace(/\D/g, "");
  if (!digits || DUMMY_PHONES.has(digits)) return "";
  // 10-digit local number (what Petpooja documents).
  if (digits.length === 10) return digits;
  // +91XXXXXXXXXX / 91XXXXXXXXXX → keep the explicit country form.
  if (trimmed.startsWith("+") && digits.length >= 10 && digits.length <= 15) {
    return `+${digits}`;
  }
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  // 0XXXXXXXXXX (trunk prefix) → +XXXXXXXXXX.
  if (digits.length === 11 && digits.startsWith("0")) return `+${digits.slice(1)}`;
  return "";
}

/**
 * KOT timestamps must be IST wall-clock time regardless of where the
 * function runs. The old local-zone formatting shifted every preorder/
 * created timestamp by the deploy region's offset (finding: petpoojaClock
 * timezone) — kitchens plan around these fields.
 */
const PETPOOJA_TZ = "Asia/Kolkata";

export function petpoojaClock(now: Date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: PETPOOJA_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value || "00";
  // Some ICU builds render midnight as hour "24" with hourCycle h23 off.
  const hour = get("hour") === "24" ? "00" : get("hour");
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  const time = `${hour}:${get("minute")}:${get("second")}`;
  return { preorderDate: date, preorderTime: time, createdOn: `${date} ${time}` };
}

/**
 * Petpooja item id for an order line.
 *
 * The `orders` document stores the app's `CartLine` shape — `productId`,
 * `unitPrice`, `veg`, and an optional `meta` bag — none of which is a field name
 * this relay used to read (`petpoojaItemId` / `itemId` / `id`). Every line
 * therefore went out with no id at all and the POS had nothing to match.
 *
 * Accepts, in order of authority:
 *   1. an explicit POS id on the line (`petpoojaItemId`)
 *   2. the cart's `meta` bag (`meta.petpoojaItemId`)
 *   3. a legacy `itemId` / `id`
 *   4. the menu doc id the sync writes, `prod_<branchId>_<petpoojaItemId>`,
 *      stripped by exact prefix — never parsed loosely.
 * Returns "" when nothing resolves, so the gap stays visible.
 */
function linePetpoojaItemId(item: any, firestoreBranchId?: string): string {
  const meta = item?.meta || {};
  for (const candidate of [item?.petpoojaItemId, meta.petpoojaItemId, item?.itemId, item?.id]) {
    if (candidate !== undefined && candidate !== null && String(candidate).trim() !== "") {
      return String(candidate);
    }
  }
  const productId = item?.productId;
  if (firestoreBranchId && typeof productId === "string") {
    const prefix = `prod_${firestoreBranchId}_`;
    if (productId.startsWith(prefix)) return productId.slice(prefix.length);
  }
  return "";
}

/**
 * Unit price of a line: the app writes `unitPrice`; legacy shapes write
 * price/basePrice. A MISSING price is refused rather than rendered as a free
 * item — `Number(undefined) || 0` used to ship unpriced SKUs at 0.00.
 */
function lineUnitPrice(item: any, index: number): number {
  const raw = item?.basePrice ?? item?.price ?? item?.unitPrice;
  if (raw === undefined || raw === null || raw === "") {
    throw invalidPayload(`line ${index} has no unit price`);
  }
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw invalidPayload(`line ${index} has an invalid unit price (${String(raw)})`);
  }
  return value;
}

/** Quantity defaults to 1 for legacy lines, but a present value must be sane. */
function lineQuantity(item: any, index: number): number {
  const raw = item?.quantity;
  if (raw === undefined || raw === null) return 1;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw invalidPayload(`line ${index} has an invalid quantity (${String(raw)})`);
  }
  return value;
}

export function formatPetpoojaOrderPayload(
  order: any,
  branch: any,
  resId: string,
  firestoreBranchId?: string
) {
  const fulfillment = (order.fulfillmentType || order.orderType || "DELIVERY").toUpperCase();
  // Official V2.1.0 order_type is a letter code: H (home delivery),
  // P (parcel/takeaway), D (dine-in). The numeric 1/2/3 form the old code sent
  // is not part of the documented contract — both are emitted so the POS
  // parser reads whichever it implements.
  const orderTypeCode =
    fulfillment === "DELIVERY" ? "H" : fulfillment === "TAKEAWAY" || fulfillment === "PICKUP" ? "P" : "D";
  const orderTypeLegacy = fulfillment === "DELIVERY" ? "1" : fulfillment === "TAKEAWAY" || fulfillment === "PICKUP" ? "2" : "3";

  // REAL order docs carry the tender at `payment.method`
  // (firestore_schema.md: 'razorpay' | 'cash'; COD is stored as "cod").
  // `paymentMethod` is the legacy flat spelling and is still honoured — it is
  // read FIRST because the two are written by the same order writer, and a
  // legacy flat field present on a doc is an explicit statement about that
  // order.
  // An absent/unknown tender is REFUSED: the old `else ONLINE` silently turned
  // every unrecognised value into a captured payment, which is a money lie.
  const rawTender = order?.paymentMethod ?? order?.payment?.method;
  const tender = typeof rawTender === "string" ? rawTender.trim().toUpperCase() : "";
  if (!tender) {
    throw invalidPayload(
      "order has no payment tender (payment.method / paymentMethod)",
      "PETPOOJA_PAYMENT_TENDER_UNKNOWN"
    );
  }
  const COD_TENDERS = new Set(["COD", "CASH"]);
  const ONLINE_TENDERS = new Set([
    "RAZORPAY",
    "UPI",
    "CARD",
    "ONLINE",
    "PREPAID",
    "NETBANKING",
    "WALLET",
    "CREDIT_CARD",
    "DEBIT_CARD",
  ]);
  let paymentType: "COD" | "ONLINE";
  if (COD_TENDERS.has(tender)) {
    paymentType = "COD";
  } else if (ONLINE_TENDERS.has(tender)) {
    paymentType = "ONLINE";
  } else {
    throw invalidPayload(
      `unknown payment tender "${tender}" — refusing to guess ONLINE`,
      "PETPOOJA_PAYMENT_TENDER_UNKNOWN"
    );
  }

  // ---------------------------------------------------------------------------
  // Authoritative money comes from the SERVER pricing engine
  // (`payments/pricing.engine.ts`): it computes 5% GST on the DISCOUNTED food
  // subtotal and adds that GST (plus fees) to reach `grandTotal`. So:
  //   - `pricing.grandTotal` ALREADY CONTAINS the GST. It is sent verbatim as
  //     `Order.total`/`tax_total`'s parent and is never taxed a second time.
  //   - the item prices sent on the lines are EX-GST (the engine's catalog
  //     price), so each line declares `tax_inclusive: false`.
  // Vendor mail of 28 Oct 2026 16:01 (lines 276-278): "total includes tax_total",
  // with 350 + 17.50 = 367.50. Anything we cannot represent is refused HERE —
  // before `pushOrderToPetpooja` flips its transmission flag — so the failure is
  // pre-send instead of a KOT with numbers we cannot stand behind.
  // ---------------------------------------------------------------------------
  const hasPricingObject =
    !!order.pricing && typeof order.pricing === "object" && !Array.isArray(order.pricing);
  const pricingSource = hasPricingObject ? order.pricing : {};
  const totalsSource =
    order.totals && typeof order.totals === "object" && !Array.isArray(order.totals)
      ? order.totals
      : {};

  // A COD KOT tells the counter how much cash to collect, so the amount MUST
  // come from the server pricing engine. Falling back to `order.totals` (a
  // client-mirrored summary) or the flat client fields would put a
  // client-asserted number on the cash drawer. Refuse pre-send, terminal: no
  // later automatic retry can invent the missing server pricing.
  if (paymentType === "COD" && !hasPricingObject) {
    throw invalidPayload(
      "COD order has no server pricing object — refusing to derive collect_cash from client totals",
      "PETPOOJA_PRICING_MISSING_COD"
    );
  }

  const grandTotal = firstPresentMoney(
    [
      { source: pricingSource, key: "grandTotal" },
      { source: totalsSource, key: "grandTotal" },
      { source: order, key: "totalAmount" },
      { source: order, key: "total" },
    ],
    "order total"
  );
  if (grandTotal === undefined) {
    throw invalidPayload(
      "no stored order total (pricing.grandTotal / totals.grandTotal / totalAmount / total)"
    );
  }
  if (grandTotal < 0) throw invalidPayload(`order total ${grandTotal} is negative`);

  let gstAmount = firstPresentMoney(
    [
      { source: pricingSource, key: "gst" },
      { source: totalsSource, key: "taxGst" },
      { source: order, key: "taxAmount" },
      { source: order, key: "tax" },
    ],
    "order tax"
  );
  if (gstAmount === undefined) {
    // A legitimate zero-GST order stores `gst: 0`. An ABSENT tax component on a
    // positive total is MISSING data — the old `||` chain silently turned both
    // cases into 0 (and could not tell them apart).
    if (grandTotal > 0) {
      throw invalidPayload("order total is positive but no tax component is stored");
    }
    gstAmount = 0;
  }
  if (gstAmount < 0) throw invalidPayload(`order tax ${gstAmount} is negative`);
  const grandTotalPaise = toPaise(grandTotal);
  const gstPaise = toPaise(gstAmount);
  if (gstPaise > grandTotalPaise) {
    throw invalidPayload(`order tax ${gstAmount} exceeds the order total ${grandTotal}`);
  }

  const deliveryFee =
    firstPresentMoney(
      [
        { source: pricingSource, key: "deliveryFee" },
        { source: totalsSource, key: "deliveryFee" },
        { source: order, key: "deliveryFee" },
      ],
      "delivery fee"
    ) ?? 0;
  const packagingFee =
    firstPresentMoney(
      [
        { source: pricingSource, key: "packagingFee" },
        { source: totalsSource, key: "packingCharge" },
        { source: order, key: "packagingFee" },
      ],
      "packaging fee"
    ) ?? 0;
  if (deliveryFee < 0) throw invalidPayload(`delivery fee ${deliveryFee} is negative`);
  if (packagingFee < 0) throw invalidPayload(`packaging fee ${packagingFee} is negative`);

  // The engine applies the coupon discount AND the loyalty redemption before
  // GST, and `grandTotal` reflects both. The KOT carries ONE fixed discount, so
  // it must sum them; sending only the coupon left the POS to compute a total
  // higher than the amount we say is due.
  const couponDiscount =
    firstPresentMoney(
      [
        { source: pricingSource, key: "discount" },
        { source: order, key: "discountAmount" },
      ],
      "discount"
    ) ?? 0;
  const loyaltyDiscount = presentMoney(pricingSource, "loyaltyDiscount", "loyalty discount") ?? 0;
  if (couponDiscount < 0) throw invalidPayload(`discount ${couponDiscount} is negative`);
  if (loyaltyDiscount < 0) throw invalidPayload(`loyalty discount ${loyaltyDiscount} is negative`);
  const discountAmount = couponDiscount + loyaltyDiscount;

  if (!Array.isArray(order.items) || order.items.length === 0) {
    throw invalidPayload("order has no item lines");
  }

  const branchTaxes = outletTaxes(branch, resId);
  const branchTaxPct = branchTaxes.reduce((sum, t) => sum + t.rate, 0);

  // Validate and flatten every line ONCE; the tax split below needs the totals
  // before any line object can be built.
  //
  // A line's VALUE includes its add-ons. The add-on price is real money the
  // customer paid (and the pricing engine folded into `foodSubtotal` when it
  // priced the cart), so excluding it understated that line's share of the
  // order's GST — the tax was allocated as if the burger were bought without
  // the extra patty.
  const lineInputs = (order.items as any[]).map((item: any, index: number) => {
    const unit = lineUnitPrice(item, index);
    const qty = lineQuantity(item, index);
    let addonUnitPaise = 0;
    const addons = (item.modifiers || item.selectedAddons || []).map((mod: any) => {
      const rawPrice = mod?.price ?? mod?.priceDelta ?? 0;
      const parsedPrice = typeof rawPrice === "number" ? rawPrice : Number(rawPrice);
      if (!Number.isFinite(parsedPrice) || parsedPrice < 0) {
        throw invalidPayload(
          `line ${index} add-on "${String(mod?.name ?? "?")}" has an invalid price (${String(rawPrice)})`
        );
      }
      addonUnitPaise += toPaise(parsedPrice);
      return {
        // official AddonItem names: id / name / group_name / price
        id: mod.id || mod.optionId || "addon",
        name: mod.name,
        group_name: mod.groupName || "Addons",
        // CartModifier carries `priceDelta`; `price` is the legacy spelling.
        price: money(parsedPrice),
        // legacy spelling the POS parser may still read
        addon_id: mod.id || mod.optionId || "addon",
        addon_name: mod.name,
      };
    });
    // Integer paise end to end: `(unit + addons) x qty` in floats can drift a
    // paisa on a 0.1-priced line, and this value is both the reconciliation
    // target and the tax weight.
    const unitValuePaise = toPaise(unit) + addonUnitPaise;
    const lineValuePaise = unitValuePaise * qty;
    if (!Number.isSafeInteger(lineValuePaise)) {
      throw invalidPayload(`line ${index} value is not a finite paise amount`);
    }
    return { item, unit, qty, addons, lineValuePaise };
  });

  // ADD-ON RECONCILIATION. The server pricing engine prices a line as
  // (unit price + every modifier) x quantity and sums those into
  // `pricing.foodSubtotal`. If the order document's lines no longer add up to
  // that figure, either the cart was edited after pricing or an add-on was
  // dropped/re-priced in flight — and every downstream figure (this KOT's tax
  // weights, the POS total, the customer's bill) is then describing a
  // different basket. Refuse pre-send rather than transmit it.
  //
  // Only a PRESENT `foodSubtotal` is compared: the engine always writes it, so
  // its absence means a legacy pricing object that predates the field, and
  // there is nothing truthful to compare against.
  const itemsFoodSubtotalPaise = lineInputs.reduce((sum, line) => sum + line.lineValuePaise, 0);
  const declaredFoodSubtotal = presentMoney(
    pricingSource,
    "foodSubtotal",
    "pricing foodSubtotal"
  );
  if (declaredFoodSubtotal !== undefined) {
    if (declaredFoodSubtotal < 0) {
      throw invalidPayload(`pricing foodSubtotal ${declaredFoodSubtotal} is negative`);
    }
    const declaredFoodSubtotalPaise = toPaise(declaredFoodSubtotal);
    if (declaredFoodSubtotalPaise !== itemsFoodSubtotalPaise) {
      throw invalidPayload(
        `add-on reconciliation failed: item lines (unit + add-ons) x qty total ${fromPaise(
          itemsFoodSubtotalPaise
        )} but pricing.foodSubtotal is ${fromPaise(declaredFoodSubtotalPaise)}`,
        "PETPOOJA_ADDON_RECONCILIATION_MISMATCH"
      );
    }
  }

  // Tax is allocated over (line x outlet tax row) in integer paise with the
  // largest-remainder method, so the per-line amounts sum EXACTLY to
  // `tax_total` and the per-row amounts sum exactly to it as well. Weights are
  // the line value — unit price PLUS add-ons (which line bears the tax) — and
  // the row's declared rate (how the outlet splits it). Nothing is re-priced:
  // the authoritative total is untouched.
  const rateWeights = branchTaxes.map((t) => Math.round(t.rate * 100));
  const linePaise = lineInputs.map((line) => line.lineValuePaise);
  const rateWeightTotal = rateWeights.reduce((sum, weight) => sum + weight, 0);
  const lineWeightTotal = linePaise.reduce((sum, weight) => sum + weight, 0);
  if (gstPaise > 0) {
    if (branchTaxes.length === 0) {
      throw invalidPayload("GST is charged but no outlet tax rows could be resolved");
    }
    if (rateWeightTotal <= 0) {
      throw invalidPayload("GST is charged but the outlet tax rows declare no positive rate");
    }
    if (lineWeightTotal <= 0) {
      throw invalidPayload("GST is charged but the item lines total zero");
    }
  }
  const taxCellWeights: number[] = [];
  for (let lineIndex = 0; lineIndex < lineInputs.length; lineIndex++) {
    for (let rowIndex = 0; rowIndex < branchTaxes.length; rowIndex++) {
      taxCellWeights.push(linePaise[lineIndex] * rateWeights[rowIndex]);
    }
  }
  const taxCells = allocatePaise(gstPaise, taxCellWeights);
  if (!taxCells) {
    throw invalidPayload("GST cannot be allocated across the outlet tax rows");
  }
  const rowTaxPaise = branchTaxes.map((_, rowIndex) =>
    lineInputs.reduce(
      (sum, _line, lineIndex) =>
        sum + taxCells[lineIndex * branchTaxes.length + rowIndex],
      0
    )
  );

  const orderItems = lineInputs.map(({ item, unit, qty, addons }, lineIndex) => {
    const lineTaxStart = lineIndex * branchTaxes.length;
    return {
      // ---- official V2.1.0 OrderItem names ----
      id: linePetpoojaItemId(item, firestoreBranchId),
      name: item.name,
      price: money(unit),
      // `final_price` is a UNIT figure — "Item Price - Item level discount if
      // any" (vendor "API Guide for Placing Orders on Petpooja POS", p.6), and
      // the same guide's OrderItem example (p.5) pairs price "250" with
      // final_price "250" at quantity "2". The previous builder emitted the LINE
      // total (unit x qty), which halved the POS view of every multi-quantity
      // line. Quantity now multiplies nothing here; the order total continues to
      // carry the quantity (see `quantity` below and `Order.total`).
      final_price: money(unit),
      quantity: String(qty),
      // Vendor mail 28 Oct 2026: GST liability is the RESTAURANT including
      // item tax and any fee GST actually charged.
      gst_liability: "restaurant",
      // The line price we send is EX-GST (see the money block above): the
      // server engine ADDS 5% GST on top of the discounted food subtotal to
      // reach `grandTotal`. Declaring `true` told the POS the item price
      // already contained the tax, so it backed the GST out a second time.
      // The sandbox runner computes its GST on top of item prices too, and also
      // declares `false`.
      tax_inclusive: false,
      // Petpooja expects the line's own tax. It was omitted entirely, so every
      // line reached the POS untaxed even though the order carried a tax total.
      tax_percentage: String(branchTaxPct),
      item_discount: money(0),
      item_tax: branchTaxes.map((t, rowIndex) => ({
        id: t.id,
        name: t.name,
        tax_percentage: String(t.rate),
        amount: fromPaise(taxCells[lineTaxStart + rowIndex]),
      })),
      variation_id: item.petpoojaVariationId || item.variationId || "",
      variation_name: item.petpoojaVariationName || item.variationName || "",
      // The documented OrderItem carries its add-ons as `AddonItem.details`.
      AddonItem: { details: addons },
      // ---- legacy spellings ----
      // The flat contract in the official PDF names this key `addon_items`.
      // It was never emitted, so a POS implementing the documented contract
      // saw every line item as addon-free. Sent alongside the other spellings
      // because the multi-contract relay exists precisely to satisfy
      // whichever contract the target implements.
      addon_items: addons,
      item_id: linePetpoojaItemId(item, firestoreBranchId),
      item_name: item.name,
      addons: addons.map((a: { id: string; name: string; price: string }) => ({
        addon_id: a.id,
        addon_name: a.name,
        price: a.price,
      })),
      // `CartLine` names the flag `veg`; `isVeg` is the legacy spelling. Reading
      // only `isVeg` meant every line was reported as veg.
      item_attribute: (item.isVeg ?? item.veg) !== false ? "1" : "2",
    };
  });

  // Normalized (never invented) contact + the clock fields Save Order marks
  // required. Table number rides along whenever the order carries one —
  // dine-in KOTs are useless to the floor without it.
  const customerPhone = normalizeCustomerPhone(
    order.customerPhone || order.customer?.phone
  );
  const { preorderDate, preorderTime, createdOn } = petpoojaClock();
  const tableNo = order.tableNumber ? String(order.tableNumber).trim() : "";

  // ---------------------------------------------------------------------------
  // The published Orders API — the OpenAPI `OrderInfo` component and that
  // spec's Postman example body — carries every member under
  // `orderinfo.OrderInfo`, and wraps each member in a `details` object, with
  // OrderItem / Tax / Discount holding a `details` ARRAY:
  //
  //   orderinfo.OrderInfo.{Restaurant,Customer,Order,OrderItem,Tax,Discount}
  //
  // BOTH levels are REQUIRED for the payload to be PARSED. Without them the
  // endpoint still answers `success:"1"` but parses nothing: it echoes empty
  // restID/clientOrderID. That was previously misread as "the sandbox endpoint
  // is a stub" — it was this envelope. The live probe in §12 of
  // references/petpooja_save_order_api.md shows the difference directly: empty
  // ids without these levels, our real restID/clientOrderID echoed with them.
  //
  // Note the LIMIT of that evidence: an empty echo proves the payload was not
  // parsed, NOT that no order was registered. The endpoint returns an empty
  // `orderID` even for a fully parsed POST whose order does register (proven
  // against the outlet's Order List, §16.8), so never treat an empty id as
  // proof that nothing landed at the POS.
  // ---------------------------------------------------------------------------
  const restaurantDetails = {
    // The authoritative restaurant identifier in this contract. Fail-closed:
    // this is the verified branch.petpoojaStoreId, never a guess.
    restID: resId,
    resID: resId,
    res_name: branch?.name || "Burgonomics",
    address: branch?.address || "",
    contact_information: branch?.phone || "",
  };

  // The delivery app saves the address at `deliveryAddress` (full/line1);
  // counter/legacy orders at `address.street`. Read both so the rider never
  // gets a KOT with an empty address. Never invent one.
  const customerAddress =
    orderTypeLegacy === "1"
      ? order.deliveryAddress?.full ||
        order.deliveryAddress?.line1 ||
        order.address?.street ||
        order.customerAddress ||
        ""
      : "";

  const customerDetails = {
    name: order.customerName || order.customer?.name || "Customer",
    phone: customerPhone,
    address: customerAddress,
    email: order.customerEmail || order.customer?.email || "",
    latitude: "",
    longitude: "",
  };

  const orderDetails = {
    orderID: order.orderNumber || order.id,
    clientOrderID: order.id,
    // Documented letter code (H/P/D); the numeric form stays as a legacy alias
    // for POS parsers that still read it.
    order_type: orderTypeCode,
    order_type_legacy: orderTypeLegacy,
    // Petpooja accepts COD / CARD / ONLINE only.
    payment_type: paymentType,
    total: money(grandTotal),
    tax: money(gstAmount),
    tax_total: money(gstAmount),
    // Vendor mail 28 Oct 2026: a COD order's `collect_cash` must equal the
    // order total; an already-paid order must not ask the counter for the money
    // again. Both are the SAME serialized amount/zero — the wire name is the
    // documented V2.1.0 `collect_cash` (API docs line 5381), never a new case
    // variant.
    collect_cash: paymentType === "COD" ? money(grandTotal) : money(0),
    discount: money(discountAmount),
    // Discounts are sent as discount_type + discount_total (spec §8).
    discount_type: "F",
    discount_total: money(discountAmount),
    delivery_charges: money(deliveryFee),
    packing_charges: money(packagingFee),
    service_charge: money(0),
    // advanced_order "N" = immediate order (we never schedule), so preorder_*
    // describe "now", never a fake slot.
    advanced_order: "N",
    preorder_date: preorderDate,
    preorder_time: preorderTime,
    created_on: createdOn,
    // Delivery/packing/service charges carry NO GST in the server pricing
    // engine (`pricing.engine.ts` taxes the discounted food subtotal only), so
    // the documented required fee-tax scalars are truthfully zero. No
    // `dc_gst_details`/`pc_gst_details` array is invented: there is no fee tax
    // to split, and a rate here would be a fabricated liability.
    dc_tax_percentage: "0",
    dc_tax_amount: money(0),
    pc_tax_percentage: "0",
    pc_tax_amount: money(0),
    sc_tax_amount: money(0),
    min_prep_time: "0",
    // Riders are always third-party (Porter/Borzo/Shadowfax), never ours.
    enable_delivery: "0",
    // The spec documents the callback on Order.details, and that is where the
    // POS reads the URL it POSTs order-status updates (Accept / Food Ready /
    // Reject) to. Emitting it only at the top level — as this builder used to —
    // is consistent with no status callback ever reaching our webhook.
    callback_url: getCallbackUrl(),
    ...(tableNo ? { table_no: tableNo } : {}),
    // ---- legacy aliases (absent from the documented contract; ignorable) ----
    // resID must be the verified branch.petpoojaStoreId — no fallback chain,
    // because a wrong resID sends the KOT to the wrong kitchen.
    resID: resId,
    restID: resId,
    customer_name: order.customerName || order.customer?.name || "Customer",
    // Never invent a phone number: an empty string fails visibly at Petpooja
    // instead of dispatching a rider to a fake contact. Counter orders must
    // capture a real number (Partner modal enforces this for delivery).
    customer_phone: customerPhone,
    customer_address: customerAddress,
  };

  // Official Tax[] shape: id / title / type / price / tax / restaurant_liable_amt.
  // The ids must name rows that exist on the outlet; the previous payload sent
  // the labels "cgst"/"sgst", which match no tax row, and omitted
  // `restaurant_liable_amt`. Each row's amount is the SUM OF THE ACTUAL LINE
  // ROW AMOUNTS above (paise-exact), and the restaurant is liable for it —
  // vendor mail 28 Oct 2026.
  const taxDetails = branchTaxes.map((t, rowIndex) => ({
    id: t.id,
    title: t.name,
    type: "P",
    price: `${t.rate}%`,
    tax: fromPaise(rowTaxPaise[rowIndex]),
    restaurant_liable_amt: fromPaise(rowTaxPaise[rowIndex]),
  }));

  return {
    // callback_url tells Petpooja where to POST KOT status updates
    // (accept/reject/ready/delivered). Without it our webhook is unreachable.
    callback_url: getCallbackUrl(),
    // The API guide's flat contract marks customer `name`/`address` and
    // `restID` as required TOP-LEVEL fields; the published API carries them
    // under orderinfo.OrderInfo instead. Unknown keys are ignored, so both are
    // safe and either contract is satisfied.
    name: order.customerName || order.customer?.name || "Customer",
    phone: customerPhone,
    email: order.customerEmail || order.customer?.email || "",
    latitude: "",
    longitude: "",
    res_name: branch?.name || "Burgonomics",
    address: branch?.address || "",
    contact_information: branch?.phone || "",
    restID: resId,
    orderinfo: {
      OrderInfo: {
        Restaurant: { details: restaurantDetails },
        Customer: { details: customerDetails },
        Order: { details: orderDetails },
        OrderItem: { details: orderItems },
        Tax: { details: taxDetails },
        // The contract defines no `Discount` object — discounts are the
        // `discount_type` + `discount_total` scalars on Order (spec §8) — but
        // the documented example body includes the member, so it is declared
        // empty rather than omitted.
        Discount: { details: [] },
      },
      // ---- legacy aliases ----
      // The members directly under `orderinfo` (the shape this builder used
      // before the missing OrderInfo level was found) plus the flat-PDF
      // spellings the POS parser may still read.
      Customer: customerDetails,
      Order: orderDetails,
      OrderItem: orderItems,
      Tax: taxDetails,
      // Legacy flat aliases MUST agree with the documented Tax[] above: the old
      // hardcoded CGST/SGST 2.5 pair disagreed with any outlet whose rows differ
      // (and with a zero-GST order). Derived, never re-typed.
      tax_details: taxDetails.map((t) => ({
        tax_name: t.title,
        tax_percent: Number(String(t.price).replace("%", "")),
        tax_amount: Number(t.tax),
      })),
      order_items: orderItems,
      items: orderItems,
    },
  };
}

// ---------------------------------------------------------------------------
// Failure classification
//
// The axis that matters for a KOT is NOT "did the call fail" but "may the POS
// have received the order". A duplicate KOT rings the kitchen twice and cannot
// be undone from our side, so ONLY work that provably never attempted a send
// may be retried automatically.
//
//  - pre_send     : thrown BEFORE fetch() is invoked (missing branch config,
//                   payload/validation error). Provably nothing was sent, so
//                   the durable send intent may be resolved as unsent and a
//                   bounded retry is safe.
//  - pre_send_terminal: also provably unsent, but the CAUSE is the order data
//                   itself (no tender, no server pricing, add-ons that do not
//                   reconcile, no outlet tax rows). Re-POSTing the same document
//                   can never succeed, so it is parked `failed` for a human
//                   instead of burning the retry budget and dead-lettering.
//  - possibly_sent: ANY post-fetch outcome that is not the one documented
//                   explicit refusal — timeout, abort, socket error, any
//                   non-2xx status (including 429), unreadable/empty/unknown
//                   2xx body, ACK received but not persisted. NEVER auto-retry.
//  - rejected     : ONLY the documented SaveOrderResponse refusal, success:"0".
//                   The POS parsed the payload and refused it; nothing was
//                   registered, so park terminal `failed` (manual payload fix).
//
// Redirects are disabled on the mutating POST (`redirect: "error"`); even a
// DNS/TLS error can otherwise be reported by a redirect target, so no
// transport code is treated as proof that nothing was transmitted.
// ---------------------------------------------------------------------------

export type PetpoojaPushFailureClass =
  | "pre_send"
  | "pre_send_terminal"
  | "possibly_sent"
  | "rejected";

/** Operator-visible state for an outcome that may already be at the POS. */
export const RECONCILIATION_REQUIRED = "reconciliation_required";

// A send intent is written in the SAME transaction that takes the push claim,
// BEFORE fetch(). It never expires: its only purpose is to make a later caller
// fail closed if the outcome record could not be written.
export const SEND_INTENT_IN_FLIGHT = "in_flight";
export const SEND_INTENT_AMBIGUOUS = "ambiguous";
export const SEND_INTENT_ACCEPTED = "accepted";
export const SEND_INTENT_REJECTED = "rejected";
export const SEND_INTENT_PROVABLY_UNSENT = "provably_unsent";

const PUSH_CLAIM_TTL_MS = 10 * 60 * 1000;

/** Numeric-first lease read: serverTimestamp sentinels have no toMillis. */
function leaseAgeMs(raw: any, now: number): number {
  const claimedAt =
    typeof raw === "number" && Number.isFinite(raw)
      ? raw
      : raw && typeof raw.toMillis === "function"
        ? raw.toMillis()
        : 0;
  return now - claimedAt;
}

function isFreshPushClaim(data: any, now: number = Date.now()): boolean {
  const raw = data?.petpoojaPushClaimedAt;
  return !!raw && leaseAgeMs(raw, now) < PUSH_CLAIM_TTL_MS;
}

/**
 * The scheduler's `processing` + `petpoojaClaimedAt` lease. A stale one is
 * legacy evidence of a worker that died mid-push; TTL expiry alone never
 * proves that its attempt was pre-send.
 */
function isFreshSchedulerClaim(data: any, now: number = Date.now()): boolean {
  const raw = data?.petpoojaClaimedAt;
  return !!raw && leaseAgeMs(raw, now) < PUSH_CLAIM_TTL_MS;
}

export interface PetpoojaPushEvidence {
  httpStatus?: number;
  responseBody?: string;
}

/**
 * Structured push failure. Carries the classification and the response
 * evidence through the catch path so the persisted ambiguity record names the
 * exact attempt and what the vendor said.
 */
export class PetpoojaPushFailure extends Error {
  readonly failureClass: PetpoojaPushFailureClass;
  readonly evidence: PetpoojaPushEvidence;

  constructor(
    message: string,
    failureClass: PetpoojaPushFailureClass,
    evidence: PetpoojaPushEvidence = {}
  ) {
    super(message);
    this.name = "PetpoojaPushFailure";
    this.failureClass = failureClass;
    this.evidence = evidence;
  }
}

/** Safe body snippet: `response.json()` may legally yield undefined. */
export function petpoojaBodySnippet(value: any): string | undefined {
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" ? json.slice(0, 500) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The documented SaveOrder refusal body, exactly: HTTP 400 with
 * `success:"0"` (numeric 0 normalised), optionally carrying message /
 * errorCode / validation_errors. A success that is not strictly "0", a
 * contradictory `status:"success"`, or an echoed non-empty POS order id is
 * NOT a definitive refusal — it must stay ambiguous.
 */
export function isStrictPetpoojaRefusal(body: any): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const strictRefusal = body.success === "0" || body.success === 0;
  if (!strictRefusal) return false;
  if (body.status === "success") return false;
  const echoedOrderId =
    body.orderID || body.order_id || body.orderId || body.petpooja_order_id;
  if (typeof echoedOrderId === "string" && echoedOrderId.trim() !== "") return false;
  return true;
}

/** Reads a response body once; non-JSON/unreadable bodies yield undefined. */
async function readPetpoojaResponseBody(response: any): Promise<any | undefined> {
  try {
    if (typeof response?.json === "function") return await response.json();
  } catch {
    // Fall through to text/JSON parsing for gateways that require it.
  }
  try {
    if (typeof response?.text === "function") {
      const raw = await response.text();
      return raw ? JSON.parse(raw) : undefined;
    }
  } catch {
    // Not JSON — the caller treats this as an unknown outcome.
  }
  return undefined;
}

/**
 * TRUE when the order's send outcome is unknown and must be reconciled by a
 * human before ANY further POST. A recorded acceptance always wins: in that
 * case the KOT is already at the kitchen and the caller dedupes instead.
 *
 * Shared with the retry scheduler so the query-level guard and the push-level
 * guard cannot drift apart.
 */
export function isPetpoojaAmbiguousOutcome(data: any): boolean {
  if (!data) return false;
  if (data.petpoojaOrderId || data.petpoojaAcceptedNoId) return false;
  return (
    data.petpoojaStatus === RECONCILIATION_REQUIRED ||
    data.petpoojaSyncStatus === RECONCILIATION_REQUIRED ||
    data.petpoojaAmbiguousSend === true ||
    // Written by the crash/lease-recovery path: same operator meaning (the
    // pusher died mid-flight, so the POS may hold the order).
    data.petpoojaAmbiguousProcessing === true
  );
}

/**
 * TRUE while a durable send intent has not been resolved by a recorded
 * acceptance, the documented refusal, or a provably pre-send failure.
 *
 * This flag NEVER expires. It is written in the claim transaction before the
 * fetch, so even if every catch-path write fails the next caller is blocked.
 * The only way out is explicit operator reconciliation: clear the flag after
 * verifying the POS (there is deliberately no bypass endpoint).
 */
export function hasUnresolvedPetpoojaSendIntent(data: any): boolean {
  if (!data) return false;
  // A recorded acceptance is terminal truth regardless of stale intent fields.
  if (data.petpoojaOrderId || data.petpoojaAcceptedNoId) return false;
  return (
    data.petpoojaUnresolvedIntent === true ||
    data.petpoojaSendIntentState === SEND_INTENT_IN_FLIGHT ||
    data.petpoojaSendIntentState === SEND_INTENT_AMBIGUOUS
  );
}

/**
 * The single blocking predicate used by the push handler AND the scheduler:
 * either an unknown outcome marker or an unresolved send intent forbids a POST.
 */
export function isPetpoojaPushBlocked(data: any): boolean {
  return isPetpoojaAmbiguousOutcome(data) || hasUnresolvedPetpoojaSendIntent(data);
}

/**
 * A pending_retry doc may be retried automatically ONLY when its last failure
 * was provably pre-send. Legacy `pending_retry` rows written by the old code
 * (post-send timeout/5xx) have no such marker and must be quarantined instead
 * of re-POSTed.
 */
export function isProvablyUnsentPetpoojaRetry(data: any): boolean {
  if (!data) return false;
  if (data.petpoojaStatus !== "pending_retry") return false;
  if (isPetpoojaPushBlocked(data)) return false;
  return (
    data.petpoojaSendIntentState === SEND_INTENT_PROVABLY_UNSENT &&
    data.petpoojaUnresolvedIntent !== true
  );
}

/**
 * Persisted shape for a failed attempt. Kept in one place so the transactional
 * and fallback paths cannot disagree.
 *
 * `attemptId` is the identity of the attempt that produced the evidence;
 * `petpoojaRetryCount` is only advanced for retryable pre-send failures.
 * A possibly-sent failure deliberately leaves the send intent UNRESOLVED.
 */
export function buildPetpoojaFailureWrite(
  failureClass: PetpoojaPushFailureClass,
  err: any,
  attemptId: string,
  nextRetryCount: number
): Record<string, any> {
  const evidence = err instanceof PetpoojaPushFailure ? err.evidence : {};
  const base = {
    lastPetpoojaError: err?.message || String(err),
    petpoojaAttemptId: attemptId,
    petpoojaPushClaimedAt: null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (failureClass === "possibly_sent") {
    return {
      ...base,
      petpoojaStatus: RECONCILIATION_REQUIRED,
      petpoojaSyncStatus: RECONCILIATION_REQUIRED,
      petpoojaAmbiguousSend: true,
      petpoojaAmbiguousAt: admin.firestore.FieldValue.serverTimestamp(),
      petpoojaAmbiguousHttpStatus: evidence.httpStatus ?? null,
      petpoojaAmbiguousResponse: evidence.responseBody ?? null,
      // NOT resolved. This record is the operator's evidence, but only an
      // explicit human reconciliation may clear the blocking intent.
      petpoojaUnresolvedIntent: true,
      petpoojaSendIntentState: SEND_INTENT_AMBIGUOUS,
      // The scheduler lease belongs to an attempt that is now parked; clear it
      // so an operator's manual recovery starts from a clean state.
      petpoojaClaimedAt: null,
      // Partner-visible "POS sync needs attention", but the text must send
      // staff to reconciliation — NOT to re-entering the KOT, which could
      // duplicate one the POS already has.
      kotSyncFailed: true,
    };
  }

  if (failureClass === "rejected" || failureClass === "pre_send_terminal") {
    return {
      ...base,
      petpoojaStatus: "failed",
      petpoojaSyncStatus: "failed",
      petpoojaRejectedAt: admin.firestore.FieldValue.serverTimestamp(),
      petpoojaRejectedHttpStatus: evidence.httpStatus ?? null,
      petpoojaRejectedResponse: evidence.responseBody ?? null,
      // The data defect itself, so an operator can see WHY without grepping logs.
      ...(failureClass === "pre_send_terminal"
        ? {
            petpoojaPayloadInvalidAt: admin.firestore.FieldValue.serverTimestamp(),
            petpoojaPayloadInvalidCode: typeof err?.code === "string" ? err.code : null,
          }
        : {}),
      petpoojaClaimedAt: null,
      // Provably nothing was registered (documented refusal / refused before the
      // wire), so the intent is resolved — but the row is TERMINAL: no automatic
      // retry can fix a payload the POS refused or order data that is wrong.
      petpoojaUnresolvedIntent: false,
      petpoojaSendIntentState: SEND_INTENT_REJECTED,
      petpoojaSendIntentResolvedAt: admin.firestore.FieldValue.serverTimestamp(),
      kotSyncFailed: true,
    };
  }

  return {
    ...base,
    petpoojaStatus: "pending_retry",
    petpoojaSyncStatus: "pending_retry",
    petpoojaRetryCount: nextRetryCount,
    // Provably pre-send: resolve the intent so the scheduler may retry it.
    petpoojaUnresolvedIntent: false,
    petpoojaSendIntentState: SEND_INTENT_PROVABLY_UNSENT,
    petpoojaSendIntentResolvedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

export async function pushOrderToPetpooja(orderId: string, caller?: StaffCaller): Promise<boolean> {
  const orderDoc = await db.collection("orders").doc(orderId).get();
  if (!orderDoc.exists) {
    throw new Error(`Order ${orderId} does not exist`);
  }

  const order = orderDoc.data()!;
  // Staff boundary: branch-A staff cannot push Branch-B's KOT. System
  // callers (scheduler) pass no caller and skip the check.
  if (caller) await assertOrderBranchAccess(caller, order);
  const branchId = order.branchId;

  // ZERO-MOCK runtime gate: in a declared-production process the mock branch
  // below would stamp a synthetic `pp_kot_*` id and mark the KOT printed when
  // nothing was sent — refuse instead (boot assert is the first line, this is
  // the belt-and-braces check for a config flipped after boot).
  assertLivePetpoojaContext(`KOT push for order ${orderId}`);

  // Idempotency: the relayed marker is written ONLY on a successful push, so
  // its presence IS the already-pushed marker — independent of the status
  // field, which later bookkeeping may have moved off "synced". Replays (a
  // second Razorpay event, a double-tapped KDS button, the retry worker
  // racing a completed push) must never fire a duplicate KOT at the kitchen.
  //
  // TWO accepted shapes, because Petpooja does not always return an id:
  //  - `petpoojaOrderId`  — accepted, POS told us its id.
  //  - `petpoojaAcceptedNoId` — accepted, POS omitted the id (see the ack
  //    handling below). The order IS at the POS either way, so both dedupe.
  if (order.petpoojaOrderId || order.petpoojaAcceptedNoId) {
    console.warn(
      `[Petpooja KOT Push] Order ${orderId} already pushed (${
        order.petpoojaOrderId || "accepted, POS returned no id"
      }) — deduped, no duplicate KOT`
    );
    return true;
  }

  // Identity of THIS attempt, stamped on the durable intent BEFORE fetch and
  // on any failure record. For an ambiguous outcome it is what lets an
  // operator tie the parked state back to one specific request.
  const attemptId = randomUUID();

  // A pending_retry row may only be (re)sent with the POSITIVE pre-send
  // marker. Legacy rows written by the old timeout/5xx catch have no marker
  // (and cleared their claims), so a direct caller could otherwise POST before
  // the worker's quarantine tick ever runs. Refuse at the direct boundary too.
  if (
    order.petpoojaStatus === "pending_retry" &&
    !isProvablyUnsentPetpoojaRetry(order)
  ) {
    console.warn(
      `[Petpooja KOT Push] Order ${orderId} is pending_retry WITHOUT positive pre-send evidence (legacy outcome unknown) — refusing direct POST; reconcile with Petpooja`
    );
    return false;
  }

  // A LIVE in-flight attempt (fresh claim + in-flight intent) is not a stale
  // unknown outcome: yield to its owner, which will resolve or park it.
  if (order.petpoojaSendIntentState === SEND_INTENT_IN_FLIGHT && isFreshPushClaim(order)) {
    console.warn(
      `[Petpooja KOT Push] Order ${orderId} push already in flight — yielding to the owner`
    );
    return true;
  }

  // Stale `processing` lease (legacy worker died mid-push). A stale timestamp
  // is NOT proof that nothing was transmitted — refuse rather than takeover.
  // A FRESH processing lease is the scheduler calling this push right now.
  if (
    order.petpoojaStatus === "processing" &&
    !isFreshSchedulerClaim(order)
  ) {
    console.warn(
      `[Petpooja KOT Push] Order ${orderId} has a stale PROCESSING claim (legacy timestamp only) — refusing takeover; reconcile with Petpooja`
    );
    return false;
  }

  // Unresolved-intent / ambiguous guard: a previous attempt may already be at
  // the POS. Any further POST could duplicate the KOT, so refuse before taking
  // a claim or touching the network. The accepted dedupe above runs FIRST — an
  // accepted order is not blocked, it is done.
  if (isPetpoojaPushBlocked(order)) {
    console.warn(
      `[Petpooja KOT Push] Order ${orderId} has an UNRESOLVED/UNKNOWN POS outcome (${RECONCILIATION_REQUIRED}) — refusing to POST again; reconcile with Petpooja by hand`
    );
    return false;
  }

  // Transactional claim (finding: duplicate-KOT race): the read above is
  // NOT a lock — `payment.captured` + `order.paid` webhooks, a KDS double
  // tap, and the retry worker can all pass the dedupe concurrently and each
  // POST a KOT, ringing the kitchen N times for one paid order. This claim
  // serializes them exactly like the scheduler's pending_retry lease, on a
  // DEDICATED field (petpoojaPushClaimedAt) so the scheduler's own
  // petpoojaClaimedAt lease (taken BEFORE it calls this function) is never
  // mistaken for a competing push. Datastores without runTransaction keep
  // the read-based dedupe above (best effort, same as the scheduler).
  if (db && typeof (db as any).runTransaction === "function") {
    let claim: "claimed" | "dup" | "busy" | "gone" | "blocked" | "legacy_claim";
    try {
      claim = await (db as any).runTransaction(async (tx: any) => {
        const fresh = await tx.get(orderDoc.ref);
        const data = (fresh.exists ? fresh.data() : undefined) as any;
        if (!data) return "gone";
        // A racing caller finished the push while we were reading — reuse
        // its outcome, never POST a second KOT. Both accepted shapes count.
        if (data.petpoojaOrderId || data.petpoojaAcceptedNoId) return "dup";
        // Re-check the positive retry-safety marker against the FRESH doc:
        // a legacy pending_retry row may have been written between our
        // pre-read and this claim, and it must never reach the wire.
        if (
          data.petpoojaStatus === "pending_retry" &&
          !isProvablyUnsentPetpoojaRetry(data)
        ) {
          return "blocked";
        }
        // FRESH lease: another caller is transmitting right now. Yield to it
        // (return true — "not ours to send"), even though its in-flight intent
        // correctly blocks a takeover. The owner will resolve or park it.
        if (isFreshPushClaim(data)) return "busy";
        // A stale `processing` scheduler lease is a legacy crash signal. The
        // scheduler calls this function immediately after claiming (fresh),
        // so a stale one is never the legitimate owner.
        if (data.petpoojaStatus === "processing" && !isFreshSchedulerClaim(data)) {
          return "blocked";
        }
        // A STALE/absent lease with an unresolved intent or unknown outcome
        // means a previous attempt may already be at the POS. TTL expiry is
        // never proof of non-transmission — refuse the claim.
        if (isPetpoojaPushBlocked(data)) return "blocked";
        if (data.petpoojaPushClaimedAt) {
          // A stale claim with no positive proof that its attempt was
          // pre-send is LEGACY evidence of a pusher that may have sent the
          // order before dying. Never take it over. A provably-unsent retry
          // carries the positive marker (and normally has its claim cleared).
          const provablyUnsent =
            data.petpoojaSendIntentState === SEND_INTENT_PROVABLY_UNSENT &&
            data.petpoojaUnresolvedIntent !== true;
          if (!provablyUnsent) return "legacy_claim";
        }
        // DURABLE SEND INTENT, committed atomically with the claim and BEFORE
        // fetch(). If every later write fails (crash, Firestore outage), this
        // non-expiring marker is what stops a later caller from re-POSTing an
        // order the POS may already hold. Only an accepted/rejected/provably
        // pre-send write below may resolve it.
        tx.set(
          orderDoc.ref,
          {
            petpoojaPushClaimedAt: Date.now(),
            petpoojaAttemptId: attemptId,
            petpoojaUnresolvedIntent: true,
            petpoojaSendIntentState: SEND_INTENT_IN_FLIGHT,
            petpoojaSendIntentAt: Date.now(),
          },
          { merge: true }
        );
        return "claimed";
      });
    } catch (err: any) {
      console.warn(
        `[Petpooja KOT Push] claim transaction failed for order ${orderId} — skipping push:`,
        err?.message || err
      );
      return false;
    }
    if (claim === "dup") {
      console.warn(
        `[Petpooja KOT Push] Order ${orderId} already pushed by a concurrent caller — deduped, no duplicate KOT`
      );
      return true;
    }
    if (claim === "busy") {
      // The in-flight owner either completes (KOT at the kitchen) or its
      // catch below parks a retryable/ambiguous outcome — either way this
      // caller must not stack a second POST on top of it.
      console.warn(
        `[Petpooja KOT Push] Order ${orderId} push already in flight — yielding to the owner`
      );
      return true;
    }
    if (claim === "blocked") {
      console.warn(
        `[Petpooja KOT Push] Order ${orderId} became UNRESOLVED-outcome during the claim — refusing to POST; reconcile with Petpooja`
      );
      return false;
    }
    if (claim === "legacy_claim") {
      console.warn(
        `[Petpooja KOT Push] Order ${orderId} has a stale LEGACY push claim with no provable pre-send evidence — refusing TTL takeover; reconcile with Petpooja`
      );
      return false;
    }
    if (claim === "gone") {
      console.warn(`[Petpooja KOT Push] Order ${orderId} vanished before push — refusing`);
      return false;
    }
  } else {
    // Fail closed. Without a transaction there is no atomic check-and-claim,
    // so a raw pre-fetch write is not fencing and two callers can both reach
    // the wire. Production Firestore supports transactions; exotic datastores
    // must not get a best-effort duplicate-KOT path.
    console.warn(
      `[Petpooja KOT Push] Order ${orderId} — runTransaction unavailable, refusing to transmit without an atomic send intent`
    );
    return false;
  }

  // Mock Mode Return
  if (config.mock.petpoojaPos) {
    const mockPetpoojaOrderId = `pp_kot_${Date.now()}`;
    await orderDoc.ref.set(
      {
        petpoojaOrderId: mockPetpoojaOrderId,
        petpoojaStatus: "synced",
        petpoojaSyncStatus: "synced",
        petpoojaMock: true,
        // Mock delivery is not physical-printer proof; kotPrinted is never
        // manufactured. Genuine terminal printer evidence is left untouched.
        kotPushedAt: admin.firestore.FieldValue.serverTimestamp(),
        petpoojaPushClaimedAt: null,
        petpoojaUnresolvedIntent: false,
        petpoojaSendIntentState: SEND_INTENT_ACCEPTED,
        petpoojaSendIntentResolvedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return true;
  }

  // Flips immediately before `fetch`. Used only as the safe default for an
  // error whose class no throw site could prove: once the request may have
  // left the process, the outcome is unknown until the POS says otherwise.
  let transmissionAttempted = false;

  try {
    let branchData: any = null;
    if (branchId) {
      const branchSnap = await db.collection("branches").doc(branchId).get();
      if (branchSnap.exists) {
        branchData = branchSnap.data();
      }
    }

    const petpoojaConfig = getPetpoojaConfig();

    // Fail-closed: resID must come from branch.petpoojaStoreId only.
    // Fallback chains (branch.id, order.branchId, order.store.*) could send
    // KOT to the wrong outlet — fail instead of guessing.
    const resId = branchData?.petpoojaStoreId;
    if (!resId) {
      await captureErrorSnapshot({
        source: "petpooja",
        severity: "p0_critical",
        message: `Order ${orderId} missing branch.petpoojaStoreId — cannot push KOT to unknown outlet`,
        orderId,
        branchId,
      });
      const err: any = new Error("Branch Petpooja Store ID not configured — cannot push KOT");
      err.statusCode = 503;
      throw err;
    }

    const payload = formatPetpoojaOrderPayload(order, branchData, resId, branchId);

    // Debug visibility: missing contact or zero totals push a broken KOT that
    // looks successful. Flag loudly instead of masking with fallbacks.
    if (!payload.orderinfo.Order.customer_phone) {
      await captureErrorSnapshot({
        source: "petpooja",
        severity: "medium",
        message: `KOT push for order ${orderId} has no customer phone — rider contact will fail`,
        orderId,
        branchId,
      });
    }
    if (!(Number(payload.orderinfo.Order.total) > 0)) {
      await captureErrorSnapshot({
        source: "petpooja",
        severity: "medium",
        message: `KOT push for order ${orderId} resolved total=0 — pricing data missing upstream`,
        orderId,
        branchId,
      });
    }

    // From here on the request may cross the wire. Every post-fetch outcome
    // that is not the documented refusal or a recognised acceptance is
    // fail-closed as `possibly_sent`.
    transmissionAttempted = true;

    let response: any;
    try {
      response = await fetch(petpoojaConfig.orderUrl, {
        method: "POST",
        // A mutating POST must never follow a redirect: following one could
        // transmit the order to a different endpoint and makes every transport
        // error ambiguous. `error` rejects instead.
        redirect: "error",
        // Loop: hung gateway held the function until platform timeout.
        signal: AbortSignal.timeout(15_000),
        headers: {
          "Content-Type": "application/json",
          Content_key: petpoojaConfig.appKey,
          Authorization: `Bearer ${petpoojaConfig.accessToken}`,
        },
        body: JSON.stringify({
          app_key: petpoojaConfig.appKey,
          app_secret: petpoojaConfig.appSecret,
          access_token: petpoojaConfig.accessToken,
          ...payload,
        }),
      });
    } catch (fetchErr: any) {
      // No transport code is treated as proof of non-transmission: DNS/TLS
      // errors can be produced on behalf of a redirect/proxy hop. Fail closed.
      throw new PetpoojaPushFailure(
        `Petpooja KOT push transport error (outcome unknown): ${fetchErr?.message || fetchErr}`,
        "possibly_sent"
      );
    }

    // TRANSPORT TRUTH, before any body parsing. The ack below inspects only the
    // JSON body, so an HTTP failure whose body still says success:"1" - a
    // gateway/proxy error page, a WAF interstitial, a 5xx from a half-broken
    // upstream - was accepted as a registered KOT. That is a fabricated success:
    // the order is marked synced and the claim released, so the retry worker
    // never looks at it again.
    //
    // HTTP status is NOT a retry signal. The ONE documented non-2xx refusal is
    // the SaveOrder 400 body `{success:"0", message, errorCode, validation_errors}`
    // (PETPOOJA API Docs 7027-7042): the POS answered and refused, so nothing
    // was registered. Any other non-2xx — including 400 without a strict
    // success:"0", any 429, and all 5xx/gateway responses — may have reached
    // the POS and remains ambiguous.
    if (!response.ok) {
      const httpStatus = Number(response.status) || 0;
      const body = await readPetpoojaResponseBody(response);
      const bodySnippet = petpoojaBodySnippet(body);
      if (httpStatus === 400 && isStrictPetpoojaRefusal(body)) {
        throw new PetpoojaPushFailure(
          typeof body.message === "string" && body.message
            ? body.message
            : "Petpooja KOT push rejected by POS server (HTTP 400)",
          "rejected",
          { httpStatus, responseBody: bodySnippet }
        );
      }
      throw new PetpoojaPushFailure(
        `Petpooja KOT push HTTP ${response.status ?? "(no status)"}${
          response.statusText ? ` ${response.statusText}` : ""
        } — outcome unknown, the request may have reached the POS`,
        "possibly_sent",
        { httpStatus, responseBody: bodySnippet }
      );
    }

    let result: any;
    try {
      result = await response.json();
    } catch (parseErr: any) {
      // A 2xx we cannot read is still a 2xx: the POS may have registered the
      // order. Never retry this automatically.
      throw new PetpoojaPushFailure(
        `Petpooja KOT push returned HTTP ${response.status} but the acknowledgement could not be read ` +
          `(${parseErr?.message || parseErr}) — the order may already be registered`,
        "possibly_sent",
        { httpStatus: Number(response.status) || undefined }
      );
    }

    const resultIsObject = !!result && typeof result === "object" && !Array.isArray(result);
    const ackSnippet = petpoojaBodySnippet(result);

    // STRICT SaveOrderResponse contract:
    //   acceptance = success:"1" (numeric 1 is the normalised equivalent)
    //   refusal    = success:"0" (numeric 0 is the normalised equivalent)
    // `success:true`, a missing `success`, `{}`, null, `false`, or
    // `status:"success"` alone are NOT documented acceptances. Contradictory
    // pairs (e.g. success:"0" + status:"success", or success:"1" joined by a
    // non-success status) are ambiguous — never accepted, never terminally
    // rejected.
    const success = resultIsObject ? result.success : undefined;
    const status = resultIsObject ? result.status : undefined;
    const documentedAccept = success === "1" || success === 1;
    const contradictory =
      documentedAccept && status !== undefined && status !== "success";
    const ok = documentedAccept && !contradictory;
    // Shared strict-refusal predicate: success:"0", no contradictory status,
    // and no echoed POS order id.
    const documentedRejection = isStrictPetpoojaRefusal(result);

    // An ack WITHOUT an order id is STILL an accepted relay — proven live.
    // Petpooja's sandbox answers {"success":"1","message":"Your order is
    // saved.","restID":"31z58ciw0h","clientOrderID":"<our id>","orderID":"",
    // "code":200} and leaves `orderID` empty, yet the order DOES register:
    // on 2026-10-17 the customer-visible Order List for 5439 - Burgonomics
    // DEMO [135148] showed every order this relay pushed — the five
    // deliverable scenarios (clientOrderIDs and totals matching exactly:
    // 598.5 / 419 / 283.5 / 252 / 312.95) plus all 34 API-placed records.
    //
    // Two earlier shapes for this branch, both wrong, recorded so it is not
    // re-flipped blind:
    //  1. Fabricate a `pp_<epoch>` id and stamp kotPrinted. The invented id is
    //     truthy, so the dedupe above short-circuited every later attempt —
    //     and it claimed an id the POS never issued.
    //  2. Throw and let the catch below park pending_retry. The order WAS at
    //     the POS, so each retry POSTed it again and rang the kitchen twice.
    // The POS holds the order, so: record acceptance, record that the vendor
    // omitted the id, dedupe on that acceptance, and never invent an id.
    const petpoojaOrderId = resultIsObject
      ? result.petpooja_order_id || result.order_id || result.orderID || result.orderId || ""
      : "";
    if (ok && petpoojaOrderId) {
      try {
        await orderDoc.ref.set(
          {
            petpoojaOrderId,
            petpoojaStatus: "synced",
            petpoojaSyncStatus: "synced",
            // No `kotPrinted`/`kotPrintedAt`: a network ACK only proves the
            // POS cloud accepted the order. Physical printer proof must come
            // from the terminal/printer event and is never manufactured here.
            kotPushedAt: admin.firestore.FieldValue.serverTimestamp(),
            petpoojaPushClaimedAt: null,
            petpoojaUnresolvedIntent: false,
            petpoojaSendIntentState: SEND_INTENT_ACCEPTED,
            petpoojaSendIntentResolvedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      } catch (persistErr: any) {
        // The POS accepted, but we could not record the acceptance. The order
        // IS at the kitchen; retrying would ring it twice. The durable send
        // intent from the claim transaction stays unresolved.
        throw new PetpoojaPushFailure(
          `POS accepted the KOT (HTTP ${response.status}, id ${petpoojaOrderId}) but persisting the acceptance failed: ` +
            `${persistErr?.message || persistErr} — the order may already be at the POS`,
          "possibly_sent",
          { httpStatus: Number(response.status) || undefined, responseBody: ackSnippet }
        );
      }
      return true;
    }
    if (ok) {
      try {
        await orderDoc.ref.set(
          {
            petpoojaAcceptedNoId: true,
            petpoojaAcceptedNoIdAt: admin.firestore.FieldValue.serverTimestamp(),
            // Kept verbatim so an operator can see the vendor really did omit
            // the id rather than trusting our summary of it.
            petpoojaAcceptedNoIdAck: ackSnippet || "",
            petpoojaStatus: "synced",
            petpoojaSyncStatus: "synced",
            // No `kotPrinted`/`kotPrintedAt` here either — see the ID branch.
            kotPushedAt: admin.firestore.FieldValue.serverTimestamp(),
            petpoojaPushClaimedAt: null,
            petpoojaUnresolvedIntent: false,
            petpoojaSendIntentState: SEND_INTENT_ACCEPTED,
            petpoojaSendIntentResolvedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      } catch (persistErr: any) {
        throw new PetpoojaPushFailure(
          `POS accepted the KOT without an order id (HTTP ${response.status}) but persisting the acceptance failed: ` +
            `${persistErr?.message || persistErr} — the order may already be at the POS`,
          "possibly_sent",
          { httpStatus: Number(response.status) || undefined, responseBody: ackSnippet }
        );
      }
      console.warn(
        `[Petpooja KOT Push] Order ${orderId} accepted by POS but the response carried no order id — marked synced (accepted-no-id), NOT queued for retry (a retry would duplicate the KOT)`
      );
      return true;
    }
    // The ONLY documented refusal: success:"0". The POS parsed the payload and
    // said no; nothing was registered, so this is terminal (manual fix), not
    // an ambiguity. A missing/unknown success was already treated as unknown
    // below.
    if (documentedRejection) {
      throw new PetpoojaPushFailure(
        typeof result.message === "string" && result.message
          ? result.message
          : "Petpooja KOT push rejected by POS server",
        "rejected",
        { httpStatus: Number(response.status) || undefined, responseBody: ackSnippet }
      );
    }
    // Readable 2xx that is neither a recognised acceptance nor the documented
    // refusal (`{}`, null, false, unknown success...). The order may have
    // registered — never retry this automatically.
    throw new PetpoojaPushFailure(
      `Petpooja KOT push returned HTTP ${response.status} with an unrecognised acknowledgement ` +
        `(${ackSnippet || "empty body"}) — outcome unknown, the order may already be registered`,
      "possibly_sent",
      { httpStatus: Number(response.status) || undefined, responseBody: ackSnippet }
    );
  } catch (err: any) {
    const failureClass: PetpoojaPushFailureClass =
      err instanceof PetpoojaPushFailure
        ? err.failureClass
        : err?.petpoojaFailureClass === "pre_send_terminal"
          ? "pre_send_terminal"
          : transmissionAttempted
            ? "possibly_sent"
            : "pre_send";
    const errorMessage = err?.message || String(err);

    console.warn(
      `[Petpooja KOT Push Error] Order ${orderId} [${failureClass}] attempt ${attemptId}: ${errorMessage}`
    );

    // Guarded re-read (finding: duplicate-KOT race): if a racing caller's
    // push landed while ours failed, the order IS at the kitchen — never
    // regress it to pending_retry (the retry would ring the kitchen twice)
    // and never lose the winner's synced state. The transaction also reads
    // the FRESH retry count so two concurrent failures don't both write +1
    // off the same stale base. Releases our claim either way.
    let pushedByRacer = false;
    let parked = false;
    const fallbackRetry = (order.petpoojaRetryCount || 0) + 1;
    let retryForSnapshot = fallbackRetry;
    if (db && typeof (db as any).runTransaction === "function") {
      try {
        const outcome = await (db as any).runTransaction(async (tx: any) => {
          const fresh = await tx.get(orderDoc.ref);
          const data = (fresh.exists ? fresh.data() : undefined) as any;
          if (data?.petpoojaOrderId || data?.petpoojaAcceptedNoId) return "won";
          // Only OUR attempt may resolve/overwrite its own intent. An intent
          // owned by a different attempt (or a legacy ambiguity marker) is
          // preserved untouched — its evidence is the operator's only truth.
          const foreignBlocked =
            isPetpoojaPushBlocked(data) && data?.petpoojaAttemptId !== attemptId;
          if (foreignBlocked) return "already_blocked";
          const freshRetry = (Number(data?.petpoojaRetryCount) || 0) + 1;
          retryForSnapshot = freshRetry;
          tx.set(
            orderDoc.ref,
            buildPetpoojaFailureWrite(failureClass, err, attemptId, freshRetry),
            { merge: true }
          );
          return "parked";
        });
        if (outcome === "won") pushedByRacer = true;
        if (outcome === "parked" || outcome === "already_blocked") parked = true;
      } catch (txErr: any) {
        // Transactional write failed — re-read and use the guarded fallback.
        console.warn(
          `[Petpooja KOT Push] guarded failure write failed for order ${orderId}:`,
          txErr?.message || txErr
        );
      }
    }
    if (pushedByRacer) {
      console.warn(
        `[Petpooja KOT Push] Order ${orderId} was pushed by a concurrent caller — keeping synced state, no retry parked`
      );
      return true;
    }

    if (!parked) {
      // FAIL CLOSED ON OUTCOME-WRITE FAILURE. A re-read followed by a raw set
      // is not fencing: a newer attempt can start between the read and the
      // write, and this older attempt would clear/replace its intent. The
      // claim-time durable intent is already on the document, so leave the
      // state untouched and let the next caller fail closed / a human
      // reconcile. Never write an outcome without a successful transaction.
      console.warn(
        `[Petpooja KOT Push] Order ${orderId} outcome write failed — leaving durable send intent unresolved; manual reconciliation required`
      );
    }

    // The message is the operator's first signal: ambiguous records must say
    // "reconcile", never "retry", because a resend could duplicate a KOT the
    // POS already holds.
    const snapshotMessage =
      failureClass === "possibly_sent"
        ? `Petpooja KOT push outcome UNKNOWN for order ${orderId} (attempt ${attemptId}) — parked in ${RECONCILIATION_REQUIRED}, NO automatic resend: ${errorMessage}`
        : failureClass === "rejected"
          ? `Petpooja KOT push definitively REJECTED for order ${orderId} (attempt ${attemptId}) — terminal until the payload is corrected: ${errorMessage}`
          : failureClass === "pre_send_terminal"
            ? `Petpooja KOT push refused BEFORE transmission for order ${orderId} (attempt ${attemptId}) — ORDER DATA must be corrected, no automatic retry: ${errorMessage}`
            : `Petpooja KOT Push failed BEFORE transmission for order ${orderId} (Attempt ${retryForSnapshot}) — safe to retry: ${errorMessage}`;

    await captureErrorSnapshot({
      source: "petpooja",
      severity: failureClass === "pre_send" ? "medium" : "high",
      message: snapshotMessage,
      orderId,
      branchId,
    });

    return false;
  }
}
