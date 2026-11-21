import type { Response } from "express";
import type { AuthenticatedRequest } from "../../core/middleware";
import { WalkInError } from "./walkInErrors";
import { quoteWalkIn } from "./walkInQuote";

/**
 * `POST /orders/walkInQuote` — the read-only bill the counter till shows before
 * it confirms. Same error contract as the create route so the Partner app has
 * one handler for both.
 */
export async function handleWalkInQuote(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const quote = await quoteWalkIn(req.user?.uid ?? "", req.body);
    res.status(200).json(quote);
  } catch (error: unknown) {
    if (error instanceof WalkInError) {
      res.status(error.statusCode).json({
        code: error.code,
        error: error.message,
        ...(error.totals ? { totals: error.totals } : {}),
      });
      return;
    }
    res.status(503).json({
      code: "WALKIN_UNAVAILABLE",
      error: "Walk-in pricing is temporarily unavailable.",
    });
  }
}
