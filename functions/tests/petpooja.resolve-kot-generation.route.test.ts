import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";

/**
 * P1-K final review — a resolvable id-less acceptance must be bound to an
 * ACCEPTANCE GENERATION, not just an in-flight lease.
 *
 * The defect: `resolveKot` `retry` cleared the acceptance dedupe, sent one KOT,
 * and the POS answered with ANOTHER id-less acceptance — the sandbox's normal
 * answer and possible in production. The response to the client then dropped.
 * An identical client retry saw `accepted_unconfirmed` again, treated it as a
 * fresh resolvable state, cleared the dedupe and sent a SECOND ticket: the same
 * staff decision printed the food twice.
 *
 * Contract pinned here (real sequence, real Express route):
 *   retry -> POS accepts with no id -> response lost -> identical retry
 *   => exactly ONE POS call, and the repeat reports `reused`.
 *
 * A genuinely NEW failure stays resolvable: the retry after a NON-accepting
 * outcome (transport failure / proven rejection) is a different generation and
 * may send once more. That is asserted too, so the fix cannot degenerate into
 * "retry only ever works once".
 */

vi.hoisted(() => {
  process.env.BURGONOMICS_ENV = "dev";
  process.env.APP_CHECK_ENFORCEMENT = "";
});

const h = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const hooks: { failNextAcceptanceWrite?: boolean } = {};
  const verifyIdToken = vi.fn(async (token: string) => {
    if (token !== "staff-token") throw new Error("invalid token");
    return {
      uid: "staff_kot_gen",
      role: "branch_staff",
      branchIds: ["branch_gen_1"],
      email: "ops.gen@burgonomics.test",
    };
  });

  const clone = (v: any) => (v && typeof v === "object" ? JSON.parse(JSON.stringify(v)) : v);

  const mergeSet = (path: string, data: any, merge: boolean | undefined) => {
    savedDocs[path] = merge && savedDocs[path] ? { ...savedDocs[path], ...clone(data) } : clone(data);
  };

  const docRef = (colName: string, docId: string): any => {
    const path = `${colName}/${docId}`;
    const ref: any = {
      id: docId,
      path,
      get: async () => ({
        exists: Object.prototype.hasOwnProperty.call(savedDocs, path),
        id: docId,
        data: () => (savedDocs[path] ? clone(savedDocs[path]) : undefined),
        ref,
      }),
      set: async (data: any, opts?: any) => {
        // F3 injection: reject the FIRST write that records a POS acceptance.
        if (
          hooks.failNextAcceptanceWrite &&
          data &&
          (data.petpoojaAcceptedNoId !== undefined ||
            data.petpoojaOrderId !== undefined ||
            data.petpoojaAcceptanceGeneration !== undefined)
        ) {
          hooks.failNextAcceptanceWrite = false;
          throw new Error("simulated Firestore rejection while recording the ack");
        }
        mergeSet(path, data, opts?.merge);
      },
      update: async (data: any) => mergeSet(path, data, true),
    };
    return ref;
  };

  const emptyQuery: any = {
    where: () => emptyQuery,
    orderBy: () => emptyQuery,
    limit: () => emptyQuery,
    startAfter: () => emptyQuery,
    get: async () => ({ empty: true, docs: [] }),
  };

  const mockDb: any = {
    collection: (colName: string) => ({
      ...emptyQuery,
      doc: (docId?: string) => docRef(colName, docId as string),
    }),
    getAll: async (...refs: any[]) => Promise.all(refs.map((r: any) => r.get())),
    // Real-ish transaction: reads must precede writes.
    runTransaction: async (fn: any) => {
      let hasWritten = false;
      return fn({
        get: async (ref: any) => {
          if (hasWritten) {
            throw new Error(
              "Firestore transactions require all reads to be executed before all writes."
            );
          }
          return ref.get();
        },
        set: (ref: any, data: any, opts?: any) => {
          hasWritten = true;
          return ref.set(data, opts);
        },
        update: (ref: any, data: any) => {
          hasWritten = true;
          return ref.update(data);
        },
      });
    },
  };

  return { savedDocs, hooks, verifyIdToken, mockDb };
});

vi.mock("../src/core/firebase", () => ({
  db: h.mockDb,
  auth: { verifyIdToken: h.verifyIdToken },
  messaging: { send: vi.fn(async () => "msg"), sendEachForMulticast: vi.fn(async () => ({})) },
}));

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TIMESTAMP",
    increment: (n: number) => n,
    arrayUnion: (value: unknown) => ({ union: value }),
    arrayRemove: (...values: unknown[]) => ({ remove: values }),
    delete: () => "MOCK_DELETE",
  };
  const firestoreFn: any = vi.fn(() => h.mockDb);
  firestoreFn.FieldValue = FieldValue;
  return {
    default: {
      firestore: firestoreFn,
      auth: vi.fn(() => ({ verifyIdToken: h.verifyIdToken })),
      messaging: vi.fn(() => ({ send: vi.fn(async () => "msg") })),
      appCheck: vi.fn(() => ({ verifyToken: vi.fn(async () => ({})) })),
      initializeApp: vi.fn(),
      apps: [{ name: "mock" }],
    },
    firestore: firestoreFn,
    auth: vi.fn(() => ({ verifyIdToken: h.verifyIdToken })),
    messaging: vi.fn(() => ({ send: vi.fn(async () => "msg") })),
    appCheck: vi.fn(() => ({ verifyToken: vi.fn(async () => ({})) })),
    initializeApp: vi.fn(),
    apps: [{ name: "mock" }],
  };
});

vi.mock("../src/modules/notifications/fcm.service", () => ({
  dispatchFCM: vi.fn(async () => true),
}));

import { app } from "../src/index";
import { config } from "../src/config/env";

const BRANCH = "branch_gen_1";

let server: Server;
let baseUrl: string;
let posFetch: any;
/** What the next POS save_order answers: id-less acceptance, or a transport error. */
let nextPos: "accepted_no_id" | "rejected_hard" | "transport_error" = "accepted_no_id";

const posCalls = () =>
  posFetch.mock.calls.filter((call: any[]) => String(call[0]).includes("save_order")).length;

function seedOrder(orderId: string) {
  h.savedDocs[`branches/${BRANCH}`] = {
    name: "Generation Outlet",
    petpoojaStoreId: "res_gen_1",
    petpoojaTaxes: [
      { id: "3928", name: "CGST", rate: 2.5 },
      { id: "3929", name: "SGST", rate: 2.5 },
    ],
  };
  h.savedDocs[`products/prod_gen_${orderId}`] = {
    id: `prod_gen_${orderId}`,
    branchId: BRANCH,
    name: "Generation Burger",
    price: 199,
    inStock: true,
    petpoojaItemId: "7765862",
  };
  h.savedDocs[`orders/${orderId}`] = {
    id: orderId,
    branchId: BRANCH,
    customerId: "cust_gen_1",
    userId: "cust_gen_1",
    fulfillment: "takeaway",
    paymentMethod: "cod",
    paymentStatus: "completed",
    customerName: "Generation Customer",
    customerPhone: "+919825000222",
    items: [
      {
        id: "l1",
        productId: `prod_gen_${orderId}`,
        name: "Generation Burger",
        price: 199,
        quantity: 1,
      },
    ],
    pricing: { grandTotal: 199, gst: 9.48 },
    status: "accepted",
    // The state the first retry left behind: relay accepted, no order id.
    petpoojaStatus: "accepted_unconfirmed",
    petpoojaSyncStatus: "accepted_unconfirmed",
    petpoojaAcceptedNoId: true,
    petpoojaAcceptedNoIdAt: "EARLIER_TIMESTAMP",
    petpoojaAcceptedNoIdAck: '{"success":"1","orderID":""}',
    kotPushedAt: "EARLIER_TIMESTAMP",
  };
}

function post(body: Record<string, any>) {
  return fetch(`${baseUrl}/petpooja/resolveKot`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer staff-token" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  const prevMock = config.mock.petpoojaPos;
  config.mock.petpoojaPos = false;

  const realFetch = globalThis.fetch;
  posFetch = vi.fn(async (url: any, init?: any) => {
    const target = String(url);
    if (target.startsWith("http://127.0.0.1:")) return realFetch(url, init);
    if (!target.includes("save_order")) {
      throw new Error(`unexpected provider call in this suite: ${target}`);
    }
    if (nextPos === "transport_error") {
      const err = new TypeError("fetch failed");
      (err as any).cause = Object.assign(new Error("connect ECONNRESET"), { code: "ECONNRESET" });
      throw err;
    }
    if (nextPos === "rejected_hard") {
      return new Response(JSON.stringify({ success: "0", message: "invalid resID" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    // The sandbox's real answer: accepted, and NO order id.
    return new Response(
      JSON.stringify({
        success: "1",
        message: "Your order is saved.",
        restID: "res_gen_1",
        clientOrderID: "whatever",
        orderID: "",
        code: 200,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });
  vi.stubGlobal("fetch", posFetch);

  server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  (globalThis as any).__restoreGenConfig = () => {
    config.mock.petpoojaPos = prevMock;
  };
});

afterAll(async () => {
  vi.unstubAllGlobals();
  (globalThis as any).__restoreGenConfig?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  for (const key of Object.keys(h.savedDocs)) delete h.savedDocs[key];
  h.verifyIdToken.mockClear();
  posFetch.mockClear();
  h.hooks.failNextAcceptanceWrite = false;
  nextPos = "accepted_no_id";
});

describe("resolveKot retry is bound to the acceptance generation", () => {
  it("retry, POS accepts with no id, response lost, identical retry: exactly ONE POS call", async () => {
    seedOrder("ord_gen_lost");

    // 1. Staff say the kitchen did NOT print. One fresh push goes out and the
    //    POS accepts it WITHOUT an id — a new acceptance generation, still
    //    `accepted_unconfirmed`.
    const first = await post({ orderId: "ord_gen_lost", resolution: "retry" });
    expect(first.status).toBe(200);
    const firstBody: any = await first.json();
    expect(firstBody).toMatchObject({ resolved: "retry", orderId: "ord_gen_lost", pushed: true });
    expect(posCalls()).toBe(1);

    const afterFirst = h.savedDocs["orders/ord_gen_lost"];
    expect(afterFirst.petpoojaStatus).toBe("accepted_unconfirmed");
    expect(afterFirst.petpoojaAcceptedNoId).toBe(true);
    // The generation that this retry consumed is recorded, whoever sent it.
    expect(typeof afterFirst.petpoojaAcceptanceGeneration).toBe("number");
    const consumedGeneration = afterFirst.petpoojaAcceptanceGeneration;
    expect(afterFirst.petpoojaResolvedGeneration).toBe(consumedGeneration);

    // 2. The client never saw that response (network drop) and retries the SAME
    //    decision for the SAME acceptance. It must not send a second KOT.
    const repeat = await post({ orderId: "ord_gen_lost", resolution: "retry" });
    expect(repeat.status).toBe(200);
    const repeatBody: any = await repeat.json();
    expect(repeatBody).toMatchObject({
      resolved: "retry",
      orderId: "ord_gen_lost",
      pushed: false,
      reused: true,
    });
    expect(repeatBody.acceptanceGeneration).toBe(consumedGeneration);
    expect(posCalls()).toBe(1);

    // Nothing on the order moved backwards, and the ticket state is unchanged.
    const afterRepeat = h.savedDocs["orders/ord_gen_lost"];
    expect(afterRepeat.petpoojaStatus).toBe("accepted_unconfirmed");
    expect(afterRepeat.petpoojaAcceptedNoId).toBe(true);
    expect(afterRepeat.petpoojaAcceptanceGeneration).toBe(consumedGeneration);
    expect(afterRepeat.petpoojaResolution).toBe("retry");
    expect(afterRepeat.petpoojaResolvedBy).toBe("staff_kot_gen");
  });

  it("an explicit token from the client is honoured: same token never re-sends, a new token may", async () => {
    seedOrder("ord_gen_token");

    const first = await post({
      orderId: "ord_gen_token",
      resolution: "retry",
      idempotencyToken: "dec-abc-1",
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ pushed: true, idempotencyToken: "dec-abc-1" });
    expect(posCalls()).toBe(1);

    // Same token (the client's own retry of the same decision): no second KOT,
    // even though the POS accepted id-lessly again.
    const sameToken = await post({
      orderId: "ord_gen_token",
      resolution: "retry",
      idempotencyToken: "dec-abc-1",
    });
    expect(sameToken.status).toBe(200);
    expect(await sameToken.json()).toMatchObject({ pushed: false, reused: true });
    expect(posCalls()).toBe(1);

    // A DIFFERENT token does NOT buy a second KOT for an acceptance the first
    // decision already covered — the generation, not the token, is the truth.
    // (Otherwise a client minting a fresh token per tap would defeat the guard.)
    const otherToken = await post({
      orderId: "ord_gen_token",
      resolution: "retry",
      idempotencyToken: "dec-abc-2",
    });
    expect(otherToken.status).toBe(200);
    expect(await otherToken.json()).toMatchObject({ pushed: false, reused: true });
    expect(posCalls()).toBe(1);
  });

  it("a NEW acceptance produced after an unrelated push is resolvable once", async () => {
    seedOrder("ord_gen_new_acceptance");

    // Decision 1 covers acceptance #1.
    const first = await post({ orderId: "ord_gen_new_acceptance", resolution: "retry" });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ pushed: true });
    expect(posCalls()).toBe(1);

    // Simulate a DIFFERENT, later failure path that lands its own acceptance
    // (e.g. the retry worker pushed and the POS again omitted the id). That is
    // acceptance #2 — a genuinely new state, so exactly one more decision may
    // resolve it.
    h.savedDocs["orders/ord_gen_new_acceptance"].petpoojaAcceptanceGeneration = 2;
    h.savedDocs["orders/ord_gen_new_acceptance"].petpoojaAcceptedNoId = true;
    h.savedDocs["orders/ord_gen_new_acceptance"].petpoojaStatus = "accepted_unconfirmed";

    const second = await post({ orderId: "ord_gen_new_acceptance", resolution: "retry" });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ pushed: true, reused: false });
    expect(posCalls()).toBe(2);

    // ...and only once: repeating THAT decision sends nothing.
    const repeat = await post({ orderId: "ord_gen_new_acceptance", resolution: "retry" });
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toMatchObject({ pushed: false, reused: true });
    expect(posCalls()).toBe(2);
  });

  it("after a proven rejection the recorded decision keeps covering the worker's single push", async () => {
    seedOrder("ord_gen_new_failure");
    // An ambiguous POST that never produced an acceptance: nothing is bound, so
    // `retry` hands the single deliberate push to the worker lane.
    Object.assign(h.savedDocs["orders/ord_gen_new_failure"], {
      petpoojaStatus: "reconciliation_required",
      petpoojaSyncStatus: "reconciliation_required",
      petpoojaAmbiguousProcessing: true,
      petpoojaAcceptedNoId: false,
      petpoojaAcceptedNoIdAck: null,
      kotSyncFailed: true,
    });
    delete h.savedDocs["orders/ord_gen_new_failure"].petpoojaAcceptedNoIdAt;

    // First staff decision: no acceptance on the order, so the one deliberate
    // push is handed to the worker lane (this call sends nothing inline).
    const first = await post({ orderId: "ord_gen_new_failure", resolution: "retry" });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ pushed: false, resolved: "retry" });
    expect(posCalls()).toBe(0);

    // The worker's push reaches the POS and is PROVEN rejected: nothing printed.
    nextPos = "rejected_hard";
    const { pushOrderToPetpooja } = await import("../src/modules/petpooja/orderPush");
    expect(await pushOrderToPetpooja("ord_gen_new_failure")).toBe(false);
    expect(posCalls()).toBe(1);

    const afterFailure = h.savedDocs["orders/ord_gen_new_failure"];
    // Nothing was accepted, so nothing is bound: the order is parked retryable
    // with defined numbers only (never `undefined`).
    expect(afterFailure.petpoojaAcceptedNoId).not.toBe(true);
    expect(afterFailure.petpoojaStatus).toBe("pending_retry");
    expect(afterFailure.petpoojaResolvedGeneration).toBe(afterFailure.petpoojaAcceptanceGeneration);
    // The decision is still entitled to its ONE push.
    expect(afterFailure.petpoojaRetryCoversNextAcceptance).toBe(true);

    // A blind repeat of the SAME decision does not send again — the worker still
    // owns the single authorised push.
    nextPos = "accepted_no_id";
    const repeat = await post({ orderId: "ord_gen_new_failure", resolution: "retry" });
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toMatchObject({ pushed: false, reused: true });
    expect(posCalls()).toBe(1);

    // The worker's retry lands the ticket id-lessly, and its acceptance belongs
    // to the recorded decision (covered) — one printed ticket, total.
    expect(await pushOrderToPetpooja("ord_gen_new_failure")).toBe(true);
    expect(posCalls()).toBe(2);
    const afterWorker = h.savedDocs["orders/ord_gen_new_failure"];
    expect(afterWorker.petpoojaStatus).toBe("accepted_unconfirmed");
    expect(afterWorker.petpoojaResolvedGeneration).toBe(afterWorker.petpoojaAcceptanceGeneration);
    expect(afterWorker.petpoojaRetryCoversNextAcceptance).toBe(false);

    // Still covered afterwards: another identical press prints nothing.
    const again = await post({ orderId: "ord_gen_new_failure", resolution: "retry" });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ pushed: false, reused: true });
    expect(posCalls()).toBe(2);
  });

  it("a transport-ambiguous failure parks for reconciliation and its resolution still sends only once", async () => {
    seedOrder("ord_gen_ambiguous");

    // ECONNRESET: the request may have landed. The order parks
    // reconciliation_required (never auto-retried) with no acceptance marker.
    nextPos = "transport_error";
    const first = await post({ orderId: "ord_gen_ambiguous", resolution: "retry" });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ pushed: false });
    expect(posCalls()).toBe(1);
    expect(h.savedDocs["orders/ord_gen_ambiguous"].petpoojaStatus).toBe("reconciliation_required");

    // The human checks the outlet, says it did NOT print, and the one
    // deliberate push lands id-lessly (via the worker's own entry point).
    nextPos = "accepted_no_id";
    const second = await post({ orderId: "ord_gen_ambiguous", resolution: "retry" });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ pushed: false, resolved: "retry" });

    const { pushOrderToPetpooja } = await import("../src/modules/petpooja/orderPush");
    expect(await pushOrderToPetpooja("ord_gen_ambiguous")).toBe(true);
    expect(posCalls()).toBe(2);

    // The worker's id-less acceptance BELONGS to that decision: it is covered,
    // so a dropped response plus an identical client retry does not reprint.
    const afterWorker = h.savedDocs["orders/ord_gen_ambiguous"];
    expect(afterWorker.petpoojaStatus).toBe("accepted_unconfirmed");
    expect(afterWorker.petpoojaResolvedGeneration).toBe(afterWorker.petpoojaAcceptanceGeneration);
    expect(afterWorker.petpoojaRetryCoversNextAcceptance).toBe(false);

    const repeat = await post({ orderId: "ord_gen_ambiguous", resolution: "retry" });
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toMatchObject({ pushed: false, reused: true });
    expect(posCalls()).toBe(2);
  });

  it("an acceptance whose bookkeeping write failed (F3) is bound and never reprinted", async () => {
    // A fresh order with NO acceptance yet: the push below is the first one.
    seedOrder("ord_gen_f3");
    const orderDoc = h.savedDocs["orders/ord_gen_f3"];
    delete orderDoc.petpoojaStatus;
    delete orderDoc.petpoojaSyncStatus;
    delete orderDoc.petpoojaAcceptedNoId;
    delete orderDoc.petpoojaAcceptedNoIdAt;
    delete orderDoc.petpoojaAcceptedNoIdAck;
    delete orderDoc.kotPushedAt;

    // The POS accepts id-lessly, and recording the acceptance itself fails once
    // (the F3 shape). That park is still a real POS acceptance.
    h.hooks.failNextAcceptanceWrite = true;
    const { pushOrderToPetpooja } = await import("../src/modules/petpooja/orderPush");
    expect(await pushOrderToPetpooja("ord_gen_f3").catch(() => false)).toBe(false);
    expect(h.hooks.failNextAcceptanceWrite).toBe(false);

    const doc = h.savedDocs["orders/ord_gen_f3"];
    expect(doc.petpoojaStatus).toBe("reconciliation_required");
    expect(doc.petpoojaAcceptedUnrecorded).toBe(true);
    // The parked ack is an acceptance generation like any other.
    expect(typeof doc.petpoojaAcceptanceGeneration).toBe("number");
    expect(doc.petpoojaAcceptanceGeneration).toBeGreaterThan(0);

    // `printed` on that park is a no-op on the POS, and the acceptance dedupe
    // is kept (the ticket exists).
    const res = await post({ orderId: "ord_gen_f3", resolution: "printed" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ resolved: "printed" });
    expect(posCalls()).toBe(1);
    expect(h.savedDocs["orders/ord_gen_f3"].petpoojaStatus).toBe("synced");
  });

  it("printed is unaffected and still never sends a KOT", async () => {
    seedOrder("ord_gen_printed");

    const res = await post({ orderId: "ord_gen_printed", resolution: "printed" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ resolved: "printed" });
    expect(posCalls()).toBe(0);

    const doc = h.savedDocs["orders/ord_gen_printed"];
    expect(doc.petpoojaStatus).toBe("synced");
    expect(doc.kotPrinted).toBe(true);
    expect(doc.petpoojaAcceptedNoId).toBe(true);

    const replay = await post({ orderId: "ord_gen_printed", resolution: "printed" }).catch(
      (err) => err
    );
    expect(replay.status).toBe(200);
    expect(posCalls()).toBe(0);
  });
});
