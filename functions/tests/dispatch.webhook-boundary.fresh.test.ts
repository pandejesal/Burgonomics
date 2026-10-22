import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Boundary pins for the Borzo/Shadowfax webhook intake (lane 04, owned paths:
 * dispatch.webhooks.ts + this suite). Harness mirrors
 * dispatch.webhooks-hardening.test.ts (firebase-admin mocked,
 * handleDispatchWebhook called directly) plus a dispatchFCM spy so rebook /
 * manual-review notification semantics are asserted without any real send.
 *
 * Semantics under test (F2/F6/F7 + the two HIGH findings on the F2/F6/F7
 * packet, repro'd by Main: ses_e9efc4eebffejwcRcuTJQQWyeY):
 *  - F2 [order integrity]: a late/out-of-order ARRIVED (-> ARRIVED_AT_PICKUP)
 *    must not rewind an in_transit mirror back to at_pickup; a pre-pickup
 *    ARRIVED still records rider arrival truthfully.
 *  - F6 [consent/safety containment]: CANCELLED_BY_CUSTOMER and
 *    RETURNED_TO_SELLER are manual-review outcomes on the EXISTING
 *    `needs_review` dispatch state — dispatchBook's rebook vocabulary, the
 *    guarded staff rebook (NOT_REBOOKABLE allows needs_review) and the
 *    customer's order status lifecycle are NOT overwritten: no order.status
 *    write, no RIDER_CANCELLED code (which contradicts the manual-review
 *    label), no needsRebook=true, no carrier_cancelled trigger, no rebook
 *    FCM. The cause rides the existing rebookTrigger/riderCancellationReason
 *    fields. Carrier/no-rider cancels keep the prior auto-rebook flow.
 *  - F6-sticky [containment must not be unwound]: once the active booking is
 *    contained (needs_review), a later NO_RIDERS_FOUND / generic carrier
 *    cancel on the SAME booking must not re-set needsRebook (the scheduled
 *    auto-rebook worker would book another courier for a customer-called-off
 *    delivery), must not overwrite the contained state, and must not send a
 *    rebook alert. NOTE: this is a pre-write state predicate on a plain
 *    read/write, NOT a transaction — two truly concurrent different-body
 *    events remain last-write-wins; redeliveries dedup on the deterministic
 *    park id. The harness does not claim race evidence.
 *  - F7 read-side [binding integrity at resolution]: a dispatch_order_map row
 *    bound to a DIFFERENT provider must park (order_id_conflict, high)
 *    BEFORE any order/rider/status mutation.
 *  - F7-order-side [stale-map ownership proof]: the map row only proves WHAT
 *    the callback claims; the order's CURRENT binding (dispatchProvider +
 *    dispatchOrderId, rewritten by every book/rebook) proves what the order
 *    still belongs to. dispatchBook never deletes a superseded map row, so a
 *    Borzo->Shadowfax rebook leaves the old row behind and its late
 *    DELIVERED/CANCELLED callback can still resolve — the pre-mutation
 *    check parks that mismatch HIGH (provider mismatch, booking-id
 *    mismatch, or an order with no binding metadata at all: absent evidence
 *    is not license to guess). Numeric vs string provider ids compare
 *    consistently. Same-provider/current-binding callbacks stay green.
 *
 * NEGATIVE CONTROLS (distinguish, never blur): running THIS suite against the
 * pristine committed source (086b60d) must fail the F2/F6/F7 pins — those are
 * the original packet's defects. Running it against the frozen v1 packet
 * bytes (Temp/opencode/main-dispatch-boundary-v1) must fail the NEEDS_REVIEW
 * vocabulary pins and the NEW stale-map/containment pins — those are the two
 * HIGH findings. Each RED run names which groups fail; no group is silently
 * mixed. No production source is mutated to manufacture RED.
 *
 * Harness fidelity notes (finding-final): a missing doc in ANY collection —
 * including orders — is a true absence (exists:false, data() undefined);
 * every positive test seeds its order explicitly. The merge fake shallow-
 * spreads, which is faithful here because the webhook rebuilds the whole
 * order.delivery snapshot from the pre-write state before writing it.
 */

const { mockDb, savedDocs, defaultOrder } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const defaultOrder = () => ({
    branchId: "branch_ahmedabad_1",
    branchName: "Burgonomics CG Road",
    branchCoordinates: { lat: 23.0131, lng: 72.5085 },
    deliveryAddress: {
      full: "102, Shivalik Highstreet, Vastrapur",
      lat: 23.0338,
      lng: 72.5262,
    },
    customerName: "Aarav Shah",
    status: "ready", // legacy string shape — kept on purpose to prove preservation below
  });
  const mergeSet = (colName: string, docId: string, data: any) => {
    savedDocs[`${colName}/${docId}`] = {
      ...(savedDocs[`${colName}/${docId}`] || {}),
      ...data,
    };
  };
  const readDoc: any = (colName: string, docId: string) => {
    // TRUE ABSENCE for every missing doc (orders included): no synthetic
    // default order may hide behind an exists:true fallback, otherwise a
    // "missing order" pin passes for the wrong reason.
    const rec = savedDocs[`${colName}/${docId}`];
    const snap: any = {
      exists: !!rec,
      data: () => (rec ? rec : undefined),
      ref: {
        get: vi.fn(async () => readDoc(colName, docId)),
        set: vi.fn(async (data: any) => mergeSet(colName, docId, data)),
      },
    };
    return snap;
  };
  const mockDb: any = {
    collection: (colName: string) => ({
      doc: (docId: string) => ({
        id: docId,
        set: vi.fn(async (data: any) => mergeSet(colName, docId, data)),
        get: vi.fn(async () => readDoc(colName, docId)),
      }),
      where: (field: string, op: string, val: any) => ({
        limit: (n: number) => ({
          get: async () => ({ empty: true, docs: [] }),
        }),
      }),
    }),
    // Passthrough transaction shim: the webhook does not use transactions, so
    // this exists only to satisfy the shared harness shape. It is NOT race
    // evidence and no assertion below claims concurrency protection.
    runTransaction: vi.fn(async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
      })
    ),
  };
  return { mockDb, savedDocs, defaultOrder };
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

// Operator alert boundary mirroring the hardening harness: parks do reach it,
// so mismatch parks are asserted via severity.
vi.mock("../src/core/errors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/errors")>();
  return {
    ...actual,
    captureErrorSnapshot: vi.fn(async () => "err_test_snapshot"),
  };
});

// Manual-review/rebook FCM boundary: nothing real is ever sent from tests.
vi.mock("../src/modules/notifications/fcm.service", () => ({
  dispatchFCM: vi.fn(async () => undefined),
}));

import { handleDispatchWebhook } from "../src/modules/dispatch/dispatch.webhooks";
import { dispatchFCM } from "../src/modules/notifications/fcm.service";
import { captureErrorSnapshot } from "../src/core/errors";
import { config } from "../src/config/env";

const TEST_SHADOWFAX_WEBHOOK_SECRET = "test_sfx_whsec_vitest_only";
const TEST_BORZO_WEBHOOK_SECRET = "test_borzo_whsec_vitest_only";

const fcmSpy = vi.mocked(dispatchFCM);
const snapshotSpy = vi.mocked(captureErrorSnapshot);

function seedOrder(id: string, extra: Record<string, any> = {}) {
  savedDocs[`orders/${id}`] = { ...defaultOrder(), ...extra };
}

function seedMap(providerOrderId: string, data: Record<string, any> | undefined) {
  if (data === undefined) {
    delete savedDocs[`dispatch_order_map/${providerOrderId}`];
  } else {
    savedDocs[`dispatch_order_map/${providerOrderId}`] = data;
  }
}

function docOf(id: string): any {
  return savedDocs[`orders/${id}`];
}

function parkedUnmatched(): any[] {
  return Object.entries(savedDocs)
    .filter(([k]) => k.startsWith("unmatched_dispatch_events/"))
    .map(([, v]) => v);
}

function webhookEventRows(): any[] {
  return Object.entries(savedDocs)
    .filter(([k]) => k.startsWith("dispatch_webhook_events/"))
    .map(([, v]) => v);
}

// Shadowfax verifies by static shared secret (the header value IS the secret).
const sfxSig = () => config.shadowfax.webhookSecret;
const borzoSig = (rawBody: string) => computeHmac(rawBody);

import { computeHmacSha256 } from "../src/core/security";
function computeHmac(rawBody: string): string {
  return computeHmacSha256(rawBody, config.borzo.webhookSecret);
}

const savedConfig = {
  borzo: { ...config.borzo },
  shadowfax: { ...config.shadowfax },
};

beforeEach(() => {
  config.borzo = { ...savedConfig.borzo };
  config.borzo.webhookSecret = TEST_BORZO_WEBHOOK_SECRET;
  config.shadowfax = { ...savedConfig.shadowfax };
  config.shadowfax.webhookSecret = TEST_SHADOWFAX_WEBHOOK_SECRET;

  for (const k of Object.keys(savedDocs)) delete savedDocs[k];
  fcmSpy.mockClear();
  snapshotSpy.mockClear();
});

const sfxWebhook = (payload: any) =>
  handleDispatchWebhook(
    "shadowfax",
    JSON.stringify(payload),
    sfxSig(),
    payload
  );

const borzoWebhook = (payload: any) =>
  handleDispatchWebhook(
    "borzo",
    JSON.stringify(payload),
    borzoSig(JSON.stringify(payload)),
    payload
  );

describe("F6 — customer-cancelled / returned deliveries are manual review, not auto-rebook", () => {
  it("routes CANCELLED_BY_CUSTOMER to the existing needs_review state: no needsRebook, no carrier trigger, no rebook FCM, customer status lifecycle preserved", async () => {
    seedOrder("ord_cust", {
      deliveryStatus: "in_transit",
      dispatchProvider: "shadowfax",
      dispatchOrderId: "SFX-CC1",
    });
    seedMap("SFX-CC1", { orderId: "ord_cust", provider: "shadowfax", branchId: "branch_ahmedabad_1" });

    await sfxWebhook({
      sfx_order_id: "SFX-CC1",
      order_status: "CANCELLED_BY_CUSTOMER",
      cancel_reason_text: "Customer cancelled",
    });

    const order = docOf("ord_cust");
    // Worker-safety contract (dispatch.router autoRebookDispatchWorker only
    // ever acts on needsRebook==true && trigger carrier_CANCELLED/dispatch_failed).
    expect(order.needsRebook).toBe(false);
    expect(order.rebookTrigger).toBe("customer_cancelled");
    // Existing needs_review dispatch state (porter's poller, the NOT_REBOOKABLE
    // rebook guard and DR9 already speak it) — NOT a new mirror vocabulary.
    expect(order.deliveryStatus).toBe("needs_review");
    expect(order.delivery?.status).toBe("needs_review");
    // Explicit cause: existing rebookTrigger field + existing reason field.
    expect(order.delivery?.riderCancellationReason).toBeTruthy();
    expect(order.riderCancellationReason).toBeTruthy();
    // The customer's order.status lifecycle is preserved verbatim: a manual
    // review must NOT stencil RIDER_CANCELLED (code contradicted its own
    // manual-review label) nor any terminal/kind flip onto a live order.
    expect(order.status).toBe("ready");
    // No payment/refund/cancelled-at residue from this path.
    expect(order.cancelledAt).toBeFalsy();
    expect(order.refundedAt).toBeFalsy();
    // POSITIVE containment alert pin: the manual-review FCM fires, telling
    // staff to review; NO carrier rebook alert may fire on this path.
    const manualFcm = fcmSpy.mock.calls.filter(
      (c: any[]) => c[0]?.data?.type === "dispatch_manual_review"
    );
    expect(manualFcm).toHaveLength(1);
    expect(manualFcm[0][0].data.needsRebook).toBe("false");
    expect(manualFcm[0][0].topic).toBe("branch_branch_ahmedabad_1_orders");
    const rebookFcm = fcmSpy.mock.calls.filter(
      (c: any[]) => c[0]?.data?.type === "rider_cancelled" && c[0]?.data?.needsRebook === "true"
    );
    expect(rebookFcm).toHaveLength(0);
  });

  it("routes RETURNED_TO_SELLER to needs_review without auto-rebook (returned cause in rebookTrigger)", async () => {
    seedOrder("ord_ret", {
      deliveryStatus: "in_transit",
      dispatchProvider: "shadowfax",
      dispatchOrderId: "SFX-RT1",
    });
    seedMap("SFX-RT1", { orderId: "ord_ret", provider: "shadowfax", branchId: "branch_ahmedabad_1" });

    await sfxWebhook({
      sfx_order_id: "SFX-RT1",
      order_status: "RETURNED_TO_SELLER",
    });

    const order = docOf("ord_ret");
    expect(order.needsRebook).toBe(false);
    expect(order.rebookTrigger).toBe("returned_to_seller");
    expect(order.deliveryStatus).toBe("needs_review");
    expect(order.delivery?.status).toBe("needs_review");
    expect(order.status).toBe("ready"); // lifecycle preserved
    const rebookFcm = fcmSpy.mock.calls.filter(
      (c: any[]) => c[0]?.data?.type === "rider_cancelled" && c[0]?.data?.needsRebook === "true"
    );
    expect(rebookFcm).toHaveLength(0);
  });

  it("mixed-case/spaced CANCELLED_BY_CUSTOMER still takes the manual-review path (normalization must not bypass the cause branch)", async () => {
    seedOrder("ord_cust2", {
      deliveryStatus: "in_transit",
      dispatchProvider: "shadowfax",
      dispatchOrderId: "SFX-CC2",
    });
    seedMap("SFX-CC2", { orderId: "ord_cust2", provider: "shadowfax", branchId: "branch_ahmedabad_1" });

    await sfxWebhook({
      sfx_order_id: "SFX-CC2",
      order_status: "cancelled by customer", // vendor casings vary; [\s-] normalization must apply
    });

    const order = docOf("ord_cust2");
    expect(order.needsRebook).toBe(false);
    expect(order.rebookTrigger).toBe("customer_cancelled");
    expect(order.deliveryStatus).toBe("needs_review");
    expect(
      fcmSpy.mock.calls.filter((c: any[]) => c[0]?.data?.type === "dispatch_manual_review")
    ).toHaveLength(1);
  });

  it("carrier arm stays verbatim for Borzo's umbrella delivery status 'canceled' (no wrong-type containment)", async () => {
    // DS review: the generic Borzo alias must NOT be captured by the
    // customer/returned containment — it is the documented carrier path.
    seedOrder("ord_b_canceled", {
      deliveryStatus: "in_transit",
      dispatchProvider: "borzo",
      dispatchOrderId: "BZ-CX9",
    });
    seedMap("BZ-CX9", { orderId: "ord_b_canceled", provider: "borzo", branchId: "branch_ahmedabad_1" });

    await borzoWebhook({
      delivery: { status: "canceled", order_id: "BZ-CX9", reason_text: "unfulfillable" },
    });

    const order = docOf("ord_b_canceled");
    expect(order.needsRebook).toBe(true);
    expect(order.rebookTrigger).toBe("carrier_cancelled");
    expect(order.deliveryStatus).toBe("rider_cancelled");
    expect(order.status?.code).toBe("RIDER_CANCELLED"); // ordinary carrier cancel: prior behaviour kept
    const rebookFcm = fcmSpy.mock.calls.filter(
      (c: any[]) => c[0]?.data?.type === "rider_cancelled" && c[0]?.data?.needsRebook === "true"
    );
    expect(rebookFcm).toHaveLength(1);
  });

  it("POSITIVE CONTROL: NO_RIDERS_FOUND keeps the existing carrier auto-rebook flow (needsRebook + trigger + branch rebook FCM)", async () => {
    seedOrder("ord_norider", {
      deliveryStatus: "dispatched",
      dispatchProvider: "shadowfax",
      dispatchOrderId: "SFX-NR1",
    });
    seedMap("SFX-NR1", { orderId: "ord_norider", provider: "shadowfax", branchId: "branch_ahmedabad_1" });

    await sfxWebhook({
      sfx_order_id: "SFX-NR1",
      order_status: "NO_RIDERS_FOUND",
    });

    const order = docOf("ord_norider");
    expect(order.needsRebook).toBe(true);
    expect(order.rebookTrigger).toBe("carrier_cancelled");
    expect(order.deliveryStatus).toBe("rider_cancelled");
    const rebookFcm = fcmSpy.mock.calls.filter(
      (c: any[]) => c[0]?.data?.type === "rider_cancelled" && c[0]?.data?.needsRebook === "true"
    );
    expect(rebookFcm).toHaveLength(1);
    expect(rebookFcm[0][0].topic).toBe("branch_branch_ahmedabad_1_orders");
  });
});

describe("F6-sticky — containment survives subsequent events on the same booking", () => {
  it("customer-cancel first: a later NO_RIDERS_FOUND on the same booking must NOT re-arm the auto-rebook worker", async () => {
    // Sequence on ONE live booking: Shadowfax reports the customer called the
    // delivery off (contained manual review), then reports no riders found.
    // A non-sticky containment would flip needsRebook back to true with
    // trigger carrier_cancelled and the scheduled worker would book another
    // courier for a delivery the customer cancelled.
    seedOrder("ord_sticky_cc", {
      deliveryStatus: "in_transit",
      dispatchProvider: "shadowfax",
      dispatchOrderId: "SFX-ST1",
    });
    seedMap("SFX-ST1", { orderId: "ord_sticky_cc", provider: "shadowfax", branchId: "branch_ahmedabad_1" });

    await sfxWebhook({ sfx_order_id: "SFX-ST1", order_status: "CANCELLED_BY_CUSTOMER" });
    expect(docOf("ord_sticky_cc").deliveryStatus).toBe("needs_review"); // first event contained

    await sfxWebhook({ sfx_order_id: "SFX-ST1", order_status: "NO_RIDERS_FOUND" });

    const order = docOf("ord_sticky_cc");
    // Contained state preserved verbatim — no rebook flag, no trigger swap,
    // no vocabulary rewind. (Pre-write predicate on a plain read/write; not a
    // transaction, so different-body concurrency stays last-write-wins.)
    expect(order.needsRebook).toBe(false);
    expect(order.rebookTrigger).toBe("customer_cancelled");
    expect(order.deliveryStatus).toBe("needs_review");
    expect(order.delivery?.status).toBe("needs_review");
    expect(order.status).toBe("ready"); // lifecycle still intact
    // NO new alert of either kind: the manual-review alert already fired
    // (one, from the first event); no carrier rebook alert may appear.
    expect(
      fcmSpy.mock.calls.filter((c: any[]) => c[0]?.data?.type === "dispatch_manual_review")
    ).toHaveLength(1);
    expect(
      fcmSpy.mock.calls.filter((c: any[]) => c[0]?.data?.type === "rider_cancelled")
    ).toHaveLength(0);
    // Vendor retries should stop: both events were genuinely consumed.
    const rows = webhookEventRows();
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.status === "processed")).toBe(true);
  });

  it("returned first: a later generic carrier cancel on the same booking stays contained", async () => {
    seedOrder("ord_sticky_ret", {
      deliveryStatus: "in_transit",
      dispatchProvider: "shadowfax",
      dispatchOrderId: "SFX-ST3",
    });
    seedMap("SFX-ST3", { orderId: "ord_sticky_ret", provider: "shadowfax", branchId: "branch_ahmedabad_1" });

    await sfxWebhook({ sfx_order_id: "SFX-ST3", order_status: "RETURNED_TO_SELLER" });
    expect(docOf("ord_sticky_ret").deliveryStatus).toBe("needs_review");
    const cmAfterFirst = fcmSpy.mock.calls.filter(
      (c: any[]) => c[0]?.data?.type === "dispatch_manual_review"
    );
    expect(cmAfterFirst).toHaveLength(1);

    // The SAME provider reports a generic carrier problem; containment must hold.
    await sfxWebhook({ sfx_order_id: "SFX-ST3", order_status: "CANCELED" });

    const order = docOf("ord_sticky_ret");
    expect(order.needsRebook).toBe(false);
    expect(order.rebookTrigger).toBe("returned_to_seller");
    expect(order.deliveryStatus).toBe("needs_review");
    expect(fcmSpy.mock.calls.filter((c: any[]) => c[0]?.data?.type === "dispatch_manual_review")).toHaveLength(1);
    expect(fcmSpy.mock.calls.filter((c: any[]) => c[0]?.data?.type === "rider_cancelled")).toHaveLength(0);
  });

  it("contained booking + late ARRIVED stays ignored: no rider-at-store resurrect for a dead dispatch", async () => {
    seedOrder("ord_sticky_arr", {
      deliveryStatus: "needs_review",
      rebookTrigger: "customer_cancelled",
      needsRebook: false,
      dispatchProvider: "shadowfax",
      dispatchOrderId: "SFX-ST2",
      delivery: { status: "needs_review" },
    });
    seedMap("SFX-ST2", { orderId: "ord_sticky_arr", provider: "shadowfax", branchId: "branch_ahmedabad_1" });

    await sfxWebhook({ sfx_order_id: "SFX-ST2", order_status: "ARRIVED" });

    const order = docOf("ord_sticky_arr");
    expect(order.riderArrivedAtStore).toBeFalsy();
    expect(order.riderArrivedAt).toBeFalsy();
    expect(order.delivery?.status).toBe("needs_review");
  });

  it("DS finding: a late DISPATCHED/ALLOTTED on a contained booking must not rewrite the needs_review marker (central containment, worker already disarmed)", async () => {
    // Out-of-order vendor replay: containment was set by a customer cancel;
    // a later (fresh-timestamped) DISPATCHED / ALLOTTED must not flip
    // deliveryStatus to in_transit/dispatched or stamp OUT_FOR_DELIVERY.
    seedOrder("ord_sticky_move", {
      deliveryStatus: "needs_review",
      rebookTrigger: "customer_cancelled",
      needsRebook: false,
      dispatchProvider: "shadowfax",
      dispatchOrderId: "SFX-ST4",
      status: "ready",
      delivery: { status: "needs_review" },
    });
    seedMap("SFX-ST4", { orderId: "ord_sticky_move", provider: "shadowfax", branchId: "branch_ahmedabad_1" });
    const before = { ...docOf("ord_sticky_move") };

    await sfxWebhook({ sfx_order_id: "SFX-ST4", order_status: "DISPATCHED" });
    await sfxWebhook({ sfx_order_id: "SFX-ST4", order_status: "ALLOTTED" });

    const order = docOf("ord_sticky_move");
    expect(order.deliveryStatus).toBe("needs_review");
    expect(order.delivery?.status).toBe("needs_review");
    expect(order.status).toBe("ready"); // lifecycle untouched — no OUT_FOR_DELIVERY stencil
    expect(order.dispatchWebhookEvent).toBeUndefined();
    expect(fcmSpy.mock.calls).toHaveLength(0);
    const rows = webhookEventRows();
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.status === "processed")).toBe(true);
    // DELIVERED stays exempt by design (a vendor may actually hand over);
    // that path is covered by the positive-resolution controls above.
    expect(before.deliveryStatus).toBe("needs_review");
  });

  it("POSITIVE CONTROL: a genuinely fresh booking (post-rebook state) still auto-rebooks on a carrier cancel", async () => {
    // The staff rebook path (dispatchBook) rewrites the order to the
    // documented post-rebook state — deliveryStatus dispatched, needsRebook
    // false, rebookTrigger null, NEW dispatchProvider/dispatchOrderId. We
    // seed exactly that rebooked state (dispatchBook itself is another
    // module); the point is that containment is per-booking and releases.
    seedOrder("ord_fresh_rz", {
      deliveryStatus: "dispatched",
      needsRebook: false,
      rebookTrigger: null,
      dispatchProvider: "shadowfax",
      dispatchOrderId: "SFX-FRESH1",
    });
    seedMap("SFX-FRESH1", { orderId: "ord_fresh_rz", provider: "shadowfax", branchId: "branch_ahmedabad_1" });

    await sfxWebhook({ sfx_order_id: "SFX-FRESH1", order_status: "NO_RIDERS_FOUND" });

    const order = docOf("ord_fresh_rz");
    expect(order.needsRebook).toBe(true);
    expect(order.rebookTrigger).toBe("carrier_cancelled");
    expect(order.deliveryStatus).toBe("rider_cancelled");
    expect(
      fcmSpy.mock.calls.filter((c: any[]) => c[0]?.data?.type === "rider_cancelled" && c[0]?.data?.needsRebook === "true")
    ).toHaveLength(1);
  });
});

describe("F2 — late ARRIVED must not rewind in_transit", () => {
  it("in_transit + ARRIVED stays in_transit: no at_pickup rewind, no late store-arrival stamps", async () => {
    seedOrder("ord_arrive_late", {
      deliveryStatus: "in_transit",
      dispatchProvider: "shadowfax",
      dispatchOrderId: "SFX-AR1",
      // Pre-existing mirror so the pin proves NON-rewind of it (the guard
      // must leave this in_transit object untouched).
      delivery: { status: "in_transit", riderLocation: { lat: 23.01, lng: 72.5 } },
    });
    seedMap("SFX-AR1", { orderId: "ord_arrive_late", provider: "shadowfax", branchId: "branch_ahmedabad_1" });
    const before = { ...docOf("ord_arrive_late") };

    await sfxWebhook({
      sfx_order_id: "SFX-AR1",
      order_status: "ARRIVED",
    });

    const order = docOf("ord_arrive_late");
    expect(order.deliveryStatus).toBe("in_transit");
    expect(order.delivery?.status).toBe("in_transit");
    expect(order.delivery).toEqual(before.delivery);
    expect(order.riderArrivedAtStore).toBeFalsy();
  });

  it("POSITIVE CONTROL: dispatched + ARRIVED records at_pickup arrival truthfully", async () => {
    seedOrder("ord_arrive_ok", {
      deliveryStatus: "dispatched",
      dispatchProvider: "shadowfax",
      dispatchOrderId: "SFX-AR2",
    });
    seedMap("SFX-AR2", { orderId: "ord_arrive_ok", provider: "shadowfax", branchId: "branch_ahmedabad_1" });

    await sfxWebhook({
      sfx_order_id: "SFX-AR2",
      order_status: "ARRIVED",
    });

    const order = docOf("ord_arrive_ok");
    expect(order.deliveryStatus).toBe("dispatched"); // order-status leg only records stage via mirror
    expect(order.delivery?.status).toBe("at_pickup");
    expect(order.riderArrivedAtStore).toBe(true);
  });

  // (fixture deduplication, DS final review finding 10: the contained-dead-
  // dispatch ARRIVED case is asserted once, in the containment sequence block
  // above; the old mislabelled "rider_cancelled" fixture was renamed there.)
});

describe("F7 read-side — dispatch_order_map provider mismatch must park before mutation", () => {
  it("PARKS a shadowfax callback on a Borzo-bound map row: zero order/rider/status mutations", async () => {
    seedOrder("ord_b_rzd", {
      deliveryStatus: "dispatched",
      dispatchProvider: "borzo",
      dispatchOrderId: "SFX-DUP",
    });
    seedMap("SFX-DUP", { orderId: "ord_b_rzd", provider: "borzo", branchId: "branch_ahmedabad_1" });

    await sfxWebhook({
      sfx_order_id: "SFX-DUP",
      order_status: "DELIVERED",
    });

    // Nothing on the order moved.
    const order = docOf("ord_b_rzd");
    expect(order.deliveryStatus).toBe("dispatched");
    expect(order.deliveryStatus).not.toBe("delivered");
    expect(order.deliveredAt).toBeFalsy();
    expect(order.dispatchWebhookProvider).toBeUndefined();

    // Operator trail: needs_review row, high severity, no processed mark.
    const rows = parkedUnmatched();
    expect(rows.length).toBe(1);
    expect(rows[0].orderId).toBe("ord_b_rzd");
    expect(rows[0].reason).toBe("order_id_conflict");
    const ws = webhookEventRows();
    expect(ws.length).toBe(1);
    expect(ws[0].status).toBe("parked");
    const high = snapshotSpy.mock.calls.filter((c: any[]) => c[0]?.severity === "high");
    expect(high.length).toBeGreaterThanOrEqual(1);
  });

  it("POSITIVE CONTROL: same-provider shadowfax DELIVERED flips the mapped order normally", async () => {
    seedOrder("ord_ok_sfx", {
      deliveryStatus: "dispatched",
      dispatchProvider: "shadowfax",
      dispatchOrderId: "SFX-OK1",
    });
    seedMap("SFX-OK1", { orderId: "ord_ok_sfx", provider: "shadowfax", branchId: "branch_ahmedabad_1" });

    await sfxWebhook({
      sfx_order_id: "SFX-OK1",
      order_status: "DELIVERED",
    });

    const order = docOf("ord_ok_sfx");
    expect(order.deliveryStatus).toBe("delivered");
    expect(order.status?.code).toBe("DELIVERED");
    expect(order.deliveredAt).toBeTruthy();
    expect(parkedUnmatched()).toHaveLength(0);
  });

  it("POSITIVE CONTROL: legacy map row WITHOUT a provider field is not false-parked (binding evidence via orderId preserved)", async () => {
    seedOrder("ord_legacy", {
      deliveryStatus: "dispatched",
      dispatchProvider: "shadowfax",
      dispatchOrderId: "SFX-LG1",
    });
    seedMap("SFX-LG1", { orderId: "ord_legacy", branchId: "branch_ahmedabad_1" });

    await sfxWebhook({
      sfx_order_id: "SFX-LG1",
      order_status: "DELIVERED",
    });

    const order = docOf("ord_legacy");
    expect(order.deliveryStatus).toBe("delivered");
    expect(order.status?.code).toBe("DELIVERED");
    expect(parkedUnmatched()).toHaveLength(0);
  });

  it("POSITIVE CONTROL: legacy provider-less row + MATCHING hint binding still resolves normally", async () => {
    // Legacy map row has no provider field; the order's OWN dispatch binding
    // matches the callback provider order id, so resolution stands (no
    // identity guessing needed — the binding IS the evidence).
    seedOrder("ord_legacy_hint", {
      deliveryStatus: "dispatched",
      dispatchProvider: "shadowfax",
      dispatchOrderId: "SFX-LH1",
    });
    seedMap("SFX-LH1", { orderId: "ord_legacy_hint", branchId: "branch_ahmedabad_1" });

    await sfxWebhook({
      sfx_order_id: "SFX-LH1",
      client_order_id: "ord_legacy_hint",
      order_status: "DELIVERED",
    });

    const order = docOf("ord_legacy_hint");
    expect(order.deliveryStatus).toBe("delivered");
    expect(order.status?.code).toBe("DELIVERED");
    expect(parkedUnmatched()).toHaveLength(0);
  });

  it("POSITIVE CONTROL: legacy provider-less row + CONFLICTING hint still parks (order_id_conflict, no mutation)", async () => {
    seedOrder("ord_legacy_cf", {
      deliveryStatus: "dispatched",
      dispatchProvider: "shadowfax",
      dispatchOrderId: "SFX-LC1",
    });
    seedOrder("ord_hint_cf", {
      deliveryStatus: "dispatched",
      dispatchProvider: "shadowfax",
      dispatchOrderId: "SFX-LC9",
    });
    seedMap("SFX-LC1", { orderId: "ord_legacy_cf", branchId: "branch_ahmedabad_1" });

    await sfxWebhook({
      sfx_order_id: "SFX-LC1",
      client_order_id: "ord_hint_cf",
      order_status: "DELIVERED",
    });

    const rows = parkedUnmatched();
    expect(rows.length).toBe(1);
    expect(rows[0].reason).toBe("order_id_conflict");
    expect(docOf("ord_legacy_cf").deliveryStatus).toBe("dispatched");
    expect(docOf("ord_hint_cf").deliveryStatus).toBe("dispatched");
  });

  it("PARKS a hint-resolved callback when the ORDER's own dispatchProvider disagrees (no map row; binding equality alone is not provider proof)", async () => {
    // No dispatch_order_map row at all. The hint path resolves the order via
    // its own dispatch binding; without a provider check a foreign/stale
    // provider callback could still mutate the order on a re-dispatch.
    seedOrder("ord_hint_mis", {
      deliveryStatus: "in_transit",
      dispatchProvider: "borzo",
      dispatchOrderId: "BZ-HM1",
    });
    const before = { ...docOf("ord_hint_mis") };

    await sfxWebhook({
      sfx_order_id: "BZ-HM1",
      client_order_id: "ord_hint_mis",
      order_status: "DELIVERED",
    });

    const rows = parkedUnmatched();
    expect(rows.length).toBe(1);
    expect(rows[0].reason).toBe("order_id_conflict");
    expect(rows[0].callbackProvider).toBe("shadowfax"); // recorded diagnosis
    const order = docOf("ord_hint_mis");
    expect(order.deliveryStatus).toBe(before.deliveryStatus);
    expect(order.status).toBe(before.status);
    expect(order.deliveredAt).toBeFalsy();
    const ws = webhookEventRows();
    expect(ws.length).toBe(1);
    expect(ws[0].status).toBe("parked");
  });

  it("POSITIVE CONTROL: hint path with the ORDER's dispatchProvider matching still resolves and flips", async () => {
    seedOrder("ord_hint_ok", {
      deliveryStatus: "dispatched",
      dispatchProvider: "shadowfax",
      dispatchOrderId: "SFX-HO1",
    });

    await sfxWebhook({
      sfx_order_id: "SFX-HO1",
      client_order_id: "ord_hint_ok",
      order_status: "DELIVERED",
    });

    const order = docOf("ord_hint_ok");
    expect(order.deliveryStatus).toBe("delivered");
    expect(order.status?.code).toBe("DELIVERED");
    expect(parkedUnmatched()).toHaveLength(0);
  });

  it("POSITIVE CONTROL: hint path with a padded-string binding vs a numeric Borzo callback resolves (same id normalization as the ownership proof)", async () => {
    // DS final-review finding (low, applied): without a map row, the hint
    // resolves strictly through the order's own binding. "0012" (legacy
    // padded string) and 12 (numeric Borzo callback) are the SAME booking;
    // the comparison must not false-park HIGH order_id_conflict.
    seedOrder("ord_hint_num", {
      deliveryStatus: "dispatched",
      dispatchProvider: "borzo",
      dispatchOrderId: "0012",
    });

    await borzoWebhook({
      event: "DELIVERED",
      order_id: 12,
      merchant_order_id: "ord_hint_num",
      timestamp: Date.now(),
    });

    const order = docOf("ord_hint_num");
    expect(order.deliveryStatus).toBe("delivered");
    expect(order.status?.code).toBe("DELIVERED");
    expect(parkedUnmatched()).toHaveLength(0);
  });
});

describe("F7-order-side — the order's CURRENT binding must veto a superseded map row (stale-map HIGH)", () => {
  it("stale map after a Borzo->Shadowfax rebook: late BORZO DELIVERED parks HIGH, the live shadowfax booking is untouched, no FCM", async () => {
    // dispatch_order_map/BZ-OLD1 survived the rebook (dispatchBook re-binds
    // the NEW provider order id but never deletes the old row). The order now
    // carries the CURRENT binding: shadowfax/SFX-NEW1.
    seedOrder("ord_rebook_p", {
      deliveryStatus: "dispatched",
      dispatchProvider: "shadowfax",
      dispatchOrderId: "SFX-NEW1",
    });
    seedMap("BZ-OLD1", { orderId: "ord_rebook_p", provider: "borzo", branchId: "branch_ahmedabad_1" });
    seedMap("SFX-NEW1", { orderId: "ord_rebook_p", provider: "shadowfax", branchId: "branch_ahmedabad_1" });
    const before = { ...docOf("ord_rebook_p") };

    await borzoWebhook({ event: "DELIVERED", order_id: "BZ-OLD1", timestamp: Date.now() });

    // Zero mutation: the dead old-booking callback must not deliver the live one.
    const order = docOf("ord_rebook_p");
    expect(order.deliveryStatus).toBe("dispatched");
    expect(order.deliveryStatus).not.toBe("delivered");
    expect(order.deliveredAt).toBeFalsy();
    expect(order.dispatchWebhookProvider).toBeUndefined();
    expect(order.status).toBe(before.status);
    expect(fcmSpy.mock.calls).toHaveLength(0); // no rebook/manual-review alert either

    const rows = parkedUnmatched();
    expect(rows.length).toBe(1);
    expect(rows[0].reason).toBe("order_id_conflict");
    expect(rows[0].callbackProvider).toBe("borzo");
    expect(rows[0].boundProvider).toBe("shadowfax");
    expect(rows[0].boundOrderId).toBe("SFX-NEW1");
    const high = snapshotSpy.mock.calls.filter((c: any[]) => c[0]?.severity === "high");
    expect(high.length).toBeGreaterThanOrEqual(1);
    const ws = webhookEventRows();
    expect(ws.length).toBe(1);
    expect(ws[0].status).toBe("parked");
  });

  it("stale map after a same-provider rebook: late BORZO event for the OLD booking id parks HIGH (id mismatch)", async () => {
    seedOrder("ord_rebook_id", {
      deliveryStatus: "dispatched",
      dispatchProvider: "borzo",
      dispatchOrderId: "BZ-NEW2",
    });
    // Superseded same-provider row survives the rebook.
    seedMap("BZ-OLD2", { orderId: "ord_rebook_id", provider: "borzo", branchId: "branch_ahmedabad_1" });
    seedMap("BZ-NEW2", { orderId: "ord_rebook_id", provider: "borzo", branchId: "branch_ahmedabad_1" });
    const before = { ...docOf("ord_rebook_id") };

    await borzoWebhook({ event: "DELIVERED", order_id: "BZ-OLD2", timestamp: Date.now() });

    const order = docOf("ord_rebook_id");
    expect(order.deliveryStatus).toBe(before.deliveryStatus);
    expect(order.deliveryStatus).not.toBe("delivered");
    expect(order.deliveredAt).toBeFalsy();
    expect(order.dispatchWebhookProvider).toBeUndefined();
    expect(fcmSpy.mock.calls).toHaveLength(0);
    const rows = parkedUnmatched();
    expect(rows.length).toBe(1);
    expect(rows[0].reason).toBe("order_id_conflict");
    expect(rows[0].boundOrderId).toBe("BZ-NEW2");
  });

  it("parks HIGH when a map row resolves an order with NO binding metadata at all (absent evidence is not license to guess)", async () => {
    // Legacy/manual row pointing at an order with neither dispatchProvider
    // nor dispatchOrderId/porterOrderId: the map row alone cannot prove the
    // order is still on this provider's booking (rows survive later rebooks),
    // so the callback must park for review rather than mutate.
    seedOrder("ord_naked", { deliveryStatus: "dispatched" });
    seedMap("BZ-UPT", { orderId: "ord_naked", provider: "borzo", branchId: "branch_ahmedabad_1" });
    const before = { ...docOf("ord_naked") };

    await borzoWebhook({ event: "DELIVERED", order_id: "BZ-UPT", timestamp: Date.now() });

    const order = docOf("ord_naked");
    expect(order.deliveryStatus).toBe(before.deliveryStatus);
    expect(order.deliveryStatus).not.toBe("delivered");
    expect(order.deliveredAt).toBeFalsy();
    expect(order.dispatchWebhookProvider).toBeUndefined();
    expect(fcmSpy.mock.calls).toHaveLength(0);
    const rows = parkedUnmatched();
    expect(rows.length).toBe(1);
    expect(rows[0].reason).toBe("order_binding_unproven");
    const high = snapshotSpy.mock.calls.filter((c: any[]) => c[0]?.severity === "high");
    expect(high.length).toBeGreaterThanOrEqual(1);
  });

  it("POSITIVE CONTROL: numeric/string provider-id forms compare equal through the binding check", async () => {
    // Borzo order ids are JSON numbers; dispatchBook stores both shapes
    // across versions. 12 (number) vs "0012" (legacy padded string) is the
    // SAME booking id — normalization must not defeat (or fake) the check.
    seedOrder("ord_num", {
      deliveryStatus: "dispatched",
      dispatchProvider: "borzo",
      dispatchOrderId: "0012",
    });
    seedMap("12", { orderId: "ord_num", provider: "borzo", branchId: "branch_ahmedabad_1" });

    await borzoWebhook({ event: "DELIVERED", order_id: 12, timestamp: Date.now() });

    const order = docOf("ord_num");
    expect(order.deliveryStatus).toBe("delivered");
    expect(order.status?.code).toBe("DELIVERED");
    expect(parkedUnmatched()).toHaveLength(0);
  });

  it("POSITIVE CONTROL: callback matching the CURRENT rebooked binding (same provider + same id) still flips", async () => {
    seedOrder("ord_rebook_ok", {
      deliveryStatus: "dispatched",
      dispatchProvider: "shadowfax",
      dispatchOrderId: "SFX-CB1",
    });
    seedMap("BZ-STALEX", { orderId: "ord_rebook_ok", provider: "borzo", branchId: "branch_ahmedabad_1" });
    seedMap("SFX-CB1", { orderId: "ord_rebook_ok", provider: "shadowfax", branchId: "branch_ahmedabad_1" });

    await sfxWebhook({ sfx_order_id: "SFX-CB1", order_status: "DELIVERED" });

    const order = docOf("ord_rebook_ok");
    expect(order.deliveryStatus).toBe("delivered");
    expect(order.status?.code).toBe("DELIVERED");
    expect(parkedUnmatched()).toHaveLength(0);
  });

  it("DS finding (low, applied): provider bound WITHOUT a bound order id parks order_binding_unproven (partial metadata is not license to guess)", async () => {
    seedOrder("ord_partial_meta", {
      deliveryStatus: "dispatched",
      dispatchProvider: "borzo",
      // no dispatchOrderId / porterOrderId: manual-branch/legacy state
    });
    seedMap("BZ-P1", { orderId: "ord_partial_meta", provider: "borzo", branchId: "branch_ahmedabad_1" });
    const before = { ...docOf("ord_partial_meta") };

    await borzoWebhook({ event: "DELIVERED", order_id: "BZ-P1", timestamp: Date.now() });

    const order = docOf("ord_partial_meta");
    expect(order.deliveryStatus).toBe(before.deliveryStatus);
    expect(order.deliveryStatus).not.toBe("delivered");
    expect(order.deliveredAt).toBeFalsy();
    expect(order.dispatchWebhookProvider).toBeUndefined();
    expect(fcmSpy.mock.calls).toHaveLength(0);
    const rows = parkedUnmatched();
    expect(rows.length).toBe(1);
    expect(rows[0].reason).toBe("order_binding_unproven");
  });

  it("DS finding (low, applied): padded-vs-numeric stays equal, but >15-digit ids must NOT collapse to each other", async () => {
    // Two DISTINCT 16-digit bookings must not compare equal — the old
    // Number()-based padding strip lost precision past 2^53 and could make
    // "9007199254740993" equal "9007199254740992", the one direction that
    // loosens the ownership check.
    seedOrder("ord_bigint", {
      deliveryStatus: "dispatched",
      dispatchProvider: "borzo",
      dispatchOrderId: "9007199254740993",
    });
    seedMap("9007199254740992", { orderId: "ord_bigint", provider: "borzo", branchId: "branch_ahmedabad_1" });
    const before = { ...docOf("ord_bigint") };

    await borzoWebhook({ event: "DELIVERED", order_id: "9007199254740992", timestamp: Date.now() });

    const order = docOf("ord_bigint");
    expect(order.deliveryStatus).toBe(before.deliveryStatus);
    expect(order.deliveredAt).toBeFalsy();
    expect(fcmSpy.mock.calls).toHaveLength(0);
    const rows = parkedUnmatched();
    expect(rows.length).toBe(1);
    expect(rows[0].reason).toBe("order_id_conflict");
    expect(rows[0].boundOrderId).toBe("9007199254740993");
  });
});
