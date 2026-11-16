import { beforeEach, describe, expect, it, vi } from "vitest";

const { documents, database } = vi.hoisted(() => {
  const documents: Record<string, Record<string, unknown>> = {};
  const reference = (collection: string, id: string) => ({
    path: `${collection}/${id}`,
    get: async () => ({ exists: !!documents[`${collection}/${id}`], data: () => documents[`${collection}/${id}`] }),
  });
  return {
    documents,
    database: {
      collection: (name: string) => ({ doc: (id: string) => reference(name, id) }),
      runTransaction: async (callback: (transaction: unknown) => Promise<unknown>) => callback({
        get: async (ref: { path: string }) => ({ exists: !!documents[ref.path], data: () => documents[ref.path] }),
        update: (ref: { path: string }, data: Record<string, unknown>) => { documents[ref.path] = { ...documents[ref.path], ...data }; },
      }),
    },
  };
});

vi.mock("../src/core/firebase", () => ({ db: database }));
vi.mock("firebase-admin", () => ({ firestore: { FieldValue: { serverTimestamp: () => "timestamp", arrayUnion: (value: unknown) => [value] } } }));

import { bumpOrderStatus } from "../src/modules/orders/orderStatus";

describe("walk-in payment progression", () => {
  beforeEach(() => {
    documents["orders/walkin"] = {
      customerId: "cust_walkin", branchId: "b1", fulfillment: "takeaway",
      status: { code: "PLACED", terminal: false }, paymentMethod: "upi", paymentStatus: "pending",
      payment: { method: "upi", status: "pending" },
    };
  });

  it("refuses pending UPI before changing the order", async () => {
    const before = JSON.stringify(documents["orders/walkin"]);
    await expect(bumpOrderStatus({ orderId: "walkin", status: "accepted" })).rejects.toMatchObject({ code: "ORDER_NOT_PAID", statusCode: 409 });
    expect(JSON.stringify(documents["orders/walkin"])).toBe(before);
  });

  it("allows pending COD to enter the kitchen", async () => {
    documents["orders/walkin"].paymentMethod = "cod";
    documents["orders/walkin"].payment = { method: "cod", status: "pending" };
    await expect(bumpOrderStatus({ orderId: "walkin", status: "accepted" })).resolves.toMatchObject({ status: { code: "CONFIRMED" } });
  });
});
