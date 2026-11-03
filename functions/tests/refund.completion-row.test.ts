import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The partner Refund Clearance Terminal reads the `refunds` collection, but the
 * refund release routine used to record completion only in
 * `payment_refund_requests`. Live staging showed the consequence: money went back
 * (Razorpay rfnd_… processed) while the review row stayed PENDING, so the console
 * still offered "Approve Payout" for an already-refunded order.
 *
 * These are source-contract assertions on the release routine: the operator row
 * must be completed in the same transaction, and every read must precede writes.
 */
const SRC = readFileSync(
  resolve(__dirname, "../src/modules/payments/razorpay.service.ts"),
  "utf8"
);

function completionRegion(): string {
  const start = SRC.indexOf("const refundedTotal = await runTx(async (tx) => {");
  const end = SRC.indexOf("if (refundState.fullyRefunded)", start);
  if (start < 0 || end < 0) throw new Error("refund completion transaction not found");
  return SRC.slice(start, end);
}

describe("refund release completes the operator-visible refunds row", () => {
  it("writes COMPLETED with the gateway refund id on refunds/{id}", () => {
    const region = completionRegion();
    expect(region).toContain('db.collection("refunds").doc(completionDocId)');
    expect(region).toContain('status: "COMPLETED"');
    expect(region).toContain('gatewayStatus: "processed"');
    expect(region).toContain("gatewayRefundId: refundResult.id");
    expect(region).toContain("settledPaise:");
  });

  it("derives the row id from the partner refund request key", () => {
    const region = completionRegion();
    // buildAdminRefundKey produces `refundreq_<refundDocId>`.
    expect(region).toContain('refundRequestId.replace(/^refundreq_/, "")');
    // An unrelated request id must never be treated as a refunds doc id.
    expect(region).toContain("completionDocId !== refundRequestId");
    expect(region).toContain("isSafeDocId(completionDocId)");
  });

  it("reads that row before any write in the transaction", () => {
    const region = completionRegion();
    const readAt = region.indexOf("await tx.get(refundRowRefForCompletion)");
    const firstWriteAt = region.indexOf("tx.set(");
    expect(readAt).toBeGreaterThan(-1);
    expect(firstWriteAt).toBeGreaterThan(-1);
    expect(readAt).toBeLessThan(firstWriteAt);
  });
});
