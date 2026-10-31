/**
 * Petpooja packaging fields (owner decision 2026-11-01, P1/P2; corrected by
 * the design review: the vendor doc shows ONLY `ORDER` with a blank charge
 * type. `ITEM`, `F`, `FIXED` and percentages are undocumented, so treating
 * them as understood would be a guess).
 *
 * The outlet-level `restaurants[0].details` block of a Push Menu sample carries:
 *
 *   packaging_applicable_on  "ORDER"
 *   packaging_charge         "20"               (string money)
 *   packaging_charge_type    ""
 *   calculatetaxonpacking    1
 *   pc_taxes_id              "11213,20375"
 *
 * We store the RAW values plus an `understood` flag rather than silently
 * coercing. `understood` is true ONLY for the documented rule; everything else
 * means the runtime must fall back to the branch value / default and record the
 * raw values, never guess a number.
 */

export const PACKAGING_KEYS = [
  "packaging_applicable_on",
  "packaging_charge",
  "packaging_charge_type",
  "calculatetaxonpacking",
  "pc_taxes_id",
] as const;

/** The ONLY applicable-on value the vendor document defines. */
const KNOWN_APPLICABLE_ON = new Set(["ORDER"]);
/** The ONLY charge type the vendor document defines ("" = plain amount). */
const KNOWN_CHARGE_TYPES = new Set([""]);

export interface PetpoojaPackaging {
  source: "petpooja";
  applicableOn: string;
  charge: number | null;
  chargeType: string;
  taxOnPacking: unknown;
  pcTaxIds: unknown;
  understood: boolean;
  syncedAt?: unknown;
}

export interface PackagingInterpretation {
  /** True when at least one packaging key was present on the outlet block. */
  present: boolean;
  packaging: PetpoojaPackaging | null;
  /** Raw vendor values, for the sync log (no customer data). */
  raw: Record<string, unknown> | null;
}

function asTrimmedString(value: unknown): string {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

/** Parses the outlet `details` block of a Push Menu payload. */
export function interpretPackaging(details: any): PackagingInterpretation {
  const d = details || {};
  const present = PACKAGING_KEYS.some((key) => (d as any)[key] !== undefined);
  if (!present) {
    return { present: false, packaging: null, raw: null };
  }

  const raw: Record<string, unknown> = {};
  for (const key of PACKAGING_KEYS) raw[key] = (d as any)[key];

  const applicableOn = asTrimmedString(d.packaging_applicable_on);
  const chargeType = asTrimmedString(d.packaging_charge_type);
  const chargeRaw = d.packaging_charge;
  const charge =
    chargeRaw === undefined || chargeRaw === null || chargeRaw === ""
      ? null
      : Number(chargeRaw);
  const chargeOk = charge !== null && Number.isFinite(charge) && charge >= 0;

  const understood =
    KNOWN_APPLICABLE_ON.has(applicableOn.toUpperCase()) &&
    KNOWN_CHARGE_TYPES.has(chargeType.toUpperCase()) &&
    chargeOk;

  return {
    present: true,
    packaging: {
      source: "petpooja",
      applicableOn,
      charge: chargeOk ? (charge as number) : null,
      chargeType,
      taxOnPacking: d.calculatetaxonpacking ?? null,
      pcTaxIds: d.pc_taxes_id ?? null,
      understood,
    },
    raw,
  };
}

/**
 * Item-level `item_packingcharges`: a number, or null when the vendor sends
 * `""` (no item-level charge).
 */
export function itemPackingCharge(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}
