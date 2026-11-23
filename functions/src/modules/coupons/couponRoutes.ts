import type { Request, Response } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../../core/middleware";
import { calculateOrderPricing } from "../payments/pricing.engine";
import { resolveBranchId } from "../payments/branchResolver";
import { quoteCoupon, couponMessage } from "./couponAuthority";
import {
  createCoupon,
  createCouponSchema,
  issueCouponSchema,
  issueCouponToCustomer,
  listAvailableCoupons,
  listCouponUsage,
  listCoupons,
  setCouponActive,
  setCouponActiveSchema,
} from "./couponService";

/**
 * HTTP surface for the coupon authority. Mounted from `src/index.ts` (the only
 * shared file this package edits).
 *
 * Customer side (the ONLY way the app learns a discount):
 *   POST /coupons/quote     — server prices the cart from the catalogue and
 *                             answers with the discount and the items total.
 *   GET  /coupons/available — the offers screen's list, filtered server-side.
 *
 * Staff side (owner / brand roles only — enforced at the route):
 *   POST /coupons/create    — create or update a coupon
 *   POST /coupons/active    — the disable/enable switch
 *   POST /coupons/issue     — issue a coupon to one customer
 *   GET  /coupons/usage     — usage rows for one coupon
 *   GET  /coupons/list      — every coupon with live usage
 */

export const couponQuoteSchema = z.object({
  code: z.string().trim().min(1).max(64),
  branchId: z.string().trim().min(1).max(128).optional(),
  /** The customer app knows its outlet as a STORE; the server maps it. */
  storeId: z.string().trim().min(1).max(128).optional(),
  items: z
    .array(
      z.object({
        productId: z.string().trim().min(1).max(128),
        quantity: z.number().int().min(1).max(99),
        price: z.number().min(0).max(100000).optional(),
        // M9: the priced SELECTIONS (option ids) travel with the quote, so the
        // coupon is evaluated against the same catalogue-priced basket that
        // cash create and online checkout price — not a bare base price.
        customizations: z.array(z.any()).max(50).optional(),
        modifiers: z.array(z.any()).max(50).optional(),
      })
    )
    .min(1)
    .max(100),
});

function statusFor(err: any): number {
  const status = Number(err?.statusCode);
  if ([400, 401, 403, 404, 409, 422, 503].includes(status)) return status;
  return 500;
}

/**
 * POST /coupons/quote
 *
 * The cart is priced by the SAME engine that charges it (catalogue prices, not
 * the request's), then the coupon is evaluated by the ONE authority. Nothing
 * here trusts a client-supplied subtotal or discount.
 */
export async function handleCouponQuote(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const body = req.body as z.infer<typeof couponQuoteSchema>;
    // Resolve the branch the same way the payment does (store → linked branch).
    // A store that is not linked yet cannot honour a branch-scoped coupon, so
    // the resolution failure is not fatal for a preview: brand-wide codes still
    // quote, and a branch-scoped one refuses with its own honest message.
    let branchId = body.branchId ?? "";
    if (!branchId && body.storeId) {
      try {
        branchId = await resolveBranchId({ storeId: body.storeId });
      } catch {
        branchId = "";
      }
    }
    // Food subtotal comes from the server catalogue. "takeaway" is used only to
    // obtain the subtotal — packaging and delivery are the fees route's job, so
    // no delivery quote is needed for a discount preview.
    const priced = await calculateOrderPricing({
      items: body.items as any,
      // `branchId` is required by the engine's type; an absent one already
      // degrades to the documented default packaging (flagged separately), so
      // the quote never invents a branch.
      branchId,
      orderType: "takeaway",
    });
    const quote = await quoteCoupon({
      code: body.code,
      foodSubtotal: priced.foodSubtotal,
      branchId: branchId || null,
      customerId: req.user?.uid ?? null,
    });
    res.status(200).json({
      valid: quote.eligible,
      code: quote.code,
      title: quote.title,
      discount: quote.discount,
      subtotal: quote.subtotal,
      totalAfterDiscount: quote.totalAfterDiscount,
      message: quote.message,
      reason: quote.reason,
    });
  } catch (err: any) {
    const status = statusFor(err);
    res.status(status).json({
      valid: false,
      error: err?.message || couponMessage("COUPON_INVALID"),
      code: err?.code || "COUPON_QUOTE_FAILED",
    });
  }
}

/** GET /coupons/available — the offers screen's data, server-filtered. */
export async function handleListAvailableCoupons(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const branchId =
      typeof req.query.branchId === "string" && req.query.branchId.trim()
        ? req.query.branchId.trim()
        : null;
    const coupons = await listAvailableCoupons({
      branchId,
      customerId: req.user?.uid ?? null,
    });
    res.status(200).json({ coupons });
  } catch (err: any) {
    res.status(503).json({
      coupons: [],
      error: "Coupons are temporarily unavailable — please try again.",
    });
  }
}

/** POST /coupons/create — create or update. Owner / brand roles only. */
export async function handleCreateCoupon(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const parsed = createCouponSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Check the coupon details and try again.", code: "COUPON_INVALID" });
      return;
    }
    const coupon = await createCoupon(parsed.data, {
      uid: req.user!.uid,
      role: String((req.user as any)?.role ?? ""),
    });
    res.status(200).json({ coupon });
  } catch (err: any) {
    res.status(statusFor(err)).json({
      error: err?.message || "Could not save the coupon.",
      code: err?.code,
    });
  }
}

/** POST /coupons/active — the disable/enable switch. */
export async function handleSetCouponActive(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const parsed = setCouponActiveSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "A coupon code and active flag are required.", code: "COUPON_INVALID" });
      return;
    }
    const result = await setCouponActive(parsed.data, { uid: req.user!.uid });
    res.status(200).json(result);
  } catch (err: any) {
    res.status(statusFor(err)).json({
      error: err?.message || "Could not update the coupon.",
      code: err?.code,
    });
  }
}

/** POST /coupons/issue — issue a coupon to one customer. */
export async function handleIssueCoupon(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const parsed = issueCouponSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Check the coupon details and try again.", code: "COUPON_INVALID" });
      return;
    }
    const result = await issueCouponToCustomer(parsed.data, {
      uid: req.user!.uid,
      role: String((req.user as any)?.role ?? ""),
    });
    res.status(200).json({ issued: result });
  } catch (err: any) {
    res.status(statusFor(err)).json({
      error: err?.message || "Could not issue the coupon.",
      code: err?.code,
    });
  }
}

/** GET /coupons/usage?code=... — usage rows for one coupon. */
export async function handleCouponUsage(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 100;
    const usage = await listCouponUsage(code, limit);
    res.status(200).json(usage);
  } catch (err: any) {
    res.status(statusFor(err)).json({
      error: err?.message || "Could not load coupon usage.",
      code: err?.code,
    });
  }
}

/** GET /coupons/list — every coupon with live usage. */
export async function handleListCoupons(
  _req: Request,
  res: Response
): Promise<void> {
  try {
    const coupons = await listCoupons();
    res.status(200).json({ coupons });
  } catch (err: any) {
    res.status(503).json({
      coupons: [],
      error: "Coupons are temporarily unavailable — please try again.",
    });
  }
}
