import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// Finding 4 (duplicate-KOT race) + finding 9 (petpoojaClock timezone)
// regressions. Generic Firestore mock with real-ish get/set/transaction
// semantics over an in-memory `savedDocs` map.
const { mockDb, savedDocs } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
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
  const mockDb: any = {
    collection: (col: string) => ({ doc: (id: string) => docRef(col, id) }),
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

import { pushOrderToPetpooja, petpoojaClock } from "../src/modules/petpooja/orderPush";
import { config } from "../src/config/env";

describe("Petpooja KOT push — duplicate-push race (finding 4)", () => {
  let prevMock: boolean;
  const fetchMock = vi.fn();

  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    prevMock = config.mock.petpoojaPos;
    config.mock.petpoojaPos = false; // live path — the POS POST is stubbed
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    savedDocs["branches/branch_k1"] = { petpoojaStoreId: "res_k1" };
    savedDocs["orders/kot_1"] = {
      id: "kot_1",
      branchId: "branch_k1",
      customerName: "Test Customer",
      customerPhone: "+919825000001",
      items: [{ id: "itm_1", name: "Burger", price: 199, quantity: 1 }],
      pricing: { grandTotal: 199, gst: 9.95 },
      status: "pending",
    };
  });

  afterEach(() => {
    config.mock.petpoojaPos = prevMock;
    vi.unstubAllGlobals();
  });

  const posAck = () => ({
    status: 200,
    json: async () => ({ success: "1", petpooja_order_id: "pp_ack_1" }),
  });

  it("dedupes on petpoojaOrderId presence even when status is NOT synced", async () => {
    // Legacy corruption: a successful push later overwritten to pending_retry
    // by the old catch path. The KOT is AT the kitchen — never re-push.
    savedDocs["orders/kot_1"].petpoojaOrderId = "pp_old_1";
    savedDocs["orders/kot_1"].petpoojaStatus = "pending_retry";

    const pushed = await pushOrderToPetpooja("kot_1");
    expect(pushed).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    // State untouched — the winner's synced marker is never regressed.
    expect(savedDocs["orders/kot_1"].petpoojaStatus).toBe("pending_retry");
  });

  it("yields to an in-flight push (live claim) instead of double-POSTing", async () => {
    savedDocs["orders/kot_1"].petpoojaPushClaimedAt = Date.now();

    const pushed = await pushOrderToPetpooja("kot_1");
    expect(pushed).toBe(true); // owner will complete or park — no stack-up
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("takes over a STALE claim (crashed pusher) and pushes once", async () => {
    savedDocs["orders/kot_1"].petpoojaPushClaimedAt = Date.now() - 11 * 60 * 1000;
    fetchMock.mockResolvedValueOnce(posAck());

    const pushed = await pushOrderToPetpooja("kot_1");
    expect(pushed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(savedDocs["orders/kot_1"].petpoojaOrderId).toBe("pp_ack_1");
    expect(savedDocs["orders/kot_1"].petpoojaStatus).toBe("synced");
    // Claim released on success.
    expect(savedDocs["orders/kot_1"].petpoojaPushClaimedAt).toBeNull();
  });

  it("a racing winner's success survives OUR failure — no pending_retry regression", async () => {
    // The POS POST "lands" for a concurrent caller (they write the synced
    // marker) and then OUR call fails — the guarded catch must keep synced.
    fetchMock.mockImplementationOnce(async () => {
      savedDocs["orders/kot_1"].petpoojaOrderId = "pp_racer_1";
      savedDocs["orders/kot_1"].petpoojaStatus = "synced";
      throw new Error("socket hang up after send");
    });

    const pushed = await pushOrderToPetpooja("kot_1");
    expect(pushed).toBe(true);
    expect(savedDocs["orders/kot_1"].petpoojaStatus).toBe("synced");
    expect(savedDocs["orders/kot_1"].petpoojaOrderId).toBe("pp_racer_1");
    expect(savedDocs["orders/kot_1"].petpoojaRetryCount).toBeUndefined();
  });

  it("parks a genuine rejection in pending_retry with a fresh count + released claim", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      json: async () => ({ success: "0", message: "invalid resID" }),
    });

    const pushed = await pushOrderToPetpooja("kot_1");
    expect(pushed).toBe(false);
    const doc = savedDocs["orders/kot_1"];
    expect(doc.petpoojaStatus).toBe("pending_retry");
    expect(doc.petpoojaRetryCount).toBe(1);
    expect(doc.lastPetpoojaError).toMatch(/invalid resID/);
    expect(doc.petpoojaPushClaimedAt).toBeNull();
    // No bogus "already pushed" marker on failure — the retry worker owns it.
    expect(doc.petpoojaOrderId).toBeUndefined();
  });

  it("an ack with an EMPTY order id is NOT success — never fabricates an id, never claims the KOT printed", async () => {
    // The EXACT live sandbox response, verbatim. Petpooja answers this to
    // every relay: success:"1" with all ids empty. The old code took it as a
    // win, invented `pp_<epoch>` and stamped kotPrinted:true — telling the
    // kitchen a KOT had printed that Petpooja never registered, and then
    // skipping every later retry because the fake id looked like a real one.
    fetchMock.mockResolvedValueOnce({
      status: 200,
      json: async () => ({
        success: "1",
        message: "Your order is saved.",
        restID: "",
        clientOrderID: "",
        orderID: "",
        code: 200,
      }),
    });

    const pushed = await pushOrderToPetpooja("kot_1");
    expect(pushed).toBe(false);

    const doc = savedDocs["orders/kot_1"];
    // Parked for the retry worker instead of lied about.
    expect(doc.petpoojaStatus).toBe("pending_retry");
    expect(doc.petpoojaRetryCount).toBe(1);
    // The two guarantees that make the order recoverable.
    expect(doc.petpoojaOrderId).toBeUndefined();
    expect(doc.kotPrinted).toBeUndefined();
    expect(doc.petpoojaSyncStatus).not.toBe("synced");
    // The raw POS body is preserved for diagnosis.
    expect(doc.lastPetpoojaError).toMatch(/returned no order id/);
  });

  it("echoes the POS's capitalised orderID when it does send one", async () => {
    // Petpooja spells the field `orderID` in its own responses; the old code
    // only read snake_case, so a REAL id would have been thrown away and
    // replaced by a fabricated one.
    fetchMock.mockResolvedValueOnce({
      status: 200,
      json: async () => ({ success: "1", message: "Your order is saved.", orderID: "PP-9911" }),
    });

    const pushed = await pushOrderToPetpooja("kot_1");
    expect(pushed).toBe(true);
    const doc = savedDocs["orders/kot_1"];
    expect(doc.petpoojaOrderId).toBe("PP-9911");
    expect(doc.petpoojaStatus).toBe("synced");
    expect(doc.kotPrinted).toBe(true);
  });

  it("a second push after an empty-id park RETRIES instead of deduping out", async () => {
    // The recoverability guarantee: because no fake id was written, the
    // dedupe at the top of pushOrderToPetpooja does not treat the order as
    // already-pushed, so the retry worker can still deliver the KOT.
    fetchMock.mockResolvedValueOnce({
      status: 200,
      json: async () => ({ success: "1", orderID: "" }),
    });
    await pushOrderToPetpooja("kot_1");
    expect(savedDocs["orders/kot_1"].petpoojaStatus).toBe("pending_retry");

    // Retry worker finds it and the POS now returns a real id.
    savedDocs["orders/kot_1"].petpoojaPushClaimedAt = Date.now() - 11 * 60 * 1000;
    fetchMock.mockResolvedValueOnce({
      status: 200,
      json: async () => ({ success: "1", orderID: "PP-4242" }),
    });
    const retried = await pushOrderToPetpooja("kot_1");
    expect(retried).toBe(true);
    expect(savedDocs["orders/kot_1"].petpoojaOrderId).toBe("PP-4242");
    expect(savedDocs["orders/kot_1"].petpoojaStatus).toBe("synced");
  });

  it("two truly concurrent pushes produce exactly ONE KOT POST", async () => {
    let release: (v: any) => void = () => undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );

    const first = pushOrderToPetpooja("kot_1");
    // Let the first call take the claim (its tx + fetch are pending), then
    // the second caller must yield WITHOUT reaching the POS.
    await new Promise((r) => setImmediate(r));
    const second = pushOrderToPetpooja("kot_1");
    release(posAck());
    const [a, b] = await Promise.all([first, second]);

    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(savedDocs["orders/kot_1"].petpoojaOrderId).toBe("pp_ack_1");
  });
});

describe("petpoojaClock — IST wall-clock regardless of runtime zone (finding 9)", () => {
  it("formats a UTC instant into Asia/Kolkata date/time parts", () => {
    // 2026-01-01T10:00:00Z -> 15:30 IST same day.
    const { preorderDate, preorderTime, createdOn } = petpoojaClock(
      new Date("2026-01-01T10:00:00Z")
    );
    expect(preorderDate).toBe("2026-01-01");
    expect(preorderTime).toBe("15:30:00");
    expect(createdOn).toBe("2026-01-01 15:30:00");
  });

  it("rolls the date at IST midnight (never hour 24)", () => {
    // 2026-01-01T18:30:00Z -> 00:00 IST on 2026-01-02.
    const { preorderDate, preorderTime } = petpoojaClock(
      new Date("2026-01-01T18:30:00Z")
    );
    expect(preorderDate).toBe("2026-01-02");
    expect(preorderTime).toBe("00:00:00");
  });
});
