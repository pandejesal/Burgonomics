import { describe, expect, it } from "vitest";
import { serviceError } from "../src/core/errors";
import { bumpStatusErrorResponse } from "../src/modules/orders/bumpRouteErrors";

// /orders/bumpStatus error mapping (scoped route-errors regression).
//
// The route used to honour only 400/404, so the DOCUMENTED 409
// STALE_ORDER_STATUS (orderStatus.ts:129-134) surfaced as HTTP 500 and the
// partner app could not distinguish "refresh before acting" from a server
// fault. These tests pin the mapping and the "no leak expansion" rule at the
// exact function the route now calls.

describe("/orders/bumpStatus error mapping", () => {
  it("preserves the documented 409 STALE_ORDER_STATUS and its code", () => {
    const err = serviceError(
      "STALE_ORDER_STATUS",
      "Order ord_1 moved to PREPARING since the screen loaded; refresh before acting",
      409
    );
    const res = bumpStatusErrorResponse(err);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("STALE_ORDER_STATUS");
    expect(res.body.error).toContain("refresh before acting");
  });

  it("preserves 409 ORDER_STATUS_CONFLICT", () => {
    const res = bumpStatusErrorResponse(
      serviceError("ORDER_STATUS_CONFLICT", "Two bumps raced; reload the order", 409)
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ORDER_STATUS_CONFLICT");
  });

  it("preserves the 400 and 404 refusals with their codes", () => {
    expect(
      bumpStatusErrorResponse(serviceError("BAD_TRANSITION", "Cannot move DELIVERED to PREPARING", 400))
    ).toMatchObject({ status: 400, body: { code: "BAD_TRANSITION" } });

    expect(
      bumpStatusErrorResponse(serviceError("ORDER_NOT_FOUND", "Order does not exist", 404))
    ).toMatchObject({ status: 404, body: { code: "ORDER_NOT_FOUND" } });
  });

  it("honours an explicit 403 and keeps the middleware Forbidden fallback", () => {
    expect(
      bumpStatusErrorResponse(serviceError("FORBIDDEN_ROLE", "Role cannot bump", 403))
    ).toMatchObject({ status: 403, body: { code: "FORBIDDEN_ROLE" } });

    // No statusCode: staffErrorStatus maps the message prefix (unchanged).
    const fallback = bumpStatusErrorResponse(new Error("Forbidden: role cannot bump"));
    expect(fallback.status).toBe(403);
    expect(fallback.body.error).toContain("Forbidden");
    expect(Object.keys(fallback.body)).toEqual(["error"]);
  });

  it("keeps an UNKNOWN failure at 500 and does not widen the body", () => {
    const res = bumpStatusErrorResponse(new Error("Firestore transaction aborted: internal detail"));
    expect(res.status).toBe(500);
    // No code is invented and no stack/details are added.
    expect(Object.keys(res.body).sort()).toEqual(["error"]);
    expect(res.body).not.toHaveProperty("code");
    expect(JSON.stringify(res.body)).not.toContain("stack");
  });

  it("never emits an undefined message", () => {
    const res = bumpStatusErrorResponse({});
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Failed to update order status");
    expect(Object.keys(res.body)).toEqual(["error"]);
  });

  it("treats a non-object throwable as an unknown 500", () => {
    expect(bumpStatusErrorResponse("boom")).toMatchObject({
      status: 500,
      body: { error: "Failed to update order status" },
    });
  });
});
