import type { Response } from "express";
import type { AuthenticatedRequest } from "../../core/middleware";
import { createWalkIn, WalkInError } from "./createWalkIn";

export async function handleCreateWalkIn(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const receipt = await createWalkIn(req.user?.uid ?? "", req.body);
    res.status(receipt.replayed ? 200 : 201).json(receipt);
  } catch (error: unknown) {
    if (error instanceof WalkInError) {
      res.status(error.statusCode).json({ code: error.code, error: error.message, ...(error.totals ? { totals: error.totals } : {}) });
      return;
    }
    res.status(503).json({ code: "WALKIN_UNAVAILABLE", error: "Walk-in creation is temporarily unavailable." });
  }
}
