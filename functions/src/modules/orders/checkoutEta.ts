/** A checkout estimate exists only if the storefront supplies that mode's ETA. */
export function checkoutEstimatedAt(
  store: { etaMinutes?: unknown; pickupEtaMinutes?: unknown } | null,
  orderType: "delivery" | "takeaway" | "dinein",
): string | undefined {
  const minutes = orderType === "delivery" ? store?.etaMinutes : store?.pickupEtaMinutes;
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) return undefined;
  const date = new Date(Date.now() + minutes * 60_000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}
