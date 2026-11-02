import * as admin from "firebase-admin";
import { auth as adminAuth } from "./firebase";

/**
 * Drop (customer) contact resolution — the ONE place every booking path asks,
 * including the Petpooja KOT relay.
 *
 * WHY. Live order `ord_1793599121207_hJvkYS` (paid, real customer app) could not
 * be dispatched at all: `dispatch.router.ts` read only `order.customerPhone`, and
 * the customer app never writes that field. Its address blocks carry
 * `contactPhone: ""` (the address form permits an empty contact), so every
 * delivery order ended in a 500 "Customer phone number is missing".
 *
 * The customer signs in BY PHONE, so the number is already known server-side.
 * Resolution order (first non-empty wins, and the first four are values the
 * customer or the branch actually entered):
 *   1. order.customerPhone            (staff-entered / walk-in / legacy)
 *   2. deliveryAddress.contactPhone
 *   3. address.contactPhone
 *   4. the VERIFIED phone on the Firebase Auth user named by order.customerId
 *      (falling back to order.userId) — never a client-supplied value, never a
 *      value from the request body.
 * Anything else is a typed refusal, not a 500.
 *
 * Same shape on the KOT relay (P1-J/P1-K hot path): the persisted phone is used
 * with NO Auth I/O; only a genuinely contactless order pays for one lookup, and
 * a failed lookup is LOGGED and never blocks the kitchen ticket.
 *
 * Name: contactName (deliveryAddress, then address) → the Auth displayName →
 * "Customer".
 *
 * Normalisation: the returned `phone` is a trimmed E.164-ish string suitable for
 * persisting and for display (`+919825012345`); `formatFor` gives each provider
 * the shape its own API documents. Numbers are NEVER truncated into a different
 * person's line and NEVER invented.
 */

export type CustomerPhoneSource =
  | "order.customerPhone"
  | "deliveryAddress.contactPhone"
  | "address.contactPhone"
  | "firebase_auth";

export interface ResolvedDropContact {
  /** Normalised `+91XXXXXXXXXX` (or a plausible E.164 form) for storage/display. */
  phone: string;
  name: string;
  source: CustomerPhoneSource;
  /** True when the value came from the verified Auth profile (not client data). */
  fromVerifiedProfile: boolean;
}

/**
 * Normalises a phone number to `+<country><national>`.
 *
 * Refuses (returns null) rather than guessing: an 11-digit trunk-prefixed form
 * is unwrapped, a 12-digit `91…` is treated as +91, a bare 10-digit Indian
 * mobile gets +91. Anything else must already look like E.164. A number we
 * cannot normalise unambiguously is NOT handed to a courier.
 */
export function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;
  // Placeholder/dummy numbers are not contacts.
  if (/^0+$/.test(digits) || digits === "1234567890" || digits === "9999999999") {
    return null;
  }
  if (digits.length === 10) {
    // A 10-digit value starting with 0 is an STD/trunk form, not a mobile.
    if (digits.startsWith("0")) return null;
    return `+91${digits}`;
  }
  // 0XXXXXXXXXX (11) → national 10 digits.
  if (digits.length === 11 && digits.startsWith("0")) {
    const national = digits.slice(1);
    return national.startsWith("0") ? null : `+91${national}`;
  }
  // 91XXXXXXXXXX (12) → +91.
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  // Already international: trust an explicit "+" and a plausible length.
  if (trimmed.startsWith("+") && digits.length >= 10 && digits.length <= 15) {
    return `+${digits}`;
  }
  return null;
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/** True when the order's OWN `customerPhone` field already holds a real number. */
function orderCustomerPhonePresent(order: any): boolean {
  return normalizePhone(order?.customerPhone) !== null;
}

/**
 * KOT-PHONE: a failed verified-profile lookup must be VISIBLE but never fatal —
 * a kitchen ticket is not worth losing because the Auth API hiccuped.
 */
function warnVerifiedProfileFailure(uid: string, err: any): void {
  console.warn(
    `[Drop Contact] verified phone lookup failed for uid ${uid} — continuing without it:`,
    err?.message || err
  );
}

/**
 * The verified phone (and display name) of the signed-in customer.
 *
 * Deliberately accepts ONLY the order's own uid fields, never a caller-supplied
 * value: the uid is the authorization subject the order was created for, and
 * the Admin SDK is the one place its phone can be read without trusting input.
 * A lookup failure (deleted user, Admin SDK down) resolves to null so the
 * caller's refusal path handles it — it must never throw into a booking flow.
 * It IS logged: a silent null made "the customer has no number" and "Auth was
 * down" indistinguishable to operators.
 */
async function verifiedProfile(order: any): Promise<{ phone: string | null; name: string | null }> {
  const uid = firstNonEmptyString(order?.customerId, order?.userId);
  if (!uid) return { phone: null, name: null };
  try {
    const user = await adminAuth.getUser(uid);
    return {
      phone: normalizePhone(user?.phoneNumber),
      name: firstNonEmptyString(user?.displayName),
    };
  } catch (err) {
    // Unknown/deleted account, or Auth unavailable: no verified phone. The
    // caller's refusal path reports it; the log keeps it diagnosable.
    warnVerifiedProfileFailure(uid, err);
    return { phone: null, name: null };
  }
}

/** Synchronous resolution from the order alone (no Auth I/O). */
export function resolveDropContactFromOrder(order: any): ResolvedDropContact | null {
  const phone =
    normalizePhone(order?.customerPhone) ??
    normalizePhone(order?.deliveryAddress?.contactPhone) ??
    normalizePhone(order?.address?.contactPhone);
  if (!phone) return null;
  const source: CustomerPhoneSource =
    normalizePhone(order?.customerPhone) !== null
      ? "order.customerPhone"
      : normalizePhone(order?.deliveryAddress?.contactPhone) !== null
        ? "deliveryAddress.contactPhone"
        : "address.contactPhone";
  const name =
    firstNonEmptyString(
      order?.deliveryAddress?.contactName,
      order?.address?.contactName,
      order?.customerName
    ) || "Customer";
  return { phone, name, source, fromVerifiedProfile: false };
}

export interface ResolveDropContactOptions {
  /** Skip the Auth lookup entirely (quote paths that must not do I/O). */
  allowAuthLookup?: boolean;
}

/**
 * Resolves the drop contact for an order. Returns null when nothing real can be
 * found — the caller must then refuse with `dropContactMissingError()`.
 */
export async function resolveDropContact(
  order: any,
  options: ResolveDropContactOptions = {}
): Promise<ResolvedDropContact | null> {
  const allowAuthLookup = options.allowAuthLookup !== false;

  const enteredPhone =
    normalizePhone(order?.customerPhone) !== null
      ? { phone: normalizePhone(order?.customerPhone)!, source: "order.customerPhone" as const }
      : normalizePhone(order?.deliveryAddress?.contactPhone) !== null
        ? {
            phone: normalizePhone(order?.deliveryAddress?.contactPhone)!,
            source: "deliveryAddress.contactPhone" as const,
          }
        : normalizePhone(order?.address?.contactPhone) !== null
          ? {
              phone: normalizePhone(order?.address?.contactPhone)!,
              source: "address.contactPhone" as const,
            }
          : null;

  const enteredName = firstNonEmptyString(
    order?.deliveryAddress?.contactName,
    order?.address?.contactName,
    order?.customerName
  );

  if (enteredPhone) {
    return {
      phone: enteredPhone.phone,
      name: enteredName || "Customer",
      source: enteredPhone.source,
      fromVerifiedProfile: false,
    };
  }

  if (!allowAuthLookup) return null;

  const profile = await verifiedProfile(order);
  if (!profile.phone) return null;
  return {
    phone: profile.phone,
    name: enteredName || profile.name || "Customer",
    source: "firebase_auth",
    fromVerifiedProfile: true,
  };
}

/**
 * KOT-PHONE: the customer contact for the Petpooja Save Order payload, shaped
 * for the wire. Petpooja documents `Customer.details.phone` as the contact
 * number (10-digit national in the vendor's example, E.164 tolerated), and the
 * relay's own `normalizeCustomerPhone` already accepts either.
 *
 * Hot path: a persisted phone (order or address level) resolves with NO network
 * I/O. Only a genuinely contactless order pays for the ONE verified-profile
 * lookup, and that lookup already degrades to null + a log on failure — so this
 * function never throws and never blocks a kitchen ticket.
 *
 * Returns "" when nothing real can be found; the caller flags it (the order is
 * still relayed) rather than inventing a number.
 */
export async function resolveKotCustomerPhone(order: any): Promise<{
  phone: string;
  name: string;
  source: CustomerPhoneSource | "none";
  fromVerifiedProfile: boolean;
}> {
  const fromOrder = resolveDropContactFromOrder(order);
  if (fromOrder) {
    return {
      phone: fromOrder.phone,
      name: fromOrder.name,
      source: fromOrder.source,
      fromVerifiedProfile: false,
    };
  }
  const profile = await verifiedProfile(order);
  return {
    phone: profile.phone || "",
    name:
      firstNonEmptyString(
        order?.deliveryAddress?.contactName,
        order?.address?.contactName,
        order?.customerName
      ) ||
      profile.name ||
      "Customer",
    source: profile.phone ? "firebase_auth" : "none",
    fromVerifiedProfile: !!profile.phone,
  };
}

/**
 * The typed refusal every booking path throws when no contact exists. 422 (the
 * caller's input/data gap is fixable), with staff-actionable copy — the old 500
 * made a fixable data gap look like a server fault and carried no code.
 */
export function dropContactMissingError(): any {
  const err: any = new Error(
    "This order has no customer phone number and the customer's verified profile has none either — ask the customer for a number, add it to the order, then retry dispatch."
  );
  err.statusCode = 422;
  err.code = "DISPATCH_CONTACT_MISSING";
  return err;
}

/**
 * Persists the resolved phone on the order when (and only when) the order itself
 * carries no phone. A value the customer or staff entered is NEVER overwritten.
 *
 * Best-effort by design: this is a convenience for the rebook path and the
 * partner app's rider call, not a booking precondition — a failed write must not
 * fail a dispatch that already has a valid contact in hand.
 */
export async function persistResolvedCustomerPhone(
  docRef: any,
  order: any,
  resolved: ResolvedDropContact
): Promise<void> {
  if (!resolved) return;
  // Never overwrite a value the customer or staff entered into the order's own
  // `customerPhone`. An address-level contact is a DIFFERENT field, so copying
  // it up is a fill, not an overwrite (and it is what the partner rider-call
  // reads).
  if (orderCustomerPhonePresent(order)) return;
  try {
    await docRef.set(
      {
        customerPhone: resolved.phone,
        customerPhoneSource: resolved.source,
        customerPhoneResolvedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  } catch (err: any) {
    console.warn(
      "[Dispatch] could not persist the resolved customer phone:",
      err?.message || err
    );
  }
}

/** Provider-specific phone shapes, derived from ONE normalised value. */
export const phoneFormats = {
  /** Borzo: `91` + 10-digit national form (documented by the adapter). */
  borzo(phone: string | null): string | null {
    const e164 = normalizePhone(phone);
    if (!e164) return null;
    const digits = e164.replace(/\D/g, "");
    return /^91\d{10}$/.test(digits) ? digits : null;
  },
  /** Shadowfax: bare 10-digit national form (doc examples). */
  shadowfax(phone: string | null): string {
    const e164 = normalizePhone(phone);
    if (!e164) return "";
    const digits = e164.replace(/\D/g, "");
    if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
    return digits.slice(-10);
  },
  /** Porter: the value we already store/display. */
  porter(phone: string | null): string | undefined {
    return normalizePhone(phone) || undefined;
  },
} as const;
