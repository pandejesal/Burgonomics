import { describe, it, expect, vi, beforeEach } from "vitest";

// Finding 5 regressions: item86ingSync's Petpooja status webhook must never
// rewind a TERMINAL order (DELIVERED/CANCELLED), must dedupe replays by event
// id inside a freshness window, and must park at most ONE POS-cancel refund
// request per order even under concurrent replays.
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
          opts?.merge && savedDocs[path] ? { ...savedDocs[path], ...data } : data;
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
              filters.every(([f, op, v]) =>
                op === "==" ? savedDocs[p]?.[f] === v : false
              )
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

const seedDelivered = (id: string, extra: Record<string, any> = {}) => {
  savedDocs[`orders/${id}`] = {
    id,
    branchId: "branch_t1",
    status: { code: "DELIVERED", label: "Delivered", kind: "completed", terminal: true },
    payment: { razorpayPaymentId: "pay_t1" },
    ...extra,
  };
};

const seedInProgress = (id: string, extra: Record<string, any> = {}) => {
  savedDocs[`orders/${id}`] = {
    id,
    branchId: "branch_t1",
    status: { code: "CONFIRMED", label: "Order confirmed", kind: "upcoming", terminal: false },
    payment: { razorpayPaymentId: "pay_t1" },
    ...extra,
  };
};

const refundDocs = () =>
  Object.keys(savedDocs).filter((p) => p.startsWith("refunds/"));

describe("Petpooja status webhook — terminal-state guard (finding 5)", () => {
  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
  });

  it("ignores a late 'accepted' after DELIVERED — no rewind", async () => {
    seedDelivered("ord_1");
    await handlePetpoojaWebhook({ order_id: "ord_1", status: 2 });
    expect(savedDocs["orders/ord_1"].status).toMatchObject({ code: "DELIVERED", terminal: true });
    // No side-channel rewrite either: kitchen status marker stays absent.
    expect(savedDocs["orders/ord_1"].petpoojaKitchenStatus).toBeUndefined();
  });

  it("ignores a late CANCELLED after DELIVERED — no refund parked, no money movement", async () => {
    seedDelivered("ord_2");
    await handlePetpoojaWebhook({ order_id: "ord_2", status: -1, cancel_reason: "late replay" });
    expect(savedDocs["orders/ord_2"].status).toMatchObject({ code: "DELIVERED" });
    expect(refundDocs()).toEqual([]);
    expect(savedDocs["orders/ord_2"]["payment.refundStatus"]).toBeUndefined();
  });

  it("honors legacy bare-string terminal statuses too", async () => {
    savedDocs["orders/ord_3"] = {
      id: "ord_3",
      branchId: "branch_t1",
      status: "DELIVERED",
      payment: { razorpayPaymentId: "pay_t3" },
    };
    await handlePetpoojaWebhook({ order_id: "ord_3", status: -1 });
    expect(savedDocs["orders/ord_3"].status).toBe("DELIVERED");
    expect(refundDocs()).toEqual([]);
  });

  it("still parks a refund request for a LEGITIMATE kitchen cancel (non-terminal order)", async () => {
    seedInProgress("ord_4");
    await handlePetpoojaWebhook({ order_id: "ord_4", status: -1, cancel_reason: "item 86ed" });
    expect(savedDocs["orders/ord_4"].status).toMatchObject({ code: "CANCELLED", terminal: true });
    expect(refundDocs()).toEqual(["refunds/refund_pos_cancel_ord_4"]);
    expect(savedDocs["refunds/refund_pos_cancel_ord_4"]).toMatchObject({
      orderId: "ord_4",
      status: "PENDING",
      reason: "POS_CANCELLED",
    });
    expect(savedDocs["orders/ord_4"]["payment.refundStatus"]).toBe("PENDING_APPROVAL");
  });

  it("parks exactly ONE refund doc under CONCURRENT replayed cancels", async () => {
    seedInProgress("ord_5");
    await Promise.all([
      handlePetpoojaWebhook({ order_id: "ord_5", status: -1 }),
      handlePetpoojaWebhook({ order_id: "ord_5", status: -1 }),
    ]);
    expect(refundDocs()).toEqual(["refunds/refund_pos_cancel_ord_5"]);
  });
});

describe("Petpooja status webhook — event-id replay defense (finding 5)", () => {
  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
  });

  it("dedupes a redelivered event id inside the 15-min freshness window", async () => {
    seedInProgress("ord_r1");
    await handlePetpoojaWebhook({ order_id: "ord_r1", status: 5, id: "evt_100" });
    expect(savedDocs["orders/ord_r1"].status).toMatchObject({ code: "READY_FOR_PICKUP" });
    expect(savedDocs["orders/ord_r1"].petpoojaKitchenStatus).toBe(5);

    // Redelivery of the SAME event: no re-apply (status/kitchen marker frozen).
    savedDocs["orders/ord_r1"].petpoojaKitchenStatus = "tampered";
    await handlePetpoojaWebhook({ order_id: "ord_r1", status: 2, id: "evt_100" });
    expect(savedDocs["orders/ord_r1"].petpoojaKitchenStatus).toBe("tampered");
    expect(savedDocs["orders/ord_r1"].status).toMatchObject({ code: "READY_FOR_PICKUP" });
  });

  it("applies a same-id event OUTSIDE the freshness window (marker is bounded)", async () => {
    seedInProgress("ord_r2");
    savedDocs["orders/ord_r2"].petpoojaWebhookEventId = "evt_200";
    savedDocs["orders/ord_r2"].petpoojaWebhookReceivedAtMs = Date.now() - 16 * 60 * 1000;
    await handlePetpoojaWebhook({ order_id: "ord_r2", status: 5, id: "evt_200" });
    expect(savedDocs["orders/ord_r2"].status).toMatchObject({ code: "READY_FOR_PICKUP" });
  });

  it("applies distinct event ids in sequence (no false dedupe)", async () => {
    seedInProgress("ord_r3");
    await handlePetpoojaWebhook({ order_id: "ord_r3", status: 5, id: "evt_a" });
    await handlePetpoojaWebhook({ order_id: "ord_r3", status: 10, id: "evt_b" });
    expect(savedDocs["orders/ord_r3"].status).toMatchObject({ code: "DELIVERED", terminal: true });
    expect(savedDocs["orders/ord_r3"].petpoojaWebhookEventId).toBe("evt_b");
  });
});

// Petpooja's Configuration page points BOTH "Get Store Status" and "Update
// Store Status" at /petpooja/webhook, but those payloads carry no order id
// ({"restID":"...","status":"1"}), so the order-lifecycle path threw and the
// endpoint answered HTTP 500 — which Petpooja reads as a broken webhook and
// retries or disables. Store-status pings must be recognised, not error.
describe("handlePetpoojaWebhook — store-status pings", () => {
  it("accepts a store-status payload instead of throwing", async () => {
    // The exact shape Petpooja's Configuration page sends. Used to be HTTP 500
    // {"error":"Missing order_id in Petpooja status webhook payload"}.
    await expect(
      handlePetpoojaWebhook({ restID: "31z58ciw0h", status: "1" })
    ).resolves.toBeUndefined();
  });

  it("records the ping so the status encoding can be confirmed from real traffic", async () => {
    await handlePetpoojaWebhook({ restID: "31z58ciw0h", status: "1" });
    const rec = savedDocs["petpooja_store_status_events/ss_31z58ciw0h"];
    expect(rec).toBeDefined();
    expect(rec.restId).toBe("31z58ciw0h");
    expect(rec.rawStatus).toBe("1");
    // Unlinked outlet: recorded with branchId null, nothing mutated.
    expect(rec.branchId).toBeNull();
  });

  it("resolves the branch once the outlet IS linked", async () => {
    savedDocs["branches/hl-road"] = { petpoojaStoreId: "31z58ciw0h", name: "HL Road" };
    await handlePetpoojaWebhook({ restID: "31z58ciw0h", status: "1" });
    expect(savedDocs["petpooja_store_status_events/ss_31z58ciw0h"].branchId).toBe("hl-road");
  });

  it("does NOT mutate branch ordering state on an unverified encoding", async () => {
    savedDocs["branches/hl-road"] = {
      petpoojaStoreId: "31z58ciw0h",
      acceptingOrdersStatus: "open",
      status: "active",
    };
    await handlePetpoojaWebhook({ restID: "31z58ciw0h", status: "0" });
    // A guessed encoding must not close a live outlet.
    expect(savedDocs["branches/hl-road"].acceptingOrdersStatus).toBe("open");
    expect(savedDocs["branches/hl-road"].status).toBe("active");
  });

  it("still fails loudly when NO order id and NO store-status shape is present", async () => {
    // The guard is narrow: an unidentifiable payload must not silently pass.
    await expect(handlePetpoojaWebhook({ unrelated: true })).rejects.toThrow(
      /Missing order_id/
    );
  });

  it("never shadows a real order event that also carries restID + status", async () => {
    // Order events carry restID and status too, so the store-status branch must
    // only be reachable when there is NO order id. The order path parks an
    // unknown order for review, which proves the event went the order way.
    await handlePetpoojaWebhook({ order_id: "ord_ss", restID: "31z58ciw0h", status: 2 });
    expect(savedDocs["unmatched_petpooja_orders/upo_ord_ss"]).toBeDefined();
  });
});

// The documented order-status callback carries `orderID` as a CLIENT reference
// (vendor blueprint); it is treated as a POS id only when a branch-scoped
// petpoojaOrderId lookup proves it. Before this, the key was never read, nothing
// in the codebase was keyed on `petpoojaOrderId`, and such a payload was
// swallowed by the store-status branch — so a genuine Accept/Reject could never
// reach the order it referred to. The cases below pin BOTH readings: proven POS
// ids still resolve, and unproven ids never become petpoojaOrderId.
describe("handlePetpoojaWebhook — POS-assigned order id (only when proven)", () => {
  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
  });

  it("records an unproven callback id without claiming it as the POS id, and promotes out of pending_retry", async () => {
    savedDocs["branches/branch_t1"] = { petpoojaStoreId: "31z58ciw0h", name: "HL Road" };
    // The outbound relay parks an order here when save_order echoes orderID:"".
    savedDocs["orders/ord_pos"] = {
      id: "ord_pos",
      branchId: "branch_t1",
      petpoojaStatus: "pending_retry",
      petpoojaSyncStatus: "pending_retry",
      status: { code: "PENDING", label: "Pending", kind: "upcoming", terminal: false },
    };
    await handlePetpoojaWebhook({
      order_id: "ord_pos",
      restID: "31z58ciw0h",
      orderID: "PP-9001",
      status: "Accept",
    });
    const doc = savedDocs["orders/ord_pos"];
    expect(doc.status).toMatchObject({ code: "CONFIRMED" });
    expect(doc.petpoojaKitchenStatus).toBe("Accept");
    // The documented callback `orderID` is a CLIENT id. With no POS-issued id
    // proven, it must not be promoted onto petpoojaOrderId (that would fabricate
    // provenance and poison the outbound dedupe). It is kept for visibility and
    // the order is marked accepted-no-id truthfully.
    expect(doc.petpoojaOrderId).toBeUndefined();
    expect(doc.petpoojaCallbackOrderId).toBe("PP-9001");
    expect(doc.petpoojaAcceptedNoId).toBe(true);
    // Promoted, or the retry worker would keep re-pushing an accepted order.
    expect(doc.petpoojaStatus).toBe("synced");
    expect(doc.petpoojaSyncStatus).toBe("synced");
    // An order event must never be recorded as a store-status ping.
    expect(savedDocs["petpooja_store_status_events/ss_31z58ciw0h"]).toBeUndefined();
  });

  it("resolves an order from the POS id alone, with no client reference in the payload", async () => {
    savedDocs["branches/branch_t1"] = { petpoojaStoreId: "31z58ciw0h", name: "HL Road" };
    savedDocs["orders/ord_bypos"] = {
      id: "ord_bypos",
      branchId: "branch_t1",
      petpoojaOrderId: "PP-9002",
      petpoojaStatus: "synced",
      status: { code: "PENDING", label: "Pending", kind: "upcoming", terminal: false },
    };
    // No order_id / clientOrderID at all — the shape that used to be swallowed.
    await handlePetpoojaWebhook({
      restID: "31z58ciw0h",
      orderID: "PP-9002",
      status: "Accept",
    });
    const doc = savedDocs["orders/ord_bypos"];
    expect(doc.status).toMatchObject({ code: "CONFIRMED" });
    expect(doc.petpoojaKitchenStatus).toBe("Accept");
    expect(doc.petpoojaOrderId).toBe("PP-9002");
    expect(savedDocs["petpooja_store_status_events/ss_31z58ciw0h"]).toBeUndefined();
  });

  it("refuses a POS id matching only an order outside the restID's branch", async () => {
    savedDocs["branches/branch_t2"] = { petpoojaStoreId: "31z58ciw0h" };
    savedDocs["orders/ord_other"] = {
      id: "ord_other",
      branchId: "branch_t1",
      petpoojaOrderId: "PP-9003",
      status: { code: "PENDING", label: "Pending", kind: "upcoming", terminal: false },
    };
    await handlePetpoojaWebhook({
      restID: "31z58ciw0h",
      orderID: "PP-9003",
      status: "Accept",
    });
    // The wrong branch's order must not be touched...
    expect(savedDocs["orders/ord_other"].petpoojaKitchenStatus).toBeUndefined();
    // ...and the event is parked for review instead.
    expect(savedDocs["unmatched_petpooja_orders/upo_PP-9003"]).toBeDefined();
  });

  it("parks an unknown POS-shaped id rather than rejecting the callback", async () => {
    await handlePetpoojaWebhook({
      restID: "31z58ciw0h",
      orderID: "PP-9999",
      status: "Accept",
    });
    const parked = savedDocs["unmatched_petpooja_orders/upo_PP-9999"];
    expect(parked).toMatchObject({ status: "needs_review" });
    // Unproven ids are not labelled POS ids in the review queue.
    expect(parked.posOrderId).toBeNull();
    expect(parked.callbackOrderId).toBe("PP-9999");
  });

  // ---- Untrusted (shape-admitted, no credential) callers ----
  // The middleware admits the vendor's credential-less callback by shape. These
  // bound what such a call may do.

  it("refuses an untrusted bare POS id — no restID means no outlet scoping", async () => {
    savedDocs["branches/branch_t1"] = { petpoojaStoreId: "31z58ciw0h" };
    savedDocs["orders/ord_bare"] = {
      id: "ord_bare",
      branchId: "branch_t1",
      petpoojaOrderId: "PP-9004",
      status: { code: "PENDING", label: "Pending", kind: "upcoming", terminal: false },
    };
    await handlePetpoojaWebhook({ orderID: "PP-9004", status: "Accept" }, { authenticated: false });
    // The order must be untouched, and the claim parked instead.
    expect(savedDocs["orders/ord_bare"].petpoojaKitchenStatus).toBeUndefined();
    expect(savedDocs["unmatched_petpooja_orders/upo_PP-9004"]).toBeDefined();
  });

  it("does not let an untrusted callback write the POS id or suppress retries", async () => {
    savedDocs["branches/branch_t1"] = { petpoojaStoreId: "31z58ciw0h" };
    savedDocs["orders/ord_untrusted"] = {
      id: "ord_untrusted",
      branchId: "branch_t1",
      petpoojaStatus: "pending_retry",
      petpoojaSyncStatus: "pending_retry",
      status: { code: "PENDING", label: "Pending", kind: "upcoming", terminal: false },
    };
    await handlePetpoojaWebhook(
      { order_id: "ord_untrusted", restID: "31z58ciw0h", orderID: "PP-9005", status: "Accept" },
      { authenticated: false }
    );
    const doc = savedDocs["orders/ord_untrusted"];
    // A bounded status change is still applied...
    expect(doc.status).toMatchObject({ code: "CONFIRMED" });
    // ...but sync state is off limits: the retry worker and the outbound dedupe
    // both key off these, so a forged value would drop a real order from retry.
    expect(doc.petpoojaOrderId).toBeUndefined();
    expect(doc.petpoojaStatus).toBe("pending_retry");
    expect(doc.petpoojaSyncStatus).toBe("pending_retry");
    // What the caller claimed is recorded separately, for visibility only.
    expect(doc.petpoojaCallbackOrderId).toBe("PP-9005");
  });

  it("refuses an untrusted callback whose restID is not the order's branch", async () => {
    savedDocs["branches/branch_t2"] = { petpoojaStoreId: "31z58ciw0h" };
    savedDocs["orders/ord_z"] = {
      id: "ord_z",
      branchId: "branch_t1",
      status: { code: "PENDING", label: "Pending", kind: "upcoming", terminal: false },
    };
    await handlePetpoojaWebhook(
      { order_id: "ord_z", restID: "31z58ciw0h", status: "Cancel" },
      { authenticated: false }
    );
    expect(savedDocs["orders/ord_z"].status).toMatchObject({ code: "PENDING" });
    expect(savedDocs["orders/ord_z"].petpoojaKitchenStatus).toBeUndefined();
    expect(savedDocs["unmatched_petpooja_orders/upo_ord_z"]).toBeDefined();
  });

  it("does not promote a Reject to a synced state even when credentialed", async () => {
    savedDocs["branches/branch_t1"] = { petpoojaStoreId: "31z58ciw0h" };
    savedDocs["orders/ord_reject"] = {
      id: "ord_reject",
      branchId: "branch_t1",
      petpoojaStatus: "pending_retry",
      status: { code: "PENDING", label: "Pending", kind: "upcoming", terminal: false },
    };
    await handlePetpoojaWebhook(
      { order_id: "ord_reject", restID: "31z58ciw0h", orderID: "PP-9007", status: "Reject" }
    );
    const doc = savedDocs["orders/ord_reject"];
    // The POS refused the KOT: no id, no "synced".
    expect(doc.petpoojaOrderId).toBeUndefined();
    expect(doc.petpoojaStatus).toBe("pending_retry");
  });
});

// Documented contract (vendor Apiary V2.1, order-callback-request-response):
// the callback carries `orderID` = "Unique client order id which is used to
// update order status at client side". It is therefore OUR reference, not the
// POS-issued id. These cases pin the client-ref-first resolution, the branch
// contradiction park, and the provenance rule that a client ref never becomes
// petpoojaOrderId.
describe("handlePetpoojaWebhook — documented client-ref callback (orderID only)", () => {
  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
  });

  const seedLinkedOrder = (id: string, extra: Record<string, any> = {}) => {
    savedDocs["branches/branch_t1"] = { petpoojaStoreId: "31z58ciw0h", name: "HL Road" };
    savedDocs[`orders/${id}`] = {
      id,
      branchId: "branch_t1",
      petpoojaStatus: "pending_retry",
      petpoojaSyncStatus: "pending_retry",
      status: { code: "PENDING", label: "Pending", kind: "upcoming", terminal: false },
      ...extra,
    };
  };

  it("resolves the documented shape and records acceptance without inventing a POS id", async () => {
    seedLinkedOrder("ord_cb1");
    await handlePetpoojaWebhook({ restID: "31z58ciw0h", orderID: "ord_cb1", status: "5" });
    const doc = savedDocs["orders/ord_cb1"];
    expect(doc.status).toMatchObject({ code: "READY_FOR_PICKUP" });
    expect(doc.petpoojaKitchenStatus).toBe("5");
    // Truthful provenance: no POS id was issued, so none is claimed.
    expect(doc.petpoojaOrderId).toBeUndefined();
    expect(doc.petpoojaAcceptedNoId).toBe(true);
    expect(doc.petpoojaAcceptedNoIdSource).toBe("callback_client_ref");
    expect(doc.petpoojaCallbackClientRef).toBe("ord_cb1");
    // Promoted out of pending_retry so the retry worker cannot duplicate a KOT.
    expect(doc.petpoojaStatus).toBe("synced");
    expect(doc.petpoojaSyncStatus).toBe("synced");
    expect(savedDocs["unmatched_petpooja_orders/upo_ord_cb1"]).toBeUndefined();
  });

  it("PARKS a client reference that contradicts the callback's outlet and does not fall back to the POS path", async () => {
    savedDocs["branches/branch_t1"] = { petpoojaStoreId: "31z58ciw0h" };
    savedDocs["branches/branch_t2"] = { petpoojaStoreId: "OTHER-REST" };
    // The client ref names branch_t1's order ...
    savedDocs["orders/ord_cb2"] = {
      id: "ord_cb2",
      branchId: "branch_t1",
      status: { code: "PENDING", label: "Pending", kind: "upcoming", terminal: false },
    };
    // ... while a POS-shaped lookup under the callback's outlet WOULD match this
    // decoy. A contradiction must park, never retry the POS path and apply here.
    savedDocs["orders/ord_decoy"] = {
      id: "ord_decoy",
      branchId: "branch_t2",
      petpoojaOrderId: "ord_cb2",
      status: { code: "PENDING", label: "Pending", kind: "upcoming", terminal: false },
    };
    await handlePetpoojaWebhook({ restID: "OTHER-REST", orderID: "ord_cb2", status: "5" });
    expect(savedDocs["orders/ord_cb2"].status).toMatchObject({ code: "PENDING" });
    expect(savedDocs["orders/ord_cb2"].petpoojaKitchenStatus).toBeUndefined();
    expect(savedDocs["orders/ord_decoy"].status).toMatchObject({ code: "PENDING" });
    expect(savedDocs["orders/ord_decoy"].petpoojaKitchenStatus).toBeUndefined();
    expect(savedDocs["unmatched_petpooja_orders/upo_ord_cb2"].reason).toMatch(
      /outside callback outlet/
    );
  });

  it("parks a documented client ref when restID is missing or unlinked", async () => {
    seedLinkedOrder("ord_cb3");
    await handlePetpoojaWebhook({ restID: "UNLINKED-REST", orderID: "ord_cb3", status: "5" });
    expect(savedDocs["orders/ord_cb3"].status).toMatchObject({ code: "PENDING" });
    expect(savedDocs["orders/ord_cb3"].petpoojaKitchenStatus).toBeUndefined();
    expect(savedDocs["unmatched_petpooja_orders/upo_ord_cb3"]).toBeDefined();
  });

  it("parks an unknown client ref without touching any order", async () => {
    savedDocs["branches/branch_t1"] = { petpoojaStoreId: "31z58ciw0h" };
    await handlePetpoojaWebhook({ restID: "31z58ciw0h", orderID: "does_not_exist", status: "5" });
    expect(savedDocs["unmatched_petpooja_orders/upo_does_not_exist"]).toMatchObject({
      callbackOrderId: "does_not_exist",
      status: "needs_review",
    });
  });

  it("lets an untrusted client-ref callback change status but never promote sync state", async () => {
    seedLinkedOrder("ord_cb5");
    await handlePetpoojaWebhook(
      { restID: "31z58ciw0h", orderID: "ord_cb5", status: "5" },
      { authenticated: false }
    );
    const doc = savedDocs["orders/ord_cb5"];
    // Bounded status change is preserved ...
    expect(doc.status).toMatchObject({ code: "READY_FOR_PICKUP" });
    // ... but the retry/dedupe state stays untouched, and the claim is only
    // recorded under the visibility field.
    expect(doc.petpoojaOrderId).toBeUndefined();
    expect(doc.petpoojaAcceptedNoId).toBeUndefined();
    expect(doc.petpoojaStatus).toBe("pending_retry");
    expect(doc.petpoojaSyncStatus).toBe("pending_retry");
    expect(doc.petpoojaCallbackClientRef).toBe("ord_cb5");
  });

  it("keeps the genuine POS-id fallback working when the callback carries a proven POS id", async () => {
    savedDocs["branches/branch_t1"] = { petpoojaStoreId: "31z58ciw0h" };
    savedDocs["orders/ord_pos2"] = {
      id: "ord_pos2",
      branchId: "branch_t1",
      petpoojaOrderId: "PP-9100",
      petpoojaStatus: "synced",
      status: { code: "PENDING", label: "Pending", kind: "upcoming", terminal: false },
    };
    await handlePetpoojaWebhook({ restID: "31z58ciw0h", orderID: "PP-9100", status: "Accept" });
    const doc = savedDocs["orders/ord_pos2"];
    expect(doc.status).toMatchObject({ code: "CONFIRMED" });
    expect(doc.petpoojaOrderId).toBe("PP-9100");
    expect(doc.petpoojaCallbackClientRef).toBeUndefined();
  });

  it("parks conflicting client refs instead of choosing one", async () => {
    savedDocs["branches/branch_t1"] = { petpoojaStoreId: "31z58ciw0h" };
    savedDocs["orders/ord_legit"] = {
      id: "ord_legit",
      branchId: "branch_t1",
      status: { code: "PENDING", label: "Pending", kind: "upcoming", terminal: false },
    };
    savedDocs["orders/ord_other"] = {
      id: "ord_other",
      branchId: "branch_t1",
      status: { code: "PENDING", label: "Pending", kind: "upcoming", terminal: false },
    };
    await handlePetpoojaWebhook({
      order_id: "ord_legit",
      restID: "31z58ciw0h",
      orderID: "ord_other",
      status: "5",
    });
    expect(savedDocs["orders/ord_legit"].status).toMatchObject({ code: "PENDING" });
    expect(savedDocs["orders/ord_legit"].petpoojaKitchenStatus).toBeUndefined();
    expect(savedDocs["orders/ord_other"].status).toMatchObject({ code: "PENDING" });
    expect(savedDocs["unmatched_petpooja_orders/upo_ord_legit"].reason).toMatch(
      /conflicting client refs/
    );
  });

  it("parks a credentialed legacy client ref whose claimed outlet does not resolve", async () => {
    seedLinkedOrder("ord_cb7");
    await handlePetpoojaWebhook({ order_id: "ord_cb7", restID: "NOPE-999", status: "5" });
    expect(savedDocs["orders/ord_cb7"].status).toMatchObject({ code: "PENDING" });
    expect(savedDocs["orders/ord_cb7"].petpoojaKitchenStatus).toBeUndefined();
    expect(savedDocs["unmatched_petpooja_orders/upo_ord_cb7"].reason).toMatch(
      /did not resolve to a linked branch/
    );
  });

  it("parks a documented client ref with no restID at all (no unscoped lookup)", async () => {
    seedLinkedOrder("ord_cb8");
    await handlePetpoojaWebhook({ orderID: "ord_cb8", status: "5" });
    expect(savedDocs["orders/ord_cb8"].status).toMatchObject({ code: "PENDING" });
    expect(savedDocs["unmatched_petpooja_orders/upo_ord_cb8"]).toBeDefined();
  });

  it("does not overwrite a proven POS id with a second claimed id in the same payload", async () => {
    savedDocs["branches/branch_t1"] = { petpoojaStoreId: "31z58ciw0h" };
    savedDocs["orders/ord_ab"] = {
      id: "ord_ab",
      branchId: "branch_t1",
      petpoojaOrderId: "PP-A",
      petpoojaStatus: "synced",
      status: { code: "PENDING", label: "Pending", kind: "upcoming", terminal: false },
    };
    await handlePetpoojaWebhook({
      restID: "31z58ciw0h",
      orderID: "PP-A",
      petpooja_order_id: "PP-B",
      status: "Accept",
    });
    const doc = savedDocs["orders/ord_ab"];
    // The lookup proved PP-A; the explicit PP-B is only a claim and must not win.
    expect(doc.petpoojaOrderId).toBe("PP-A");
    expect(doc.status).toMatchObject({ code: "CONFIRMED" });
  });

  it("does not mark accepted-no-id on an order that already holds a proven POS id, and preserves the push ack", async () => {
    savedDocs["branches/branch_t1"] = { petpoojaStoreId: "31z58ciw0h" };
    savedDocs["orders/ord_hasid"] = {
      id: "ord_hasid",
      branchId: "branch_t1",
      petpoojaOrderId: "PP-1",
      petpoojaStatus: "synced",
      petpoojaAcceptedNoIdAck: '{"success":"1"}',
      status: { code: "PENDING", label: "Pending", kind: "upcoming", terminal: false },
    };
    await handlePetpoojaWebhook({ restID: "31z58ciw0h", orderID: "ord_hasid", status: "5" });
    const doc = savedDocs["orders/ord_hasid"];
    expect(doc.status).toMatchObject({ code: "READY_FOR_PICKUP" });
    expect(doc.petpoojaAcceptedNoId).toBeUndefined();
    expect(doc.petpoojaAcceptedNoIdAck).toBe('{"success":"1"}');
  });

  it("does not reuse an unproven callback id as a later POS lookup key", async () => {
    seedLinkedOrder("ord_taught");
    await handlePetpoojaWebhook({
      order_id: "ord_taught",
      restID: "31z58ciw0h",
      orderID: "PP-7",
      status: "Accept",
    });
    expect(savedDocs["orders/ord_taught"].petpoojaOrderId).toBeUndefined();
    expect(savedDocs["orders/ord_taught"].petpoojaCallbackOrderId).toBe("PP-7");
    // A later POS-id-only event carrying the unproven value must park: it was
    // never proven to be a POS id, so it cannot become a lookup key.
    await handlePetpoojaWebhook({ restID: "31z58ciw0h", orderID: "PP-7", status: "5" });
    expect(savedDocs["orders/ord_taught"].status).toMatchObject({ code: "CONFIRMED" });
    expect(savedDocs["unmatched_petpooja_orders/upo_PP-7"]).toBeDefined();
  });
});
