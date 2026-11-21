import { DEFAULT_MONTHLY_FEE_RUPEES, DEFAULT_PACKAGING_FEE, type BranchPricingConfig } from "../payments/branchPricing";
import { computeSnapshotPricing, type PricingBreakdown, type PricingLineItem, type SnapshotProduct } from "../payments/pricing.engine";
import { WalkInError } from "./walkInErrors";

/**
 * The ONE bill builder for counter orders.
 *
 * Both the create transaction (`createWalkIn`) and the read-only preview
 * (`quoteWalkIn`) price through this module, so the till's bill and the booked
 * bill are the same arithmetic on the same branch config (F4: HL Road's ₹15
 * packaging used to be missing from the modal because the modal computed the
 * bill itself and confirmed that number).
 *
 * Nothing here writes; nothing here reads Firestore. Callers pass the docs they
 * already read, which keeps the create path's reads inside its transaction.
 */

/** Re-checks authoritative role and assignment on every counter request. */
export function assertWalkInScope(
  data: FirebaseFirestore.DocumentData | undefined,
  branchId: string,
  verb: "create" | "quote"
): void {
  const role = data?.role;
  if (role === "brand_owner" || role === "developer") return;
  if (
    (role === "branch_owner" || role === "branch_staff") &&
    Array.isArray(data?.branchIds) &&
    data.branchIds.includes(branchId)
  ) {
    return;
  }
  throw new WalkInError(403, "FORBIDDEN", `You cannot ${verb} an order for this branch.`);
}

/**
 * Branch pricing snapshot. A malformed `packagingFee` is a refusal, never a
 * silent default: a wrong packaging charge is a wrong bill.
 */
export function walkInBranchConfig(
  branch: Record<string, any>,
  branchId: string
): BranchPricingConfig {
  const branchFee = branch.packagingFee;
  if (
    branchFee !== undefined &&
    (typeof branchFee !== "number" || !Number.isFinite(branchFee) || branchFee < 0)
  ) {
    throw new WalkInError(
      503,
      "BRANCH_UNAVAILABLE",
      `Branch pricing is unavailable for ${branchId}.`
    );
  }
  return {
    packagingFee: branchFee ?? DEFAULT_PACKAGING_FEE,
    monthlyFeePaise: DEFAULT_MONTHLY_FEE_RUPEES * 100,
    ...(branchFee !== undefined ? { branchPackagingFee: branchFee } : {}),
    packaging: branch.packaging ?? null,
  };
}

/**
 * Validates one catalogue doc for a counter sale and returns the snapshot the
 * pricing seam re-prices from plus the printable line. Fails closed on
 * anything unverifiable — never the client's price.
 */
export function walkInLineFor(
  product: Record<string, any> | undefined,
  exists: boolean,
  branchId: string,
  productId: string,
  quantity: number
): { snapshot: SnapshotProduct; line: PricingLineItem } {
  if (
    !exists ||
    !product ||
    product.branchId !== branchId ||
    product.inStock !== true ||
    typeof product.price !== "number" ||
    !Number.isFinite(product.price) ||
    product.price < 0 ||
    product.price > 100000 ||
    typeof product.name !== "string" ||
    !product.name.trim() ||
    product.priceAvailable === false
  ) {
    throw new WalkInError(
      503,
      "ITEM_UNAVAILABLE",
      "An item is unavailable or cannot be verified."
    );
  }
  if (
    (product.customizations !== undefined &&
      (!Array.isArray(product.customizations) || product.customizations.length > 0)) ||
    product.priceFromVariation === true
  ) {
    throw new WalkInError(
      422,
      "PRODUCT_UNSUPPORTED",
      "Configurable products are not supported for walk-ins."
    );
  }
  const snapshot: SnapshotProduct = { price: product.price, inStock: product.inStock };
  const line: PricingLineItem = {
    id: productId,
    productId,
    name: product.name,
    price: product.price,
    quantity,
    ...(typeof product.petpoojaItemId === "string" && product.petpoojaItemId.trim()
      ? { petpoojaItemId: product.petpoojaItemId }
      : {}),
  };
  return { snapshot, line };
}

/** The complete counter bill: lines + totals from the shared pricing engine. */
export function priceWalkInLines(input: {
  lines: PricingLineItem[];
  products: ReadonlyMap<string, SnapshotProduct>;
  branchConfig: BranchPricingConfig;
  branchId: string;
  orderType: "takeaway" | "dinein" | "delivery";
}): PricingBreakdown {
  // `packagingUsedFallback` is the seam's post-commit signal for callers that
  // must record a fallback; a counter bill has no audit field for it, so it is
  // dropped exactly as `createWalkIn` always did.
  const { packagingUsedFallback: _fallback, ...totals } = computeSnapshotPricing({
    items: input.lines,
    products: input.products,
    branchConfig: input.branchConfig,
    branchId: input.branchId,
    orderType: input.orderType,
  });
  return totals;
}
