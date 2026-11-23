import { describe, expect, it } from "vitest";
import { verifyGatewayNonCapturable } from "../src/modules/coupons/couponObligationWorker";

const NOW = 1_800_000_000_000;
const check = (payments: any[] | undefined) =>
  verifyGatewayNonCapturable("rzp_order", payments as any, NOW);

describe("r6 gateway non-capturability classifier", () => {
  it.each(["captured", "authorized", "authorised", "created", "attempted", "pending", "processing"])(
    "treats a %s payment as still capturable",
    async (status) => {
      const result = await check([{ id: "pay_1", status, amount: 5000 }]);
      expect(result.state).toBe("capturable");
    },
  );

  it("treats only failed payments as non-capturable", async () => {
    expect((await check([{ id: "pay_f", status: "failed", amount: 0 }])).state).toBe("non_capturable");
  });

  it("treats a positive unrefunded amount as blocking even with an odd status", async () => {
    expect((await check([{ id: "pay_x", status: "weird", amount: 5000, amount_refunded: 0 }])).state).toBe("capturable");
  });

  it("keeps the hold on a malformed or missing provider answer (error path)", async () => {
    expect((await check(undefined)).state).toBe("uncertain");
    expect((await check({ items: [] } as any)).state).toBe("uncertain");
  });
});
