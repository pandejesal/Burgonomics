import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F4 (staging 2026-11-21, Test 7): the counter bill the till shows did not
 * match the bill the server booked — HL Road's ₹15 packaging was missing from
 * the preview.
 *
 * Root cause: the Partner modal computed the bill itself (food + an inline GST
 * figure + a separately fetched order-level packaging fee) and posted that
 * number as `expectedTotalPaise`, so the preview and the charge were two
 * independent money paths. This test pins the fix: ONE server quote, priced by
 * the same builder the create transaction calls, that a packaging-charging
 * branch bills identically in preview and booking.
 *
 * RED before the fix: `quoteWalkIn` does not exist, so the till had no server
 * bill to show and had to invent one.
 */
const state = vi.hoisted(() => {
  const docs: Record<string, any> = {};
  let tail = Promise.resolve();
  const db = {
    collection: (collection: string) => ({
      doc: (id = "audit") => ({
        path: `${collection}/${id}`,
        id,
        get: async () => ({
          exists: Object.hasOwn(docs, `${collection}/${id}`),
          data: () => docs[`${collection}/${id}`],
        }),
      }),
    }),
    runTransaction: async (callback: (tx: any) => Promise<any>) => {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      const writes: Array<{ path: string; data: any }> = [];
      let wrote = false;
      try {
        const result = await callback({
          get: async (ref: { path: string }) => {
            if (wrote) throw new Error("Firestore reads must precede writes");
            return { exists: Object.hasOwn(docs, ref.path), data: () => docs[ref.path] };
          },
          create: (ref: { path: string }, data: any) => {
            wrote = true;
            if (Object.hasOwn(docs, ref.path)) throw new Error("already exists");
            writes.push({ path: ref.path, data });
          },
          set: (ref: { path: string }, data: any) => {
            wrote = true;
            writes.push({ path: ref.path, data });
          },
        });
        for (const write of writes) docs[write.path] = write.data;
        return result;
      } finally {
        release();
      }
    },
  };
  return { docs, db };
});
vi.mock("../src/core/firebase", () => ({ db: state.db }));
vi.mock("firebase-admin", () => ({
  firestore: { FieldValue: { serverTimestamp: () => "timestamp" } },
}));

import { createWalkIn } from "../src/modules/orders/createWalkIn";
import { quoteWalkIn } from "../src/modules/orders/walkInQuote";

const cart = {
  branchId: "hl-road",
  orderType: "takeaway" as const,
  items: [{ productId: "p1", quantity: 1 }],
};
const bind = (expectedTotalPaise: number) => ({
  ...cart,
  requestId: "request-f4",
  tender: "cash" as const,
  expectedTotalPaise,
});
const orders = () => Object.entries(state.docs).filter(([path]) => path.startsWith("orders/"));

beforeEach(() => {
  for (const key of Object.keys(state.docs)) delete state.docs[key];
  state.docs["admins/staff"] = { role: "branch_staff", branchIds: ["hl-road"] };
  // HL Road charges ₹15 packaging, exactly as the staging branch does.
  state.docs["branches/hl-road"] = {
    name: "Burgonomics - HL Road",
    city: "Ahmedabad",
    packagingFee: 15,
  };
  state.docs["products/p1"] = {
    name: "Burger",
    branchId: "hl-road",
    price: 100,
    inStock: true,
  };
});

describe("counter bill preview vs booking (F4)", () => {
  it("quotes the packaging-charging branch total the booking actually charges", async () => {
    const quote = await quoteWalkIn("staff", cart);
    expect(quote.totals.foodSubtotal).toBe(100);
    expect(quote.totals.packagingFee).toBe(15);
    expect(quote.totals.grandTotal).toBe(115);
    expect(quote.totals.split.totalAmountPaise).toBe(11500);
    expect(quote.branchName).toBe("Burgonomics - HL Road");
  });

  it("books exactly the quoted total when the till confirms the quote", async () => {
    const quote = await quoteWalkIn("staff", cart);
    // The till confirms the quote verbatim: preview == charge, by construction.
    const receipt = await createWalkIn(
      "staff",
      bind(quote.totals.split.totalAmountPaise)
    );
    expect(receipt.replayed).toBe(false);
    expect(receipt.totals).toEqual(quote.totals);
    expect(receipt.totals.grandTotal).toBe(115);
    expect(receipt.totals.packagingFee).toBe(15);
    expect(receipt.branchName).toBe(quote.branchName);
    // And the stored order carries the same money the customer was shown.
    expect(state.docs[`orders/${receipt.orderId}`].pricing.grandTotal).toBe(115);
    expect(state.docs[`orders/${receipt.orderId}`].total).toBe(115);
  });

  it("prices dine-in with no packaging on the same branch (the one P2 rule)", async () => {
    const quote = await quoteWalkIn("staff", { ...cart, orderType: "dinein" });
    expect(quote.totals.packagingFee).toBe(0);
    expect(quote.totals.grandTotal).toBe(100);
  });

  it("quotes nothing and writes nothing for a foreign branch", async () => {
    await expect(
      quoteWalkIn("staff", { ...cart, branchId: "other-outlet" })
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(orders()).toHaveLength(0);
  });

  it("refuses an item the catalogue cannot verify", async () => {
    state.docs["products/p1"].inStock = false;
    await expect(quoteWalkIn("staff", cart)).rejects.toMatchObject({
      statusCode: 503,
      code: "ITEM_UNAVAILABLE",
    });
  });

  it("refuses delivery quotes like the create route does", async () => {
    await expect(
      quoteWalkIn("staff", { ...cart, orderType: "delivery" })
    ).rejects.toMatchObject({ statusCode: 422, code: "ORDER_TYPE_UNSUPPORTED" });
  });
});
