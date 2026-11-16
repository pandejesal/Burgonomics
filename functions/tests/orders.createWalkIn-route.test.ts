import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/core/firebase", () => ({ db: {} }));
import * as service from "../src/modules/orders/createWalkIn";
import { WalkInError } from "../src/modules/orders/createWalkIn";
import { handleCreateWalkIn } from "../src/modules/orders/createWalkInRoute";

describe("walk-in route", () => {
  it("wires revocation-checking auth and strict validation", () => {
    const source = readFileSync(resolve(__dirname, "../src/index.ts"), "utf8");
    expect(source).toMatch(/"\/orders\/createWalkIn",\s*requireAuth,\s*validateBody\(createWalkInSchema\),\s*handleCreateWalkIn/);
  });
  it("returns authentication failure without entering the database", async () => {
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handleCreateWalkIn({ body: {} } as never, response as never);
    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ code: "UNAUTHENTICATED" }));
  });
  it("returns the authoritative breakdown on a price conflict", async () => {
    const totals = { grandTotal: 100 } as service.WalkInReceipt["totals"];
    const spy = vi.spyOn(service, "createWalkIn").mockRejectedValueOnce(new WalkInError(409, "PRICE_CHANGED", "changed", totals));
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handleCreateWalkIn({ user: { uid: "staff" }, body: {} } as never, response as never);
    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith({ code: "PRICE_CHANGED", error: "changed", totals });
    spy.mockRestore();
  });
  it.each([false, true])("returns the receipt with replayed=%s", async (replayed) => {
    const receipt = { orderId: "order", replayed, paymentStatus: "pending", totals: { grandTotal: 100 }, settlementAvailable: false } as service.WalkInReceipt;
    const spy = vi.spyOn(service, "createWalkIn").mockResolvedValueOnce(receipt);
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handleCreateWalkIn({ user: { uid: "staff" }, body: {} } as never, response as never);
    expect(response.status).toHaveBeenCalledWith(replayed ? 200 : 201);
    expect(response.json).toHaveBeenCalledWith(receipt);
    spy.mockRestore();
  });
});
