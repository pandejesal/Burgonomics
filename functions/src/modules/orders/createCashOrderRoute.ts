import type { Response } from "express";
import type { AuthenticatedRequest } from "../../core/middleware";
import { createCashOrder, CashOrderError } from "./createCashOrder";

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
    res
      .status(503)
      .json({ code: "CASH_ORDER_UNAVAILABLE", error: "Cash ordering is temporarily unavailable." });
  }
}
