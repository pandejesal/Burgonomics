/**
 * Petpooja send-outcome truth — "never retried automatically".
 *
 * The only failures that may be retried by the worker are those POSITIVELY
 * proven pre-send. Anything that may have crossed the wire (timeout, any
 * non-2xx including 429, unreadable/unknown 2xx, ACK received but not
 * persisted) must park for manual reconciliation and produce ZERO further
 * POSTs — a duplicate KOT rings the kitchen twice and cannot be undone.
 *
 * Hermetic: mocked Firestore (strict transaction semantics) + mocked fetch +
 * fake timers. No network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockDb, savedDocs, writeFault, hooks } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};

  // Deterministic write failure injection. `match` decides which writes fail;
  // `remaining` allows "every fallback write fails" scenarios.
  const writeFault: {
    path: string | null;
    match: ((data: any) => boolean) | null;
    remaining: number;
  } = { path: null, match: null, remaining: 0 };

  const hooks: {
    afterQueryRead: (() => void) | null;
    afterDocGet: (() => void) | null;
  } = { afterQueryRead: null, afterDocGet: null };

  const clone = (value: any) =>
    value === undefined ? undefined : JSON.parse(JSON.stringify(value));

  const commitWrite = (path: string, data: any, opts?: any) => {
    if (
      writeFault.path === path &&
      writeFault.remaining > 0 &&
      (!writeFault.match || writeFault.match(data))
    ) {
      writeFault.remaining--;
      throw new Error("Firestore write unavailable (simulated)");
    }
    savedDocs[path] =
      opts?.merge && savedDocs[path] ? { ...savedDocs[path], ...data } : { ...data };
  };

  const docRef = (col: string, id: string) => {
    const path = `${col}/${id}`;
    return {
      id,
      path,
      get: vi.fn(async () => {
        const exists = Object.prototype.hasOwnProperty.call(savedDocs, path);
        // Freeze the read. A later mutation (concurrent attempt) must not
        // leak into a snapshot already handed to a caller.
        const frozen = clone(savedDocs[path]);
        const snapshot = {
          exists,
          data: () => clone(frozen),
          ref: docRef(col, id),
        };
        const hook = hooks.afterDocGet;
        hooks.afterDocGet = null;
        if (hook) hook();
        return snapshot;
      }),
      set: vi.fn(async (data: any, opts?: any) => commitWrite(path, data, opts)),
    };
  };

  const runQuery = (
    col: string,
    filters: Array<{ field: string; value: any }>,
    sortField?: string,
    limitCount?: number
  ) => ({
    where: (field: string, _op: string, value: any) =>
      runQuery(col, [...filters, { field, value }], sortField, limitCount),
    orderBy: (field: string) => runQuery(col, filters, field, limitCount),
    limit: (n: number) => runQuery(col, filters, sortField, n),
    get: async () => {
      let matched = Object.entries(savedDocs)
        .filter(([p]) => p.startsWith(`${col}/`))
        .map(([p, data]) => {
          const id = p.slice(col.length + 1);
          // Snapshot semantics: a doc read here is a point-in-time copy, so a
          // test can mutate the live store to simulate a concurrent writer
          // landing between the query and the worker's fresh transaction.
          return { id, ref: docRef(col, id), data: () => clone(data) };
        })
        .filter((doc) => filters.every((f) => doc.data()[f.field] === f.value));
      if (sortField) {
        matched = matched.sort(
          (a, b) => (a.data()[sortField] || 0) - (b.data()[sortField] || 0)
        );
      }
      if (typeof limitCount === "number") matched = matched.slice(0, limitCount);
      const hook = hooks.afterQueryRead;
      hooks.afterQueryRead = null;
      if (hook) hook();
      return { docs: matched, empty: matched.length === 0 };
    },
  });

  const mockDb: any = {
    collection: (col: string) => ({
      doc: (id: string) => docRef(col, id),
      where: (field: string, op: string, value: any) =>
        runQuery(col, [{ field, value }]),
    }),
    // Strict Firestore semantics: every read must happen before any write in
    // one transaction. The old in-memory fake silently allowed read-after-
    // write, hiding a production-only failure for >= 2 claimed docs.
    runTransaction: vi.fn(async (fn: any) => {
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
          commitWrite(ref.path, data, opts);
          hasWritten = true;
        },
      });
    }),
  };

  return { mockDb, savedDocs, writeFault, hooks };
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

// Keep the fetch call log free of developer-alert traffic: these tests count
// exactly how many times the POS endpoint was POSTed.
vi.mock("../src/core/errors", () => ({
  captureErrorSnapshot: vi.fn(async () => "snap_test"),
}));

vi.mock("../src/modules/notifications/fcm.service", () => ({
  dispatchFCM: vi.fn(async () => undefined),
}));

import {
  pushOrderToPetpooja,
  RECONCILIATION_REQUIRED,
  SEND_INTENT_ACCEPTED,
  SEND_INTENT_PROVABLY_UNSENT,
  SEND_INTENT_REJECTED,
} from "../src/modules/petpooja/orderPush";
import { retryPendingPetpoojaOrdersWorker } from "../src/modules/petpooja/petpooja.scheduler";
import { dispatchFCM } from "../src/modules/notifications/fcm.service";
import { captureErrorSnapshot } from "../src/core/errors";
import { config } from "../src/config/env";

const BASE_TIME = 1_700_000_000_000;
const ORDER_PATH = "orders/ord_ambiguous_1";
const AMBIGUOUS_ORDER_PATH = "orders/ord_ambiguous_2";

describe("Petpooja send outcome — no automatic replay", () => {
  let prevMock: boolean;
  const fetchMock = vi.fn();

  /** POSTs that targeted the Petpooja save_order endpoint. */
  const posPostCount = () =>
    fetchMock.mock.calls.filter(([input]: any[]) =>
      String(input?.url ?? input).includes("save_order")
    ).length;

  const posTimeout = () =>
    Object.assign(new Error("The operation was aborted due to timeout"), {
      name: "TimeoutError",
    });

  const seedOrder = (path: string, overrides: Record<string, any> = {}) => {
    const id = path.slice("orders/".length);
    savedDocs[path] = {
      id,
      branchId: "branch_pos_1",
      customerName: "Ambiguity Test",
      customerPhone: "+919825000001",
      items: [{ id: "itm_1", name: "Smash Burger", price: 250, quantity: 1 }],
      pricing: { grandTotal: 250, gst: 12.5 },
      // Real order docs carry the tender at `payment.method` (COD is "cod").
      payment: { method: "razorpay" },
      status: "pending",
      createdAt: BASE_TIME - 60_000,
      ...overrides,
    };
  };

  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    writeFault.path = null;
    writeFault.match = null;
    writeFault.remaining = 0;
    hooks.afterQueryRead = null;
    hooks.afterDocGet = null;
    vi.mocked(dispatchFCM).mockClear();
    vi.mocked(captureErrorSnapshot).mockReset();
    vi.mocked(captureErrorSnapshot).mockImplementation(async () => "snap_test");

    prevMock = config.mock.petpoojaPos;
    config.mock.petpoojaPos = false; // live path; fetch is stubbed

    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);

    savedDocs["branches/branch_pos_1"] = {
      name: "POS Test Outlet",
      petpoojaStoreId: "res_pos_01",
      // Captured outlet tax rows (menu webhook writes these with provenance).
      petpoojaTaxes: [
        { id: "POS-CGST", name: "CGST", rate: 2.5 },
        { id: "POS-SGST", name: "SGST", rate: 2.5 },
      ],
      petpoojaTaxesRestId: "res_pos_01",
    };
    seedOrder(ORDER_PATH);
  });

  afterEach(() => {
    config.mock.petpoojaPos = prevMock;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("TIMEOUT + both ambiguity writes fail: durable intent blocks a caller after the claim TTL — exactly one POST", async () => {
    fetchMock.mockRejectedValueOnce(posTimeout());
    // The claim transaction's intent write must succeed; only the catch-path
    // outcome writes fail (transactional + fallback).
    writeFault.path = ORDER_PATH;
    writeFault.match = (data: any) => data?.petpoojaStatus === RECONCILIATION_REQUIRED;
    writeFault.remaining = 1; // the catch TX write; no raw fallback exists

    const pushed = await pushOrderToPetpooja("ord_ambiguous_1");
    expect(pushed).toBe(false);
    expect(posPostCount()).toBe(1);

    // Nothing but the claim-time intent survived — that is the whole point.
    const doc = savedDocs[ORDER_PATH];
    expect(doc.petpoojaUnresolvedIntent).toBe(true);
    expect(doc.petpoojaSendIntentState).toBe("in_flight");
    expect(typeof doc.petpoojaAttemptId).toBe("string");
    expect(doc.petpoojaOrderId).toBeUndefined();
    expect(doc.petpoojaAcceptedNoId).toBeUndefined();

    // Advance well past the old 10-minute takeover window, then a second
    // direct caller and scheduler ticks must all refuse to POST.
    vi.setSystemTime(BASE_TIME + 45 * 60 * 1000);
    const second = await pushOrderToPetpooja("ord_ambiguous_1");
    expect(second).toBe(false);
    await retryPendingPetpoojaOrdersWorker();
    await retryPendingPetpoojaOrdersWorker();
    expect(posPostCount()).toBe(1);
    expect(savedDocs[ORDER_PATH].petpoojaUnresolvedIntent).toBe(true);
  });

  it("ACK then acceptance + both ambiguity writes fail: durable intent blocks forever — exactly one POST", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: "1", message: "Your order is saved.", orderID: "PP-9999" }),
    });
    // Fail the acceptance write, then the transactional ambiguity write, then
    // the fallback ambiguity write.
    writeFault.path = ORDER_PATH;
    writeFault.match = (data: any) =>
      data?.petpoojaOrderId === "PP-9999" ||
      data?.petpoojaStatus === RECONCILIATION_REQUIRED;
    writeFault.remaining = 2; // acceptance write + catch TX write

    const pushed = await pushOrderToPetpooja("ord_ambiguous_1");
    expect(pushed).toBe(false);
    expect(posPostCount()).toBe(1);

    const doc = savedDocs[ORDER_PATH];
    expect(doc.petpoojaUnresolvedIntent).toBe(true);
    expect(doc.petpoojaAttemptId).toBeTruthy();
    expect(doc.petpoojaOrderId).toBeUndefined();

    vi.setSystemTime(BASE_TIME + 60 * 60 * 1000);
    const second = await pushOrderToPetpooja("ord_ambiguous_1");
    expect(second).toBe(false);
    await retryPendingPetpoojaOrdersWorker();
    expect(posPostCount()).toBe(1);
  });

  it("PRE-SEND config failure: 0 POSTs, bounded pending_retry, intent resolved as provably unsent", async () => {
    delete savedDocs["branches/branch_pos_1"].petpoojaStoreId;

    const pushed = await pushOrderToPetpooja("ord_ambiguous_1");
    expect(pushed).toBe(false);
    expect(posPostCount()).toBe(0);

    const doc = savedDocs[ORDER_PATH];
    expect(doc.petpoojaStatus).toBe("pending_retry");
    expect(doc.petpoojaSyncStatus).toBe("pending_retry");
    expect(doc.petpoojaRetryCount).toBe(1);
    expect(doc.petpoojaAmbiguousSend).toBeUndefined();
    expect(doc.petpoojaUnresolvedIntent).toBe(false);
    expect(doc.petpoojaSendIntentState).toBe(SEND_INTENT_PROVABLY_UNSENT);
    expect(doc.petpoojaPushClaimedAt).toBeNull();
  });

  it("COD with no server pricing: 0 POSTs, terminal failed — never pending_retry, never dead-lettered", async () => {
    // The cash the counter is told to collect cannot come from client totals.
    savedDocs[ORDER_PATH].payment = { method: "cod" };
    delete savedDocs[ORDER_PATH].pricing;
    savedDocs[ORDER_PATH].totals = { grandTotal: 250, taxGst: 12.5 };

    const pushed = await pushOrderToPetpooja("ord_ambiguous_1");
    expect(pushed).toBe(false);
    expect(posPostCount()).toBe(0);

    const doc = savedDocs[ORDER_PATH];
    expect(doc.petpoojaStatus).toBe("failed");
    expect(doc.petpoojaSyncStatus).toBe("failed");
    // Distinguishable from a transport failure / POS refusal.
    expect(doc.petpoojaPayloadInvalidCode).toBe("PETPOOJA_PRICING_MISSING_COD");
    // NOT in the retry lane: no retry counter, and no dead-letter candidate.
    expect(doc.petpoojaRetryCount).toBeUndefined();
    expect(doc.petpoojaUnresolvedIntent).toBe(false);
    expect(doc.petpoojaSendIntentState).toBe(SEND_INTENT_REJECTED);
    expect(doc.petpoojaPushClaimedAt).toBeNull();

    // The worker only sweeps pending_retry, so nothing is POSTed or dead-lettered.
    vi.setSystemTime(BASE_TIME + 60 * 60 * 1000);
    await retryPendingPetpoojaOrdersWorker();
    await retryPendingPetpoojaOrdersWorker();
    expect(posPostCount()).toBe(0);
    expect(savedDocs[ORDER_PATH].petpoojaStatus).toBe("failed");
  });

  it.each([
    ["empty object", {}],
    ["null", null],
    ["false", false],
    ["success:true (unsupported)", { success: true }],
    ["status:success only (unsupported)", { status: "success" }],
  ])("readable 2xx %s is AMBIGUOUS, never success or terminal rejection", async (_label, body) => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => body,
    });

    const pushed = await pushOrderToPetpooja("ord_ambiguous_1");
    expect(pushed).toBe(false);
    expect(posPostCount()).toBe(1);

    const doc = savedDocs[ORDER_PATH];
    expect(doc.petpoojaStatus).toBe(RECONCILIATION_REQUIRED);
    expect(doc.petpoojaAmbiguousSend).toBe(true);
    expect(doc.petpoojaUnresolvedIntent).toBe(true);
    expect(doc.petpoojaOrderId).toBeUndefined();
    expect(doc.petpoojaAcceptedNoId).toBeUndefined();

    vi.setSystemTime(BASE_TIME + 60 * 60 * 1000);
    await retryPendingPetpoojaOrdersWorker();
    expect(posPostCount()).toBe(1);
  });

  it("contradictory ack (success:0 + status:success) is AMBIGUOUS, not accepted and not terminal rejected", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: "0", status: "success", orderID: "PP-CONFLICT" }),
    });

    const pushed = await pushOrderToPetpooja("ord_ambiguous_1");
    expect(pushed).toBe(false);
    const doc = savedDocs[ORDER_PATH];
    expect(doc.petpoojaStatus).toBe(RECONCILIATION_REQUIRED);
    expect(doc.petpoojaAmbiguousSend).toBe(true);
    expect(doc.petpoojaOrderId).toBeUndefined();
    expect(doc.petpoojaUnresolvedIntent).toBe(true);
  });

  it("HTTP 429 after attempt is AMBIGUOUS — never safe pre-send, never automatically replayed", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      // Even a strict-looking refusal body must NOT make 429 definitive: the
      // status is not the documented 400 refusal and may be a proxy outcome.
      json: async () => ({ success: "0", message: "rate limited" }),
    });

    const pushed = await pushOrderToPetpooja("ord_ambiguous_1");
    expect(pushed).toBe(false);
    expect(posPostCount()).toBe(1);

    const doc = savedDocs[ORDER_PATH];
    expect(doc.petpoojaStatus).toBe(RECONCILIATION_REQUIRED);
    expect(doc.petpoojaStatus).not.toBe("pending_retry");
    expect(doc.petpoojaAmbiguousHttpStatus).toBe(429);
    expect(doc.petpoojaUnresolvedIntent).toBe(true);

    for (let tick = 1; tick <= 3; tick++) {
      vi.setSystemTime(BASE_TIME + tick * 5 * 60 * 1000);
      await retryPendingPetpoojaOrdersWorker();
    }
    expect(posPostCount()).toBe(1);
  });

  it("documented HTTP 400 + strict success:0 (SO_105) is a DEFINITIVE refusal → failed + resolved intent", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: async () => ({
        success: "0",
        message: "Invalid order relay payload",
        errorCode: "SO_105",
        validation_errors: { orderID: "required" },
      }),
    });

    const pushed = await pushOrderToPetpooja("ord_ambiguous_1");
    expect(pushed).toBe(false);
    expect(posPostCount()).toBe(1);

    const doc = savedDocs[ORDER_PATH];
    expect(doc.petpoojaStatus).toBe("failed");
    expect(doc.petpoojaSyncStatus).toBe("failed");
    expect(doc.petpoojaRejectedHttpStatus).toBe(400);
    expect(doc.petpoojaUnresolvedIntent).toBe(false);
    expect(doc.petpoojaSendIntentState).toBe("rejected");
    expect(doc.petpoojaAmbiguousSend).toBeUndefined();
    expect(String(doc.lastPetpoojaError)).toMatch(/Invalid order relay payload/);
  });

  it("HTTP 400 with malformed/unknown body stays AMBIGUOUS (not a documented refusal)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: async () => ({ message: "bad request", errorCode: "SO_105" }),
    });

    const pushed = await pushOrderToPetpooja("ord_ambiguous_1");
    expect(pushed).toBe(false);

    const doc = savedDocs[ORDER_PATH];
    expect(doc.petpoojaStatus).toBe(RECONCILIATION_REQUIRED);
    expect(doc.petpoojaAmbiguousSend).toBe(true);
    expect(doc.petpoojaUnresolvedIntent).toBe(true);
    expect(doc.petpoojaSendIntentState).toBe("ambiguous");
  });

  it("HTTP 400 success:0 with contradictory status:success stays AMBIGUOUS", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ success: "0", status: "success", message: "conflict" }),
    });

    const pushed = await pushOrderToPetpooja("ord_ambiguous_1");
    expect(pushed).toBe(false);
    expect(savedDocs[ORDER_PATH].petpoojaStatus).toBe(RECONCILIATION_REQUIRED);
    expect(savedDocs[ORDER_PATH].petpoojaUnresolvedIntent).toBe(true);
  });

  it("DEFINITIVE rejection: only explicit success:0 → terminal failed, resolved intent, no reconciliation state", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: "0", message: "Invalid order relay payload" }),
    });

    const pushed = await pushOrderToPetpooja("ord_ambiguous_1");
    expect(pushed).toBe(false);
    expect(posPostCount()).toBe(1);

    const doc = savedDocs[ORDER_PATH];
    expect(doc.petpoojaStatus).toBe("failed");
    expect(doc.petpoojaSyncStatus).toBe("failed");
    expect(doc.petpoojaAmbiguousSend).toBeUndefined();
    expect(doc.petpoojaStatus).not.toBe(RECONCILIATION_REQUIRED);
    expect(doc.petpoojaRejectedHttpStatus).toBe(200);
    expect(doc.petpoojaUnresolvedIntent).toBe(false);
    expect(doc.petpoojaSendIntentState).toBe("rejected");
    expect(doc.kotSyncFailed).toBe(true);
    expect(String(doc.lastPetpoojaError)).toMatch(/Invalid order relay payload/);

    vi.setSystemTime(BASE_TIME + 60 * 60 * 1000);
    await retryPendingPetpoojaOrdersWorker();
    expect(posPostCount()).toBe(1);
  });

  it("ACCEPTED-NO-ID: accepted truth preserved, no kotPrinted, deduped and never resent", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: "1",
        message: "Your order is saved.",
        restID: "res_pos_01",
        clientOrderID: "ord_ambiguous_1",
        orderID: "",
        code: 200,
      }),
    });

    const first = await pushOrderToPetpooja("ord_ambiguous_1");
    expect(first).toBe(true);
    expect(posPostCount()).toBe(1);

    const doc = savedDocs[ORDER_PATH];
    expect(doc.petpoojaAcceptedNoId).toBe(true);
    expect(doc.petpoojaStatus).toBe("synced");
    expect(doc.petpoojaUnresolvedIntent).toBe(false);
    expect(doc.petpoojaSendIntentState).toBe(SEND_INTENT_ACCEPTED);
    // Relay acceptance is NOT physical-printer proof.
    expect(doc.kotPrinted).toBeUndefined();
    expect(doc.kotPrintedAt).toBeUndefined();
    expect(doc.kotPushedAt).toBe("MOCK_TIMESTAMP");

    const replay = await pushOrderToPetpooja("ord_ambiguous_1");
    expect(replay).toBe(true);
    expect(posPostCount()).toBe(1);

    // Even if bookkeeping leaves the doc in the retry lane, the accepted
    // marker must dedupe it — zero POSTs.
    savedDocs[ORDER_PATH].petpoojaStatus = "pending_retry";
    savedDocs[ORDER_PATH].petpoojaSyncStatus = "pending_retry";
    vi.setSystemTime(BASE_TIME + 30 * 60 * 1000);
    await retryPendingPetpoojaOrdersWorker();
    expect(posPostCount()).toBe(1);
    expect(savedDocs[ORDER_PATH].petpoojaAcceptedNoId).toBe(true);
  });

  it("accepted WITH id: no kotPrinted manufactured; genuine printer evidence preserved", async () => {
    savedDocs[ORDER_PATH].kotPrinted = true;
    savedDocs[ORDER_PATH].kotPrintedAt = 1_600_000_000_000;

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: "1", message: "Your order is saved.", orderID: "PP-4242" }),
    });

    const pushed = await pushOrderToPetpooja("ord_ambiguous_1");
    expect(pushed).toBe(true);

    const doc = savedDocs[ORDER_PATH];
    expect(doc.petpoojaOrderId).toBe("PP-4242");
    expect(doc.petpoojaStatus).toBe("synced");
    // Pre-existing physical-printer evidence is left untouched (merge only).
    expect(doc.kotPrinted).toBe(true);
    expect(doc.kotPrintedAt).toBe(1_600_000_000_000);
    expect(doc.petpoojaUnresolvedIntent).toBe(false);
    expect(doc.petpoojaSendIntentState).toBe(SEND_INTENT_ACCEPTED);
  });

  it("scheduler claims TWO provably-unsent docs in one transaction without read-after-write", async () => {
    seedOrder(AMBIGUOUS_ORDER_PATH, {
      petpoojaStatus: "pending_retry",
      petpoojaSyncStatus: "pending_retry",
      petpoojaRetryCount: 0,
      petpoojaUnresolvedIntent: false,
      petpoojaSendIntentState: SEND_INTENT_PROVABLY_UNSENT,
      createdAt: BASE_TIME - 120_000,
    });
    savedDocs[ORDER_PATH].petpoojaStatus = "pending_retry";
    savedDocs[ORDER_PATH].petpoojaSyncStatus = "pending_retry";
    savedDocs[ORDER_PATH].petpoojaRetryCount = 0;
    savedDocs[ORDER_PATH].petpoojaUnresolvedIntent = false;
    savedDocs[ORDER_PATH].petpoojaSendIntentState = SEND_INTENT_PROVABLY_UNSENT;

    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: "1", orderID: `PP-${Math.random()}` }),
    }));

    const tick = await retryPendingPetpoojaOrdersWorker();
    expect(tick.retriedCount).toBe(2);
    expect(tick.failedCount).toBe(0);
    expect(posPostCount()).toBe(2);
    expect(savedDocs[ORDER_PATH].petpoojaStatus).toBe("synced");
    expect(savedDocs[AMBIGUOUS_ORDER_PATH].petpoojaStatus).toBe("synced");
  });

  it("stale exhausted snapshot cannot overwrite a concurrent reconciliation or send 'enter manually'", async () => {
    seedOrder(ORDER_PATH, {
      petpoojaStatus: "pending_retry",
      petpoojaSyncStatus: "pending_retry",
      petpoojaRetryCount: 4,
      petpoojaUnresolvedIntent: false,
      petpoojaSendIntentState: SEND_INTENT_PROVABLY_UNSENT,
    });

    // The worker reads the pending_retry snapshot; a concurrent actor then
    // reconciles the doc before the dead-letter pass.
    hooks.afterQueryRead = () => {
      savedDocs[ORDER_PATH] = {
        ...savedDocs[ORDER_PATH],
        petpoojaStatus: RECONCILIATION_REQUIRED,
        petpoojaSyncStatus: RECONCILIATION_REQUIRED,
        petpoojaAmbiguousSend: true,
        petpoojaUnresolvedIntent: true,
        petpoojaSendIntentState: "ambiguous",
      };
    };

    const tick = await retryPendingPetpoojaOrdersWorker();
    expect(posPostCount()).toBe(0);
    expect(tick.failedCount).toBe(0);
    expect(savedDocs[ORDER_PATH].petpoojaStatus).toBe(RECONCILIATION_REQUIRED);
    expect(savedDocs[ORDER_PATH].petpoojaAmbiguousSend).toBe(true);
    expect(vi.mocked(dispatchFCM)).not.toHaveBeenCalled();
  });

  it("stale legacy PROCESSING claim is not taken over by a direct caller", async () => {
    const staleLease = BASE_TIME - 30 * 60 * 1000;
    seedOrder(ORDER_PATH, {
      petpoojaStatus: "processing",
      petpoojaClaimedAt: staleLease,
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: "1", orderID: "PP-STALE-PROCESSING" }),
    });

    const pushed = await pushOrderToPetpooja("ord_ambiguous_1");
    expect(pushed).toBe(false);
    expect(posPostCount()).toBe(0);
    expect(savedDocs[ORDER_PATH].petpoojaStatus).toBe("processing");
    expect(savedDocs[ORDER_PATH].petpoojaClaimedAt).toBe(staleLease);
  });

  it("legacy pending_retry with NO positive pre-send marker is quarantined, not POSTed and not told to re-enter", async () => {
    seedOrder(ORDER_PATH, {
      petpoojaStatus: "pending_retry",
      petpoojaSyncStatus: "pending_retry",
      petpoojaRetryCount: 1,
      petpoojaClaimedAt: BASE_TIME - 30 * 60 * 1000, // stale legacy lease
    });

    const tick = await retryPendingPetpoojaOrdersWorker();
    expect(posPostCount()).toBe(0);
    expect(tick.retriedCount).toBe(0);
    expect(tick.failedCount).toBe(1);

    const doc = savedDocs[ORDER_PATH];
    expect(doc.petpoojaStatus).toBe(RECONCILIATION_REQUIRED);
    expect(doc.petpoojaAmbiguousSend).toBe(true);
    expect(doc.petpoojaLegacyOutcomeUnknown).toBe(true);
    expect(doc.petpoojaUnresolvedIntent).toBe(true);
    expect(vi.mocked(dispatchFCM)).not.toHaveBeenCalled();
  });

  it("exhausted PROVABLY-UNSENT retry is dead-lettered with NEUTRAL review advice", async () => {
    seedOrder(ORDER_PATH, {
      petpoojaStatus: "pending_retry",
      petpoojaSyncStatus: "pending_retry",
      petpoojaRetryCount: 4,
      petpoojaUnresolvedIntent: false,
      petpoojaSendIntentState: SEND_INTENT_PROVABLY_UNSENT,
    });

    const tick = await retryPendingPetpoojaOrdersWorker();
    expect(posPostCount()).toBe(0);
    expect(tick.failedCount).toBe(1);
    expect(savedDocs[ORDER_PATH].petpoojaStatus).toBe("failed");
    expect(savedDocs[ORDER_PATH].kotSyncFailed).toBe(true);
    expect(vi.mocked(dispatchFCM)).toHaveBeenCalledTimes(1);
    const notice = vi.mocked(dispatchFCM).mock.calls[0][0] as any;
    // CONTRACT CHANGE (final audit): the notification runs after an awaited
    // snapshot write, so it can never claim the order was "never sent" and
    // must not instruct blind manual re-entry. It asks for verification.
    expect(notice.body).toMatch(/verify the order\/attempt in Petpooja before any re-entry/i);
    expect(notice.body).not.toMatch(/enter the KOT|ever sent|enter manually/i);
  });

  it("DIRECT caller refuses a legacy pending_retry row before the worker tick — 0 wire", async () => {
    // Reviewer counterexample: the old timeout catch cleared every claim, so a
    // direct caller could POST a legacy pending_retry row before the scheduler
    // quarantined it. The direct boundary must apply the positive-marker rule.
    seedOrder(ORDER_PATH, {
      petpoojaStatus: "pending_retry",
      petpoojaSyncStatus: "pending_retry",
      petpoojaRetryCount: 1,
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: "1", orderID: "PP-MUST-NOT-SEND" }),
    });

    const pushed = await pushOrderToPetpooja("ord_ambiguous_1");
    expect(pushed).toBe(false);
    expect(posPostCount()).toBe(0);

    const doc = savedDocs[ORDER_PATH];
    expect(doc.petpoojaStatus).toBe("pending_retry");
    expect(doc.petpoojaOrderId).toBeUndefined();
    expect(doc.petpoojaAcceptedNoId).toBeUndefined();
    expect(doc.petpoojaUnresolvedIntent).toBeUndefined();
  });

  it("outcome-TX failure performs no raw fallback write and preserves a newer attempt", async () => {
    const originalRunTx = mockDb.runTransaction;
    let txCalls = 0;
    mockDb.runTransaction = vi.fn(async (fn: any) => {
      txCalls++;
      // Claim TX succeeds; the catch-path outcome TX fails.
      if (txCalls === 2) throw new Error("outcome transaction unavailable");
      return originalRunTx(fn);
    });
    // A newer attempt lands while the failed attempt is capturing its error
    // snapshot. The old fallback's read-then-raw-set could clobber it.
    vi.mocked(captureErrorSnapshot).mockImplementationOnce(async () => {
      savedDocs[ORDER_PATH] = {
        ...savedDocs[ORDER_PATH],
        petpoojaAttemptId: "newer-attempt",
        petpoojaUnresolvedIntent: true,
        petpoojaSendIntentState: "in_flight",
        petpoojaPushClaimedAt: Date.now(),
      };
      return "snap";
    });
    fetchMock.mockRejectedValueOnce(posTimeout());

    try {
      const pushed = await pushOrderToPetpooja("ord_ambiguous_1");
      expect(pushed).toBe(false);
      expect(posPostCount()).toBe(1);

      const doc = savedDocs[ORDER_PATH];
      expect(doc.petpoojaAttemptId).toBe("newer-attempt");
      expect(doc.petpoojaSendIntentState).toBe("in_flight");
      expect(doc.petpoojaUnresolvedIntent).toBe(true);
      // No outcome was written by the older attempt.
      expect(doc.petpoojaStatus).toBeUndefined();
      expect(doc.lastPetpoojaError).toBeUndefined();
    } finally {
      mockDb.runTransaction = originalRunTx;
    }
  });

  it("skips a dead-letter notification when a newer acceptance lands during snapshot capture", async () => {
    seedOrder(ORDER_PATH, {
      petpoojaStatus: "pending_retry",
      petpoojaSyncStatus: "pending_retry",
      petpoojaRetryCount: 4,
      petpoojaUnresolvedIntent: false,
      petpoojaSendIntentState: SEND_INTENT_PROVABLY_UNSENT,
      petpoojaAttemptId: "attempt-at-dead-letter",
    });
    vi.mocked(captureErrorSnapshot).mockImplementationOnce(async () => {
      // A new direct push is accepted while the advisory snapshot is awaited.
      savedDocs[ORDER_PATH] = {
        ...savedDocs[ORDER_PATH],
        petpoojaStatus: "synced",
        petpoojaSyncStatus: "synced",
        petpoojaOrderId: "PP-NEWER-ACCEPT",
        petpoojaUnresolvedIntent: false,
        petpoojaSendIntentState: SEND_INTENT_ACCEPTED,
        petpoojaAttemptId: "newer-attempt",
      };
      return "snap";
    });

    const tick = await retryPendingPetpoojaOrdersWorker();
    expect(posPostCount()).toBe(0);
    expect(tick.failedCount).toBe(1);
    expect(savedDocs[ORDER_PATH].petpoojaStatus).toBe("synced");
    expect(savedDocs[ORDER_PATH].petpoojaOrderId).toBe("PP-NEWER-ACCEPT");
    expect(vi.mocked(dispatchFCM)).not.toHaveBeenCalled();
  });

  it("pending_retry doc carrying an ambiguity marker is quarantined, never claimed or dead-lettered", async () => {
    seedOrder(ORDER_PATH, {
      petpoojaStatus: "pending_retry",
      petpoojaSyncStatus: "pending_retry",
      petpoojaRetryCount: 0,
      petpoojaAmbiguousSend: true,
      petpoojaUnresolvedIntent: true,
    });

    const tick = await retryPendingPetpoojaOrdersWorker();
    expect(tick.retriedCount).toBe(0);
    expect(tick.failedCount).toBe(0);
    expect(posPostCount()).toBe(0);
    expect(savedDocs[ORDER_PATH].petpoojaStatus).toBe("pending_retry");
    expect(savedDocs[ORDER_PATH].petpoojaClaimedAt).toBeUndefined();
    expect(vi.mocked(dispatchFCM)).not.toHaveBeenCalled();
  });
});
