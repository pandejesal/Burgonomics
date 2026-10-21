import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Lane 08 (payments) — Route transfer ACCOUNT-SHAPE guard.
//
// Defect: attemptRouteTransfer accepted ANY non-empty string as the linked
// account id. A typo'd/loose value ("acc_x", garbage persisted by a loose
// config form) was either POSTed to the gateway (definite 4xx → endless
// pending_retry with a misleading gateway error) or — in mock mode — stamped
// as an ok:true "transferred" receipt for an account that cannot receive
// money. The transfer chokepoint is the last line of defense regardless of
// what any UI validates, so it must refuse a malformed id itself.
//
// Compatibility rule: real Razorpay linked-account ids are alphanumeric
// (acc_ + ~14 chars). The repo's documented demo fixtures use underscores
// (acc_Rzp_Surat_01), so the backend guard requires >=6 chars of
// [A-Za-z0-9_] after acc_ — it rejects bare/short ids (the actual defect)
// without breaking the documented fixture shape. The partner UI enforces the
// stricter alphanumeric rule at entry.
const { mockDb } = vi.hoisted(() => {
  process.env.OTP_HMAC_SECRET = "test_otp_route_account_shape";
  const mockDb: any = {
    collection: () => ({ doc: () => ({ get: async () => ({ exists: false, data: () => ({}) }) }) }),
  };
  return { mockDb };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TIMESTAMP",
    increment: (n: number) => n,
    arrayUnion: (item: any) => [item],
    delete: () => "MOCK_DELETE",
  };
  const firestoreFn: any = vi.fn(() => mockDb);
  firestoreFn.FieldValue = FieldValue;
  return {
    default: {
      firestore: firestoreFn,
      auth: vi.fn(() => ({})),
      messaging: vi.fn(() => ({})),
      initializeApp: vi.fn(),
      apps: [{ name: "mock" }],
    },
    firestore: firestoreFn,
    auth: vi.fn(() => ({})),
    messaging: vi.fn(() => ({})),
    initializeApp: vi.fn(),
    apps: [{ name: "mock" }],
  };
});

import { attemptRouteTransfer, isRouteAccountIdShape } from "../src/modules/payments/routeTransfers";
import { __resetRazorpayClientForTests, __setRazorpayClientForTests } from "../src/modules/payments/razorpayClient";
import { config } from "../src/config/env";

const SPLIT = { branchTransferPaise: 9000, brandRoyaltyPaise: 1000, totalAmountPaise: 10000 };

const attempt = (accountId: string | null | undefined) =>
  attemptRouteTransfer(
    "pay_shape_1",
    "branch_shape_1",
    SPLIT,
    "order_shape_1",
    accountId as any,
    10000
  );

describe("Route transfer account-shape guard", () => {
  let prevMock: boolean;
  beforeEach(() => {
    prevMock = config.mock.paymentGateway;
    config.mock.paymentGateway = true; // gateway POST stubbed; guard path real
  });
  afterEach(() => {
    config.mock.paymentGateway = prevMock;
  });

  it("accepts a real account-id shape and reports a mock transfer (positive control)", async () => {
    expect(isRouteAccountIdShape("acc_A1B2C3D4E5F6G7")).toBe(true);
    const res = await attempt("acc_A1B2C3D4E5F6G7");
    expect(res.ok).toBe(true);
    expect(res.result).toMatchObject({ account: "acc_A1B2C3D4E5F6G7", amount: 9000 });
  });

  it("refuses the bare/short prefix BEFORE the mock-success branch (no fake transferred receipt)", async () => {
    expect(isRouteAccountIdShape("acc_")).toBe(false);
    expect(isRouteAccountIdShape("acc_x")).toBe(false);
    const res = await attempt("acc_x");
    expect(res.ok).toBe(false);
    expect(res.result).toBeUndefined();
    expect(res.error).toMatch(/invalid Razorpay Route account id shape/i);
    // Classification must NOT drift into skipped (silent-unlinked lane) or
    // unknown (needs_reconciliation lane): a config error parks for manual
    // settlement instead of burning the 4-attempt retry budget.
    expect(res.configError).toBe(true);
    expect(res.skipped).toBeFalsy();
    expect(res.unknown).toBeFalsy();
  });

  it("refuses a malformed id in LIVE mode without touching the gateway client", async () => {
    const transfer = vi.fn();
    const fetchTransfer = vi.fn();
    __setRazorpayClientForTests({ payments: { transfer, fetchTransfer } });
    try {
      config.mock.paymentGateway = false; // live path: no mock short-circuit
      const res = await attempt("acc_x");
      expect(res.ok).toBe(false);
      expect(res.configError).toBe(true);
      // The guard sits before getRazorpayClient/reconcile/POST: zero calls.
      expect(transfer).not.toHaveBeenCalled();
      expect(fetchTransfer).not.toHaveBeenCalled();
    } finally {
      __resetRazorpayClientForTests();
      config.mock.paymentGateway = true;
    }
  });

  it("trims surrounding whitespace and pays the trimmed account (never a 4xx loop)", async () => {
    expect(isRouteAccountIdShape("  acc_abc123  ")).toBe(true);
    const res = await attempt("  acc_abc123  ");
    expect(res.ok).toBe(true);
    expect(res.result.account).toBe("acc_abc123");
  });

  it("refuses arbitrary text that never had the acc_ prefix", async () => {
    const res = await attempt("branch-account-42");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/invalid Razorpay Route account id shape/i);
  });

  it("keeps the documented demo fixture shape working (acc_Rzp_Surat_01)", async () => {
    expect(isRouteAccountIdShape("acc_Rzp_Surat_01")).toBe(true);
    expect(isRouteAccountIdShape("acc_branch_ahmedabad_01")).toBe(true);
    const res = await attempt("acc_Rzp_Surat_01");
    expect(res.ok).toBe(true);
  });

  it("pins the >=6-suffix boundary", async () => {
    expect(isRouteAccountIdShape("acc_12345")).toBe(false);
    expect(isRouteAccountIdShape("acc_123456")).toBe(true);
  });

  it("keeps the unlinked-branch skip behavior unchanged", async () => {
    const res = await attempt(null);
    expect(res.ok).toBe(false);
    expect(res.skipped).toBe(true);
    expect(res.error).toMatch(/No linked Razorpay account/i);
  });
});
