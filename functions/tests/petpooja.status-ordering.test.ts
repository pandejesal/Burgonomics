import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Finding 4 (F4): authenticated Petpooja lifecycle callbacks could move the
// canonical order status BACKWARDS. The replay defence only remembers the last
// event id and the terminal guard only protects DELIVERED/CANCELLED, so
// `planStatusUpdate` assigned ANY recognised nonterminal status (accepted /
// ready / out_for_delivery) over whatever the order already showed:
//   READY_FOR_PICKUP -> delayed ACCEPTED   rewound to CONFIRMED
//   OUT_FOR_DELIVERY -> READY              rewound to READY_FOR_PICKUP
//   CONFIRMED -> READY -> CONFIRMED (A->B->A) escaped the single-last-id check
//   staff PREPARING  -> delayed ACCEPTED   overwrote kitchen progress
//
// Contract under test (parent decision, phase42 slice F4): a vendor lifecycle
// callback may only move canonical `status` FORWARD relative to the FRESH
// transactional snapshot. The rank is the repository's own vocabulary
// (functions/src/modules/orders/orderStatus.ts PARTNER_TO_DELIVERY +
// ALIAS_TO_CANONICAL, the `statusMeta` table in item86ingSync.ts, and
// references/order_flow.md §1):
//   PLACED / PENDING < CONFIRMED < PREPARING <
//   READY_FOR_PICKUP (= READY_TO_SERVE, the dine-in fork) < OUT_FOR_DELIVERY
// Terminal states (DELIVERED / CANCELLED) keep their existing guard. A current
// code with no rank (legacy/unknown literal) keeps today's behaviour: apply.
//
// Traceability, replay markers, terminal cancellation + refund planning,
// default-deny and POS binding checks are ALL unchanged — the cases below pin
// that the ordering guard suppresses only `status`, never the rest.
//
// HARNESS NOTE: same in-memory double shape as petpooja.webhook-terminal.test.ts
// (single transactional `set` with merge, no plain-write fallback), so an
// assertion here is about the planned payload, not about which writer ran.
// Every callback below is credential-verified ({authenticated: true}) except
// the explicit default-deny case at the end.

const { mockDb, savedDocs } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  let autoId = 0;

  const docRef = (col: string, id: string) => {
    const path = `${col}/${id}`;
    return {
      id,
      path,
      get: vi.fn(async () => ({
        exists: Object.prototype.hasOwnProperty.call(savedDocs, path),
        data: () => savedDocs[path],
        ref: docRef(col, id),
      })),
      set: vi.fn(async (data: any, opts?: any) => {
        savedDocs[path] =
          opts?.merge && savedDocs[path]
            ? { ...savedDocs[path], ...JSON.parse(JSON.stringify(data)) }
            : JSON.parse(JSON.stringify(data));
      }),
    };
  };

  const query = (col: string) => {
    const filters: Array<[string, string, any]> = [];
    const q: any = {
      where: (f: string, op: string, v: any) => {
        filters.push([f, op, v]);
        return q;
      },
      limit: () => q,
      get: vi.fn(async () => {
        const docs = Object.keys(savedDocs)
          .filter(
            (p) =>
              p.startsWith(`${col}/`) &&
              filters.every(([f, op, v]) => (op === "==" ? savedDocs[p]?.[f] === v : false))
          )
          .map((p) => {
            const id = p.slice(col.length + 1);
            return { id, ref: docRef(col, id), exists: true, data: () => savedDocs[p] };
          });
        return { docs, empty: docs.length === 0 };
      }),
    };
    return q;
  };

  const mockDb: any = {
    collection: (col: string) => ({
      doc: (id?: string) => docRef(col, id || `auto_${++autoId}`),
      where: query(col).where,
    }),
    runTransaction: vi.fn(async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
      })
    ),
  };

  return { mockDb, savedDocs };
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

import { handlePetpoojaWebhook } from "../src/modules/petpooja/item86ingSync";

const trusted = { authenticated: true };

// The canonical codes this slice ranks, with the meta the apps already accept
// (statusMeta in item86ingSync.ts + PARTNER_TO_DELIVERY in orderStatus.ts).
// READY_TO_SERVE is the dine-in fork of the READY rank (order_flow.md §1).
const STATUS_META: Record<string, { code: string; label: string; kind: string; terminal: boolean }> = {
  PLACED: { code: "PLACED", label: "Order placed", kind: "upcoming", terminal: false },
  PENDING: { code: "PENDING", label: "Pending", kind: "upcoming", terminal: false },
  CONFIRMED: { code: "CONFIRMED", label: "Order confirmed", kind: "upcoming", terminal: false },
  PREPARING: { code: "PREPARING", label: "Preparing your order", kind: "in_progress", terminal: false },
  READY_FOR_PICKUP: {
    code: "READY_FOR_PICKUP",
    label: "Ready for pickup",
    kind: "in_progress",
    terminal: false,
  },
  READY_TO_SERVE: { code: "READY_TO_SERVE", label: "Ready to serve", kind: "in_progress", terminal: false },
  OUT_FOR_DELIVERY: {
    code: "OUT_FOR_DELIVERY",
    label: "Out for delivery",
    kind: "in_progress",
    terminal: false,
  },
  DELIVERED: { code: "DELIVERED", label: "Delivered", kind: "completed", terminal: true },
  CANCELLED: { code: "CANCELLED", label: "Cancelled", kind: "cancelled", terminal: true },
};

const seedAt = (id: string, code: string, extra: Record<string, any> = {}) => {
  savedDocs[`orders/${id}`] = {
    id,
    branchId: "branch_f4",
    status: { ...STATUS_META[code] },
    ...extra,
  };
};

const statusCode = (id: string) => {
  const status = savedDocs[`orders/${id}`]?.status;
  return typeof status === "string" ? status : status?.code;
};

const refundDocs = () => Object.keys(savedDocs).filter((p) => p.startsWith("refunds/"));

// Review Low-2 (phase42 POS send-safety, defense in depth — NOT a proven live
// defect): `isCancelledOrTerminal` (orderPush.ts) treats codes COMPLETED and
// PICKED_UP as terminal, while the webhook's `terminalNow` guard in
// item86ingSync.ts only recognised DELIVERED/CANCELLED. Every known writer sets
// `kind: "completed"` (orderStatus.ts:201/205), so a code-only row is not
// produced in production today; this pins the vocabulary agreement so a future
// writer that stops setting `kind` cannot let a late vendor callback rewind a
// closed order.
//
// Contract: a TRUSTED late callback against a code-only terminal row
// (COMPLETED / PICKED_UP, no `kind`, no `terminal` flag) is ignored whole —
// no status rewind, no cancel, no refund parking, no acceptance fields, and no
// outbound provider POST. Shapes the CURRENT guards already normalise are
// covered (object code, lowercase object code, bare string code); no new
// vocabulary policy is invented here.
const TERMINAL_CODE_ONLY_SHAPES: Array<{ label: string; status: any }> = [
  { label: "object code COMPLETED", status: { code: "COMPLETED" } },
  { label: "object code PICKED_UP", status: { code: "PICKED_UP" } },
  { label: "lowercase object code picked_up", status: { code: "picked_up" } },
  { label: "bare string PICKED_UP", status: "PICKED_UP" },
];

describe("Petpooja status webhook — vendor lifecycle callbacks never move status backwards (F4)", () => {
  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
  });

  it("keeps READY_FOR_PICKUP when a delayed ACCEPTED arrives afterwards", async () => {
    seedAt("ord_f4_ready_then_accept", "READY_FOR_PICKUP");

    await handlePetpoojaWebhook(
      { order_id: "ord_f4_ready_then_accept", status: 2, id: "evt_f4_late_accept" },
      trusted
    );

    expect(statusCode("ord_f4_ready_then_accept")).toBe("READY_FOR_PICKUP");
    // The event still merged its replay marker: only the `status` assignment is
    // refused, so duplicate detection is not lost.
    expect(savedDocs["orders/ord_f4_ready_then_accept"].petpoojaWebhookEventId).toBe(
      "evt_f4_late_accept"
    );
  });

  it("keeps OUT_FOR_DELIVERY when a delayed READY arrives afterwards", async () => {
    seedAt("ord_f4_ofd_then_ready", "OUT_FOR_DELIVERY");

    await handlePetpoojaWebhook(
      { order_id: "ord_f4_ofd_then_ready", status: 5, id: "evt_f4_late_ready" },
      trusted
    );

    expect(statusCode("ord_f4_ofd_then_ready")).toBe("OUT_FOR_DELIVERY");
  });

  it("does not let an A->B->A sequence escape: CONFIRMED -> READY -> ACCEPTED stays READY", async () => {
    seedAt("ord_f4_aba", "CONFIRMED");

    // A -> B: the forward leg legitimately applies.
    await handlePetpoojaWebhook(
      { order_id: "ord_f4_aba", status: 5, id: "evt_f4_aba_1" },
      trusted
    );
    expect(statusCode("ord_f4_aba")).toBe("READY_FOR_PICKUP");

    // B -> A: the delayed re-accept must NOT rewind (the single-last-id replay
    // marker sees a different id, so only an ordering check can stop this).
    await handlePetpoojaWebhook(
      { order_id: "ord_f4_aba", status: 2, id: "evt_f4_aba_2" },
      trusted
    );
    expect(statusCode("ord_f4_aba")).toBe("READY_FOR_PICKUP");

    // And the vendor's own next report of the same rank changes nothing.
    await handlePetpoojaWebhook(
      { order_id: "ord_f4_aba", status: 5, id: "evt_f4_aba_3" },
      trusted
    );
    expect(statusCode("ord_f4_aba")).toBe("READY_FOR_PICKUP");
  });

  it("keeps a staff-set PREPARING when a delayed vendor accept arrives", async () => {
    // The kitchen bumped the order on the KDS; the POS only ever reports
    // Accept/Ready, so a late Accept must not erase PREPARING.
    seedAt("ord_f4_staff_preparing", "PREPARING", {
      statusUpdatedBy: "staff",
    });

    await handlePetpoojaWebhook(
      { order_id: "ord_f4_staff_preparing", status: "Accept", id: "evt_f4_staff" },
      trusted
    );

    expect(statusCode("ord_f4_staff_preparing")).toBe("PREPARING");
    expect(savedDocs["orders/ord_f4_staff_preparing"].status).toMatchObject({
      code: "PREPARING",
      kind: "in_progress",
      terminal: false,
    });
  });

  it("still applies every forward step: PLACED -> ACCEPTED -> READY -> OUT_FOR_DELIVERY", async () => {
    seedAt("ord_f4_forward", "PLACED");

    await handlePetpoojaWebhook(
      { order_id: "ord_f4_forward", status: "Accept", id: "evt_f4_fwd_1" },
      trusted
    );
    expect(savedDocs["orders/ord_f4_forward"].status).toMatchObject({
      code: "CONFIRMED",
      kind: "upcoming",
      terminal: false,
    });

    await handlePetpoojaWebhook(
      { order_id: "ord_f4_forward", status: 5, id: "evt_f4_fwd_2" },
      trusted
    );
    expect(savedDocs["orders/ord_f4_forward"].status).toMatchObject({
      code: "READY_FOR_PICKUP",
      kind: "in_progress",
    });

    await handlePetpoojaWebhook(
      { order_id: "ord_f4_forward", status: 4, id: "evt_f4_fwd_3" },
      trusted
    );
    expect(savedDocs["orders/ord_f4_forward"].status).toMatchObject({
      code: "OUT_FOR_DELIVERY",
      kind: "in_progress",
    });
  });

  it("does not overwrite the dine-in READY_TO_SERVE fork with a same-rank generic READY", async () => {
    // Same rank (READY_FOR_PICKUP == READY_TO_SERVE): a same-rank vendor status
    // must not assign `status`, or the dine-in fork is silently lost.
    seedAt("ord_f4_dinein", "READY_TO_SERVE", { fulfillmentType: "dinein" });

    await handlePetpoojaWebhook(
      { order_id: "ord_f4_dinein", status: 5, id: "evt_f4_dinein" },
      trusted
    );

    expect(statusCode("ord_f4_dinein")).toBe("READY_TO_SERVE");
  });

  it("still applies an authenticated cancel from READY, with refund planning exactly as before", async () => {
    seedAt("ord_f4_cancel_ready", "READY_FOR_PICKUP", {
      payment: { razorpayPaymentId: "pay_f4_cancel", amount: 49900 },
    });

    await handlePetpoojaWebhook(
      {
        order_id: "ord_f4_cancel_ready",
        status: -1,
        cancel_reason: "item 86ed mid-prep",
        id: "evt_f4_cancel",
      },
      trusted
    );

    expect(savedDocs["orders/ord_f4_cancel_ready"].status).toMatchObject({
      code: "CANCELLED",
      terminal: true,
    });
    expect(savedDocs["orders/ord_f4_cancel_ready"].cancelledAt).toBe("MOCK_TIMESTAMP");
    expect(savedDocs["orders/ord_f4_cancel_ready"].cancellationReason).toBe("item 86ed mid-prep");
    // Terminal cancellation is not a "backwards" move: refund planning is intact.
    expect(refundDocs()).toEqual(["refunds/refund_pos_cancel_ord_f4_cancel_ready"]);
    expect(savedDocs["refunds/refund_pos_cancel_ord_f4_cancel_ready"]).toMatchObject({
      orderId: "ord_f4_cancel_ready",
      razorpayPaymentId: "pay_f4_cancel",
      amountPaise: 49900,
      reason: "POS_CANCELLED",
      status: "PENDING",
    });
    expect(savedDocs["orders/ord_f4_cancel_ready"]["payment.refundStatus"]).toBe(
      "PENDING_APPROVAL"
    );
  });

  it("records the POS id and synced state for a late accept on an accepted_unconfirmed order while status stays READY_FOR_PICKUP", async () => {
    seedAt("ord_f4_late_id", "READY_FOR_PICKUP", {
      petpoojaAcceptedNoId: true,
      petpoojaStatus: "accepted_unconfirmed",
      petpoojaSyncStatus: "accepted_unconfirmed",
    });

    await handlePetpoojaWebhook(
      {
        order_id: "ord_f4_late_id",
        petpooja_order_id: "PP-F4-LATE-1",
        status: "Accept",
        id: "evt_f4_late_id",
      },
      trusted
    );

    const doc = savedDocs["orders/ord_f4_late_id"];
    // Traceability is not a regression: the id the vendor now proves is bound.
    expect(doc.petpoojaOrderId).toBe("PP-F4-LATE-1");
    expect(doc.petpoojaStatus).toBe("synced");
    expect(doc.petpoojaSyncStatus).toBe("synced");
    // ... but the stale accept does not rewind the kitchen state.
    expect(doc.status).toMatchObject({ code: "READY_FOR_PICKUP", kind: "in_progress" });
  });

  it("records the stale raw kitchen status while refusing the regression (documented default)", async () => {
    // DECISION PINNED HERE: `petpoojaKitchenStatus` is the RAW vendor value and
    // stays a faithful record of what the POS last said, even when that report
    // is refused as a backwards move. Operators need the vendor's own word to
    // reconcile; the guarded field is `status`, not the audit trail.
    seedAt("ord_f4_raw", "READY_FOR_PICKUP");

    await handlePetpoojaWebhook(
      { order_id: "ord_f4_raw", status: 2, id: "evt_f4_raw" },
      trusted
    );

    expect(savedDocs["orders/ord_f4_raw"].petpoojaKitchenStatus).toBe(2);
    expect(statusCode("ord_f4_raw")).toBe("READY_FOR_PICKUP");
  });

  it("keeps today's apply behaviour when the current status code has no rank (no invented rank)", async () => {
    // `pending_payment` is a LEGACY bare-string literal that really exists on
    // order documents in this codebase (tests/e2e.flow.test.ts seeds it). The
    // ordering table ranks no such code, so the guard must not invent one: the
    // vendor status applies exactly as it does today.
    savedDocs["orders/ord_f4_legacy"] = {
      id: "ord_f4_legacy",
      branchId: "branch_f4",
      status: "pending_payment",
    };

    await handlePetpoojaWebhook(
      { order_id: "ord_f4_legacy", status: "Accept", id: "evt_f4_legacy" },
      trusted
    );

    expect(savedDocs["orders/ord_f4_legacy"].status).toMatchObject({ code: "CONFIRMED" });
  });

  it("leaves the untrusted path unchanged: no canonical status either way, hint parked", async () => {
    seedAt("ord_f4_untrusted_fwd", "PENDING", {
      petpoojaStatus: "pending_retry",
      petpoojaSyncStatus: "pending_retry",
    });
    seedAt("ord_f4_untrusted_back", "READY_FOR_PICKUP");

    const untrustedClaims: Array<{ orderRef: string; status: string | number }> = [
      { orderRef: "ord_f4_untrusted_fwd", status: "Accept" },
      { orderRef: "ord_f4_untrusted_back", status: 2 },
    ];

    for (const claim of untrustedClaims) {
      await handlePetpoojaWebhook(
        {
          order_id: claim.orderRef,
          status: claim.status,
          id: `evt_untrusted_${claim.orderRef}`,
        },
        { authenticated: false }
      );

      const doc = savedDocs[`orders/${claim.orderRef}`];
      expect(doc.petpoojaKitchenStatus).toBeUndefined();
      expect(doc.petpoojaAcceptedNoId).toBeUndefined();
      expect(savedDocs[`unmatched_petpooja_orders/upo_${claim.orderRef}`]).toMatchObject({
        status: "needs_review",
        trusted: false,
        reason: "unauthenticated_callback",
      });
    }

    expect(statusCode("ord_f4_untrusted_fwd")).toBe("PENDING");
    expect(statusCode("ord_f4_untrusted_back")).toBe("READY_FOR_PICKUP");
    expect(refundDocs()).toEqual([]);
  });
});

describe("Petpooja status webhook — code-only terminal vocabulary is honoured (review Low-2)", () => {
  const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));

  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    fetchSpy.mockClear();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Seed a row whose ONLY terminal evidence is the status CODE (no kind/flag). */
  const seedCodeOnly = (id: string, status: any, extra: Record<string, any> = {}) => {
    savedDocs[`orders/${id}`] = {
      id,
      branchId: "branch_f4",
      status,
      payment: { razorpayPaymentId: `pay_${id}`, amount: 49900 },
      ...extra,
    };
    return JSON.parse(JSON.stringify(savedDocs[`orders/${id}`]));
  };

  it.each(TERMINAL_CODE_ONLY_SHAPES)(
    "ignores a trusted late ACCEPT over a $label row, leaving the whole row untouched",
    async ({ status }) => {
      const orderId = "ord_l2_code_only";
      const original = seedCodeOnly(orderId, status);

      await handlePetpoojaWebhook(
        { order_id: orderId, status: "Accept", id: "evt_l2_late_accept" },
        trusted
      );

      // Nothing is applied at all: not the status, not the raw kitchen status,
      // not the replay marker, and no fabricated acceptance facts.
      expect(savedDocs[`orders/${orderId}`]).toEqual(original);
      // A terminal ignore must never park a POS cancel refund.
      expect(refundDocs()).toEqual([]);
      // ... and never reach an outbound transport.
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  );

  it.each(TERMINAL_CODE_ONLY_SHAPES)(
    "ignores a trusted late CANCEL over a $label row without parking a refund",
    async ({ status }) => {
      const orderId = "ord_l2_code_only_cancel";
      const original = seedCodeOnly(orderId, status);

      // A refund-requesting cancellation is the destructive shape: if the
      // terminal guard misses the code-only row, a refund row appears.
      await handlePetpoojaWebhook(
        { order_id: orderId, status: -1, cancel_reason: "late POS cancel", id: "evt_l2_late_cancel" },
        trusted
      );

      expect(savedDocs[`orders/${orderId}`]).toEqual(original);
      expect(refundDocs()).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  );

  // Controls: the vocabulary addition must not widen into non-terminal or
  // already-covered territory.

  it("still applies an ordinary non-terminal CONFIRMED -> READY callback", async () => {
    seedAt("ord_l2_forward", "CONFIRMED");

    await handlePetpoojaWebhook(
      { order_id: "ord_l2_forward", status: 5, id: "evt_l2_forward" },
      trusted
    );

    expect(savedDocs["orders/ord_l2_forward"].status).toMatchObject({
      code: "READY_FOR_PICKUP",
      kind: "in_progress",
      terminal: false,
    });
    expect(refundDocs()).toEqual([]);
  });

  it("still ignores callbacks over the existing DELIVERED/CANCELLED shapes", async () => {
    seedAt("ord_l2_delivered", "DELIVERED");
    seedAt("ord_l2_cancelled", "CANCELLED");

    await handlePetpoojaWebhook(
      { order_id: "ord_l2_delivered", status: "Accept", id: "evt_l2_delivered" },
      trusted
    );
    await handlePetpoojaWebhook(
      { order_id: "ord_l2_cancelled", status: "Accept", id: "evt_l2_cancelled" },
      trusted
    );

    expect(statusCode("ord_l2_delivered")).toBe("DELIVERED");
    expect(statusCode("ord_l2_cancelled")).toBe("CANCELLED");
    expect(savedDocs["orders/ord_l2_delivered"].petpoojaKitchenStatus).toBeUndefined();
    expect(savedDocs["orders/ord_l2_cancelled"].petpoojaKitchenStatus).toBeUndefined();
    expect(refundDocs()).toEqual([]);
  });

  it("still applies a live non-terminal PICKED-style vocabulary code that is not terminal", async () => {
    // Guard against over-broad vocabulary: a live kitchen state sharing the
    // word "PICK" (READY_FOR_PICKUP) must remain applicable.
    seedAt("ord_l2_ready_from_placed", "PLACED");

    await handlePetpoojaWebhook(
      { order_id: "ord_l2_ready_from_placed", status: 5, id: "evt_l2_ready" },
      trusted
    );

    expect(statusCode("ord_l2_ready_from_placed")).toBe("READY_FOR_PICKUP");
  });
});
