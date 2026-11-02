/**
 * Compatibility shim: the contact resolver moved to `src/core/dropContact.ts`
 * because the Petpooja KOT relay needs the SAME resolution and a `core` module
 * may not depend on a `modules/dispatch` one. Every existing
 * `modules/dispatch/dropContact` import keeps working unchanged; there is one
 * implementation, not two.
 */
export {
  normalizePhone,
  resolveDropContact,
  resolveDropContactFromOrder,
  resolveKotCustomerPhone,
  dropContactMissingError,
  persistResolvedCustomerPhone,
  phoneFormats,
} from "../../core/dropContact";

export type {
  CustomerPhoneSource,
  ResolvedDropContact,
  ResolveDropContactOptions,
} from "../../core/dropContact";
