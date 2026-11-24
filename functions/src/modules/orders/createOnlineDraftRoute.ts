import type { Response } from "express";
import type { AuthenticatedRequest } from "../../core/middleware";
import { createOnlineDraft, OnlineDraftError, retireOnlineDraft } from "./createOnlineDraft";
import { isCouponRefusal } from "../coupons/couponAuthority";

export async function handleCreateOnlineDraft(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    if (req.body?.operation === "retire") {
      res.status(200).json(await retireOnlineDraft(req.user?.uid ?? "", req.body));
      return;
    }
    const receipt = await createOnlineDraft(req.user?.uid ?? "", req.body);
    res.status(receipt.replayed ? 200 : 201).json(receipt);
  } catch (error: unknown) {
    if (error instanceof OnlineDraftError) {
      res.status(error.statusCode).json({ code: error.code, error: error.message });
      return;
    }
    if (isCouponRefusal(error)) {
      const refusal = error as Error & { code: string; statusCode: number };
      res.status(refusal.statusCode).json({ code: refusal.code, error: refusal.message });
      return;
    }
    res.status(503).json({ code: "ONLINE_DRAFT_UNAVAILABLE", error: "Online checkout is temporarily unavailable." });
  }
}
