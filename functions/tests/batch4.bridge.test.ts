import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// B4-S1 bridge gates: menu chunk-limit (≤500 writes/batch) + porter webhook
// event-id dedup + indexed branch resolve (no full-scan fallback).
const { mockDb, savedDocs, counters } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const counters = { batchCommits: 0, orderSets: 0, colGets: 0 };
  const mergeSet = (colName: string, docId: string, data: any) => {
    if (colName === "orders") counters.orderSets++;
    savedDocs[`${colName}/${docId}`] = {
      ...(savedDocs[`${colName}/${docId}`] || {}),
      ...data,
    };
  };
  const readDoc: any = (colName: string, docId: string) => {
    const snap: any = {
      exists: true,
      data: () =>
        savedDocs[`${colName}/${docId}`] || {
          branchId: "branch_ahmedabad_1",
          status: "ready",
        },
      ref: {
        get: vi.fn(async () => readDoc(colName, docId)),
        set: vi.fn(async (data: any) => mergeSet(colName, docId, data)),
      },
    };
    return snap;
  };
  const mockDb: any = {
    batch: () => ({
      set: vi.fn((docRef: any, data: any) => {
        savedDocs[`batched/${docRef.id || "last"}`] = data;
      }),
      commit: async () => {
        counters.batchCommits++;
      },
    }),
    collection: (colName: string) => ({
      doc: (docId: string) => ({
        id: docId,
        set: vi.fn(async (data: any) => mergeSet(colName, docId, data)),
        get: vi.fn(async () => readDoc(colName, docId)),
      }),
      // Indexed-query surface for resolveBranchIdForRestId.
      where: vi.fn((_field: string, _op: string, val: any) => ({
        limit: vi.fn((_n: number) => ({
          get: async () => ({
            docs: [{ id: `branch_for_${val}`, data: () => ({ petpoojaStoreId: val }) }],
          }),
        })),
      })),
      // Full-scan fallback surface: must NEVER be called after B4-S1.
      get: vi.fn(async () => {
        counters.colGets++;
        return { docs: [] };
      }),
      limit: vi.fn(() => ({
        get: async () => {
          counters.colGets++;
          return { docs: [] };
        },
      })),
    }),
  };
  return { mockDb, savedDocs, counters };
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

import { syncPetpoojaMenu } from "../src/modules/petpooja/menuSyncWebhook";
import { resolveBranchIdForRestId } from "../src/modules/petpooja/item86ingSync";
import { handlePorterWebhook } from "../src/modules/porter/porter.service";
import { computeHmacSha256 } from "../src/core/security";
import { config } from "../src/config/env";

const TEST_PORTER_WEBHOOK_SECRET = "test_porter_whsec_b4_only";

describe("B4-S1 bridge gates", () => {
  let prevPetpoojaMock = false;
  let prevPorterSecret = "";
  let prevFetch: any;

  beforeEach(() => {
    prevPetpoojaMock = config.mock.petpoojaPos;
    prevPorterSecret = config.porter.webhookSecret;
    config.porter.webhookSecret = TEST_PORTER_WEBHOOK_SECRET;
    prevFetch = (global as any).fetch;
    for (const k of Object.keys(savedDocs)) delete savedDocs[k];
    counters.batchCommits = 0;
    counters.orderSets = 0;
    counters.colGets = 0;
  });

  afterEach(() => {
    config.mock.petpoojaPos = prevPetpoojaMock;
    config.porter.webhookSecret = prevPorterSecret;
    (global as any).fetch = prevFetch;
  });

  it("chunks a >500-SKU menu into multiple ≤500-write batches", async () => {
    config.mock.petpoojaPos = false;
    // Loop 6 contract: live sync requires a linked outlet.
    savedDocs["branches/branch_bulk_1"] = { petpoojaStoreId: "rest_bulk_1" };
    const items = Array.from({ length: 1200 }, (_, i) => ({
      itemid: `sku_${i}`,
      itemname: `Item ${i}`,
      price: 100 + (i % 50),
      itemcategoryname: "Bulk",
      itemcategoryid: "cat_bulk",
      in_stock: 1,
      item_attributeid: "1",
    }));
    (global as any).fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ items, categories: [{ categoryid: "cat_bulk" }] }),
    }));

    const result = await syncPetpoojaMenu("branch_bulk_1");
    expect(result.itemCount).toBe(1200);
    // 1200 SKUs at ≤500 writes/batch → at least 3 commits (never 1).
    expect(counters.batchCommits).toBeGreaterThanOrEqual(3);
  });

  it("refuses live sync for an unlinked branch instead of pulling the wrong outlet", async () => {
    config.mock.petpoojaPos = false;
    (global as any).fetch = vi.fn(async () => {
      throw new Error("must not be called — sync refuses before fetch");
    });
    await expect(syncPetpoojaMenu("branch_unlinked_9")).rejects.toThrow(
      /no linked Petpooja outlet/
    );
  });

  it("skips a redelivered Porter webhook via event-id dedup (single order write)", async () => {
    config.mock.petpoojaPos = true;
    const rawBody = "dedup_raw_body_b4";
    const sig = computeHmacSha256(rawBody, TEST_PORTER_WEBHOOK_SECRET);
    const payload = {
      event: "IN_TRANSIT",
      request_id: "REQ-order_dedup_1",
      order_id: "PRTR-ORD-DEDUP1",
    };

    await handlePorterWebhook(rawBody, sig, payload);
    expect(savedDocs["orders/order_dedup_1"]?.deliveryStatus).toBe("in_transit");
    const setsAfterFirst = counters.orderSets;
    expect(setsAfterFirst).toBeGreaterThan(0);

    // Exact redelivery: same event + refs + body → same parkId → skipped.
    await handlePorterWebhook(rawBody, sig, payload);
    expect(counters.orderSets).toBe(setsAfterFirst);
    const seenKey = Object.keys(savedDocs).find((k) => k.startsWith("porter_webhook_events/"));
    expect(seenKey).toBeDefined();
    expect(savedDocs[seenKey!]?.status).toBe("processed");
  });

  it("parks a webhook whose hint conflicts with the server order map", async () => {
    const rawBody = "conflict_raw_b4";
    const sig = computeHmacSha256(rawBody, TEST_PORTER_WEBHOOK_SECRET);
    // Bind PRTR-ORD-MAPPED to order_mapped_real via the server map.
    savedDocs["porter_order_map/PRTR-ORD-MAPPED"] = {
      orderId: "order_mapped_real",
      branchId: "branch_ahmedabad_1",
    };

    await handlePorterWebhook(rawBody, sig, {
      event: "DELIVERED",
      request_id: "REQ-order_mapped_fake",
      order_id: "PRTR-ORD-MAPPED",
    });

    // Wrong order untouched, conflict parked.
    expect(savedDocs["orders/order_mapped_fake"]?.deliveryStatus).toBeUndefined();
    const parked = Object.keys(savedDocs).find((k) => k.startsWith("unmatched_porter_events/"));
    expect(parked).toBeDefined();
    expect(savedDocs[parked!]?.reason).toBe("order_id_conflict");
  });

  it("resolves branches via indexed where+limit(1) with zero full scans", async () => {
    const branchId = await resolveBranchIdForRestId("rest_abc");
    expect(branchId).toBe("branch_for_rest_abc");
    expect(counters.colGets).toBe(0);
    expect(await resolveBranchIdForRestId("")).toBeNull();
  });
});
