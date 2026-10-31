import { itemPackingCharge } from "./packaging";

/**
 * Petpooja Push Menu → `products.customizations` (owner decision 2026-11-01,
 * M2), in the exact shape `menuService.mapToCustomizationGroups` (customer app)
 * and `pricing.engine` already read:
 *
 *   { id, name, kind:"addon"|"variation", minSelections, maxSelections,
 *     posGroupId?, options:[{ id, name, price, absolutePrice?, packingCharge?,
 *     isAvailable, posItemId?, posVariationId? }] }
 *
 * Ids are the vendor's own (addonitemid / variation row id / variationid), so
 * the POS relay can send catalog ids (M3) instead of the client's modifier ids.
 */

const isActive = (value: unknown): boolean =>
  value === "1" || value === 1 || value === true;

export interface MappedOption {
  id: string;
  name: string;
  /** Delta over the product's effective base price (>= 0). */
  price: number;
  /** Absolute catalog price (variations only; the POS line price, M3). */
  absolutePrice?: number;
  /** Variation-level `item_packingcharges` (stored only for now). */
  packingCharge?: number | null;
  isAvailable: boolean;
  posItemId?: string;
  posVariationId?: string;
}

export interface MappedGroup {
  id: string;
  name: string;
  kind: "addon" | "variation";
  minSelections: number;
  maxSelections: number;
  posGroupId?: number;
  options: MappedOption[];
}

function finiteNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Lowest ACTIVE priced variation, or null when there is none. */
export function lowestActiveVariationPrice(item: any): number | null {
  const variations = Array.isArray(item?.variation) ? item.variation : [];
  const prices = variations
    .filter((variation: any) => isActive(variation?.active))
    .map((variation: any) => Number(variation?.price))
    .filter((price: number) => Number.isFinite(price) && price > 0);
  return prices.length > 0 ? Math.min(...prices) : null;
}

/**
 * The price every variation delta is measured against — and the price the stock
 * rule sees. Computed BEFORE resolvePushStock so a variation item with real
 * prices is not left unsellable by its raw item-level 0.
 */
export function effectiveItemPrice(item: any): number {
  const lowest = lowestActiveVariationPrice(item);
  if (lowest !== null) return lowest;
  const raw = Number(item?.price);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/** True when the item has at least one active priced variation. */
export function hasPricedVariation(item: any): boolean {
  return lowestActiveVariationPrice(item) !== null;
}

function variationGroup(item: any): MappedGroup | null {
  const variations = Array.isArray(item?.variation) ? item.variation : [];
  if (variations.length === 0) return null; // never by the itemallowvariation flag

  const base = effectiveItemPrice(item);
  const options: MappedOption[] = variations.map((variation: any) => {
    const absolute = finiteNumber(variation?.price);
    return {
      id: String(variation?.id ?? "").trim(),
      name: String(variation?.name ?? ""),
      // Deltas stay >= 0 even for an inactive option priced below the base.
      price: Math.max(0, Math.round((absolute - base) * 100) / 100),
      absolutePrice: absolute,
      packingCharge: itemPackingCharge(variation?.item_packingcharges),
      isAvailable: isActive(variation?.active),
      posItemId: String(variation?.id ?? "").trim(),
      posVariationId: String(variation?.variationid ?? "").trim(),
    };
  });

  const name =
    (item?.variation_groupname && String(item.variation_groupname)) ||
    (variations[0]?.groupname && String(variations[0].groupname)) ||
    "Variation";

  return {
    id: "variation",
    name,
    kind: "variation",
    minSelections: 1,
    maxSelections: 1,
    options,
  };
}

function addonGroups(
  item: any,
  addonGroupsById: Map<string, any>
): MappedGroup[] {
  const attached = Array.isArray(item?.addon) ? item.addon : [];
  const groups: MappedGroup[] = [];
  for (const attachment of attached) {
    const groupId = String(attachment?.addon_group_id ?? "").trim();
    const source = addonGroupsById.get(groupId);
    if (!groupId || !source) continue;
    const posGroupId = Number(source.addongroupid ?? groupId);
    if (!Number.isInteger(posGroupId)) continue; // never fabricate a group id

    const options: MappedOption[] = (Array.isArray(source.addongroupitems)
      ? source.addongroupitems
      : []
    )
      .map((option: any) => ({
        id: String(option?.addonitemid ?? "").trim(),
        name: String(option?.addonitem_name ?? ""),
        price: Math.max(0, finiteNumber(option?.addonitem_price)),
        isAvailable: isActive(option?.active),
      }))
      .filter((option: MappedOption) => option.id !== "");

    groups.push({
      id: String(source.addongroupid ?? groupId),
      name: String(source.addongroup_name ?? attachment?.addon_group_name ?? ""),
      kind: "addon",
      minSelections: finiteNumber(attachment?.addon_item_selection_min),
      maxSelections: finiteNumber(attachment?.addon_item_selection_max),
      posGroupId,
      options,
    });
  }
  return groups;
}

/** Index of the payload's top-level `addongroups` by id (string keys). */
export function addonGroupIndex(menuData: any): Map<string, any> {
  const groups = Array.isArray(menuData?.addongroups) ? menuData.addongroups : [];
  const index = new Map<string, any>();
  for (const group of groups) {
    const id = String(group?.addongroupid ?? "").trim();
    if (id) index.set(id, group);
  }
  return index;
}

/**
 * The item's `customizations` array, or null when it has neither add-ons nor
 * variations. Null means "write nothing": a doc the push does not enrich must
 * keep whatever a partner set on it.
 */
export function buildItemCustomizations(
  item: any,
  addonGroupsById: Map<string, any>
): MappedGroup[] | null {
  const groups = addonGroups(item, addonGroupsById);
  const variation = variationGroup(item);
  if (variation) groups.unshift(variation);
  return groups.length > 0 ? groups : null;
}
