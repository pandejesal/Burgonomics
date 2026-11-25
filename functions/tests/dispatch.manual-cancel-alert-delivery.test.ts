import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A8-3 (preprod audit c11, package F7) — the Borzo/Porter manual-cancel "alert"
 * must actually be DELIVERED to staff, not just written as a Firestore field.
 *
 * `recordAndAttemptProviderCancel` for a provider with no cancel API records
 * `dispatchPendingCancel.state: "manual_required"` + `dispatchCancelAlert` and
 * stops. Nothing was pushed to the branch, unlike the Shadowfax dead-letter
 * branch, so a rider could keep driving to a cancelled order with only a
 * document field as evidence. Borzo and Porter have no cancel API in our
 * adapter, so the human step stays exactly as it was — but the alert now goes
 * out through the existing staff notification channel, and it is DEDUPED so a
 * retried cancel does not ring the branch twice.
 *
 * Adapters are mocked; no vendor traffic is possible on this path (there is no
 * adapter call at all for these providers).
 */

const { mockDb, savedDocs, state } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const state = { fcmCalls: [] as any[], snapshots: [] as any[] };
  const write = (path: string, data: any, merge?: boolean) => {
    savedDocs[path] = merge ? { ...(savedDocs[path] || {}), ...data } : { ...data };
  };
  const makeRef = (path: string, id: string) => ({
    id,
    __path: path,
    get: vi.fn(async () => ({
      id,
      exists: savedDocs[path] !== undefined,
      data: () => savedDocs[path],
    })),
    set: vi.fn(async (data: any, opts?: any) => write(path, data, opts?.merge)),
  });
  const mockDb: any = {
    collection: (col: string) => ({
      doc: (id: string) => makeRef(`${col}/${id}`, id),
      where: () => ({ limit: () => ({ get: async () => ({ empty: true, docs: [] }) }) }),
    }),
    runTransaction: vi.fn(async (fn: any) =>
      fn({ get: (ref: any) => ref.get(), set: (ref: any, d: any, o?: any) => ref.set(d, o) })
    ),
  };
  return { mockDb, savedDocs, state };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TIMESTAMP",
    increment: (n: number) => n,
    arrayUnion: (item: any) => [item],
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

vi.mock("../src/core/errors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/errors")>();
  return {
    ...actual,
    captureErrorSnapshot: vi.fn(async (snap: any) => {
      state.snapshots.push(snap);
      return "err_test_snapshot";
    }),
  };
});

vi.mock("../src/modules/notifications/fcm.service", () => ({
  dispatchFCM: vi.fn(async (params: any) => {
    state.fcmCalls.push(params);
    return true;
  }),
}));

import { recordAndAttemptProviderCancel } from "../src/modules/dispatch/shadowfax.reconcile";
import { captureErrorSnapshot } from "../src/core/errors";

const snapshotSpy = vi.mocked(captureErrorSnapshot);

beforeEach(() => {
  for (const k of Object.keys(savedDocs)) delete savedDocs[k];
  state.fcmCalls.length = 0;
  state.snapshots.length = 0;
  snapshotSpy.mockClear();
});

function seed(id: string, extra: Record<string, any> = {}) {
  savedDocs[`orders/${id}`] = {
    branchId: "branch_ahmedabad_1",
    status: { code: "CANCELLED", label: "Cancelled", kind: "cancelled", terminal: true },
    deliveryStatus: "dispatched",
    ...extra,
  };
}

describe("A8-3 manual cancel alert is delivered, not just recorded", () => {
  it("pushes one operational alert to the branch topic for a Borzo booking", async () => {
    seed("ord_borzo_alert", {
      dispatchProvider: "borzo",
      dispatchOrderId: "BRZ-1",
      borzoOrderId: "BRZ-1",
      riderName: "Kiran",
    });

    const outcome = await recordAndAttemptProviderCancel({
      orderId: "ord_borzo_alert",
      provider: "borzo",
      providerOrderId: "BRZ-1",
      reason: "order_cancelled",
      requestedBy: "customer:cust_a",
    });

    expect(outcome.state).toBe("pending");
    expect(state.fcmCalls).toHaveLength(1);
    expect(state.fcmCalls[0]).toMatchObject({
      topic: "branch_branch_ahmedabad_1_orders",
      purpose: "operational",
    });
    expect(state.fcmCalls[0].data).toMatchObject({
      type: "dispatch_cancel_manual_required",
      orderId: "ord_borzo_alert",
      provider: "borzo",
      providerOrderId: "BRZ-1",
    });
    expect(String(state.fcmCalls[0].title)).toMatch(/cancel/i);
    // PII boundary: the alert copy carries no rider name or phone.
    expect(String(state.fcmCalls[0].body)).not.toContain("Kiran");
    // Durable alert trail for ops too.
    const high = state.snapshots.filter((s: any) => s?.severity === "high");
    expect(high.length).toBeGreaterThanOrEqual(1);
  });

  it("pushes the same alert for a Porter booking", async () => {
    seed("ord_porter_alert", {
      dispatchProvider: "porter",
      dispatchOrderId: "POR-77",
      porterOrderId: "POR-77",
    });

    await recordAndAttemptProviderCancel({
      orderId: "ord_porter_alert",
      provider: "porter",
      providerOrderId: "POR-77",
      reason: "order_cancelled",
      requestedBy: "staff:ops",
    });

    expect(state.fcmCalls).toHaveLength(1);
    expect(state.fcmCalls[0].data).toMatchObject({ provider: "porter", providerOrderId: "POR-77" });
  });

  it("dedupes: a retried cancel for the SAME booking does not alert the branch twice", async () => {
    seed("ord_dedupe", {
      dispatchProvider: "borzo",
      dispatchOrderId: "BRZ-2",
      borzoOrderId: "BRZ-2",
    });

    const params = {
      orderId: "ord_dedupe",
      provider: "borzo" as const,
      providerOrderId: "BRZ-2",
      reason: "order_cancelled" as const,
      requestedBy: "customer:cust_a",
    };
    await recordAndAttemptProviderCancel(params);
    await recordAndAttemptProviderCancel(params);
    await recordAndAttemptProviderCancel(params);

    expect(state.fcmCalls).toHaveLength(1);
    // The durable record is still (re)written every time.
    expect(savedDocs["orders/ord_dedupe"].dispatchPendingCancel).toMatchObject({
      provider: "borzo",
      providerOrderId: "BRZ-2",
      state: "manual_required",
    });
    expect(savedDocs["orders/ord_dedupe"].dispatchCancelAlert).toMatchObject({
      code: "DISPATCH_CANCEL_MANUAL_REQUIRED",
      alerted: true,
    });
  });

  it("alerts again for a DIFFERENT booking (a rebook is a new rider to call off)", async () => {
    seed("ord_rebook_alert", {
      dispatchProvider: "borzo",
      dispatchOrderId: "BRZ-3",
      borzoOrderId: "BRZ-3",
    });
    await recordAndAttemptProviderCancel({
      orderId: "ord_rebook_alert",
      provider: "borzo",
      providerOrderId: "BRZ-3",
      reason: "order_cancelled",
      requestedBy: "customer:cust_a",
    });
    await recordAndAttemptProviderCancel({
      orderId: "ord_rebook_alert",
      provider: "borzo",
      providerOrderId: "BRZ-4",
      reason: "order_cancelled",
      requestedBy: "customer:cust_a",
    });
    expect(state.fcmCalls).toHaveLength(2);
  });

  it("records the alert without claiming delivery when no branch id exists", async () => {
    // A branch-less order cannot be pushed: the durable record + snapshot must
    // still exist, and the call must not fail the cancel flow.
    savedDocs["orders/ord_no_branch"] = {
      status: { code: "CANCELLED", label: "Cancelled", kind: "cancelled", terminal: true },
      dispatchProvider: "borzo",
      dispatchOrderId: "BRZ-9",
      borzoOrderId: "BRZ-9",
    };

    const outcome = await recordAndAttemptProviderCancel({
      orderId: "ord_no_branch",
      provider: "borzo",
      providerOrderId: "BRZ-9",
      reason: "order_cancelled",
      requestedBy: "customer:cust_a",
    });

    expect(outcome.state).toBe("pending");
    expect(state.fcmCalls).toHaveLength(0);
    expect(savedDocs["orders/ord_no_branch"].dispatchCancelAlert).toMatchObject({
      code: "DISPATCH_CANCEL_MANUAL_REQUIRED",
      alerted: false,
    });
    const high = state.snapshots.filter((s: any) => s?.severity === "high");
    expect(high.length).toBeGreaterThanOrEqual(1);
  });
});
