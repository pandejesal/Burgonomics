import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Default-deny regression for the Petpooja inbound bridge (2026-10-28).
//
// Before this change `handlePetpoojaWebhook` treated only an EXPLICIT
// `authenticated: false` as untrusted: an omitted, empty (`{}`) or malformed
// auth context fell through to the trusted path and could rewrite canonical
// order status, POS acceptance, refunds and payment facts. The stock handler
// had no auth gate at all. These cases pin the new rule:
//
//   only `{ authenticated: true }` — the flag `verifyPetpoojaAuth` sets after
//   a token or raw-body HMAC check — may write canonical state; everything
//   else is recorded as a review/hint row and leaves canonical state alone.

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
      // The stock handler commits with update({lastUpdateTime}) inside its
      // version-precondition step (F6), so the shim must expose update too.
      update: vi.fn(async (data: any) => {
        savedDocs[path] = { ...(savedDocs[path] || {}), ...data };
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

import {
  handlePetpoojaStockWebhook,
  handlePetpoojaWebhook,
  isTrustedPetpoojaAuth,
} from "../src/modules/petpooja/item86ingSync";

const PENDING_STATUS = {
  code: "PENDING",
  label: "Pending",
  kind: "upcoming",
  terminal: false,
};

const seedLinkedOrder = (id: string, extra: Record<string, any> = {}) => {
  savedDocs["branches/branch_t1"] = {
    petpoojaStoreId: "31z58ciw0h",
    name: "HL Road",
  };
  savedDocs[`orders/${id}`] = {
    id,
    branchId: "branch_t1",
    petpoojaStatus: "pending_retry",
    petpoojaSyncStatus: "pending_retry",
    payment: { razorpayPaymentId: "pay_deny_1" },
    status: { ...PENDING_STATUS },
    ...extra,
  };
};

const refundDocs = () =>
  Object.keys(savedDocs).filter((p) => p.startsWith("refunds/"));

/** Canonical state that an unverified event must never move. */
const expectCanonicalStateUntouched = (orderId: string) => {
  const doc = savedDocs[`orders/${orderId}`];
  expect(doc, `order ${orderId} must still exist`).toBeDefined();
  expect(doc.status).toEqual(PENDING_STATUS);
  expect(doc.petpoojaKitchenStatus).toBeUndefined();
  expect(doc.petpoojaOrderId).toBeUndefined();
  expect(doc.petpoojaStatus).toBe("pending_retry");
  expect(doc.petpoojaSyncStatus).toBe("pending_retry");
  expect(doc.cancelledAt).toBeUndefined();
  expect(doc.cancellationReason).toBeUndefined();
  expect(doc["payment.refundStatus"]).toBeUndefined();
  expect(doc.payment).toEqual({ razorpayPaymentId: "pay_deny_1" });
  expect(refundDocs()).toEqual([]);
};

describe("isTrustedPetpoojaAuth", () => {
  it("trusts ONLY the boolean true set after verification", () => {
    expect(isTrustedPetpoojaAuth({ authenticated: true })).toBe(true);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["an empty object", {}],
    ["an explicit false", { authenticated: false }],
    ["the string 'true'", { authenticated: "true" }],
    ["the number 1", { authenticated: 1 }],
    ["a renamed flag", { verified: true }],
    ["a bare boolean", true],
    ["a string", "true"],
    ["an array", [{ authenticated: true }]],
  ])("treats %s as untrusted", (_label, value) => {
    expect(isTrustedPetpoojaAuth(value)).toBe(false);
  });
});

// Every canonical claim the POS can send: accepted, cancelled, delivered.
const STATUS_CLAIMS: Array<[string, string | number]> = [
  ["accepted", "Accept"],
  ["cancelled", "Cancel"],
  ["delivered", "10"],
];

// Auth contexts that must NOT authorise a canonical write. `undefined` covers
// the omitted argument (the function's `{}` default); `{}` is passed
// explicitly; the rest are malformed shapes a buggy caller could send.
const UNTRUSTED_CONTEXTS: Array<[string, unknown]> = [
  ["omitted", undefined],
  ["empty object", {}],
  ["null", null],
  ["explicit false", { authenticated: false }],
  ["string 'true'", { authenticated: "true" }],
  ["number 1", { authenticated: 1 }],
  ["renamed flag", { verified: true }],
  ["bare boolean", true],
];

describe("handlePetpoojaWebhook — default-deny without a verified context", () => {
  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
  });

  describe.each(UNTRUSTED_CONTEXTS)("auth context: %s", (_label, auth) => {
    it.each(STATUS_CLAIMS)(
      "a %s claim does not change canonical order state",
      async (_claim, status) => {
        seedLinkedOrder("ord_deny");

        await handlePetpoojaWebhook(
          {
            order_id: "ord_deny",
            restID: "31z58ciw0h",
            orderID: "PP-DENY-1",
            status,
          },
          auth
        );

        expectCanonicalStateUntouched("ord_deny");
        // The event is still recorded — as a hint/review row, not as state.
        expect(
          savedDocs["unmatched_petpooja_orders/upo_ord_deny"]
        ).toMatchObject({
          status: "needs_review",
          trusted: false,
          reason: /canonical state not applied/,
        });
      }
    );
  });

  it("does not park a refund for an unverified cancel", async () => {
    seedLinkedOrder("ord_deny_cancel");
    await handlePetpoojaWebhook({
      order_id: "ord_deny_cancel",
      restID: "31z58ciw0h",
      status: "Cancel",
      cancel_reason: "forged",
    });
    expectCanonicalStateUntouched("ord_deny_cancel");
    expect(
      savedDocs["refunds/refund_pos_cancel_ord_deny_cancel"]
    ).toBeUndefined();
  });
});

describe("handlePetpoojaWebhook — explicit verified context writes canonical state", () => {
  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
  });

  it("applies an accepted claim", async () => {
    seedLinkedOrder("ord_auth_accept");
    await handlePetpoojaWebhook(
      {
        order_id: "ord_auth_accept",
        restID: "31z58ciw0h",
        orderID: "ord_auth_accept",
        status: "Accept",
      },
      { authenticated: true }
    );
    const doc = savedDocs["orders/ord_auth_accept"];
    expect(doc.status).toMatchObject({ code: "CONFIRMED", terminal: false });
    expect(doc.petpoojaKitchenStatus).toBe("Accept");
    expect(doc.petpoojaStatus).toBe("synced");
    expect(doc.petpoojaSyncStatus).toBe("synced");
    expect(savedDocs["unmatched_petpooja_orders/upo_ord_auth_accept"]).toBeUndefined();
  });

  it("applies a cancelled claim and parks the refund request", async () => {
    seedLinkedOrder("ord_auth_cancel");
    await handlePetpoojaWebhook(
      {
        order_id: "ord_auth_cancel",
        restID: "31z58ciw0h",
        status: "Cancel",
        cancel_reason: "kitchen closed",
      },
      { authenticated: true }
    );
    const doc = savedDocs["orders/ord_auth_cancel"];
    expect(doc.status).toMatchObject({ code: "CANCELLED", terminal: true });
    expect(doc.petpoojaKitchenStatus).toBe("Cancel");
    expect(savedDocs["refunds/refund_pos_cancel_ord_auth_cancel"]).toMatchObject({
      orderId: "ord_auth_cancel",
      status: "PENDING",
      reason: "POS_CANCELLED",
    });
    expect(doc["payment.refundStatus"]).toBe("PENDING_APPROVAL");
  });

  it("applies a delivered claim", async () => {
    seedLinkedOrder("ord_auth_delivered");
    await handlePetpoojaWebhook(
      { order_id: "ord_auth_delivered", restID: "31z58ciw0h", status: "10" },
      { authenticated: true }
    );
    expect(savedDocs["orders/ord_auth_delivered"].status).toMatchObject({
      code: "DELIVERED",
      kind: "completed",
      terminal: true,
    });
  });
});

describe("handlePetpoojaStockWebhook — default-deny without a verified context", () => {
  const PRODUCT_PATH = "products/prod_unlinked_pp_item_1";

  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    // An existing live product: a refused toggle must not overwrite it.
    savedDocs[PRODUCT_PATH] = { inStock: true };
  });

  it.each([
    ["omitted", undefined],
    ["empty object", {}],
    ["malformed string", { authenticated: "true" }],
    ["explicit false", { authenticated: false }],
  ])("does not change stock with an %s auth context", async (_label, auth) => {
    await handlePetpoojaStockWebhook(
      { rest_id: "31z58ciw0h", item_id: "pp_item_1", in_stock: 0 },
      auth
    );
    expect(savedDocs[PRODUCT_PATH].inStock).toBe(true);
    expect(savedDocs["petpooja_stock_hints/sh_pp_item_1"]).toMatchObject({
      itemId: "pp_item_1",
      trusted: false,
      rawInStock: 0,
    });
  });

  it("applies the stock toggle with an explicit verified context", async () => {
    // The linked outlet + its canonical branch-scoped product (the handler
    // never creates orphan prod_unlinked_* docs: an unlinked outlet parks in
    // unmatched_petpooja_stock instead).
    savedDocs["branches/branch_t1"] = { petpoojaStoreId: "31z58ciw0h", name: "HL Road" };
    const canonical = "products/prod_branch_t1_pp_item_1";
    savedDocs[canonical] = {
      id: "prod_branch_t1_pp_item_1",
      branchId: "branch_t1",
      petpoojaItemId: "pp_item_1",
      inStock: true,
    };
    await handlePetpoojaStockWebhook(
      { rest_id: "31z58ciw0h", item_id: "pp_item_1", in_stock: 0 },
      { authenticated: true }
    );
    expect(savedDocs[canonical].inStock).toBe(false);
    expect(savedDocs[canonical].petpoojaItemId).toBe("pp_item_1");
    expect(savedDocs["petpooja_stock_hints/sh_pp_item_1"]).toBeUndefined();
  });
});

// ROUTE WIRING pin (source contract). There is no HTTP harness here, and the
// handlers are default-deny, so a route that forgets to forward the verified
// flag would fail closed — silently breaking every genuine Pos callback.
// Assert the real routes forward the middleware's strict boolean.
const indexSource = readFileSync(resolve(__dirname, "../src/index.ts"), "utf8");

function routeBlock(route: string): string {
  // Anchor on the ROUTE declaration, not on the audit endpoint string that
  // also carries the same path inside the handler.
  const match = indexSource.match(new RegExp(`app\\.post\\(\\s*"${route}"`));
  if (!match || match.index === undefined) {
    throw new Error(`Could not locate route ${route} in src/index.ts`);
  }
  return indexSource.slice(match.index, match.index + 900);
}

describe("Petpooja route wiring — verified context reaches the handlers", () => {
  it("passes the verified flag to the stock webhook handler", () => {
    const block = routeBlock("/petpooja/stockWebhook");
    expect(block).toMatch(
      /handlePetpoojaStockWebhook\(\s*p,\s*\{\s*authenticated:\s*\(req as any\)\.petpoojaAuthenticated === true\s*,?\s*\}\s*\)/
    );
    // The old one-argument call is gone.
    expect(block).not.toMatch(/handlePetpoojaStockWebhook\(\s*p\s*\)/);
  });

  it("passes the verified flag to the order webhook handler", () => {
    const block = routeBlock("/petpooja/webhook");
    expect(block).toMatch(
      /handlePetpoojaWebhook\(\s*p,\s*\{\s*authenticated:\s*\(req as any\)\.petpoojaAuthenticated === true\s*,?\s*\}\s*\)/
    );
    // An absent flag used to read as trusted via `!== false` — that is the bug.
    expect(block).not.toMatch(/petpoojaAuthenticated !== false/);
  });
});
