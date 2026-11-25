import { describe, it, expect } from "vitest";

/**
 * Franchise settlement: month-end statement maths (owner decision 2026-11-20).
 *
 * The owner's words: "if one branch makes X amount of money, 2k gets cut of
 * it, no matter the earning, not per order but month end".
 *
 *   net payable = online collected centrally - online refunds - flat monthly fee
 *   cash sales (COD + counter) are shown for information only, they never move
 *   the net payable because the branch already holds that money.
 *
 * Pure module: no Firestore, no clock, no network.
 */

import {
  DEFAULT_SETTLEMENT_FEE_RUPEES,
  SETTLEMENT_ASSUMPTIONS_VERSION,
  buildSettlementStatement,
  isBranchFeeApplicable,
  previousSettlementMonthKey,
  resolveSettlementFeePaise,
  settlementMonthBounds,
  summarizeSettlementOrders,
} from "../src/modules/settlements/settlementMath";

const DAY = 24 * 60 * 60 * 1000;

describe("settlement month buckets (Asia/Kolkata)", () => {
  it("2026-11 starts at 18:30Z on 31 Oct and ends at 18:30Z on 30 Nov", () => {
    const { startMs, endMs } = settlementMonthBounds("2026-11");
    expect(startMs).toBe(Date.UTC(2026, 9, 31, 18, 30, 0, 0));
    expect(endMs).toBe(Date.UTC(2026, 10, 30, 18, 30, 0, 0));
    expect(endMs - startMs).toBe(30 * DAY);
  });

    it("2026-02 is a 28-day bucket and 2026-12 rolls the year", () => {
    const feb = settlementMonthBounds("2026-02");
    expect(feb.endMs - feb.startMs).toBe(28 * DAY);
    const dec = settlementMonthBounds("2026-12");
    const jan = settlementMonthBounds("2027-01");
    expect(dec.endMs).toBe(jan.startMs);
  });

  it("rejects malformed month keys", () => {
    expect(() => settlementMonthBounds("2026-13")).toThrow(/month key/i);
    expect(() => settlementMonthBounds("202611")).toThrow(/month key/i);
    expect(() => settlementMonthBounds("")).toThrow(/month key/i);
  });

  it("previous month of January is December of the year before", () => {
    expect(previousSettlementMonthKey("2026-01")).toBe("2025-12");
    expect(previousSettlementMonthKey("2026-11")).toBe("2026-10");
    expect(previousSettlementMonthKey("bad")).toBe("");
  });
});

describe("flat monthly fee resolution", () => {
  it("defaults to ₹2,000 when the branch carries no fee", () => {
    const resolved = resolveSettlementFeePaise({});
    expect(resolved.feePaise).toBe(DEFAULT_SETTLEMENT_FEE_RUPEES * 100);
    expect(resolved.source).toBe("default");
    expect(DEFAULT_SETTLEMENT_FEE_RUPEES).toBe(2000);
  });

  it("is the owner's flat ₹2,000 whatever a branch carries (retired fields never price it)", () => {
    // Owner decision 2026-11-20/25: one flat fee. `monthlyFee` is the retired
    // per-order hold knob and `settlementFee` is not a price list — neither may
    // change the statement line, so every branch is charged the same ₹2,000.
    for (const branch of [
      { monthlyFee: 2500 },
      { settlementFee: 1200, monthlyFee: 2500 },
      { settlementFee: 0 },
      { settlementFee: "not-a-number" as never },
      { settlementFee: -50, monthlyFee: -1 },
    ]) {
      expect(resolveSettlementFeePaise(branch)).toMatchObject({
        feePaise: 200000,
        source: "default",
        invalid: false,
      });
    }
  });
});

describe("which months a branch is charged for", () => {
  const month = settlementMonthBounds("2026-11");

  it("charges the full fee once for a branch with sales in the month", () => {
    expect(
      isBranchFeeApplicable({ active: true, createdAtMs: month.startMs - DAY }, true, month)
    ).toMatchObject({ applicable: true });
  });

  it("charges a branch that opened mid-month even with no sales yet", () => {
    expect(
      isBranchFeeApplicable(
        { active: true, createdAtMs: month.startMs + 10 * DAY },
        false,
        month
      )
    ).toMatchObject({ applicable: true });
  });

  it("never charges a branch that opened after the month ended", () => {
    expect(
      isBranchFeeApplicable({ active: true, createdAtMs: month.endMs + DAY }, false, month)
    ).toMatchObject({ applicable: false, reason: "branch-opened-after-month" });
  });

  it("never charges a branch switched off for the whole month", () => {
    expect(
      isBranchFeeApplicable({ active: false, createdAtMs: month.startMs - DAY }, false, month)
    ).toMatchObject({ applicable: false, reason: "branch-inactive" });
    expect(
      isBranchFeeApplicable({ status: "inactive", createdAtMs: month.startMs - DAY }, false, month)
    ).toMatchObject({ applicable: false });
  });

    it("a branch switched off but that did trade in the month still pays", () => {
    expect(
      isBranchFeeApplicable({ active: false, createdAtMs: month.startMs - DAY }, true, month)
    ).toMatchObject({ applicable: true });
  });
});

describe("order aggregation", () => {
  const month = settlementMonthBounds("2026-11");
  const at = (d: number) => new Date(month.startMs + d * 1000).toISOString();

  const orders = [
    // Captured online, partially refunded: 1000 collected, 200 back.
    {
      branchId: "b1",
      createdAt: at(3600),
      settlementEffectiveAtMs: month.startMs + 3600 * 1000,
      paymentChannel: "razorpay",
      payment: { capturedAmountPaise: 100000 },
      refundedTotalPaise: 20000,
          settlementProcessedRefunds: { rf_test: 20000 },
      status: { code: "DELIVERED" },
    },
    // Captured online, no refund, still in the kitchen: money is collected.
    {
      branchId: "b1",
      createdAt: at(7200),
      settlementEffectiveAtMs: month.startMs + 7200 * 1000,
      paymentChannel: "razorpay",
      payment: { capturedAmountPaise: 50000 },
      status: { code: "PREPARING" },
    },
    // Unpaid online: never a sale.
    {
      branchId: "b1",
      createdAt: at(1000),
      settlementEffectiveAtMs: month.startMs + 1000 * 1000,
      status: { code: "PLACED" },
      pricing: { grandTotal: 300 },
    },
    // Counter cash order, completed: the branch holds it.
    {
      branchId: "b1",
      createdAt: at(2000),
      settlementEffectiveAtMs: month.startMs + 2000 * 1000,
      customerId: "cust_walkin",
      paymentMethod: "cod",
      status: { code: "COMPLETED" },
      pricing: { grandTotal: 250 },
    },
    // Counter cash order still open: receivable, not yet in hand.
    {
      branchId: "b1",
      createdAt: at(9000),
      settlementEffectiveAtMs: month.startMs + 9000 * 1000,
      customerId: "cust_walkin",
      paymentMethod: "cod",
      status: { code: "PREPARING" },
      pricing: { grandTotal: 100 },
    },
    // Cash delivery completed.
    {
      branchId: "b1",
      createdAt: at(3000),
      settlementEffectiveAtMs: month.startMs + 3000 * 1000,
      paymentMethod: "cod",
      status: { code: "DELIVERED" },
      pricing: { grandTotal: 400 },
    },
    // Cancelled: excluded everywhere.
    {
      branchId: "b1",
      createdAt: at(4000),
      settlementEffectiveAtMs: month.startMs + 4000 * 1000,
      paymentMethod: "cod",
      status: { code: "CANCELLED" },
      pricing: { grandTotal: 700 },
    },
    // Another branch and another month: never counted.
    {
      branchId: "b2",
      createdAt: at(5000),
      settlementEffectiveAtMs: month.startMs + 5000 * 1000,
      paymentChannel: "razorpay",
      payment: { capturedAmountPaise: 90000 },
      status: { code: "DELIVERED" },
    },
    {
      branchId: "b1",
      createdAt: new Date(month.endMs + DAY).toISOString(),
      settlementEffectiveAtMs: month.endMs + DAY,
      paymentChannel: "razorpay",
      payment: { capturedAmountPaise: 70000 },
      status: { code: "DELIVERED" },
    },
  ];

  const summary = summarizeSettlementOrders(orders, { branchId: "b1", ...month });

  it("nets online captures against online refunds only", () => {
    expect(summary.onlineCollectedPaise).toBe(150000);
    expect(summary.onlineRefundedPaise).toBe(20000);
    expect(summary.onlineNetPaise).toBe(130000);
    expect(summary.onlineOrders).toBe(2);
  });

  it("counts only completed cash as money the branch holds", () => {
    expect(summary.cashCollectedPaise).toBe(65000);
    expect(summary.cashOrders).toBe(2);
    expect(summary.cashPendingOrders).toBe(1);
  });

  it("ignores unpaid, cancelled, other-branch and out-of-month docs", () => {
    expect(summary.excludedOrders).toBe(2); // unpaid + cancelled
    expect(summary.outOfScopeOrders).toBe(2); // other branch + next month
    expect(summary.onlineCollectedPaise).not.toBe(240000);
  });

  it("falls back to the priced capture when the gateway amount is absent", () => {
    const priced = summarizeSettlementOrders(
      [
        {
          branchId: "b1",
          createdAt: at(100),
      settlementEffectiveAtMs: month.startMs + 100 * 1000,
          paymentChannel: "razorpay",
          pricing: { split: { totalAmountPaise: 42000 }, grandTotal: 420 },
          status: { code: "DELIVERED" },
        },
      ],
      { branchId: "b1", ...month }
    );
    expect(priced.onlineCollectedPaise).toBe(42000);
  });

  it("never lets a refund exceed the capture (no negative online money)", () => {
    const overRefunded = summarizeSettlementOrders(
      [
        {
          branchId: "b1",
          createdAt: at(100),
      settlementEffectiveAtMs: month.startMs + 100 * 1000,
          paymentChannel: "razorpay",
          payment: { capturedAmountPaise: 42000 },
          refundedTotalPaise: 60000,
          settlementProcessedRefunds: { rf_test: 60000 },
          status: { code: "DELIVERED" },
        },
      ],
      { branchId: "b1", ...month }
    );
    expect(overRefunded.onlineRefundedPaise).toBe(42000);
    expect(overRefunded.onlineNetPaise).toBe(0);
  });
});

describe("statement arithmetic", () => {
  const month = settlementMonthBounds("2026-11");
  const summary = {
    onlineCollectedPaise: 1300000,
    onlineRefundedPaise: 20000,
    onlineNetPaise: 1280000,
    onlineOrders: 40,
    cashCollectedPaise: 500000,
    cashOrders: 12,
    cashPendingOrders: 1,
    excludedOrders: 3,
    outOfScopeOrders: 0,
    ordersScanned: 56,
    truncated: false,
  };

  it("subtracts the fee once from online money only, keeping cash informational", () => {
    const statement = buildSettlementStatement({
      branchId: "b1",
      branchName: "Surat - VR Mall",
      monthKey: "2026-11",
      month,
      version: 1,
      summary,
      fee: { feePaise: 200000, source: "default", invalid: false },
      feeApplicable: { applicable: true, reason: "branch-active" },
      generatedAtMs: month.endMs + 60_000,
      generatedBy: "scheduler",
      source: "scheduler",
      monthClosed: true,
      now: month.endMs + 60_000,
    });

    expect(statement.netPayablePaise).toBe(1080000); // 12,800 - 2,000
    expect(statement.branchOwes).toBe(false);
    expect(statement.platformFeePaise).toBe(200000);
    expect(statement.cashCollectedPaise).toBe(500000);
    // Cash is NOT part of the payable: 12,800 - 2,000, never plus 5,000.
    expect(statement.netPayablePaise).not.toBe(1580000);
    expect(statement.feeNote).toContain("GST");
    expect(statement.assumptionsVersion).toBe(SETTLEMENT_ASSUMPTIONS_VERSION);
    expect(statement.paidStatus).toBe("unpaid");
    expect(statement.payments).toEqual([]);
    expect(statement.currency).toBe("INR");
    expect(statement.immutable).toBe(true);
  });

  it("can be negative — the branch then owes the brand", () => {
    const statement = buildSettlementStatement({
      branchId: "b2",
      branchName: "New outlet",
      monthKey: "2026-11",
      month,
      version: 1,
      summary: { ...summary, onlineCollectedPaise: 0, onlineRefundedPaise: 0, onlineNetPaise: 0, onlineOrders: 0 },
      fee: { feePaise: 200000, source: "default", invalid: false },
      feeApplicable: { applicable: true, reason: "branch-active" },
      generatedAtMs: month.endMs + 60_000,
      generatedBy: "owner_uid",
      source: "on_demand",
      monthClosed: true,
      now: month.endMs + 60_000,
    });
    expect(statement.netPayablePaise).toBe(-200000);
    expect(statement.branchOwes).toBe(true);
  });

  it("charges no fee for an inactive month and reports why", () => {
    const statement = buildSettlementStatement({
      branchId: "b3",
      branchName: "Closed outlet",
      monthKey: "2026-11",
      month,
      version: 1,
      summary: { ...summary, onlineCollectedPaise: 0, onlineRefundedPaise: 0, onlineNetPaise: 0, onlineOrders: 0 },
      fee: { feePaise: 200000, source: "default", invalid: false },
      feeApplicable: { applicable: false, reason: "branch-inactive" },
      generatedAtMs: month.endMs + 60_000,
      generatedBy: "scheduler",
      source: "scheduler",
      monthClosed: true,
      now: month.endMs + 60_000,
    });
    expect(statement.platformFeePaise).toBe(0);
    expect(statement.netPayablePaise).toBe(0);
    expect(statement.feeApplicableReason).toBe("branch-inactive");
  });

  it("records a truncated scan instead of pretending the totals are complete", () => {
    const statement = buildSettlementStatement({
      branchId: "b4",
      branchName: "Busy outlet",
      monthKey: "2026-11",
      month,
      version: 3,
      summary: { ...summary, truncated: true },
      fee: { feePaise: 200000, source: "default", invalid: false },
      feeApplicable: { applicable: true, reason: "branch-active" },
      generatedAtMs: month.endMs + 60_000,
      generatedBy: "scheduler",
      source: "scheduler",
      monthClosed: true,
      now: month.endMs + 60_000,
    });
    expect(statement.ordersTruncated).toBe(true);
    expect(statement.version).toBe(3);
    expect(statement.notes.join(" ")).toMatch(/truncat/i);
  });
});
