/**
 * A `pending` refund must not be recorded as settled.
 *
 * Grounded in Razorpay's own documentation, which the workstream had not checked
 * before this test was written:
 *
 *   "status … Possible values: `pending`: This state indicates that Razorpay is
 *    attempting to process the refund. `processed`: This is the final state of
 *    the refund. `failed`: …"
 *    https://razorpay.com/docs/api/refunds/entity
 *
 *   "Do all refunds … always return a 'processed' status instantly via the Refund
 *    API? No … the initial API response might return a `pending` status. In all
 *    scenarios, rely on the `refund.processed` webhook for the final, verified
 *    status update."
 *    https://razorpay.com/docs/payments/refunds/faqs
 *
 * Before this change any 2xx refund response with an id was stamped "refunded",
 * so a pending refund told the customer the money was back and dropped the
 * console row an operator would chase.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SERVICE = readFileSync(
  resolve(__dirname, "../src/modules/payments/razorpay.service.ts"),
  "utf8",
);
const WEBHOOK = readFileSync(
  resolve(__dirname, "../src/modules/payments/webhookHandler.ts"),
  "utf8",
);

/** The release transaction body, from the claim check to the completion write. */
function releaseBlock(): string {
  const start = SERVICE.indexOf("const stillOwnsClaim =");
  const end = SERVICE.indexOf("tx.set(orderRef, orderCompleteData");
  if (start < 0 || end < 0) throw new Error("release block not found");
  return SERVICE.slice(start, end);
}

describe("a pending gateway refund is not stamped settled", () => {
  it("detects the gateway's pending state on the refund response", () => {
    const block = releaseBlock();
    expect(block).toContain("gatewaySaysPending");
    expect(block).toContain('refundResult.status.toLowerCase() === "pending"');
  });

  it("marks the order in-flight instead of refunded", () => {
    const block = releaseBlock();
    expect(block).toContain('inFlightData.refundStatus = "refund_pending"');
    // NESTED MAP patch: a dotted set() key stays literal and leaves the real
    // marker stale (see refund.marker-nested-write.test.ts for the behaviour).
    expect(block).toContain("inFlightData.payment = {");
    expect(block).toContain('refundStatus: "pending"');
    expect(block).toContain('status: "IN_FLIGHT"');
  });

  it("records the gateway refund id so the webhook can match it", () => {
    const block = releaseBlock();
    expect(block).toContain("refundPendingGatewayId = refundResult.id");
    expect(block).toContain("gatewayRefundId: refundResult.id");
  });

  it("still counts the amount against the cap to block an over-refund", () => {
    const block = releaseBlock();
    expect(block).toContain("refundedTotalPaise: nextTotal");
  });

  it("keeps the operator row out of a settled state while in flight", () => {
    const block = releaseBlock();
    expect(block).toContain('status: "IN_FLIGHT"');
    expect(block).toContain('gatewayStatus: "pending"');
  });

  it("returns before the completion write, so nothing downstream says refunded", () => {
    const block = releaseBlock();
    const pendingBranch = block.indexOf("if (gatewaySaysPending) {");
    const earlyReturn = block.indexOf("return { nextTotal, fullyRefunded: false };", pendingBranch);
    const completion = block.indexOf("orderCompleteData.refundStatus = refundStatusValue");
    expect(pendingBranch).toBeGreaterThan(-1);
    expect(earlyReturn).toBeGreaterThan(pendingBranch);
    expect(completion).toBeGreaterThan(earlyReturn);
  });

  it("does not overwrite a human decision when parking the row in flight", () => {
    const block = releaseBlock();
    expect(block).toContain('priorStatus !== "REJECTED" && priorStatus !== "WITHDRAWN"');
  });
});

describe("the refund.processed webhook is what makes it final", () => {
  it("clears the in-flight markers on the final write", () => {
    expect(WEBHOOK).toContain("refundPendingSince: admin.firestore.FieldValue.delete()");
    expect(WEBHOOK).toContain("refundPendingGatewayId: admin.firestore.FieldValue.delete()");
  });

  it("settles the obligation with the proven refund id", () => {
    expect(WEBHOOK).toContain('status: "SETTLED"');
    expect(WEBHOOK).toContain("settledRefundId: refundId");
  });

  it("writes the nested payment marker the console reads, not only the top-level one", () => {
    // NESTED MAP form: a dotted key passed to set() stays LITERAL and would
    // leave the real `payment.refundStatus` stale.
    expect(WEBHOOK).toContain("payment: {");
    expect(WEBHOOK).toContain("refundStatus: hasCapture && nextTotal < capturedPaise");
    expect(WEBHOOK).not.toContain('"payment.refundStatus":');
  });
});
