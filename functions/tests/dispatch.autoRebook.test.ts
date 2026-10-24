import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";

// Porter is retired (opt-in). This suite exercises Porter booking, so it
// declares the capability explicitly; hoisted so config sees it at import time.
vi.hoisted(() => {
  process.env.PORTER_ENABLED = "true";
});

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
    customerPhone: "+91 99999 88888",
    customerName: "Aarav Shah",
    status: "ready",
  });
  const mergeSet = (colName: string, docId: string, data: any) => {
    savedDocs[`${colName}/${docId}`] = {
      ...(savedDocs[`${colName}/${docId}`] || {}),
      ...data,
    };
  };
  const readDoc: any = (colName: string, docId: string) => ({
    exists: true,
    id: docId,
    data: () => savedDocs[`${colName}/${docId}`] || defaultOrder(),
    ref: {
      get: vi.fn(async () => readDoc(colName, docId)),
      set: vi.fn(async (data: any) => mergeSet(colName, docId, data)),
    },
  });
  // Working where().limit().get() so the auto-rebook scan actually sees the
  // seeded orders (the dispatch.router rig returns an empty query result).
  const mockDb: any = {
    collection: (colName: string) => ({
      doc: (docId: string) => ({
        id: docId,
        set: vi.fn(async (data: any) => mergeSet(colName, docId, data)),
        get: vi.fn(async () => readDoc(colName, docId)),
      }),
      where: (field: string, _op: string, val: any) => ({
        limit: (n: number) => ({
          get: async () => {
            const docs = Object.keys(savedDocs)
              .filter((k) => k.startsWith(`${colName}/`))
              .map((k) => ({ id: k.slice(colName.length + 1) }))
              .filter((d) => savedDocs[`${colName}/${d.id}`]?.[field] === val)
              .slice(0, n)
              .map((d) => ({
                id: d.id,
                data: () => savedDocs[`${colName}/${d.id}`],
                ref: readDoc(colName, d.id).ref,
              }));
            return { empty: docs.length === 0, docs };
          },
        }),
      }),
    }),
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

import {
  autoRebookDispatchWorker,
  dispatchRebook,
  AUTO_REBOOK_MAX_ATTEMPTS,
} from "../src/modules/dispatch/dispatch.router";
import { rebookPorterRider } from "../src/modules/porter/porter.service";
import { config } from "../src/config/env";

const originalFetch = globalThis.fetch;
let fetchCalls: Array<{ url: string; init: any }> = [];

let saved: any = {};

beforeAll(() => {
  globalThis.fetch = vi.fn(async (url: any, init: any) => {
    fetchCalls.push({ url: String(url), init });
    return new Response(JSON.stringify({ message: "no fetch handler registered" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }) as any;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function seedOrder(id: string, extra: Record<string, any> = {}) {
  savedDocs[`orders/${id}`] = { ...defaultOrder(), ...extra };
}

function docOf(id: string): any {
  return savedDocs[`orders/${id}`];
}

beforeEach(() => {
  saved = {
    borzo: { ...config.borzo },
    shadowfax: { ...config.shadowfax },
    porter: { ...config.porter },
    mock: { ...config.mock },
  };
  config.borzo.enabled = true;
  config.borzo.apiKey = "";
  config.borzo.customerId = "";
  config.shadowfax.enabled = true;
  config.shadowfax.apiKey = "";
  config.shadowfax.clientCode = "";
  config.porter.enabled = true;
  config.porter.apiKey = "";
  config.porter.customerId = "";
  config.mock.borzoDispatch = true;
  config.mock.shadowfaxDispatch = true;
  config.mock.porterDispatch = false;

  for (const k of Object.keys(savedDocs)) delete savedDocs[k];
  fetchCalls = [];
});

afterEach(() => {
  config.borzo = { ...saved.borzo };
  config.shadowfax = { ...saved.shadowfax };
  config.porter = { ...saved.porter };
  config.mock = { ...saved.mock };
});

describe("autoRebookDispatchWorker (starvation/livelock fixes)", () => {
  it("clears the flag on a staff-cancelled order so it leaves the scan window", async () => {
    seedOrder("ord_staff", {
      needsRebook: true,
      rebookTrigger: "staff_cancelled",
      deliveryStatus: "rider_cancelled",
    });

    const res = await autoRebookDispatchWorker();

    expect(res).toMatchObject({ scanned: 1, skipped: 1, rebooked: 0, failed: 0 });
    expect(docOf("ord_staff").needsRebook).toBe(false);
    // Nothing was dispatched for a staff-owned cancel.
    expect(docOf("ord_staff").deliveryStatus).toBe("rider_cancelled");
    expect(fetchCalls).toHaveLength(0);
  });

  it("clears the flag on a legacy no-trigger row (never auto-rebooked)", async () => {
    seedOrder("ord_legacy", { needsRebook: true, deliveryStatus: "rider_cancelled" });

    const res = await autoRebookDispatchWorker();

    expect(res).toMatchObject({ scanned: 1, skipped: 1, rebooked: 0 });
    expect(docOf("ord_legacy").needsRebook).toBe(false);
  });

  it("clears the flag on a terminal order and never pays for a rider", async () => {
    seedOrder("ord_done", {
      needsRebook: true,
      rebookTrigger: "carrier_cancelled",
      deliveryStatus: "delivered",
    });

    const res = await autoRebookDispatchWorker();

    expect(res).toMatchObject({ scanned: 1, skipped: 1, rebooked: 0 });
    expect(docOf("ord_done").needsRebook).toBe(false);
    expect(docOf("ord_done").deliveryStatus).toBe("delivered");
  });

  it("clears the flag (with an exhaustion stamp) when attempts are already spent", async () => {
    seedOrder("ord_spent", {
      needsRebook: true,
      rebookTrigger: "dispatch_failed",
      dispatchStatus: "dispatch_failed",
      autoRebookAttempts: AUTO_REBOOK_MAX_ATTEMPTS,
    });

    const res = await autoRebookDispatchWorker();

    expect(res).toMatchObject({ scanned: 1, exhausted: 1, rebooked: 0, failed: 0 });
    const doc = docOf("ord_spent");
    expect(doc.needsRebook).toBe(false);
    expect(doc.autoRebookExhaustedAt).toBe("MOCK_TIMESTAMP");
  });

  it("auto-rebooks a carrier-cancelled order and clears the flag on success", async () => {
    config.porter.enabled = false;
    seedOrder("ord_carrier", {
      needsRebook: true,
      rebookTrigger: "carrier_cancelled",
      deliveryStatus: "rider_cancelled",
    });

    const res = await autoRebookDispatchWorker();

    expect(res).toMatchObject({ scanned: 1, rebooked: 1, skipped: 0, failed: 0 });
    const doc = docOf("ord_carrier");
    expect(doc.deliveryStatus).toBe("dispatched");
    expect(doc.needsRebook).toBe(false);
    expect(doc.rebookTrigger).toBeNull();
  });

  it("never re-books the carrier that cancelled the dispatch (DR6 exclusion)", async () => {
    config.porter.enabled = false;
    // Borzo owns the cancelled dispatch AND is the cheapest mock quote
    // (38 + 9d vs shadowfax 42 + 10d), so without the exclusion the worker would
    // re-book the same carrier and cancel-loop forever.
    seedOrder("ord_excl", {
      needsRebook: true,
      rebookTrigger: "carrier_cancelled",
      deliveryStatus: "rider_cancelled",
      // A real carrier cancel leaves the live booking's status/binding in
      // place; the rebook flag is what marks it replaceable.
      dispatchStatus: "dispatched",
      dispatchProvider: "borzo",
      borzoOrderId: "BZ-CANCELLED-1",
      dispatchOrderId: "BZ-CANCELLED-1",
    });

    const res = await autoRebookDispatchWorker();

    expect(res).toMatchObject({ scanned: 1, rebooked: 1, failed: 0 });
    const doc = docOf("ord_excl");
    expect(doc.deliveryStatus).toBe("dispatched");
    // The NEXT provider booked; the cancelling carrier was skipped entirely.
    expect(doc.dispatchProvider).toBe("shadowfax");
    expect(doc.delivery.provider).toBe("shadowfax");
    // The cancelled carrier's identifiers do not carry into the new dispatch.
    expect(doc.borzoOrderId).toBeNull();
    expect(doc.dispatchOrderId).not.toBe("BZ-CANCELLED-1");
  });

  it("keeps the flag for a mid-budget failed attempt (retry still pending)", async () => {
    config.porter.enabled = false;
    config.mock.borzoDispatch = false;
    config.mock.shadowfaxDispatch = false;
    seedOrder("ord_mid", {
      needsRebook: true,
      rebookTrigger: "dispatch_failed",
      autoRebookAttempts: 0,
    });

    const res = await autoRebookDispatchWorker();

    expect(res).toMatchObject({ scanned: 1, failed: 1, exhausted: 0 });
    const doc = docOf("ord_mid");
    expect(doc.autoRebookAttempts).toBe(1);
    expect(doc.needsRebook).toBe(true); // releaseClaimFailed re-armed it
    expect(doc.autoRebookExhaustedAt).toBeUndefined();
  });

  it("clears the flag when the final budgeted attempt fails (poison order retires)", async () => {
    config.porter.enabled = false;
    config.mock.borzoDispatch = false;
    config.mock.shadowfaxDispatch = false;
    seedOrder("ord_poison", {
      needsRebook: true,
      rebookTrigger: "dispatch_failed",
      autoRebookAttempts: AUTO_REBOOK_MAX_ATTEMPTS - 1,
    });

    const res = await autoRebookDispatchWorker();

    expect(res).toMatchObject({ scanned: 1, failed: 1, exhausted: 1 });
    const doc = docOf("ord_poison");
    expect(doc.autoRebookAttempts).toBe(AUTO_REBOOK_MAX_ATTEMPTS);
    expect(doc.needsRebook).toBe(false);
    expect(doc.autoRebookExhaustedAt).toBe("MOCK_TIMESTAMP");
    // A second run no longer sees it at all — the window has drained.
    const again = await autoRebookDispatchWorker();
    expect(again).toMatchObject({ scanned: 0 });
  });
});

describe("manual rebook stays open after the worker clears the flag", () => {
  it("dispatchRebook opens an exhausted dispatch_failed order (no needsRebook flag)", async () => {
    config.porter.enabled = false;
    seedOrder("ord_exhausted", {
      needsRebook: false,
      dispatchStatus: "dispatch_failed",
      autoRebookExhaustedAt: "MOCK_TIMESTAMP",
    });

    const res = await dispatchRebook({ orderId: "ord_exhausted", staffName: "Ops" });

    expect(res.provider).toBe("borzo");
    expect(res.status).toBe("dispatched");
    expect(docOf("ord_exhausted").deliveryStatus).toBe("dispatched");
  });

  it("rebookPorterRider parity: dispatch_failed status alone passes the guard", async () => {
    // Guard-pass check: with porter unkeyed/unmocked, booking itself fails —
    // what matters is the error is NOT NOT_REBOOKABLE (the guard opened).
    config.mock.porterDispatch = false;
    seedOrder("ord_p_exhausted", {
      needsRebook: false,
      dispatchStatus: "dispatch_failed",
    });

    const err: any = await rebookPorterRider("ord_p_exhausted", "Store Manager").then(
      () => null,
      (e) => e
    );
    expect(err?.code).not.toBe("NOT_REBOOKABLE");
  });
});

describe("dispatchBook manual lane (DR8) clears auto-rebook ownership", () => {
  it("manual_pending write clears needsRebook/rebookTrigger (paste lane owns it)", async () => {
    config.borzo.enabled = false;
    config.shadowfax.enabled = false;
    seedOrder("ord_manual_rb", {
      needsRebook: true,
      rebookTrigger: "carrier_cancelled",
    });

    const res = await dispatchRebook({ orderId: "ord_manual_rb", staffName: "Ops" });

    expect(res.manual_action_required).toBe(true);
    const doc = docOf("ord_manual_rb");
    expect(doc.dispatchStatus).toBe("manual_pending");
    expect(doc.needsRebook).toBe(false);
    expect(doc.rebookTrigger).toBeNull();
  });
});
