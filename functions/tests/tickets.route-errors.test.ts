import { describe, expect, it } from "vitest";
import { serviceError } from "../src/core/errors";
import { ticketErrorResponse } from "../src/modules/tickets/ticketRouteErrors";

// /tickets/resolve + /tickets/resolveNote error mapping (scoped route-errors
// regression, mirrors orders.bump-route-errors.test.ts).
//
// The money route used to map EVERY failure to HTTP 500 with no `code`, so the
// documented 409 lease refusal ("another staff member is resolving this") and
// the 409 already-resolved refusal were indistinguishable from a server fault.
// The note route honoured 404/409 but dropped the code. These tests pin the
// mapping and the "no leak expansion" rule at the exact function the routes
// now call.

describe("/tickets/resolve(+Note) error mapping", () => {
  it("preserves the 409 lease refusal and its code (the case this lane added)", () => {
    const err = serviceError(
      "TICKET_RESOLUTION_IN_PROGRESS",
      "Ticket tkt_1 is being resolved by another staff member right now — try again in a moment.",
      409
    );
    const res = ticketErrorResponse(err, "Failed to resolve ticket");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("TICKET_RESOLUTION_IN_PROGRESS");
    expect(res.body.error).toContain("another staff member");
  });

  it("preserves both already-resolved codes used by the two resolve paths", () => {
    expect(
      ticketErrorResponse(
        serviceError("TICKET_ALREADY_RESOLVED", "Ticket is already resolved", 409),
        "Failed to resolve ticket"
      )
    ).toMatchObject({ status: 409, body: { code: "TICKET_ALREADY_RESOLVED" } });
    expect(
      ticketErrorResponse(
        serviceError("TICKET_NOT_PENDING", "Ticket is already resolved.", 409),
        "Failed to resolve ticket"
      )
    ).toMatchObject({ status: 409, body: { code: "TICKET_NOT_PENDING" } });
  });

  it("preserves the 503 contention-retry refusal as retryable, not a 500", () => {
    const res = ticketErrorResponse(
      serviceError("TICKET_RESOLUTION_RETRY", "Ticket is being updated concurrently — retry", 503),
      "Failed to resolve ticket"
    );
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("TICKET_RESOLUTION_RETRY");
  });

  it("preserves documented 400 / 403 / 404 refusals with codes", () => {
    expect(
      ticketErrorResponse(
        serviceError("TICKET_REFUND_AMOUNT_REQUIRED", "Partial refund needs an amount", 400),
        "Failed to resolve ticket"
      )
    ).toMatchObject({ status: 400, body: { code: "TICKET_REFUND_AMOUNT_REQUIRED" } });
    expect(
      ticketErrorResponse(
        serviceError("TICKET_FORBIDDEN", "Forbidden: ticket is outside your branches", 403),
        "Failed to resolve ticket"
      )
    ).toMatchObject({ status: 403, body: { code: "TICKET_FORBIDDEN" } });
    expect(
      ticketErrorResponse(
        serviceError("TICKET_NOT_FOUND", "Ticket not found", 404),
        "Failed to resolve ticket"
      )
    ).toMatchObject({ status: 404, body: { code: "TICKET_NOT_FOUND" } });
  });

  it("an UNDOCUMENTED status degrades to 500 and never leaks the code", () => {
    const err = serviceError("SOME_INTERNAL", "internal detail", 418);
    const res = ticketErrorResponse(err, "Failed to resolve ticket");
    expect(res.status).toBe(500);
    expect(res.body.code).toBeUndefined();
  });

  it("a codeless error keeps the fallback message and no code", () => {
    const res = ticketErrorResponse(new Error(""), "Failed to resolve ticket");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to resolve ticket" });
  });
});
