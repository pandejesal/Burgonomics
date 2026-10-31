/**
 * Scoped HTTP mapping for the `/orders/bumpStatus` route ONLY.
 *
 * `bumpOrderStatus` throws DOCUMENTED refusals that already carry their own
 * `statusCode` and machine-readable `code` (orderStatus.ts):
 *   - 400 bad transition
 *   - 404 unknown order
 *   - 409 STALE_ORDER_STATUS     (screen moved on -> "refresh before acting")
 *   - 409 ORDER_STATUS_CONFLICT
 * The route used to honour only 400/404, so a documented 409 surfaced as a 500
 * and callers could not tell a deliberate refusal from a server fault.
 *
 * This helper keeps the mapping explicit and unit-testable without booting the
 * functions entrypoint. It deliberately does NOT widen the response: the body
 * stays `{ error }` (+ `code` when the service supplied one) and never carries
 * stack traces or internal details, so an unknown failure leaks no more than
 * before.
 */
import { staffErrorStatus } from "../../core/middleware";

export interface BumpRouteErrorResponse {
  status: number;
  body: { error: string; code?: string };
}

/** Statuses the service is allowed to decide for this route. */
const DOCUMENTED_STATUSES = new Set<number>([400, 403, 404, 409]);

export function bumpStatusErrorResponse(err: any): BumpRouteErrorResponse {
  const statusCode = err?.statusCode;
  const status = DOCUMENTED_STATUSES.has(statusCode)
    ? statusCode
    : staffErrorStatus(err, 500);

  const error =
    typeof err?.message === "string" && err.message
      ? err.message
      : "Failed to update order status";
  const code = typeof err?.code === "string" && err.code ? err.code : undefined;

  return code ? { status, body: { error, code } } : { status, body: { error } };
}
