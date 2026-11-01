import { db } from "../../core/firebase";
import type { PetpoojaPackaging } from "../petpooja/packaging";

/**
 * Branch pricing config — the single server source of packaging (owner
 * decision 2026-10-31 R5, amended 2026-11-01 P1/P2).
 *
 * Both the pricing engine and `POST /checkout/fees` read packaging through
 * `computePackagingFee`, so the checkout screen and the bill can never
 * disagree. A branch that cannot be read FAILS CLOSED (503) — pricing a bill
 * off default packaging would under/over-charge the customer.
 */

/** Documented default packaging fee, used when Petpooja has given no value. */
export const DEFAULT_PACKAGING_FEE = 15;

export interface BranchPricingConfig {
  /** Effective fee (branch value, else DEFAULT_PACKAGING_FEE). */
  packagingFee: number;
  /** Raw branch `packagingFee` when the doc carries one (fallback source). */
  branchPackagingFee?: number;
  /** Raw Petpooja packaging contract captured by the menu sync (P1). */
  packaging?: PetpoojaPackaging | null;
  /** F1: the branch's fixed monthly fee in paise (default 2500 rupees). */
  monthlyFeePaise: number;
  /** F1: true when `monthlyFee` is negative or non-finite (capture flags it). */
  monthlyFeeInvalid?: boolean;
}

export const DEFAULT_MONTHLY_FEE_RUPEES = 2500;

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
      packagingFee: DEFAULT_PACKAGING_FEE,
      monthlyFeePaise: DEFAULT_MONTHLY_FEE_RUPEES * 100,
    };
  }

  const cached = branchConfigCache.get(branchId);
  if (cached && Date.now() - cached.at < BRANCH_CACHE_TTL_MS) {
    return {
      packagingFee: cached.packagingFee,
      branchPackagingFee: cached.branchPackagingFee,
      packaging: cached.packaging ?? null,
      monthlyFeePaise: cached.monthlyFeePaise,
      ...(cached.monthlyFeeInvalid ? { monthlyFeeInvalid: true } : {}),
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
      packagingFee: DEFAULT_PACKAGING_FEE,
      monthlyFeePaise: DEFAULT_MONTHLY_FEE_RUPEES * 100,
    };

    // F1: the fixed monthly fee (rupees). Absent → 2500; 0 is valid and means
    // no fee; negative/non-finite is recorded as invalid (capture flags it for
    // manual settlement) — it never blocks the customer's checkout.
    const monthlyFeeRaw = branchData?.monthlyFee;
    if (monthlyFeeRaw !== undefined && monthlyFeeRaw !== null) {
      const rupees = typeof monthlyFeeRaw === "number" ? monthlyFeeRaw : Number(monthlyFeeRaw);
      if (!Number.isFinite(rupees) || rupees < 0) {
        config.monthlyFeeInvalid = true;
      } else {
        config.monthlyFeePaise = Math.round(rupees * 100);
      }
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
      config.branchPackagingFee = pf;
    }
    // P1: the Petpooja contract captured by the menu sync. Stored raw + an
    // `understood` flag; computePackagingFee decides how to use it.
    config.packaging = branchData?.packaging ?? null;

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

export interface ComputePackagingFeeInput {
  packaging?: PetpoojaPackaging | null;
  /** Raw branch fallback (`branches/{id}.packagingFee`), if the doc has one. */
  branchFee?: number;
  orderType: "delivery" | "takeaway" | "dinein";
  /** Logging only. */
  branchId?: string;
}

/** Dedupe the misconfiguration warning per branch (checkout is a hot path). */
const packagingWarningAt = new Map<string, number>();
const PACKAGING_WARNING_TTL_MS = 10 * 60 * 1000;

/**
 * Records a packaging value we refused to interpret, exactly as the contract
 * requires: raw values on `petpooja_sync_logs` + a medium-severity snapshot.
 * Never throws — a logging problem must not fail a checkout.
 */
async function warnUnusablePackaging(input: ComputePackagingFeeInput): Promise<void> {
  const packaging = input.packaging;
  const raw = {
    applicable_on: packaging?.applicableOn ?? null,
    charge: packaging?.charge ?? null,
    charge_type: packaging?.chargeType ?? null,
  };
  // One warning per (branch, raw value): a changed value warns again, an
  // unchanged misconfiguration does not spam the hot checkout path.
  const key = `${input.branchId || "(unknown)"}|${String(raw.applicable_on)}|${String(
    raw.charge_type
  )}|${String(raw.charge)}`;
  const last = packagingWarningAt.get(key) || 0;
  if (Date.now() - last < PACKAGING_WARNING_TTL_MS) return;
  packagingWarningAt.set(key, Date.now());

  const message = `Petpooja packaging not understood for branch ${
    input.branchId || "(unknown)"
  } (applicable_on=${String(raw.applicable_on)}, charge=${String(
    raw.charge
  )}, charge_type=${String(
    raw.charge_type
  )}) — falling back to ${input.branchFee ?? DEFAULT_PACKAGING_FEE}`;

  console.warn(`[Packaging] ${message}`);
  try {
    if (db && typeof db.collection === "function") {
      await db.collection("petpooja_sync_logs").doc().set({
        storeId: input.branchId || "(unknown)",
        storeName: input.branchId || "(unknown)",
        scope: "PACKAGING",
        status: "PACKAGING_FALLBACK",
        version: "live",
        packagingRaw: raw,
        packagingUnderstood: false,
        message,
        createdAt: (await import("firebase-admin")).firestore.FieldValue.serverTimestamp(),
        simulated: false,
        source: "computePackagingFee",
      });
    }
  } catch (err: any) {
    console.warn("[Packaging] fallback log write failed (non-blocking):", err?.message || err);
  }
  try {
    const { captureErrorSnapshot } = await import("../../core/errors");
    await captureErrorSnapshot({
      source: "payments",
      severity: "medium",
      message,
      branchId: input.branchId,
    });
  } catch {
    // non-blocking
  }
}

/**
 * P2 (corrected 2026-11-01): ONE documented rule.
 *
 *   dine-in                      → 0
 *   applicableOn "ORDER" with a blank chargeType and a finite charge → charge
 *                                   (a 0 charge is honoured, never defaulted)
 *   anything else (ITEM, F, FIXED, percentages, unknown values, no consistent
 *   charge)                      → understood:false: branch fee, then the ₹15
 *                                   default, plus a warning. Never a guess.
 *   no Petpooja data at all      → branch fee, then the default (D8)
 */
export async function computePackagingFee(
  input: ComputePackagingFeeInput
): Promise<number> {
  if (input.orderType === "dinein") return 0;

  const packaging = input.packaging;
  if (packaging) {
    const applicableOn = String(packaging.applicableOn || "").trim().toUpperCase();
    const chargeType = String(packaging.chargeType ?? "").trim().toUpperCase();
    const charge = Number(packaging.charge);
    const chargeOk = Number.isFinite(charge) && charge >= 0;

    if (packaging.understood === true && applicableOn === "ORDER" && chargeType === "" && chargeOk) {
      return Math.round(charge * 100) / 100;
    }

    await warnUnusablePackaging(input);
  }

  const branchFee = Number(input.branchFee);
  if (Number.isFinite(branchFee) && branchFee >= 0) return branchFee;
  return DEFAULT_PACKAGING_FEE;
}
