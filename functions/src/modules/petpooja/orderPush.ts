import { db } from "../../core/firebase";
import { config, assertLivePetpoojaContext } from "../../config/env";
import { captureErrorSnapshot } from "../../core/errors";
import { getPetpoojaConfig } from "./client";
import * as admin from "firebase-admin";
import { assertOrderBranchAccess, type StaffCaller } from "../../core/middleware";
import { allocatePetpoojaTax, sumPetpoojaItemTax } from "./taxAmounts";
import { petpoojaFinancials, petpoojaGstLiability, restaurantLiableItemTax, type PetpoojaGstLiability } from "./financials";

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

/**
 * H2 — NO INVENTED TAX DEFAULTS. Per-line / per-order tax rows for the KOT
 * must name rows the OUTLET itself declared in its captured menu push
 * (`branches.petpoojaTaxes`, provenance-written by menuSyncWebhook). There is
 * deliberately NO fallback catalogue: the hardcoded CGST 3928 / SGST 3929
 * defaults used before silently invented configuration for an arbitrary
 * branch — a different outlet's real ids differ, and a tax row that names
 * nothing at the POS is parsed or dropped at the vendor's whim. Missing or
 * invalid catalogue → the builder blocks (BLOCKED_CONFIGURATION) until the
 * branch's own menu sync lands truth.
 *
 * The Petpooja tax ids the POS needs must exist on the outlet. The payload
 * also omits `item_tax` from the lines entirely in the old code — every line
 * arrived untaxed while the order still declared a tax total; the per-line
 * rows below are metadata-driven (H1).
 */

function outletTaxes(branch: any): Array<{ id: string; name: string; rate: number }> {
  const declared = Array.isArray(branch?.petpoojaTaxes) ? branch.petpoojaTaxes : [];
  const valid = declared
    .filter(
      (t: any) =>
        t &&
        typeof t === "object" &&
        String(t.id ?? "").trim() !== "" &&
        Number.isFinite(Number(t.rate)) &&
        Number(t.rate) > 0
    )
    .map((t: any) => ({
      id: String(t.id).trim(),
      name: String(t.name ?? ""),
      rate: Number(t.rate),
    }));
  if (valid.length === 0) {
    throw new PetpoojaStructuralError([
      {
        field: "branch.petpoojaTaxes",
        reason:
          `branch ${branch?.id ?? "(unknown)"} has no captured Petpooja tax catalogue ` +
          `(menu push pending or invalid) — required before any KOT push; re-run the branch's own menu sync`,
      },
    ]);
  }
  return valid;
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
 * H3 — TRUSTED RESOLVED MAPPING ONLY (the requested POS item id).
 *
 * The builder NEVER emits an internal id ("line1", a uuid, the app's line id)
 * or a numeric-looking CLIENT-asserted id as a POS id by itself: provenance
 * is the synced vendor metadata of the mapped outlet, not the request.
 *
 * Resolution (fail-closed; the builder is pure — it receives the trusted
 * resolution, it does not fetch):
 *   1. TRUSTED RESOLVED mapping: `item.petpoojaResolvedId`, numeric, set by
 *      the push from the branch's ACTUAL synced product snapshot
 *      (`pushOrderToPetpooja` prefetches outside any transaction — H1/H3).
 *   2. The branch-scoped menu doc id: `productId` must match
 *      `prod_<firestoreBranchId>_<numeric>` EXACTLY; the numeric tail is then
 *      the candidate POS id. Any other prefix/wrong-branch/loose parse blocks.
 *   3. AGREEMENT: a client-stamped `petpoojaItemId` / `meta.petpoojaItemId`
 *      is accepted only when it EQUALS the trusted resolution above. Alone it
 *      proves nothing (no provenance) — missing (1) and (2) block.
 * `""` means "blocked" — the gap always stays visible, never parks silently.
 */
function linePetpoojaItemId(item: any, firestoreBranchId?: string): string {
  const meta = item?.meta || {};
  const declaredCandidates = [item?.petpoojaItemId, meta.petpoojaItemId].filter(
    (c: any) => c !== undefined && c !== null && String(c).trim() !== ""
  ) as string[];

  let resolved = "";
  // 1. Trusted resolved mapping (production prefetch snapshot).
  const trusted = item?.petpoojaResolvedId;
  if (trusted !== undefined && trusted !== null && String(trusted).trim() !== "") {
    if (!isPetpoojaPosId(trusted)) return ""; // non-numeric "resolved" id — not vendor truth
    resolved = String(trusted).trim();
  }
  // 2. Exact branch-scoped product doc id with a numeric tail.
  if (!resolved && firestoreBranchId && typeof item?.productId === "string") {
    const prefix = `prod_${firestoreBranchId}_`;
    const tail = item.productId.startsWith(prefix) ? item.productId.slice(prefix.length) : "";
    if (tail && isPetpoojaPosId(tail)) resolved = tail;
  }
  if (!resolved) return ""; // no provenance — block (gap collector reports below)

  // 3. Client-stamped agreement values must MATCH the trusted resolution —
  //    a disagreement is a mapped-outlet violation, never silently corrected.
  for (const declared of declaredCandidates) {
    if (String(declared) !== resolved) return "";
  }
  return resolved;
}

/** Unit price of a line: the app writes `unitPrice`; legacy shapes write price/basePrice. */
function lineUnitPrice(item: any): number {
  const allIn = item?.unitPrice ?? item?.price;
  if (allIn !== undefined && allIn !== null) return Number(allIn);
  const addons = item?.modifiers ?? item?.selectedAddons ?? [];
  return Number(item?.basePrice ?? 0) + addons.reduce(
    (sum: number, addon: any) => sum + Number(addon.price ?? addon.priceDelta ?? 0), 0
  );
}

/**
 * Structural integrity of the vendor sample (2026-10-26).
 *
 * Petpooja rejected the first five sandbox relays because the payload's
 * STRUCTURE was wrong - the transport answered `success: 1` while the POS
 * parsed nothing that reached the kitchen. Fabricating an identifier is in the
 * same class: a POS id that names no configured menu row is parsed or dropped
 * at the vendor's whim, and acceptance can never be proven. So identifiers are
 * only ever emitted when they RESOLVE to a verified mapping:
 *
 *   - `item.id` must resolve through `linePetpoojaItemId` (menu sync writes
 *     `petpoojaItemId` on every product doc).
 *   - A line carrying add-ons requires a numeric Petpooja addon id and a
 *     numeric Petpooja `group_id` on every modifier ("addon"/"mod_..." internal
 *     fixtures are NOT config).
 *   - A line that variation pricing depends on (`variationRequired` /
 *     a defined POS variation on the source item) requires a real
 *     `petpoojaVariationId`. The sample's own lines carry `""` when the item
 *     has no variants, so empty variation_id without a variation need is
 *     correct - the gate only refuses a VARIANT claim the ids cannot express.
 *
 * The push lane parks such an order `pending_configuration` instead of POSTing
 * a fabricated KOT - vendor re-configuration is the only cure, never a retry.
 */
export interface PetpoojaStructuralGap {
  field: string;
  reason: string;
}

export class PetpoojaStructuralError extends Error {
  readonly code = "BLOCKED_CONFIGURATION";
  readonly gaps: PetpoojaStructuralGap[];
  constructor(gaps: PetpoojaStructuralGap[]) {
    super(
      `Petpooja Save Order payload blocked (BLOCKED_CONFIGURATION): ${gaps
        .map((g) => `${g.field} — ${g.reason}`)
        .join("; ")}`
    );
    this.name = "PetpoojaStructuralError";
    this.gaps = gaps;
  }
}

/** Vendor POS ids are minted by Petpooja (numeric, e.g. "7765862"). */
function isPetpoojaPosId(value: unknown): boolean {
  const s = String(value ?? "").trim();
  return /^\d+$/.test(s) && s.length > 0;
}

/**
 * H1 — per-product tax metadata snapshot shape (the WRITE-ONLY captured
 * fields the menu sync records now actually reach the payload).
 */
export interface PetpoojaProductTaxSnapshot {
  petpoojaItemId: string;
  /** Item's declared tax-row ids, exactly as the outlet menu pushed them. */
  taxIds: string[];
  /** Strict-decode inclusivity: true = tax embedded in price (BLOCKS push). */
  taxInclusive: boolean | null;
  /** Catalogue facts the uniform GST order model cannot represent. */
  taxUnsupported: boolean;
  /** Captured menu ownership: services = integrator; goods = restaurant. */
  gstType?: string | null;
}

/**
 * Verified POS identity of one modifier: reads the vendor-first spellings and
 * falls back to the internal CartModifier ids ONLY when the outlet's own menu
 * pushed a numeric id the sync stored. Anything else is not configuration.
 */
function verifiedAddon(mod: any): { id: string; groupId: number } | null {
  if (!mod || typeof mod !== "object") return null;
  const raw =
    mod.petpoojaAddonId ??
    mod.petpoojaId ??
    mod.addonId ??
    mod.optionPetpoojaId ??
    mod.optionId ??
    mod.id;
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  // A synthetic internal marker ("mod_extra_cheese" / literal "addon") is a
  // placeholder, never a configured POS option.
  if (!isPetpoojaPosId(raw)) return null;
  const groupRaw =
    mod.petpoojaAddonGroupId ?? mod.petpoojaGroupId ?? mod.addonGroupId ?? mod.groupId ?? mod.group_id;
  if (groupRaw === undefined || groupRaw === null) return null;
  const groupId = Number(groupRaw);
  if (!Number.isInteger(groupId) || groupId <= 0) return null;
  return { id: String(raw), groupId };
}


export function formatPetpoojaOrderPayload(
  order: any,
  branch: any,
  resId: string,
  firestoreBranchId?: string,
  orderDocId?: string,
  // H1 — pure product metadata snapshot (prefetched OUTSIDE any transaction
  // by the push caller). The builder consumes it; it never fetches.
  productTaxSnapshots?: PetpoojaProductTaxSnapshot[]
) {
  const fulfillment = (order.fulfillmentType || order.orderType || "DELIVERY").toUpperCase();
  // Official V2.1.0 order_type is a letter code: H (home delivery),
  // P (parcel/takeaway), D (dine-in). The numeric 1/2/3 form the old code sent
  // is not part of the documented contract — both are emitted so the POS
  // parser reads whichever it implements.
  const orderTypeCode =
    fulfillment === "DELIVERY" ? "H" : fulfillment === "TAKEAWAY" || fulfillment === "PICKUP" ? "P" : "D";
  const orderTypeLegacy = fulfillment === "DELIVERY" ? "1" : fulfillment === "TAKEAWAY" || fulfillment === "PICKUP" ? "2" : "3";

  const paymentMethod = (order.paymentMethod || "").toUpperCase();
  // Petpooja accepts COD / CARD / ONLINE. "Prepaid" is NOT a valid value —
  // anything that is not cash on delivery is an online (captured) payment.
  const paymentType = paymentMethod === "COD" || paymentMethod === "CASH" ? "COD" : "ONLINE";

  // Hoisted so each line can carry its own share of the tax: Petpooja expects
  // `item_tax[]` on the line, and a line's share can only be derived once the
  // order's tax total is known.
  const preItems = order.items || [];
  const preGst = (order.pricing || {}).gst ?? order.taxAmount ?? order.tax ?? 0;
  const itemGstAmounts = allocatePetpoojaTax(
    Number(preGst),
    preItems.map((item: any) => lineUnitPrice(item) * (item.quantity || 1))
  );
  const branchTaxes = outletTaxes(branch);
  // H1 — union of the per-item MATCHED tax rows (the order-level Tax member
  // lists exactly the rows the items actually declare, deduped by id).
  const usedTaxRowMap = new Map<string, { id: string; name: string; rate: number }>();

  const orderItems = (order.items || []).map((item: any, itemIndex: number) => {
    const unit = lineUnitPrice(item);
    const qty = Number(item.quantity) || 1;
    // ---- STRUCTURAL GATES (fail closed, 2026-10-26) ----
    // Every gap collects a reason; the whole order (not one line) decides.
    if (!firestoreBranchId) {
      // `linePetpoojaItemId` cannot verify item ids without the branch-scoped
      // menu-id contract (prod_<branchId>_<petpoojaItemId>), and an unverified
      // id must never be sent.
      throw new PetpoojaStructuralError([
        { field: "firestoreBranchId", reason: "missing — Petpooja item ids cannot be verified without the branch-scoped menu mapping" },
      ]);
    }
    const itemPosId = linePetpoojaItemId(item, firestoreBranchId);
    const gaps: PetpoojaStructuralGap[] = [];
    if (itemPosId === "") {
      gaps.push({
        field: "OrderItem.details[].id",
        reason: `item "${item?.name ?? "(unnamed)"}" has no verified Petpooja item id (no menu-sync mapping) — the POS would receive an empty id`,
      });
    }

    // ---- H1 — PRODUCT TAX METADATA (authoritative vendor snapshot only) ----
    // The captured-but-then-ignored product fields are now CONSUMED: each
    // item's tax rows are filtered to its OWN declared ids, resolved strictly
    // against the branch's captured catalogue, and every unrepresentable tax
    // shape BLOCKS before the vendor. No metadata-notice-only toleration.
    let itemTaxRows: Array<{ id: string; name: string; tax_percentage: string; amount: string }> = [];
    let gstLiability: PetpoojaGstLiability | undefined;
    {
      const snapshot = (productTaxSnapshots || []).find(
        (s) => String(s?.petpoojaItemId) === itemPosId
      );
      try {
        gstLiability = petpoojaGstLiability(snapshot?.gstType);
      } catch {
        gaps.push({
          field: `OrderItem.details[](${itemPosId}).gst_liability`,
          reason: "missing or unknown captured item gst_type — refusing to invent GST ownership",
        });
      }
      if (!snapshot || !Array.isArray(snapshot.taxIds)) {
        gaps.push({
          field: `OrderItem.details[](${itemPosId}).taxMetadata`,
          reason: "no product tax metadata snapshot was supplied by the push prefetch — tax rows are not proxy-deliverable",
        });
      } else if (snapshot.taxInclusive === true) {
        gaps.push({
          field: `OrderItem.details[](${itemPosId}).tax_inclusive`,
          reason: "outlet menu declares this item's price TAX-INCLUSIVE — the order push's tax-EXCLUSIVE model cannot represent it honestly; vendor decision needed",
        });
      } else if (snapshot.taxUnsupported === true) {
        gaps.push({
          field: `OrderItem.details[](${itemPosId}).taxUnsupported`,
          reason: "captured menu tax metadata is not representable by the uniform GST order model (mixed/unknown rates) — vendor decision needed",
        });
      } else {
        const matched: Array<{ id: string; name: string; rate: number }> = [];
        for (const taxId of snapshot.taxIds) {
          const row = branchTaxes.find((r) => r.id === String(taxId).trim());
          if (!row) {
            gaps.push({
              field: `OrderItem.details[](${itemPosId}).item_tax`,
              reason: `item declares tax id "${taxId}" that the branch's captured tax catalogue does not publish — refusing guesswork`,
            });
            continue;
          }
          matched.push(row);
        }
        // Representability: the matched rows' rate sum must equal the pricing
        // engine's effective order GST rate (read from the order's OWN pricing
        // — the engine is never re-implemented here). Outside uniform model →
        // block with the exact two rates for the vendor question.
        const pricing_ = order.pricing || {};
        const taxableFood =
          Number(pricing_.foodSubtotal) > 0
            ? Math.max(
                0,
                Number(pricing_.foodSubtotal) -
                  Number(pricing_.discount) -
                  Number(pricing_.loyaltyDiscount)
              )
            : 0;
        const engineRatePct =
          preGst > 0 && taxableFood > 0 ? (Number(preGst) / taxableFood) * 100 : null;
        if (engineRatePct !== null && matched.length > 0) {
          const matchedRateSum = matched.reduce((sum, r) => sum + r.rate, 0);
          if (Math.abs(matchedRateSum - engineRatePct) > 0.05) {
            gaps.push({
              field: `OrderItem.details[](${itemPosId}).item_tax`,
              reason: `matched tax rows sum to ${matchedRateSum}% but the order's GST engine rate is ${engineRatePct.toFixed(
                2
              )}% — not representable by the current uniform model; vendor decision needed`,
            });
          }
        }
        if (matched.length === 0 && Number(preGst) > 0) {
          gaps.push({
            field: `OrderItem.details[](${itemPosId}).item_tax`,
            reason: "positive order GST has no matched tax rows for this item — refusing an untaxed line with a taxed summary",
          });
        }
        // Conserve integer paise across both items and their OWN captured rows.
        // Independent toFixed(gst / 2) lost a paise for GST such as 13.95.
        const amounts = matched.length > 0
          ? allocatePetpoojaTax(itemGstAmounts[itemIndex], matched.map((row) => row.rate)) : [];
        itemTaxRows = matched.map((row, taxIndex) => {
          return {
            id: row.id,
            name: row.name,
            tax_percentage: String(row.rate),
            amount: money(amounts[taxIndex]),
          };
        });
      }
    }
    // A line whose pricing DEPENDS on a variant (the line itself declares the
    // need) must carry a real POS variation id. Empty variation_id without a
    // declared need stays correct per the sample (`variation_id: ""`).
    const variationNeedsId =
      item.variationRequired === true ||
      item.allowVariation === true ||
      item.itemallowvariation === true;
    const variationIdRaw = item.petpoojaVariationId || item.variationId || "";
    if (variationNeedsId && !isPetpoojaPosId(variationIdRaw)) {
      gaps.push({
        field: "OrderItem.details[].variation_id",
        reason: `item "${item?.name ?? "(unnamed)"}" prices a variation but carries no verified Petpooja variation id`,
      });
    }
    // `CartLine.unitPrice` is ALL-IN: the cart stores base + modifier deltas in
    // it, and PaymentRepository persists that same figure as `price`. Petpooja
    // defines `price` as the per-unit value including add-ons, so the add-on
    // rows below are descriptive only and must not be added a second time.
    const modifiers = item.modifiers || item.selectedAddons || [];
    const addons: any[] = [];
    for (const mod of modifiers) {
      const verified = verifiedAddon(mod);
      if (!verified) {
        gaps.push({
          field: "OrderItem.details[].AddonItem",
          reason: `add-on "${mod?.name ?? "(unnamed)"}" has no verified Petpooja addon id / numeric group_id (internal ids are not POS configuration)`,
        });
        continue;
      }
      addons.push({
        // official AddonItem names: id / name / group_name / price / group_id
        id: verified.id,
        name: mod.name,
        group_name: mod.groupName || "Addons",
        // CartModifier carries `priceDelta`; `price` is the legacy spelling.
        price: money(mod.price ?? mod.priceDelta ?? 0),
        // The vendor sample types group_id as an integer, not a string.
        group_id: verified.groupId,
        quantity: "1",
      });
    }

    if (gaps.length > 0) throw new PetpoojaStructuralError(gaps);

    // Union the item's OWN matched rows into the order-level Tax member (H1).
    for (const row of itemTaxRows) {
      if (!usedTaxRowMap.has(row.id)) {
        const src = branchTaxes.find((r) => r.id === row.id)!;
        usedTaxRowMap.set(row.id, src);
      }
    }

    return {
      id: itemPosId,
      name: item.name,
      // Our checkout prices are TAX-EXCLUSIVE: pricing.engine adds 5% GST on
      // top of the net food subtotal. DECELERATED CORRECTNESS: upgrades come
      // from the product snapshot — a tax-inclusive menu shape above BLOCKED
      // the push before this line could ever lie.
      tax_inclusive: false,
      gst_liability: gstLiability!,
      // The item's OWN declared+matched rows only (H1) — never every outlet row.
      item_tax: itemTaxRows,
      // No per-line discount exists in this order model; order-level discounts
      // travel as `discount_type` + `discount_total`. The vendor sample defines
      // `final_price = price - item_discount` — a UNIT figure, not the line
      // total. The old line-total form broke that invariant for qty > 1.
      item_discount: money(0),
      price: money(unit),
      final_price: money(unit),
      quantity: String(qty),
      description: item.notes || item.specialInstructions || "",
      variation_name: item.petpoojaVariationName || item.variationName || "",
      variation_id: item.petpoojaVariationId || item.variationId || "",
      AddonItem: { details: addons },
    };
  });

  const pricing = order.pricing || {};
  const gstAmount = pricing.gst ?? order.taxAmount ?? order.tax ?? 0;
  const deliveryFee = pricing.deliveryFee ?? order.deliveryFee ?? 0;
  const packagingFee = pricing.packagingFee ?? order.packagingFee ?? 0;
  const discountAmount = Number(pricing.discount ?? order.discountAmount ?? 0) + Number(pricing.loyaltyDiscount ?? 0);
  const grandTotal = pricing.grandTotal ?? order.totalAmount ?? order.total ?? 0;
  let financials: ReturnType<typeof petpoojaFinancials>;
  try {
    financials = petpoojaFinancials({
      items: orderItems, discount: discountAmount, packagingFee, deliveryFee,
      customerTotal: grandTotal, isDelivery: fulfillment === "DELIVERY",
      restaurantDelivery: order.dispatchType === "manual_branch_terminal", paymentType,
    });
  } catch (error: any) {
    throw new PetpoojaStructuralError([{ field: "Order.details.total", reason: error.message }]);
  }

  // Normalized (never invented) contact + the clock fields Save Order marks
  // required. Table number rides along whenever the order carries one —
  // dine-in KOTs are useless to the floor without it.
  const customerPhone = normalizeCustomerPhone(
    order.customerPhone || order.customer?.phone
  );
  const { preorderDate, preorderTime, createdOn } = petpoojaClock();
  const tableNo = order.tableNumber ? String(order.tableNumber).trim() : "";

  // ---------------------------------------------------------------------------
  // STRUCTURE IS LOCKED TO THE VENDOR'S OWN SAMPLE (2026-10-26).
  //
  // Petpooja rejected the five sandbox test orders as structurally wrong and
  // sent back the exact body they accept. The whole envelope is:
  //
  //   {
  //     app_key, app_secret, access_token,
  //     orderinfo: {
  //       OrderInfo: { Restaurant, Customer, Order, OrderItem, Tax },
  //       udid: "",
  //       device_type: "Web"
  //     }
  //   }
  //
  // Differences from what this builder used to emit, all of them vendor-driven:
  //   - `udid` / `device_type` belong INSIDE `orderinfo`, not at the root.
  //   - There is no `Discount` member (discounts are the two Order scalars).
  //   - No legacy duplicate members under `orderinfo` (Order/Customer/...);
  //     the POS parser expects every sibling to be `OrderInfo`/`udid`/
  //     `device_type`.
  //   - `final_price` is a UNIT figure (`price - item_discount`), never the
  //     line total.
  //   - `Tax[].price` is the numeric percentage ("2.5"), not "2.5%".
  //   - `enable_delivery`, `min_prep_time`, `urgent_time`, `group_id` are
  //     NUMBERS; `no_of_persons`, `collect_cash`, `otp` are strings.
  //   - Order carries `sc_tax_amount`, `dc_tax_amount`, `pc_tax_amount`,
  //     `dc_gst_details`, `pc_gst_details`, `ondc_bap`, `urgent_order`,
  //     `urgent_time`, `no_of_persons`, `description`, `collect_cash`, `otp`.
  //
  // Alternative spellings documented in the earlier readings (§12 of
  // references/petpooja_save_order_api.md: the top-level echo fields, the
  // `Discount` member, the legacy aliases) are NO LONGER EMITTED — the vendor
  // has now shown, for these exact five cases, that extra/misplaced members are
  // what it calls structural issues, so nothing outside the sample is sent.
  // ---------------------------------------------------------------------------
  const restaurantDetails = {
    // The authoritative restaurant identifier in this contract. Fail-closed:
    // this is the verified branch.petpoojaStoreId, never a guess.
    restID: resId,
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

  const customerLat = order.deliveryAddress?.lat ?? order.address?.lat;
  const customerLng = order.deliveryAddress?.lng ?? order.address?.lng;
  const customerDetails = {
    name: order.customerName || order.customer?.name || "Customer",
    phone: customerPhone,
    address: customerAddress,
    email: order.customerEmail || order.customer?.email || "",
    latitude: customerLat !== undefined && customerLat !== null ? String(customerLat) : "",
    longitude: customerLng !== undefined && customerLng !== null ? String(customerLng) : "",
  };

  const noOfPersons = order.guestCount ?? order.noOfPersons ?? 0;
  const prepTimeMinutes = Number(
    order.prepTimeMinutes ?? branch?.defaultPrepTimeMinutes ?? 0
  );

  const orderDetails = {
    // `orderID` is the CLIENT reference the POS echoes in its order-status
    // callback, and our webhook resolves it with `orders/{orderID}`. It must
    // therefore be the Firestore document id, not the decorative order number.
    orderID: orderDocId || order.id || order.orderNumber || "",
    preorder_date: preorderDate,
    preorder_time: preorderTime,
    service_charge: money(0),
    sc_tax_amount: money(0),
    delivery_charges: money(deliveryFee),
    // Delivery/packing charges carry no separate tax in our pricing engine.
    dc_tax_percentage: "0",
    dc_tax_amount: money(0),
    dc_gst_details: [
      { gst_liable: "vendor", amount: money(0) },
      { gst_liable: "restaurant", amount: money(0) },
    ],
    packing_charges: money(packagingFee),
    pc_tax_amount: money(0),
    pc_tax_percentage: "0",
    pc_gst_details: [
      { gst_liable: "vendor", amount: money(0) },
      { gst_liable: "restaurant", amount: money(0) },
    ],
    // Documented letter code: H (home delivery), P (parcel/takeaway), D (dine-in).
    order_type: orderTypeCode,
    // Not an ONDC order.
    ondc_bap: "",
    // advanced_order "N" = immediate order (we never schedule), so preorder_*
    // describe "now", never a fake slot.
    advanced_order: "N",
    urgent_order: false,
    urgent_time: 0,
    // Petpooja accepts COD / CARD / ONLINE only.
    payment_type: paymentType,
    table_no: tableNo,
    no_of_persons: String(noOfPersons),
    discount_total: money(discountAmount),
    tax_total: money(gstAmount),
    // Discounts are sent as discount_type + discount_total (spec §8).
    discount_type: "F",
    total: financials.total,
    description: order.notes || order.specialInstructions || "",
    created_on: createdOn,
    // The persisted dispatch type, not the sample, identifies merchant riders.
    enable_delivery: financials.enable_delivery,
    min_prep_time: Number.isFinite(prepTimeMinutes) && prepTimeMinutes > 0 ? prepTimeMinutes : 0,
    // The POS reads the URL it POSTs order-status updates (Accept / Food Ready
    // / Reject) from Order.details.
    callback_url: getCallbackUrl(),
    // Only COD merchant self-delivery supports this collection instruction.
    collect_cash: financials.collect_cash,
    // Deliberately empty: the delivery OTP is the customer/rider verification
    // secret and must not be printed on a kitchen ticket.
    otp: "",
  };

  // Official Tax[] shape: id / title / type / price / tax / restaurant_liable_amt.
  // H1: the rows are the UNION of the items' declared+matched tax ids (exactly
  // what the order's lines assert) — not the whole outlet catalogue; an
  // item-less order falls back to the captured branch rows. `price` is the
  // numeric percentage, matching the vendor sample (not "2.5%").
  const orderTaxRows = usedTaxRowMap.size > 0 ? [...usedTaxRowMap.values()] : branchTaxes;
  const taxDetails = orderTaxRows.map((t) => ({
    id: t.id,
    title: t.name,
    type: "P",
    price: String(t.rate),
    // Summary tax includes both ownership modes; restaurant liability is a subset.
    tax: money(sumPetpoojaItemTax(orderItems, t.id)),
    restaurant_liable_amt: money(restaurantLiableItemTax(orderItems, t.id)),
  }));

  return {
    orderinfo: {
      OrderInfo: {
        Restaurant: { details: restaurantDetails },
        Customer: { details: customerDetails },
        Order: { details: orderDetails },
        OrderItem: { details: orderItems },
        Tax: { details: taxDetails },
      },
      // Vendor sample: both are siblings of OrderInfo, inside the `orderinfo`
      // envelope. They used to be emitted at the ROOT, where the POS ignores
      // them.
      udid: "",
      device_type: "Web",
    },
  };
}

const recentBusyPushes = new Map<string, number>();

/**
 * H1/H3 — PRODUCTION PREFETCH (outside any transaction).
 *
 * Resolves each ordered line's product snapshot from the branch-scoped
 * `products` collection (what menuSyncWebhook writes) and verifies the line's
 * POS identity against the ACTUAL synced vendor metadata:
 *   - the product doc must exist for the exact `prod_<branchId>_<id>` doc id;
 *   - its `petpoojaItemId` must be numeric and AGREE with the line's resolved
 *     id (a client/product disagreement blocks);
 *   - the doc must belong to the order's branch (mapped-outlet check);
 *   - the RETURNED value is a pure metadata snapshot list (tax ids/labels/
 *     inclusivity/unsupported) the builder joins per item.
 * Any missing/malformed/mismatched line throws PetpoojaStructuralError: the
 * push blocks before the vendor — never a notice-only decoration.
 */
export async function resolveTrustedProductSnapshots(
  lines: any[],
  firestoreBranchId: string
): Promise<PetpoojaProductTaxSnapshot[]> {
  const snapshots: PetpoojaProductTaxSnapshot[] = [];
  const gaps: PetpoojaStructuralGap[] = [];
  const seen = new Set<string>();
  for (const item of lines || []) {
    if (!item || typeof item !== "object") continue;
    const prefix = `prod_${firestoreBranchId}_`;
    const productId = typeof item?.productId === "string" ? item.productId : "";
    if (!productId || !productId.startsWith(prefix)) {
      // No branch-scoped catalog key: the builder's own resolver will report
      // the exact gap. Nothing to prefetch.
      continue;
    }
    const tail = productId.slice(prefix.length);
    if (/^\d+$/.test(tail) && !seen.has(tail)) {
      seen.add(tail);
      try {
        const snap = await db.collection("products").doc(productId).get();
        const doc = snap && snap.exists ? snap.data() : undefined;
        if (!doc) {
          gaps.push({
            field: "products",
            reason: `product ${productId} has no synced snapshot — re-run the branch's menu sync before pushing`,
          });
          continue;
        }
        const syncedId = String((doc as any).petpoojaItemId ?? "").trim();
        if (!/^\d+$/.test(syncedId)) {
          gaps.push({
            field: `products/${productId}`,
            reason: `synced snapshot carries no numeric vendoring id — not POS configuration`,
          });
          continue;
        }
        if (syncedId !== tail) {
          gaps.push({
            field: `products/${productId}`,
            reason: `snapshot vendoring id ${syncedId} disagrees with the requested catalog key tail ${tail} — mapped-outlet violation`,
          });
          continue;
        }
        if ((doc as any).branchId !== undefined && String((doc as any).branchId) !== firestoreBranchId) {
          gaps.push({
            field: `products/${productId}`,
            reason: `snapshot belongs to branch ${(doc as any).branchId} — requested item does not belong to the mapped outlet`,
          });
          continue;
        }
        snapshots.push({
          petpoojaItemId: syncedId,
          taxIds: ((doc as any).petpoojaItemTaxIds || []).map((v: any) => String(v)),
          taxInclusive:
            typeof (doc as any).petpoojaTaxInclusive === "boolean"
              ? (doc as any).petpoojaTaxInclusive
              : null,
          taxUnsupported: (doc as any).petpoojaTaxUnsupported === true,
          gstType: typeof (doc as any).petpoojaGstType === "string" ? (doc as any).petpoojaGstType : null,
        });
      } catch (err: any) {
        gaps.push({
          field: "products",
          reason: `product snapshot read failed for ${productId}: ${err?.message || err}`,
        });
      }
    }
  }
  if (gaps.length > 0) throw new PetpoojaStructuralError(gaps);
  return snapshots;
}

export function wasPushDeferredBusy(orderId: string): boolean {
  const ts = recentBusyPushes.get(orderId);
  if (!ts) return false;
  if (Date.now() - ts > 60_000) {
    recentBusyPushes.delete(orderId);
    return false;
  }
  return true;
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

  // Manual reconciliation guard: an order flagged as ambiguous or parked for
  // reconciliation must NEVER be blindly re-pushed by direct callers or retry
  // loops. Operator intervention is required to verify physical POS/kitchen state first.
  if (
    order.petpoojaStatus === "reconciliation_required" ||
    order.petpoojaAmbiguousProcessing === true ||
    (order.kotSyncFailed && (order.petpoojaStatus === "failed" || order.petpoojaStatus === "reconciliation_required"))
  ) {
    console.warn(
      `[Petpooja KOT Push] Order ${orderId} is parked for manual reconciliation (reconciliation marker / kotSyncFailed) — blocking blind direct push until operator resolves ambiguity`
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
  const PUSH_CLAIM_TTL_MS = 10 * 60 * 1000;
  if (db && typeof (db as any).runTransaction === "function") {
    let claim: "claimed" | "dup" | "busy" | "gone" | "blocked";
    try {
      claim = await (db as any).runTransaction(async (tx: any) => {
        const fresh = await tx.get(orderDoc.ref);
        const data = (fresh.exists ? fresh.data() : undefined) as any;
        if (!data) return "gone";
        // Manual reconciliation guard inside claim transaction (pre-read race check)
        if (
          data.petpoojaStatus === "reconciliation_required" ||
          data.petpoojaAmbiguousProcessing === true ||
          (data.kotSyncFailed && (data.petpoojaStatus === "failed" || data.petpoojaStatus === "reconciliation_required"))
        ) {
          return "blocked";
        }
        // A racing caller finished the push while we were reading — reuse
        // its outcome, never POST a second KOT. Both accepted shapes count.
        if (data.petpoojaOrderId || data.petpoojaAcceptedNoId) return "dup";
        // Numeric-first lease read (same trap as the scheduler): a
        // serverTimestamp sentinel has no toMillis and would read as 0,
        // causing instant false takeover and a duplicate KOT POST.
        const claimedRaw = data.petpoojaPushClaimedAt;
        const claimedAt =
          typeof claimedRaw === "number" && Number.isFinite(claimedRaw)
            ? claimedRaw
            : claimedRaw && typeof claimedRaw.toMillis === "function"
              ? claimedRaw.toMillis()
              : 0;
        if (data.petpoojaPushClaimedAt && Date.now() - claimedAt < PUSH_CLAIM_TTL_MS) {
          return "busy"; // another push is in flight right now — yield to it
        }
        // F5 (silent-drop integrity): the lease is not enough on its own. A hard
        // kill between this write and the success write used to leave a doc with
        // ONLY `petpoojaPushClaimedAt` set — and neither lane in the retry worker
        // looks at that field: the crash lane scans `petpoojaStatus ==
        // "processing"` and the retry lane scans `pending_retry`. The order then
        // belonged to no lane at all (no KOT, no retry, no alert). Marking
        // `processing` in the SAME claim write (exactly what the scheduler's own
        // claim does) makes the crash lane find it and park it
        // `reconciliation_required` with an alert once the lease expires.
        tx.set(
          orderDoc.ref,
          { petpoojaStatus: "processing", petpoojaPushClaimedAt: Date.now() },
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
    if (claim === "blocked") {
      console.warn(
        `[Petpooja KOT Push] Order ${orderId} is parked for manual reconciliation inside claim transaction — blocking push`
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
      // catch below parks pending_retry for the retry worker — either way
      // this caller must not stack a second POST on top of it.
      // Honest failure/deferred return: busy is NOT confirmed success.
      if (recentBusyPushes.size > 500) {
        const now = Date.now();
        for (const [k, v] of recentBusyPushes.entries()) {
          if (now - v > 60_000) recentBusyPushes.delete(k);
        }
      }
      recentBusyPushes.set(orderId, Date.now());
      console.warn(
        `[Petpooja KOT Push] Order ${orderId} push already in flight — yielding to the owner`
      );
      return false;
    }
    if (claim === "gone") {
      console.warn(`[Petpooja KOT Push] Order ${orderId} vanished before push — refusing`);
      return false;
    }
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
        // KOT Truth: network relay acceptance or mock delivery is NOT physical printer proof.
        // kotPrinted / kotPrintedAt are never manufactured without physical printer proof.
        kotPushedAt: admin.firestore.FieldValue.serverTimestamp(),
        petpoojaPushClaimedAt: null,
        petpoojaClaimedAt: null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return true;
  }

  // ---------------------------------------------------------------------------
  // F3 (duplicate-KOT integrity): a POS ACK and the Firestore write recording it
  // are two different failure domains. The previous shape kept both inside ONE
  // try, so a write failure AFTER the POS had already accepted the ticket fell
  // into the generic catch, which parked `pending_retry` — and the retry worker
  // then re-POSTed an order the kitchen already had. These flags capture the
  // point of no return: once `posAccepted` is true the order may exist at the
  // POS even though we failed to persist the id, so the ONLY safe state is
  // `reconciliation_required` (no retry, no retry-count burn, no re-POST).
  // ---------------------------------------------------------------------------
  let posAccepted = false;
  let posAcceptedOrderId = "";
  let posAcceptedAckBody: string | null = null;

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

    // `orderId` is the Firestore document id: `orderID` travels to the POS so
    // its status callback resolves `orders/{orderID}` against OUR doc key.
    let payload: any;
    try {
      // H1/H3 — prefetch the branch's synced product snapshots OUTSIDE any
      // transaction, BEFORE the builder. Any missing/invalid/disagreeing
      // snapshot blocks (BLOCKED_CONFIGURATION) before the vendor call.
      const productTaxSnapshots = await resolveTrustedProductSnapshots(order?.items || [], branchId);
      payload = formatPetpoojaOrderPayload(order, branchData, resId, branchId, orderId, productTaxSnapshots);
    } catch (err: any) {
      if (err?.code === "BLOCKED_CONFIGURATION") {
        // Fail-closed structural gate: unverifiable POS identifiers are never
        // POSTed (a fabricated id is a silent-config hole), never retried, and
        // never reported as acceptance. Vendor-side configuration is the cure.
        await orderDoc.ref.set(
          {
            petpoojaStatus: "pending_configuration",
            petpoojaSyncStatus: "pending_configuration",
            petpoojaBlockedConfiguration: true,
            kotSyncFailed: true,
            lastPetpoojaError: err.message,
            petpoojaPushClaimedAt: null,
            petpoojaClaimedAt: null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        await captureErrorSnapshot({
          source: "petpooja",
          severity: "high",
          message: `Petpooja KOT push BLOCKED for order ${orderId} (BLOCKED_CONFIGURATION, no vendor call made): ${err.message}`,
          orderId,
          branchId,
        });
        return false;
      }
      throw err;
    }

    // Debug visibility: missing contact or zero totals push a broken KOT that
    // looks successful. Flag loudly instead of masking with fallbacks.
    if (!payload.orderinfo.OrderInfo.Customer.details.phone) {
      await captureErrorSnapshot({
        source: "petpooja",
        severity: "medium",
        message: `KOT push for order ${orderId} has no customer phone — rider contact will fail`,
        orderId,
        branchId,
      });
    }
    if (!(Number(payload.orderinfo.OrderInfo.Order.details.total) > 0)) {
      await captureErrorSnapshot({
        source: "petpooja",
        severity: "medium",
        message: `KOT push for order ${orderId} resolved total=0 — pricing data missing upstream`,
        orderId,
        branchId,
      });
    }

    const response = await fetch(petpoojaConfig.orderUrl, {
      method: "POST",
      // Loop: hung gateway held the function until platform timeout.
      signal: AbortSignal.timeout(15_000),
      headers: {
        "Content-Type": "application/json",
        // Headers used by the tested sandbox relay (all five scenarios
        // returned HTTP 200 with them). `Content_key` is kept for the older
        // gateway build that reads that spelling.
        "Content-Type-Override": "application/json",
        "app-key": petpoojaConfig.appKey,
        "app-secret": petpoojaConfig.appSecret,
        "access-token": petpoojaConfig.accessToken,
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

    // TRANSPORT TRUTH, before any body parsing. The ack below inspects only the
    // JSON body, so an HTTP failure whose body still says success:"1" - a
    // gateway/proxy error page, a WAF interstitial, a 5xx from a half-broken
    // upstream - was accepted as a registered KOT. That is a fabricated success:
    // the order is marked synced, kotPrinted:true and the claim released, so the
    // retry worker never looks at it again. Fail closed instead and let the catch
    // below park it as pending_retry, which is the state that is retried.
    if (!response.ok) {
      throw new Error(
        `Petpooja KOT push HTTP ${response.status ?? "(no status)"}${
          response.statusText ? ` ${response.statusText}` : ""
        } - refusing to read an acceptance from a failed response`
      );
    }

    const result = await response.json();

    // Official SaveOrderResponse signals success as success:"1" (variants seen:
    // true / "success"). Accept all three — a missed ack loses the KOT.
    const ok =
      result.success === "1" || result.success === 1 || result.success === true || result.status === "success";

    // An ack WITHOUT an order id confirms network relay acceptance by the POS server.
    // Petpooja's sandbox answers {"success":"1","message":"Your order is
    // saved.","restID":"31z58ciw0h","clientOrderID":"<our id>","orderID":"",
    // "code":200} and leaves `orderID` empty. An acceptance confirms that the POS
    // cloud server accepted the payload, NOT that a physical kitchen ticket printed.
    //
    // Deduplication rules:
    //  - When the response is acknowledged with an order ID, record `petpoojaOrderId`.
    //  - When acknowledged without an order ID, record `petpoojaAcceptedNoId: true`.
    //  - NEVER invent a fake POS id or claim `kotPrinted: true` from a relay response.
    //  - Stamp `kotPushedAt` to record when the relay succeeded.
    // Both shapes prevent retry loops from firing duplicate KOTs.
    const petpoojaOrderId =
      result.petpooja_order_id || result.order_id || result.orderID || result.orderId || "";

    // Point of no return (F3): from here on the POS has ACCEPTED the ticket. Any
    // later failure (including the Firestore writes below) must never fall
    // through to `pending_retry`. Recorded in memory BEFORE the first write so a
    // rejected write cannot erase the fact that the POST was acknowledged.
    if (ok) {
      posAccepted = true;
      posAcceptedOrderId = String(petpoojaOrderId || "");
      try {
        posAcceptedAckBody = JSON.stringify(result).slice(0, 500);
      } catch {
        posAcceptedAckBody = null;
      }
    }

    if (ok && petpoojaOrderId) {
      await orderDoc.ref.set(
        {
          petpoojaOrderId,
          petpoojaStatus: "synced",
          petpoojaSyncStatus: "synced",
          // KOT Truth: A relay response is network acceptance by the POS server,
          // NOT physical-printer proof. Do NOT manufacture kotPrinted or kotPrintedAt.
          // kotPushedAt records the successful relay timestamp; genuine historical
          // printer evidence (if any) is preserved via merge.
          kotPushedAt: admin.firestore.FieldValue.serverTimestamp(),
          petpoojaPushClaimedAt: null,
          petpoojaClaimedAt: null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      return true;
    }
    if (ok) {
      await orderDoc.ref.set(
        {
          petpoojaAcceptedNoId: true,
          petpoojaAcceptedNoIdAt: admin.firestore.FieldValue.serverTimestamp(),
          // Kept verbatim so an operator can see the vendor really did omit
          // the id rather than trusting our summary of it.
          petpoojaAcceptedNoIdAck: JSON.stringify(result).slice(0, 500),
          petpoojaStatus: "synced",
          petpoojaSyncStatus: "synced",
          // KOT Truth: An ID-less relay acceptance confirms the POS server accepted
          // the payload, NOT that a physical kitchen ticket was printed.
          // Do NOT manufacture kotPrinted or kotPrintedAt.
          kotPushedAt: admin.firestore.FieldValue.serverTimestamp(),
          petpoojaPushClaimedAt: null,
          petpoojaClaimedAt: null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      console.warn(
        `[Petpooja KOT Push] Order ${orderId} accepted by POS but the response carried no order id — marked synced (accepted-no-id), NOT queued for retry (a retry would duplicate the KOT)`
      );
      return true;
    }
    throw new Error(result.message || "Petpooja KOT push rejected by POS server");
  } catch (err: any) {
    console.warn(`[Petpooja KOT Push Error] Order ${orderId}: ${err.message}`);

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
    // TRANSPORT-AMBIGUITY (stress sweep 2026-10-24, K1): a POST whose fetch
    // TIMED OUT / was Aborted after the request was written has an unknown
    // KOT state — the POS cloud may already have registered the ticket.
    // Parking it `pending_retry` re-POSTs the same paid order (a duplicate
    // kitchen ticket). The crash lane (petpooja.scheduler) already parks
    // this shape `reconciliation_required` with NO new POST; the in-process
    // path now agrees. HTTP 5xx stays retryable on purpose — the origin
    // provably did not process it cleanly (pinned by the retry-lifecycle
    // suite).
    const kotTransportAmbiguous =
      err?.name === "TimeoutError" || err?.name === "AbortError";

    // F3: the ack landed but we could not persist it. This write is the
    // reconciliation park; it is intentionally NOT a retry and does NOT touch
    // petpoojaRetryCount. It also records the acceptance marker (POS id, or the
    // accepted-no-id flag) so every later dedupe short-circuits before the POS is
    // ever contacted again. `petpoojaAcceptedUnrecorded` distinguishes this from
    // the transport-ambiguous case for the operator.
    const parkAcceptedUnrecorded = () => ({
      petpoojaStatus: "reconciliation_required",
      petpoojaSyncStatus: "reconciliation_required",
      kotSyncFailed: true,
      // Reuses the existing "do not blind-push" guards (orderPush pre-read +
      // claim transaction) until an operator has verified the physical ticket.
      petpoojaAmbiguousProcessing: true,
      petpoojaAcceptedUnrecorded: true,
      ...(posAcceptedOrderId
        ? { petpoojaOrderId: posAcceptedOrderId }
        : {
            petpoojaAcceptedNoId: true,
            petpoojaAcceptedNoIdAt: admin.firestore.FieldValue.serverTimestamp(),
            petpoojaAcceptedNoIdSource: "order_push_ack_unpersisted",
          }),
      ...(posAcceptedAckBody ? { petpoojaAcceptedAck: posAcceptedAckBody } : {}),
      lastPetpoojaError: `POS acknowledged the KOT but persisting the acceptance failed: ${err.message}`,
      petpoojaPushClaimedAt: null,
      petpoojaClaimedAt: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    if (db && typeof (db as any).runTransaction === "function") {
      try {
        const outcome = await (db as any).runTransaction(async (tx: any) => {
          const fresh = await tx.get(orderDoc.ref);
          const data = (fresh.exists ? fresh.data() : undefined) as any;
          if (data?.petpoojaOrderId || data?.petpoojaAcceptedNoId) {
            tx.set(
              orderDoc.ref,
              {
                petpoojaClaimedAt: null,
                petpoojaPushClaimedAt: null,
              },
              { merge: true }
            );
            return "won";
          }
          // F3: never re-POST an accepted KOT. Checked before the
          // transport-ambiguity branch because acceptance is PROVEN here.
          if (posAccepted) {
            tx.set(orderDoc.ref, parkAcceptedUnrecorded(), { merge: true });
            return "parked_accepted_unsaved";
          }
          // K1 stress sweep: transport-ambiguous POST (timeout/abort after
          // request written) — the POS may already hold this KOT. Park for
          // manual reconciliation, NO retry, NO retry-count burn.
          if (kotTransportAmbiguous) {
            tx.set(
              orderDoc.ref,
              {
                petpoojaStatus: "reconciliation_required",
                petpoojaSyncStatus: "reconciliation_required",
                kotSyncFailed: true,
                petpoojaAmbiguousProcessing: true,
                lastPetpoojaError: err.message,
                petpoojaPushClaimedAt: null,
                petpoojaClaimedAt: null,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              },
              { merge: true }
            );
            return "parked_ambiguous";
          }
          const freshRetry = (Number(data?.petpoojaRetryCount) || 0) + 1;
          retryForSnapshot = freshRetry;
          tx.set(
            orderDoc.ref,
            {
              petpoojaStatus: "pending_retry",
              petpoojaSyncStatus: "pending_retry",
              petpoojaRetryCount: freshRetry,
              lastPetpoojaError: err.message,
              petpoojaPushClaimedAt: null,
              petpoojaClaimedAt: null,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
          return "parked";
        });
        if (outcome === "won") pushedByRacer = true;
        // K1 reviewer fix: parked_ambiguous ALSO parked the doc (the
        // transaction already committed reconciliation_required). Leaving
        // `parked === false` let the plain fallback write below clobber a
        // concurrent racer's successful push that landed after the tx.
        if (
          outcome === "parked" ||
          outcome === "parked_ambiguous" ||
          outcome === "parked_accepted_unsaved"
        ) {
          parked = true;
        }
      } catch (txErr: any) {
        // Transactional write failed — fall back to the legacy write below.
        console.warn(
          `[Petpooja KOT Push] guarded failure write failed for order ${orderId}:`,
          txErr?.message || txErr
        );
      }
    }
    if (pushedByRacer) {
      console.warn(
        `[Petpooja KOT Push] Order ${orderId} was pushed by a concurrent caller — keeping synced state, no pending_retry`
      );
      return true;
    }

    if (!parked) {
      await orderDoc.ref.set(
        posAccepted
          ? // F3: same rule as the transactional path — an acknowledged POST is
            // never a retry candidate, even when the tx itself failed.
            parkAcceptedUnrecorded()
          : kotTransportAmbiguous
            ? {
                petpoojaStatus: "reconciliation_required",
                petpoojaSyncStatus: "reconciliation_required",
                kotSyncFailed: true,
                petpoojaAmbiguousProcessing: true,
                lastPetpoojaError: err.message,
                petpoojaPushClaimedAt: null,
                petpoojaClaimedAt: null,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              }
            : {
                petpoojaStatus: "pending_retry",
                petpoojaSyncStatus: "pending_retry",
                petpoojaRetryCount: fallbackRetry,
                lastPetpoojaError: err.message,
                petpoojaPushClaimedAt: null,
                petpoojaClaimedAt: null,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              },
        { merge: true }
      );
    }

    await captureErrorSnapshot({
      source: "petpooja",
      // A KOT the POS accepted but we could not record is a lost-ticket hazard
      // (the kitchen may be cooking an order no system tracks) — page, do not
      // bury it at medium.
      severity: posAccepted ? "high" : "medium",
      message: posAccepted
        ? `Petpooja POS ACKNOWLEDGED the KOT for order ${orderId} but the acceptance could not be persisted — parked reconciliation_required with NO retry (an automatic re-POST would duplicate the ticket): ${err.message}`
        : `Petpooja KOT Push failed for order ${orderId} (Attempt ${retryForSnapshot}): ${err.message}`,
      orderId,
      branchId,
    });

    return false;
  }
}
