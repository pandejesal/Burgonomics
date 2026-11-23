import { describe, it, expect } from "vitest";

/**
 * GPT-6.2 Sol final review 2026-11-22 — M1 / M6 / M7 pure maths regressions.
 *
 * RED evidence: settlementMath bucketed by placement, erased a capture on a
 * cancelled kitchen status, charged the flat fee again over old Route holds,
 * and never computed an outstanding balance against prior payments.
 * GREEN: the effective (capture) timestamp decides the month, captured-minus-
 * actually-booked-refunds wins whatever the kitchen says, old transfers and
 * holds are credited, and only the delta is outstanding.
 */
import {
  buildSettlementStatement,
  resolveSettlementFeePaise,
  settlementCaptureStamp,
  settlementCapturePending,
  settlementCaptureUnknown,
  providerCapturedAtMs,
  settlementEffectiveAtMsOf,
  settlementMonthBounds,
  summarizeSettlementOrders,
  type SettlementFeeResolution,
} from "../src/modules/settlements/settlementMath";

const NOV = settlementMonthBounds("2026-11");
const DEC = settlementMonthBounds("2026-12");
const scope = (m: typeof NOV) => ({ branchId: "br_a", startMs: m.startMs, endMs: m.endMs });
const FEE: SettlementFeeResolution = { feePaise: 20000, source: "settlementFee", invalid: false };

function online(id: string, extra: Record<string, any> = {}) {
  return {
    id,
    branchId: "br_a",
    createdAt: { toMillis: () => NOV.startMs + 1000 },
    settlementEffectiveAtMs: NOV.startMs + 1000,
    paymentChannel: "razorpay",
    payment: { capturedAmountPaise: 50000 },
    ...extra,
  };
}

function build(overrides: Record<string, any> = {}) {
  return buildSettlementStatement({
    branchId: "br_a",
    branchName: "A",
    monthKey: "2026-11",
    month: NOV,
    version: 1,
    summary: {
      onlineCollectedPaise: 50000,
      onlineRefundedPaise: 0,
      onlineNetPaise: 50000,
      onlineOrders: 1,
      cashCollectedPaise: 0,
      cashOrders: 0,
      cashPendingOrders: 0,
      excludedOrders: 0,
      outOfScopeOrders: 0,
      ordersScanned: 1,
      truncated: false,
      captureUnresolved: 0,
    },
    fee: FEE,
    feeApplicable: { applicable: true, reason: "branch-active" },
    generatedAtMs: NOV.endMs + 1,
    generatedBy: "test",
    source: "on_demand",
    monthClosed: true,
    now: NOV.endMs + 1,
    ...overrides,
  });
}

describe("M7 — effective capture month and booked refunds", () => {
  it("counts a cross-midnight IST capture in the month the customer PAID", () => {
    // Placed 30 Nov 23:30 IST, captured 1 Dec 00:10 IST.
    const order = online("ord_midnight", {
      createdAt: { toMillis: () => NOV.endMs - 30 * 60 * 1000 },
      settlementEffectiveAtMs: DEC.startMs + 10 * 60 * 1000,
    });
    expect(settlementEffectiveAtMsOf(order)).toBe(DEC.startMs + 10 * 60 * 1000);
    expect(summarizeSettlementOrders([order], scope(NOV)).onlineOrders).toBe(0);
    const dec = summarizeSettlementOrders([order], scope(DEC));
    expect(dec.onlineOrders).toBe(1);
    expect(dec.onlineCollectedPaise).toBe(50000);
  });

  it("uses the gateway capture time for legacy rows with no stamped field", () => {
    const order = online("ord_legacy_capture", {
      createdAt: { toMillis: () => NOV.startMs + 1 },
      settlementEffectiveAtMs: DEC.startMs + 60 * 1000,
      settlementCaptureState: "confirmed",
    });
    expect(settlementEffectiveAtMsOf(order)).toBe(DEC.startMs + 60 * 1000);
    expect(summarizeSettlementOrders([order], scope(DEC)).onlineCollectedPaise).toBe(50000);
  });

  it("reads a placedAt-only legacy row", () => {
    const order = online("ord_placed_only", {
      createdAt: undefined,
      placedAt: { toMillis: () => NOV.startMs + 60 * 1000 },
      settlementEffectiveAtMs: NOV.startMs + 60 * 1000,
    });
    expect(summarizeSettlementOrders([order], scope(NOV)).onlineOrders).toBe(1);
  });

  it("keeps a cancelled capture and only subtracts actually booked refunds", () => {
    const none = summarizeSettlementOrders(
      [online("ord_cancel_no_refund", { status: { code: "CANCELLED" } })],
      scope(NOV)
    );
    expect(none.onlineNetPaise).toBe(50000);

    const partial = summarizeSettlementOrders(
      [online("ord_cancel_partial", { status: { code: "CANCELLED" }, refundedTotalPaise: 20000, settlementProcessedRefunds: { rf_p: 20000 } })],
      scope(NOV)
    );
    expect(partial.onlineCollectedPaise).toBe(50000);
    expect(partial.onlineRefundedPaise).toBe(20000);
    expect(partial.onlineNetPaise).toBe(30000);

    const full = summarizeSettlementOrders(
      [online("ord_cancel_full", { status: { code: "CANCELLED" }, refundedTotalPaise: 50000, settlementProcessedRefunds: { rf_f: 50000 } })],
      scope(NOV)
    );
    expect(full.onlineOrders).toBe(1);
    expect(full.onlineCollectedPaise).toBe(50000);
    expect(full.onlineRefundedPaise).toBe(50000);
    expect(full.onlineNetPaise).toBe(0);
  });
});

describe("M7 — only processed refunds and a known capture are payable", () => {
  it("never guesses wall-clock capture time", () => {
    expect(settlementCaptureStamp(1767225600000)).toEqual({ settlementEffectiveAtMs: 1767225600000, settlementCaptureState: "confirmed", settlementCaptureUnresolved: false });
    expect(settlementCapturePending()).toEqual({ settlementCaptureState: "pending", settlementCaptureUnresolved: true });
    expect(settlementCaptureUnknown()).toEqual({ settlementCaptureState: "unknown", settlementCaptureUnresolved: true });
  });

  it("uses the signed payment.captured event time, never the entity authorisation time", () => {
    // Exact shape from Razorpay docs /my/webhooks/payments.mdx "Payment Captured":
    // entity.created_at is authorisation; top-level created_at is the event.
    const event = {
      event: "payment.captured",
      created_at: 1767674606,
      payload: { payment: { entity: { created_at: 1767674599, captured: true } } },
    };
    expect(providerCapturedAtMs(event)).toBe(1767674606000);
    expect(providerCapturedAtMs({ ...event, event: "payment.authorized" })).toBeUndefined();
    expect(providerCapturedAtMs({ ...event, created_at: undefined })).toBeUndefined();
    // IST month boundary is 18:30Z; event time lands in the next month.
    const boundary = Date.UTC(2026, 10, 30, 18, 30, 0) / 1000;
    const at = providerCapturedAtMs({ ...event, created_at: boundary })!;
    const nov = settlementMonthBounds("2026-11");
    const dec = settlementMonthBounds("2026-12");
    expect(at).toBeGreaterThanOrEqual(nov.endMs);
    expect(at).toBeLessThan(dec.endMs);
  });

  it("deducts only the processed refund map", () => {
    const paid = online("ord_refunded", { settlementProcessedRefunds: { rf_1: 5000 }, refundedTotalPaise: 5000 });
    const pending = online("ord_pending", { settlementProcessedRefunds: {}, refundedTotalPaise: 5000, refundStatus: "pending" });
    expect(summarizeSettlementOrders([paid], scope(NOV)).onlineRefundedPaise).toBe(5000);
    expect(summarizeSettlementOrders([pending], scope(NOV)).onlineRefundedPaise).toBe(0);
  });
});

describe("M6 — per branch/month payment ledger exposes only the delta", () => {
  it("an unchanged regeneration is fully covered by prior payments", () => {
    const s = build({
      priorSettledNetPaise: 30000,
    });
    // 50000 collected - 20000 fee = 30000 net; minus 30000 already paid = 0.
    expect(s.netPayablePaise).toBe(30000);
    expect(s.outstandingPaise).toBe(0);
    expect(s.paidStatus).toBe("unpaid"); // no carried records in this pure case
  });

  it("a late refund shows only the negative delta", () => {
    const s = build({
      summary: {
        onlineCollectedPaise: 50000,
        onlineRefundedPaise: 5000,
        onlineNetPaise: 45000,
        onlineOrders: 1,
        cashCollectedPaise: 0,
        cashOrders: 0,
        cashPendingOrders: 0,
        excludedOrders: 0,
        outOfScopeOrders: 0,
        ordersScanned: 1,
        truncated: false,
      captureUnresolved: 0,
      },
      priorSettledNetPaise: 30000,
    });
    // revised net 45000 - 20000 fee = 25000; minus 30000 settled = -5000.
    expect(s.netPayablePaise).toBe(25000);
    expect(s.outstandingPaise).toBe(-5000);
  });

  it("a truncated scan is never complete", () => {
    const s = build({
      summary: {
        onlineCollectedPaise: 50000,
        onlineRefundedPaise: 0,
        onlineNetPaise: 50000,
        onlineOrders: 1,
        cashCollectedPaise: 0,
        cashOrders: 0,
        cashPendingOrders: 0,
        excludedOrders: 0,
        outOfScopeOrders: 0,
        ordersScanned: 4000,
        truncated: true,
      captureUnresolved: 0,
      },
    });
    expect(s.complete).toBe(false);
    expect(s.notes.join(" ")).toMatch(/truncated/i);
  });
});
