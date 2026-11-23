import { beforeEach, describe, expect, it, vi } from "vitest";

/** fr-checkout r2 — A4: a missing storefront link must FAIL CLOSED. */
const h = vi.hoisted(() => {
  process.env.BURGONOMICS_ENV = "dev";
  const docs = new Map<string, any>();
  const copy = (v: any) => (v === undefined ? undefined : structuredClone(v));
  const apply = (path: string, data: any, merge?: boolean) => {
    docs.set(path, merge ? { ...(docs.get(path) ?? {}), ...copy(data) } : copy(data));
  };
  const ref = (collection: string, id: string) => ({
    id,
    path: `${collection}/${id}`,
    get: async () => ({ exists: docs.has(`${collection}/${id}`), id, data: () => copy(docs.get(`${collection}/${id}`)) }),
    set: async (data: any, opts?: { merge?: boolean }) => apply(`${collection}/${id}`, data, opts?.merge),
  });
  const collection = (name: string) => ({
    doc: (id: string) => ref(name, id),
    where: (field: string, _op: string, value: any) => ({
      limit: (n: number) => ({
        get: async () => ({
          docs: [...docs.entries()]
            .filter(([path, data]) => path.startsWith(`${name}/`) && data?.[field] === value)
            .slice(0, n)
            .map(([path, data]) => ({ id: path.slice(name.length + 1), data: () => copy(data) })),
        }),
      }),
    }),
  });
  const db: any = {
    collection,
    runTransaction: async (cb: (tx: any) => Promise<any>) => {
      const pending: Array<() => void> = [];
      let wrote = false;
      const tx = {
        get: async (r: any) => {
          if (wrote) throw new Error("FIRESTORE_READ_AFTER_WRITE");
          return r.get();
        },
        set: (r: any, data: any, opts?: { merge?: boolean }) => {
          wrote = true;
          pending.push(() => apply(r.path, data, opts?.merge));
        },
      };
      const result = await cb(tx);
      for (const w of pending) w();
      return result;
    },
  };
  return { docs, db };
});

vi.mock("../src/core/firebase", () => ({ db: h.db }));
vi.mock("firebase-admin", () => {
  const firestore: any = vi.fn(() => h.db);
  firestore.FieldValue = { serverTimestamp: () => "TS", increment: (n: number) => n, delete: () => "DEL" };
  return {
    default: { firestore: vi.fn(() => h.db), auth: vi.fn(() => ({})), initializeApp: vi.fn(), apps: [{ name: "mock" }] },
    firestore,
    auth: vi.fn(() => ({})),
    initializeApp: vi.fn(),
    apps: [{ name: "mock" }],
  };
});

import {
  assertOutletOpenForOnlineOrders,
  assertStorefrontOpenAndMatching,
  resolveCanonicalStorefront,
} from "../src/modules/payments/outletStatus";
import { createCashOrder } from "../src/modules/orders/createCashOrder";

beforeEach(() => h.docs.clear());

describe("A4 — verified canonical link required", () => {
  it("rejects an existing storefront with no branch link", async () => {
    h.docs.set("stores/s_unlinked", { isOpen: true });
    await expect(assertOutletOpenForOnlineOrders({ storeId: "s_unlinked", branchId: "b1" })).rejects.toMatchObject({
      code: "STORE_NOT_LINKED",
    });
  });

  it("rejects a storefront whose link names a different branch", async () => {
    h.docs.set("stores/s_wrong", { isOpen: true, partnerBranchId: "b_other" });
    await expect(assertOutletOpenForOnlineOrders({ storeId: "s_wrong", branchId: "b1" })).rejects.toMatchObject({
      code: "STOREFRONT_BRANCH_MISMATCH",
    });
  });

  it("a missing link on a resolved storefront is refused in the pure transaction gate", () => {
    expect(() => assertStorefrontOpenAndMatching({ isOpen: true }, "s_unlinked", "b1")).toThrow();
  });

  it("accepts the admin_stores fallback when it is open and linked", async () => {
    h.docs.set("admin_stores/s_fallback", { partnerBranchId: "b1", isOpen: true });
    const resolved = await resolveCanonicalStorefront({ storeId: "s_fallback", branchId: "b1" });
    expect(resolved?.collection).toBe("admin_stores");
    await expect(
      assertOutletOpenForOnlineOrders({ storeId: "s_fallback", branchId: "b1" })
    ).resolves.toMatchObject({ storeId: "s_fallback" });
  });

  it("a concurrent close is refused by the cash CREATE transaction", async () => {
    h.docs.set("stores/s_closed", { partnerBranchId: "b1", isOpen: false });
    h.docs.set("branches/b1", { packagingFee: 15, cashOnDelivery: { enabled: true, maxOrderValuePaise: 500000 } });
    h.docs.set("products/p1", { branchId: "b1", name: "Burger", price: 100, inStock: true });
    await expect(
      createCashOrder("cust_1", {
        orderId: "ord_closed_r2", storeId: "s_closed", orderType: "takeaway",
        items: [{ productId: "p1", quantity: 1 }], expectedTotalPaise: 11500,
      })
    ).rejects.toMatchObject({ code: "STORE_CLOSED" });
    expect(h.docs.has("orders/ord_closed_r2")).toBe(false);
  });
});
