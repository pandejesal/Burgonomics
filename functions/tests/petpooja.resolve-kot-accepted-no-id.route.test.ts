import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";

/**
 * P1-K follow-up — an `accepted_unconfirmed` KOT must be resolvable by staff.
 *
 * The defect (review of 3985a2b): when Petpooja accepts a KOT but returns an
 * empty `orderID` (the SANDBOX's normal answer), `pushOrderToPetpooja` records
 * `petpoojaAcceptedNoId: true` + `accepted_unconfirmed` and dedupes. That dedupe
 * is absolute: every later push short-circuits, and `resolvePetpoojaKotAmbiguity`
 * did not admit `accepted_unconfirmed` as a parked state, so /petpooja/resolveKot
 * refused with "not parked". Paid, unprinted food had no way out.
 *
 * Contract pinned here, driven through the REAL Express app and REAL routes:
 *   - `accepted_unconfirmed` IS admitted to POST /petpooja/resolveKot;
 *   - `printed` keeps the dedupe (mark done, never POST again);
 *   - `retry` clears the acceptance dedupe transactionally ONLY on that explicit
 *     staff statement, then sends EXACTLY ONE fresh push;
 *   - a double press still sends exactly one KOT (no duplicate food);
 *   - the resolution is audited with who and when.
 */

vi.hoisted(() => {
  process.env.BURGONOMICS_ENV = "dev";
  process.env.APP_CHECK_ENFORCEMENT = "";
});

const h = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const verifyIdToken = vi.fn(async (token: string) => {
    if (token !== "staff-token") throw new Error("invalid token");
    return {
      uid: "staff_kot_1",
      role: "branch_staff",
      branchIds: ["branch_kot_1"],
      email: "ops.kot@burgonomics.test",
    };
  });

  const mergeSet = (path: string, data: any, merge: boolean | undefined) => {
    savedDocs[path] = merge && savedDocs[path] ? { ...savedDocs[path], ...data } : { ...data };
  };

  const docRef = (colName: string, docId: string): any => {
    const path = `${colName}/${docId}`;
    const ref: any = {
      id: docId,
      path,
      get: async () => ({
        exists: Object.prototype.hasOwnProperty.call(savedDocs, path),
        id: docId,
        data: () => savedDocs[path],
        ref,
      }),
      set: async (data: any, opts?: any) => mergeSet(path, data, opts?.merge),
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
    runTransaction: async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
        update: (ref: any, data: any) => ref.update(data),
      }),
  };

  return { savedDocs, verifyIdToken, mockDb };
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

const BRANCH = "branch_kot_1";

let server: Server;
let baseUrl: string;
let posFetch: any;
let posMode: "accepted_no_id" | "accepted_with_id" = "accepted_no_id";

const posCalls = () =>
  posFetch.mock.calls.filter((call: any[]) => String(call[0]).includes("save_order")).length;

function seedBranch() {
  h.savedDocs[`branches/${BRANCH}`] = {
    name: "KOT Outlet",
    petpoojaStoreId: "res_kot_1",
    petpoojaTaxes: [
      { id: "3928", name: "CGST", rate: 2.5 },
      { id: "3929", name: "SGST", rate: 2.5 },
    ],
  };
  h.savedDocs["products/prod_kot_1"] = {
    id: "prod_kot_1",
    branchId: BRANCH,
    name: "Resolve Burger",
    price: 199,
    inStock: true,
    petpoojaItemId: "7765862",
  };
}

function seedAcceptedNoId(orderId: string) {
  h.savedDocs[`orders/${orderId}`] = {
    id: orderId,
    branchId: BRANCH,
    customerId: "cust_kot_1",
    userId: "cust_kot_1",
    fulfillment: "takeaway",
    paymentMethod: "cod",
    paymentStatus: "completed",
    customerName: "KOT Customer",
    customerPhone: "+919825000111",
    items: [
      {
        id: "l1",
        productId: "prod_kot_1",
        name: "Resolve Burger",
        price: 199,
        quantity: 1,
      },
    ],
    pricing: { grandTotal: 199, gst: 9.48 },
    status: "accepted",
    // The sandbox's normal shape: the relay accepted the payload, no orderID.
    petpoojaStatus: "accepted_unconfirmed",
    petpoojaSyncStatus: "accepted_unconfirmed",
    petpoojaAcceptedNoId: true,
    petpoojaAcceptedNoIdAt: "EARLIER_TIMESTAMP",
    petpoojaAcceptedNoIdAck: '{"success":"1","orderID":""}',
    kotPushedAt: "EARLIER_TIMESTAMP",
  };
}

function post(path: string, body: Record<string, any>) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer staff-token" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  const prevMock = config.mock.petpoojaPos;
  config.mock.petpoojaPos = false; // live path; the POS POST itself is stubbed

  const realFetch = globalThis.fetch;
  posFetch = vi.fn(async (url: any, init?: any) => {
    const target = String(url);
    if (target.startsWith("http://127.0.0.1:")) return realFetch(url, init);
    if (!target.includes("save_order")) {
      throw new Error(`unexpected provider call in this suite: ${target}`);
    }
    const body =
      posMode === "accepted_with_id"
        ? {
            success: "1",
            message: "Your order is saved.",
            restID: "res_kot_1",
            orderID: "pp_resolved_1",
          }
        : {
            success: "1",
            message: "Your order is saved.",
            restID: "res_kot_1",
            clientOrderID: "whatever",
            orderID: "",
            code: 200,
          };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", posFetch);

  server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  (globalThis as any).__restoreKotConfig = () => {
    config.mock.petpoojaPos = prevMock;
  };
});

afterAll(async () => {
  vi.unstubAllGlobals();
  (globalThis as any).__restoreKotConfig?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  for (const key of Object.keys(h.savedDocs)) delete h.savedDocs[key];
  h.verifyIdToken.mockClear();
  posFetch.mockClear();
  posMode = "accepted_no_id";
  seedBranch();
});

describe("POST /petpooja/resolveKot admits accepted_unconfirmed", () => {
  it("without a resolve path the paid order is stuck: a plain push dedupes and no KOT is sent", async () => {
    seedAcceptedNoId("ord_stuck");
    // Baseline evidence of the defect: the ordinary staff "retry" (pushOrder)
    // is deduped by the acceptance marker — nothing reaches the POS.
    const pushRes = await post("/petpooja/pushOrder", { orderId: "ord_stuck" });
    expect(pushRes.status).toBe(200);
    expect(await pushRes.json()).toEqual({ success: true });
    expect(posCalls()).toBe(0);
    expect(h.savedDocs["orders/ord_stuck"].petpoojaStatus).toBe("accepted_unconfirmed");

    // And the reconciliation route refused it entirely before the fix.
    const blockedRes = await post("/petpooja/resolveKot", {
      orderId: "ord_stuck",
      resolution: "retry",
    });
    expect(blockedRes.status).toBe(200);
    const blocked: any = await blockedRes.json();
    expect(blocked).toMatchObject({ resolved: "retry", orderId: "ord_stuck", pushed: true });
  });

  it("staff confirm the print: the order becomes synced, deduped, and no KOT is re-sent", async () => {
    seedAcceptedNoId("ord_printed");

    const res = await post("/petpooja/resolveKot", {
      orderId: "ord_printed",
      resolution: "printed",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ resolved: "printed", orderId: "ord_printed" });

    const doc = h.savedDocs["orders/ord_printed"];
    expect(doc.petpoojaStatus).toBe("synced");
    expect(doc.petpoojaSyncStatus).toBe("synced");
    expect(doc.kotPrinted).toBe(true);
    expect(doc.kotPrintedSource).toBe("staff_confirmed");
    expect(doc.petpoojaResolvedBy).toBe("staff_kot_1");
    expect(doc.petpoojaResolvedAt).toBe("MOCK_TIMESTAMP");
    // `printed` keeps the acceptance dedupe: the ticket EXISTS at the POS.
    expect(doc.petpoojaAcceptedNoId).toBe(true);

    const replay = await post("/petpooja/pushOrder", { orderId: "ord_printed" });
    expect(replay.status).toBe(200);
    expect(posCalls()).toBe(0);
  });

  it("staff confirm the kitchen did NOT print: dedupe cleared, exactly one fresh push, audited", async () => {
    seedAcceptedNoId("ord_retry");
    posMode = "accepted_with_id";

    const res = await post("/petpooja/resolveKot", {
      orderId: "ord_retry",
      resolution: "retry",
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body).toMatchObject({ resolved: "retry", orderId: "ord_retry", pushed: true });

    expect(posCalls()).toBe(1);
    const doc = h.savedDocs["orders/ord_retry"];
    expect(doc.petpoojaOrderId).toBe("pp_resolved_1");
    expect(doc.petpoojaStatus).toBe("synced");
    // The acceptance dedupe is gone; the fresh POS id is the new dedupe.
    expect(doc.petpoojaAcceptedNoId).toBe(false);
    // Audited with WHO and WHEN, and with the explicit not-printed statement.
    expect(doc.petpoojaResolvedBy).toBe("staff_kot_1");
    expect(doc.petpoojaResolvedAt).toBe("MOCK_TIMESTAMP");
    expect(doc.petpoojaResolution).toBe("retry");
    expect(doc.petpoojaKotNotPrintedConfirmedBy).toBe("staff_kot_1");
    expect(doc.petpoojaKotNotPrintedConfirmedAt).toBe("MOCK_TIMESTAMP");
  });

  it("a double press of retry still sends exactly one KOT", async () => {
    seedAcceptedNoId("ord_double");
    posMode = "accepted_with_id";

    const [first, second] = await Promise.all([
      post("/petpooja/resolveKot", { orderId: "ord_double", resolution: "retry" }),
      post("/petpooja/resolveKot", { orderId: "ord_double", resolution: "retry" }),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const bodies = [await first.json(), await second.json()];
    // Exactly one caller is the one that pushed; the other is a no-op replay.
    expect(bodies.filter((b: any) => b.pushed === true)).toHaveLength(1);
    expect(posCalls()).toBe(1);
    expect(h.savedDocs["orders/ord_double"].petpoojaOrderId).toBe("pp_resolved_1");

    // A later press is an idempotent replay of the same resolution: it reports
    // the recorded outcome and still sends nothing (never a second ticket).
    const third = await post("/petpooja/resolveKot", {
      orderId: "ord_double",
      resolution: "retry",
    });
    expect(third.status).toBe(200);
    expect(await third.json()).toMatchObject({
      resolved: "retry",
      orderId: "ord_double",
      reused: true,
      pushed: false,
    });
    expect(posCalls()).toBe(1);

    // A CONFLICTING resolution on a settled order is refused, not silently
    // reinterpreted.
    const conflicting = await post("/petpooja/resolveKot", {
      orderId: "ord_double",
      resolution: "printed",
    });
    expect(conflicting.status).toBe(409);
    expect(posCalls()).toBe(1);
  });
});
