/**
 * Refund release must clear BOTH pending markers, not just the top-level status.
 *
 * Observed live on ord_1793721600000_l29btj after a successful release:
 *   refundStatus            "refunded"           (correct)
 *   refundedTotalPaise      26300                (correct)
 *   payment.refundStatus    "PENDING_APPROVAL"   (stale)
 *   refundObligation.status "QUEUED"             (stale)
 *
 * The two stale fields are exactly what the partner console and the customer
 * card read to decide whether a refund still needs a human, so a completed
 * refund kept advertising itself as pending. This pins the fix.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(__dirname, "../src/modules/payments/razorpay.service.ts"),
  "utf8",
);

/** The block that builds the post-release order update. */
function completionBlock(): string {
  const start = SRC.indexOf("const orderCompleteData: Record<string, any> = {");
  const end = SRC.indexOf("tx.set(orderRef, orderCompleteData", start);
  if (start < 0 || end < 0) throw new Error("completion block not found");
  return SRC.slice(start, end);
}

describe("refund release clears every pending marker", () => {
  it("writes the nested payment refund status alongside the top-level one", () => {
    const block = completionBlock();
    expect(block).toContain("orderCompleteData.refundStatus = refundStatusValue");
    expect(block).toContain('orderCompleteData["payment.refundStatus"] = refundStatusValue');
  });

  it("settles the cancellation obligation instead of leaving it QUEUED", () => {
    const block = completionBlock();
    expect(block).toContain('orderCompleteData["refundObligation.status"] = "SETTLED"');
  });

  it("records which gateway refund settled the obligation", () => {
    const block = completionBlock();
    expect(block).toContain('orderCompleteData["refundObligation.settledRefundId"] = refundResult.id');
    expect(block).toContain('orderCompleteData["refundObligation.settledAt"]');
  });

  it("keeps every marker write inside the claim-ownership guard", () => {
    // A stale completed-record transaction must never rewrite another worker's
    // active lease, so the markers move only when this run still owns the claim.
    const src = SRC;
    const guard = src.indexOf("if (stillOwnsClaim) {");
    const nested = src.indexOf('orderCompleteData["payment.refundStatus"]');
    const obligation = src.indexOf('orderCompleteData["refundObligation.status"]');
    const close = src.indexOf("tx.set(orderRef, orderCompleteData");

    expect(guard).toBeGreaterThan(-1);
    expect(nested).toBeGreaterThan(guard);
    expect(obligation).toBeGreaterThan(guard);
    expect(close).toBeGreaterThan(obligation);
  });

  it("does not invent a third refund-status vocabulary", () => {
    const block = completionBlock();
    // The value must come from the existing computation, never a new literal.
    expect(block).not.toMatch(/payment\.refundStatus"\]\s*=\s*"(refunded|partially_refunded)"/);
  });
});
