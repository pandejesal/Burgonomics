/**
 * Scoped HTTP mapping for the `/tickets/resolve` + `/tickets/resolveNote`
 * routes ONLY (mirrors orders/bumpRouteErrors.ts).
 *
 * `resolveTicket` / `resolveTicketNote` throw DOCUMENTED refusals that already
 * carry their own `statusCode` and machine-readable `code`:
 *   - 400 input refusals (refund amount / loyalty bounds)
 *   - 403 TICKET_FORBIDDEN (staff / branch scope)
 *   - 404 TICKET_NOT_FOUND
 *   - 409 TICKET_ALREADY_RESOLVED / TICKET_NOT_PENDING
 *   - 409 TICKET_RESOLUTION_IN_PROGRESS (another staff member holds the lease)
 *   - 409 TICKET_RESOLUTION_CLAIM_LOST (lease taken over mid-flight)
 *   - 503 TICKET_RESOLUTION_RETRY (transaction contention exhausted)
 * The routes used to honour only 404/409 on the note path and returned a bare
 * 500 with no code on the money path — a typed "being resolved by another
 * staff member" refusal was indistinguishable from a crash. This helper keeps
 * the mapping explicit and unit-testable without booting the functions
 * entrypoint. It deliberately does NOT widen the response: the body stays
 * `{ error }` (+ `code` when the service supplied one) and never carries stack
 * traces or internal details.
 */
import { staffErrorStatus } from "../../core/middleware";

export interface TicketRouteErrorResponse {
  status: number;
  body: { error: string; code?: string };
}

/** Statuses the ticket services are allowed to decide for these routes. */
const DOCUMENTED_STATUSES = new Set<number>([400, 403, 404, 409, 503]);

export function ticketErrorResponse(err: any, fallbackMessage: string): TicketRouteErrorResponse {
  const documented = DOCUMENTED_STATUSES.has(err?.statusCode);
  const status = documented ? err.statusCode : staffErrorStatus(err, 500);

  const error =
    typeof err?.message === "string" && err.message ? err.message : fallbackMessage;
  // Codes ride ONLY documented refusals: an unexpected failure's internal
  // code name (e.g. a raw SDK/transaction error) must not reach the client.
  const code =
    documented && typeof err?.code === "string" && err.code ? err.code : undefined;

  return code ? { status, body: { error, code } } : { status, body: { error } };
}
