import type { Response } from "express";
import type { AuthenticatedRequest } from "../../core/middleware";
import { createCashOrder, CashOrderError } from "./createCashOrder";
import { isCouponRefusal } from "../coupons/couponAuthority";

export async function handleCreateCashOrder(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const receipt = await createCashOrder(req.user?.uid ?? "", req.body);
    res.status(receipt.replayed ? 200 : 201).json(receipt);
  } catch (error: unknown) {
    if (error instanceof CashOrderError) {
      res.status(error.statusCode).json({
        code: error.code,
        error: error.message,
        ...(error.totals ? { totals: error.totals } : {}),
      });
      return;
    }
    // A known coupon cause is the customer's to fix, never an outage. Keep the
    // authority's code even if a caller path throws before it is wrapped.
    if (isCouponRefusal(error)) {
      const refusal = error as Error & { code: string; statusCode: number };
      res.status(refusal.statusCode).json({ code: refusal.code, error: refusal.message });
      return;
    }
    res
      .status(503)
      .json({ code: "CASH_ORDER_UNAVAILABLE", error: "Cash ordering is temporarily unavailable." });
  }
}
