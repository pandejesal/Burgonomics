import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";

/**
 * Borzo book-time duplicate-order safety (lane 09, run 2026-10-20b).
 *
 * Provenance: the original guard in this file was written by the retired lane-8
 * session (fresh-team-20261020) and left UNCOMMITTED (adapter diff + this
 * untracked suite, GATE START without GATE END). Run 2026-10-20b lane 09
 * adopted those bytes unchanged, then closed the id-carrying duplicate hole and
 * added the router-predicate pin.
 *
 * Harness mirrors `dispatch.provider-contract.test.ts` (firebase-admin double +
 * `global.fetch` stub). The subject is narrower than that suite:
 *
 * Borzo's documented `order_is_duplicate` (400, `is_successful:false`) means the
 * provider ALREADY holds an order with our `client_order_id` — provider
 * evidence that a previous accepted create-order (e.g. one that timed out
 * client-side) may be live. At BOOK time this can never be a retryable
 * "transient" fault: the DR6 ranked walk would book a SECOND real courier
 * while Borzo may still dispatch the first (DR6/§3: ambiguous acceptance stops
 * the walk, releases the claim, and surfaces loudly for reconciliation).
 *
 * The classification-table pin in `dispatch.provider-contract.test.ts`
 * (`order_is_duplicate` → transient) is deliberately preserved for the QUOTE
 * path and every non-duplicate code: its intent is anti-misclassification
 * (never read as "address not covered"), and a calculate-order failure cannot
 * have booked anything. Only the create-order path treats the duplicate code
 * as acceptance ambiguity — the same plain-error contract its own no-id case
 * and the Shadowfax adapter (dbd1626 parity) already use.
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
  const readDoc: any = (colName: string, docId: string) => {
    const snap: any = {
      exists: true,
      data: () => savedDocs[`${colName}/${docId}`] || defaultOrder(),
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
      where: (_field: string, _op: string, _val: any) => ({
        limit: (_n: number) => ({
          get: async () => ({ empty: true, docs: [] }),
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

import { borzoAdapter } from "../src/modules/dispatch/providers/borzo.adapter";
import {
  ProviderDispatchError,
  isProviderDispatchError,
  type DispatchQuoteContext,
} from "../src/modules/dispatch/types";
import { config } from "../src/config/env";

const PICKUP = { lat: 23.0131, lng: 72.5085 };
const DROP = { lat: 23.0338, lng: 72.5262 };

const okJson = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** Documented Borzo failure body: 400 + `is_successful:false` + `errors[]`. */
const borzoBody = (errors: string[], extra: Record<string, any> = {}) => ({
  is_successful: false,
  errors,
  parameter_errors: {},
  ...extra,
});

/** Fully-formed book context: real branch phone + real customer phone. */
function borzoBookContext(orderId: string): DispatchQuoteContext & { orderId: string } {
  return {
    pickup: PICKUP,
    drop: DROP,
    customerName: "Aarav Shah",
    customerPhone: "+91 99999 88888",
    orderId,
    order: {
      branchName: "Burgonomics CG Road",
      store: { name: "Burgonomics CG Road", phone: "+91 98250 12345" },
      deliveryAddress: {
        full: "102, Shivalik Highstreet, Vastrapur",
        city: "Ahmedabad",
        lat: DROP.lat,
        lng: DROP.lng,
      },
    },
  };
}

const QUOTE = {
  provider: "borzo" as const,
  outcome: "ok" as const,
  fare: 60,
  distanceKm: 5,
  pickupEtaMinutes: 8,
  quoteId: "QTE-BORZO-duplicate-test",
  expiresAt: Date.now() + 60_000,
  source: "borzo_mock_rate_card",
};

/** Resolves with the rejection reason — asserts the call actually failed. */
async function capture(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the provider call to reject, but it resolved");
}

const originalFetch = globalThis.fetch;
let fetchCalls: Array<{ url: string; init: any }> = [];
let fetchHandler: ((url: string, init: any) => Response) | null = null;

let saved: any = {};

beforeAll(() => {
  globalThis.fetch = vi.fn(async (url: any, init: any) => {
    const u = String(url);
    fetchCalls.push({ url: u, init });
    if (fetchHandler) return fetchHandler(u, init);
    return okJson({ message: "no fetch handler registered" }, 404);
  }) as any;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  saved = {
    borzo: { ...config.borzo },
    shadowfax: { ...config.shadowfax },
    porter: { ...config.porter },
    mock: { ...config.mock },
  };
  // Borzo LIVE (keyed, unmocked) is the subject; nothing else eligible.
  config.borzo.enabled = true;
  config.borzo.apiKey = "test_borzo_key";
  config.shadowfax.enabled = false;
  config.porter.enabled = false;
  config.mock.borzoDispatch = false;
  config.mock.shadowfaxDispatch = false;
  config.mock.porterDispatch = false;

  for (const k of Object.keys(savedDocs)) delete savedDocs[k];
  fetchCalls = [];
  fetchHandler = null;
});

afterEach(() => {
  config.borzo = { ...saved.borzo };
  config.shadowfax = { ...saved.shadowfax };
  config.porter = { ...saved.porter };
  config.mock = { ...saved.mock };
});

describe("borzo book-time duplicate-order safety (no second real rider)", () => {
  it("a duplicate-order error at BOOK time is a plain AMBIGUOUS 502 that cannot fail over", async () => {
    // Provider evidence the delivery may already exist: an earlier create-order
    // for the same client_order_id was accepted. Walking to the next provider
    // would book a SECOND real courier for one order (DR6).
    fetchHandler = () => okJson(borzoBody(["order_is_duplicate"]), 400);

    const err: any = await capture(
      borzoAdapter.book({ ...borzoBookContext("ord_dup_book"), quote: QUOTE })
    );

    // Plain error — NOT the walkable ProviderDispatchError.
    expect(err.name).not.toBe("ProviderDispatchError");
    expect(err.kind).toBeUndefined();
    // The router's ACTUAL predicate (types.ts), not just the name: if this ever
    // became duck-typed on `kind`, the walk would silently reopen.
    expect(isProviderDispatchError(err)).toBe(false);
    expect(err.code).toBe("PROVIDER_BOOK_AMBIGUOUS");
    expect(err.statusCode).toBe(502);
    // The reconciliation handle must be named for staff: Borzo dedupes on
    // client_order_id, so that specific handle is pinned (not just "duplicate").
    expect(err.message).toContain("client_order_id");
  });

  it("a duplicate delivered on a 200 is_successful:false body is ALSO a plain AMBIGUOUS 502 (shape-independence of the guard)", async () => {
    // Borzo contract: EVERY documented error is HTTP 400 with is_successful:false,
    // but the code table is the decision point — the guard must not depend on
    // res.status being non-2xx.
    fetchHandler = () =>
      okJson({ is_successful: false, errors: ["order_is_duplicate"], parameter_errors: {} }, 200);

    const err: any = await capture(
      borzoAdapter.book({ ...borzoBookContext("ord_dup_200"), quote: QUOTE })
    );

    expect(err.name).not.toBe("ProviderDispatchError");
    expect(err.kind).toBeUndefined();
    expect(err.code).toBe("PROVIDER_BOOK_AMBIGUOUS");
    expect(err.statusCode).toBe(502);
  });

  it("a duplicate delivered via parameter_errors is ALSO a plain AMBIGUOUS 502 (code-collector independence)", async () => {
    fetchHandler = () =>
      okJson(
        {
          is_successful: false,
          errors: [],
          parameter_errors: { points: "order_is_duplicate" },
        },
        400
      );

    const err: any = await capture(
      borzoAdapter.book({ ...borzoBookContext("ord_dup_param"), quote: QUOTE })
    );

    expect(err.name).not.toBe("ProviderDispatchError");
    expect(err.code).toBe("PROVIDER_BOOK_AMBIGUOUS");
    expect(err.statusCode).toBe(502);
  });

  it("a duplicate in warnings (no usable id) is ALSO a plain AMBIGUOUS 502 (warnings bypass closed)", async () => {
    // Prior-review MINOR: borzoErrorCodes alone misses a warnings-carried
    // duplicate, which used to fall into the unclassifiable-body transient
    // default -> walk -> second courier.
    fetchHandler = () => okJson({ is_successful: false, errors: [], warnings: ["order_is_duplicate"] }, 200);

    const err: any = await capture(
      borzoAdapter.book({ ...borzoBookContext("ord_dup_warn"), quote: QUOTE })
    );

    expect(err.name).not.toBe("ProviderDispatchError");
    expect(err.code).toBe("PROVIDER_BOOK_AMBIGUOUS");
    expect(err.statusCode).toBe(502);
  });

  it("a duplicate code delivered TOGETHER WITH another code is ambiguity-wins", async () => {
    fetchHandler = () =>
      okJson(borzoBody(["invalid_parameters", "order_is_duplicate"]), 400);

    const err: any = await capture(
      borzoAdapter.book({ ...borzoBookContext("ord_dup_combo"), quote: QUOTE })
    );

    expect(err.name).not.toBe("ProviderDispatchError");
    expect(err.code).toBe("PROVIDER_BOOK_AMBIGUOUS");
    expect(err.statusCode).toBe(502);
  });

  it("a duplicate-ECHO response naming the EXISTING order id still binds truthfully (positive control 2)", async () => {
    // Borzo dedupe returning the existing order: as long as a usable order id
    // is present, the duplicate question is answered by Borzo itself and the
    // booking binds — this is NOT an ambiguity.
    fetchHandler = () =>
      okJson({
        is_successful: true,
        order: { order_id: "BZ-DUP-ECHO-1", status: "active" },
        warnings: ["order_is_duplicate"],
      });

    const booked = await borzoAdapter.book({
      ...borzoBookContext("ord_dup_echo"),
      quote: QUOTE,
    });

    expect(booked.kind).toBe("booked");
    if (booked.kind === "booked") {
      expect(booked.providerOrderId).toBe("BZ-DUP-ECHO-1");
      expect(booked.source).toBe("borzo_api_live");
    }
  });

  it("a fresh create-order with a real order id still books (positive control)", async () => {
    fetchHandler = () =>
      okJson({ is_successful: true, order: { order_id: "BZ-DUP-POS-1", status: "new" } });

    const booked = await borzoAdapter.book({
      ...borzoBookContext("ord_dup_pos"),
      quote: QUOTE,
    });

    expect(booked.kind).toBe("booked");
    if (booked.kind === "booked") {
      expect(booked.provider).toBe("borzo");
      expect(booked.providerOrderId).toBe("BZ-DUP-POS-1");
      expect(booked.source).toBe("borzo_api_live");
    }
  });

  it("a duplicate that ALSO names an order id and is NOT a success is a plain AMBIGUOUS 502 (no walk)", async () => {
    // The guard's first cut only fired when NO order id was present, so this
    // shape slipped past it: assertBorzoResponse then classified
    // order_is_duplicate as "transient" and dispatch.router.ts walked to the
    // NEXT provider — a SECOND real courier while Borzo may hold this one.
    // Naming an order id is the strongest evidence the order exists, so the
    // id must make the guard STRICTER, never bypass it.
    fetchHandler = () =>
      okJson(
        borzoBody(["order_is_duplicate"], { order: { order_id: "BZ-EXISTING-1" } }),
        400
      );

    const err: any = await capture(
      borzoAdapter.book({ ...borzoBookContext("ord_dup_with_id"), quote: QUOTE })
    );

    expect(err.name).not.toBe("ProviderDispatchError");
    expect(err.kind).toBeUndefined();
    expect(isProviderDispatchError(err)).toBe(false);
    expect(err.code).toBe("PROVIDER_BOOK_AMBIGUOUS");
    expect(err.statusCode).toBe(502);
    expect(err.message).toContain("client_order_id");
  });

  it("a 200 is_successful:false body naming an order id is ALSO AMBIGUOUS, not a walkable fault)", async () => {
    // Same hole, HTTP-200 carrier: res.ok is true, so only is_successful
    // decides. Borzo already returned an order id => the order may exist.
    fetchHandler = () =>
      okJson(
        { is_successful: false, errors: [], order: { order_id: "BZ-EXISTING-2" } },
        200
      );

    const err: any = await capture(
      borzoAdapter.book({ ...borzoBookContext("ord_nonok_with_id"), quote: QUOTE })
    );

    expect(err.name).not.toBe("ProviderDispatchError");
    expect(isProviderDispatchError(err)).toBe(false);
    expect(err.code).toBe("PROVIDER_BOOK_AMBIGUOUS");
    expect(err.statusCode).toBe(502);
  });

  it("a duplicate WARNING + success + NO id still lands on the no-id ambiguity, never a bind", async () => {
    // Warnings carry the duplicate prediction Borzo documents; the body is a
    // success but names nothing bindable. It must not be reported as booked.
    fetchHandler = () =>
      okJson({ is_successful: true, warnings: ["order_is_duplicate"] }, 200);

    const err: any = await capture(
      borzoAdapter.book({ ...borzoBookContext("ord_dup_warn_noid"), quote: QUOTE })
    );

    expect(isProviderDispatchError(err)).toBe(false);
    expect(err.code).toBe("PROVIDER_BOOK_AMBIGUOUS");
    expect(err.statusCode).toBe(502);
    expect(err.message).toContain("no order id");
  });

  it("a NON-duplicate code that still names an order is ambiguous too (failed create may have created it)", async () => {
    // The duplicate label is not the only evidence: a body that named a real
    // order and also failed to be a success would otherwise walk as a
    // transient "invalid_parameters" and book a second courier.
    fetchHandler = () =>
      okJson(
        borzoBody(["invalid_parameters"], { order: { order_id: "BZ-NAMED-ON-FAIL" } }),
        400
      );

    const err: any = await capture(
      borzoAdapter.book({ ...borzoBookContext("ord_named_on_fail"), quote: QUOTE })
    );

    expect(isProviderDispatchError(err)).toBe(false);
    expect(err.code).toBe("PROVIDER_BOOK_AMBIGUOUS");
    expect(err.statusCode).toBe(502);
    expect(err.message).toContain("BZ-NAMED-ON-FAIL");
  });

  it("a create-order TIMEOUT with no response is ambiguous, not a walkable transient", async () => {
    // The canonical duplicate trigger: the request reached Borzo, the client
    // gave up. A walk would book a second courier against the order the first
    // request may already have created. Shape is Node's real abort rejection.
    fetchHandler = () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    };

    const err: any = await capture(
      borzoAdapter.book({ ...borzoBookContext("ord_timeout"), quote: QUOTE })
    );

    expect(isProviderDispatchError(err)).toBe(false);
    expect(err.code).toBe("PROVIDER_BOOK_AMBIGUOUS");
    expect(err.statusCode).toBe(502);
    expect(err.message).toContain("client_order_id");
  });

  it("a PRE-SEND failure (DNS) stays transient/walkable: no order can exist at a host we never reached", async () => {
    // Node's real DNS failure: TypeError("fetch failed") with cause.code
    // ENOTFOUND. No abort/timeout token, so the ambiguity guard must not fire.
    fetchHandler = () => {
      const err: any = new TypeError("fetch failed");
      err.cause = { code: "ENOTFOUND" };
      throw err;
    };

    const err: any = await capture(
      borzoAdapter.book({ ...borzoBookContext("ord_dns"), quote: QUOTE })
    );

    expect(err).toBeInstanceOf(ProviderDispatchError);
    expect(err.kind).toBe("transient");
  });

  it("non-duplicate documented codes at book time REMAIN transient-walkable (first-body wins)", async () => {
    // Protects the classification-table intent: a provider/account-side fault
    // is still a retryable provider failure — only the duplicate code changes.
    fetchHandler = () => okJson(borzoBody(["invalid_parameters"]), 400);

    const err: any = await capture(
      borzoAdapter.book({ ...borzoBookContext("ord_dup_other"), quote: QUOTE })
    );

    expect(err).toBeInstanceOf(ProviderDispatchError);
    expect(err.kind).toBe("transient");
    expect(err.message).toContain("invalid_parameters");
  });

  it("a duplicate code at QUOTE time does not change quote semantics", async () => {
    // calculate-order never booked anything — the transient classification
    // (and the anti-misclassification contract) stays untouched on the quote
    // path.
    fetchHandler = () => okJson(borzoBody(["order_is_duplicate"]), 400);

    const err: any = await capture(borzoAdapter.quote(borzoBookContext("ord_dup_quote")));

    expect(err).toBeInstanceOf(ProviderDispatchError);
    expect(err.kind).toBe("transient");
  });
});
