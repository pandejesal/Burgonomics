import * as admin from "firebase-admin";

/**
 * Owner decision 2026-11-25 #3 (preprod audit cycle 11) — WhatsApp consent.
 *
 * OFF by default, and consent exists only when the CUSTOMER explicitly said yes
 * AND the server recorded WHEN. Both creators used to write
 * `whatsappOptIn: input.whatsappOptIn !== false`, i.e. `true` whenever the field
 * was omitted — a consent record nobody gave (the Customer app never asked).
 *
 * The rules of this module:
 *   1. an omitted / null / non-boolean value is NOT consent — it stores `false`;
 *   2. only a literal `true` from the customer stores `true`, together with a
 *      SERVER stamp in `whatsappOptInAt` (a client-supplied timestamp is never
 *      read, so it can neither backdate nor forge consent);
 *   3. a stored `true` WITHOUT a stamp is a legacy default and is NOT consent,
 *      which is why every sender must ask `hasWhatsappConsent`, never the bare
 *      boolean.
 *
 * There is no WhatsApp sender in this repo yet; the guard exists so the first
 * one cannot be written against the bare flag.
 */
export const WHATSAPP_CONSENT_FIELD = "whatsappOptIn";
export const WHATSAPP_CONSENT_AT_FIELD = "whatsappOptInAt";

/**
 * The exact fields a creator writes. Explicit `true` + a server stamp; anything
 * else is a plain, stamped `false` with no consent record.
 */
export function whatsappConsentFields(raw: unknown): Record<string, any> {
  if (raw === true) {
    return {
      [WHATSAPP_CONSENT_FIELD]: true,
      [WHATSAPP_CONSENT_AT_FIELD]: admin.firestore.FieldValue.serverTimestamp(),
    };
  }
  return { [WHATSAPP_CONSENT_FIELD]: false };
}

/** True only for a value that can be a real consent instant. */
function isConsentStamp(value: unknown): boolean {
  if (typeof value === "string") return Number.isFinite(Date.parse(value));
  if (typeof value === "number") return Number.isFinite(value) && value > 0;
  if (value && typeof value === "object") {
    const stamp = value as any;
    if (typeof stamp.toMillis === "function") {
      const ms = Number(stamp.toMillis());
      return Number.isFinite(ms) && ms > 0;
    }
    if (typeof stamp.toDate === "function") {
      const date = stamp.toDate();
      return date instanceof Date && Number.isFinite(date.getTime());
    }
    if (typeof stamp.seconds === "number") return stamp.seconds > 0;
    if (typeof stamp._seconds === "number") return stamp._seconds > 0;
    return false;
  }
  return false;
}

/**
 * THE consent question. Every WhatsApp sender must gate on this, never on
 * `order.whatsappOptIn` alone: a legacy document carries `true` because the old
 * default wrote it, not because anybody agreed.
 */
export function hasWhatsappConsent(order: any): boolean {
  if (!order || typeof order !== "object") return false;
  if (order[WHATSAPP_CONSENT_FIELD] !== true) return false;
  return isConsentStamp(order[WHATSAPP_CONSENT_AT_FIELD]);
}

/**
 * Fail-closed wrapper for a future sender. A missing consent throws instead of
 * quietly skipping, so a bug in the caller is visible rather than silent.
 */
export function assertWhatsappConsent(order: any, orderId: string): void {
  if (hasWhatsappConsent(order)) return;
  const err: any = new Error(
    `Order ${orderId} has no recorded WhatsApp consent; refusing to send a WhatsApp message.`
  );
  err.code = "WHATSAPP_CONSENT_MISSING";
  err.statusCode = 403;
  throw err;
}
