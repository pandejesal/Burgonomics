import { db } from "../../core/firebase";

/**
 * Branch pricing config — the SINGLE server source of `packagingFee` and
 * `royaltyPercentage` (owner decision 2026-10-31, R5).
 *
 * Both the pricing engine and `POST /checkout/fees` read packaging through
 * this helper, so the checkout screen and the bill can never disagree about
 * what packaging costs. The branch document wins; when it does not carry a
 * value the documented default applies. A branch that cannot be read FAILS
 * CLOSED (503) — pricing a bill off default royalty/packaging silently drifts
 * the Route split and under/over-charges the customer.
 */

/** Documented default packaging fee. No branch sets `packagingFee` today. */
export const DEFAULT_PACKAGING_FEE = 15;
/** Default brand royalty (spec: 95/5 split). */
export const DEFAULT_ROYALTY_PERCENTAGE = 5;

export interface BranchPricingConfig {
  royaltyPercentage: number;
  packagingFee: number;
}

/** 60s in-memory branch config cache (royalty/packaging change rarely). */
const branchConfigCache = new Map<string, BranchPricingConfig & { at: number }>();
const BRANCH_CACHE_TTL_MS = 60_000;

function branchConfigUnavailable(reason: string, branchId: string): Error {
  const err: any = new Error("Branch configuration unavailable — cannot calculate pricing");
  err.statusCode = 503;
  err.branchId = branchId;
  err.reason = reason;
  return err;
}

/**
 * Resolves royalty/packaging for a branch. `branchId` absent or no datastore
 * yields the documented defaults (callers flag that separately).
 */
export async function resolveBranchPricingConfig(
  branchId?: string
): Promise<BranchPricingConfig> {
  if (!branchId || !db || typeof db.collection !== "function") {
    return {
      royaltyPercentage: DEFAULT_ROYALTY_PERCENTAGE,
      packagingFee: DEFAULT_PACKAGING_FEE,
    };
  }

  const cached = branchConfigCache.get(branchId);
  if (cached && Date.now() - cached.at < BRANCH_CACHE_TTL_MS) {
    return {
      royaltyPercentage: cached.royaltyPercentage,
      packagingFee: cached.packagingFee,
    };
  }

  try {
    const branchSnap = await db.collection("branches").doc(branchId).get();
    if (!branchSnap.exists) {
      // Fail-closed: a branchId that resolves to no branch doc (new outlet not
      // yet onboarded, deleted branch) must NOT fall back to default
      // royalty/packaging — that silently misprices the order and drifts the
      // Route split.
      const { captureErrorSnapshot } = await import("../../core/errors");
      await captureErrorSnapshot({
        source: "payments",
        severity: "p0_critical",
        message: `branch doc missing for ${branchId} — cannot price without verified royalty/packaging`,
        branchId,
      });
      throw branchConfigUnavailable("BRANCH_DOC_MISSING", branchId);
    }

    const branchData = branchSnap.data() as any;
    const config: BranchPricingConfig = {
      royaltyPercentage: DEFAULT_ROYALTY_PERCENTAGE,
      packagingFee: DEFAULT_PACKAGING_FEE,
    };

    if (typeof branchData?.royaltyPercentage === "number") {
      const rp = branchData.royaltyPercentage;
      // Bounds before use: a corrupt rate (>100%, negative, NaN) would mint a
      // NEGATIVE branch leg (split > 100% of net food), which
      // attemptRouteTransfer then refuses forever — a permanently stuck Route
      // settlement for every order at this branch. Refuse to price instead.
      if (!Number.isFinite(rp) || rp < 0 || rp > 100) {
        throw new Error(
          `branch royaltyPercentage ${String(rp)} outside [0,100] for ${branchId} — refusing to price (corrupt royalty config would strand the Route split)`
        );
      }
      config.royaltyPercentage = rp;
    }
    if (typeof branchData?.packagingFee === "number") {
      // Same bound: a negative or non-finite packaging fee must never credit
      // the customer, and a NaN would poison the total.
      const pf = branchData.packagingFee;
      if (!Number.isFinite(pf) || pf < 0) {
        throw new Error(
          `branch packagingFee ${String(pf)} is invalid for ${branchId} — refusing to price`
        );
      }
      config.packagingFee = pf;
    }

    branchConfigCache.set(branchId, { at: Date.now(), ...config });
    return config;
  } catch (err: any) {
    // Fail-closed: branch config determines royalty split (money-critical).
    // Using defaults would silently change the 95/5 split — must fail instead.
    if (err?.statusCode === 503) throw err;
    const { captureErrorSnapshot } = await import("../../core/errors");
    await captureErrorSnapshot({
      source: "payments",
      severity: "p0_critical",
      message: `branch config read failed for ${branchId} — cannot price without verified royalty/packaging`,
      branchId,
      errorStack: err?.stack,
    });
    throw branchConfigUnavailable("BRANCH_CONFIG_UNREADABLE", branchId);
  }
}

/** Test seam: the cache survives between suites otherwise. */
export function clearBranchPricingCache(): void {
  branchConfigCache.clear();
}
