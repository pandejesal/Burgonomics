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
    savedDocs["branches/branch_k1"] = {
      petpoojaStoreId: "res_k1",
      // H2 fixture — captured Petpooja tax catalogue (no builder default).
      petpoojaTaxes: [
        { id: "3928", name: "CGST", rate: 2.5 },
        { id: "3929", name: "SGST", rate: 2.5 },
      ],
    };
    savedDocs["products/prod_branch_k1_7765862"] = {
      id: "prod_branch_k1_7765862",
      branchId: "branch_k1",
      petpoojaItemId: "7765862",
      petpoojaItemTaxIds: ["3928", "3929"],
      petpoojaTaxInclusive: false,
      petpoojaTaxUnsupported: false,
      petpoojaGstType: "goods",
    };
    savedDocs["orders/kot_1"] = {
      id: "kot_1",
      branchId: "branch_k1",
      customerName: "Test Customer",
      customerPhone: "+919825000001",
      items: [{ id: "itm_1", productId: "prod_branch_k1_7765862", petpoojaItemId: "7765862", name: "Burger", price: 199, quantity: 1 }],
      pricing: { grandTotal: 199, gst: 9.95 },
      status: "pending",
    };
  });

  afterEach(() => {
    config.mock.petpoojaPos = prevMock;
    vi.unstubAllGlobals();
  });

  const posAck = () => ({
    ok: true,
    status: 200,
    json: async () => ({ success: "1", petpooja_order_id: "pp_ack_1" }),
  });

  it("never reads an acceptance out of an HTTP failure", async () => {
    // Regression for a FABRICATED SUCCESS. The ack classifier inspects only the
    // JSON body, so an HTTP failure whose body still carried success:"1" - a
    // gateway/proxy error page, a WAF interstitial, a half-broken 5xx - was
    // recorded as petpoojaStatus "synced" + kotPrinted:true with the push claim
    // released, so the retry worker would never look at an order that never
    // reached the POS. Every mock in this file previously omitted `ok`, which is
    // exactly why the gap was invisible: the code never asked.
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      json: async () => ({ success: "1", message: "Your order is saved.", orderID: "" }),
    });
    const pushed = await pushOrderToPetpooja("kot_1");
    expect(pushed).toBe(false);
    expect(savedDocs["orders/kot_1"].petpoojaOrderId).toBeUndefined();
    expect(savedDocs["orders/kot_1"].petpoojaAcceptedNoId).toBeUndefined();
    expect(savedDocs["orders/kot_1"].petpoojaStatus).toBe("pending_retry");
    expect(String(savedDocs["orders/kot_1"].lastPetpoojaError)).toContain("502");
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
    expect(pushed).toBe(false); // owner will complete or park — busy is not confirmed success
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
      ok: true,
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

  it("an ack with an EMPTY order id is ACCEPTED — synced, deduped, and no id invented", async () => {
    // The EXACT live sandbox response, verbatim: success:"1" with all ids
    // empty. Two earlier readings of this payload were both wrong:
    //  1. invent `pp_<epoch>` + kotPrinted  → claimed an id the POS never issued.
    //  2. throw and park pending_retry       → the order HAD registered, so the
    //     retry re-POSTed it and rang the kitchen twice.
    // Proven 2026-10-17 against Petpooja's own Order List for 5439: every
    // relayed order is listed (the five deliverable scenarios with matching
    // clientOrderIDs and totals) despite this empty `orderID`. So: accepted.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: "1",
        message: "Your order is saved.",
        restID: "31z58ciw0h",
        clientOrderID: "bgx_items_tax_1",
        orderID: "",
        code: 200,
      }),
    });

    const pushed = await pushOrderToPetpooja("kot_1");
    expect(pushed).toBe(true);

    const doc = savedDocs["orders/kot_1"];
    expect(doc.petpoojaStatus).toBe("synced");
    expect(doc.petpoojaSyncStatus).toBe("synced");
    // Finding 5: An ack without an order ID establishes relay acceptance (kotPushedAt),
    // but does NOT manufacture physical printer evidence (kotPrinted).
    expect(doc.kotPrinted).toBeUndefined();
    expect(doc.kotPushedAt).toBeDefined();
    expect(doc.petpoojaOrderId).toBeUndefined();
    // The accepted-without-id shape is recorded explicitly, with the raw body.
    expect(doc.petpoojaAcceptedNoId).toBe(true);
    expect(doc.petpoojaAcceptedNoIdAck).toMatch(/Your order is saved/);
    expect(doc.petpoojaRetryCount).toBeUndefined();
    expect(doc.petpoojaPushClaimedAt).toBeNull();
  });

  it("echoes the POS's capitalised orderID when it does send one", async () => {
    // Petpooja spells the field `orderID` in its own responses; the old code
    // only read snake_case, so a REAL id would have been thrown away and
    // replaced by a fabricated one.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: "1", message: "Your order is saved.", orderID: "PP-9911" }),
    });

    const pushed = await pushOrderToPetpooja("kot_1");
    expect(pushed).toBe(true);
    const doc = savedDocs["orders/kot_1"];
    expect(doc.petpoojaOrderId).toBe("PP-9911");
    expect(doc.petpoojaStatus).toBe("synced");
    expect(doc.kotPrinted).toBeUndefined();
    expect(doc.kotPushedAt).toBeDefined();
  });

  it("preserves genuine preexisting physical printer evidence across relay ACKs", async () => {
    savedDocs["orders/kot_1"].kotPrinted = true;
    savedDocs["orders/kot_1"].kotPrintedAt = 1600000000000;
    fetchMock.mockResolvedValueOnce(posAck());

    const pushed = await pushOrderToPetpooja("kot_1");
    expect(pushed).toBe(true);
    const doc = savedDocs["orders/kot_1"];
    expect(doc.petpoojaOrderId).toBe("pp_ack_1");
    expect(doc.petpoojaStatus).toBe("synced");
    // Preexisting physical evidence must NOT be erased or clobbered
    expect(doc.kotPrinted).toBe(true);
    expect(doc.kotPrintedAt).toBe(1600000000000);
    expect(doc.kotPushedAt).toBeDefined();
  });

  it("a second push after an accepted-no-id ack DEDUPES instead of re-POSTing", async () => {
    // The duplicate-KOT guarantee for the id-less acceptance shape: because the
    // acceptance marker is written, a replay (second Razorpay event, KDS double
    // tap, retry worker) must NOT reach the POS a second time — the first POST
    // already put the order in Petpooja's Order List.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: "1", orderID: "" }),
    });
    const first = await pushOrderToPetpooja("kot_1");
    expect(first).toBe(true);
    expect(savedDocs["orders/kot_1"].petpoojaAcceptedNoId).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const replay = await pushOrderToPetpooja("kot_1");
    expect(replay).toBe(true);
    // No second POST — the kitchen is not rung twice.
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
    expect(await b).toBe(false); // second caller yielded to busy in-flight push
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
