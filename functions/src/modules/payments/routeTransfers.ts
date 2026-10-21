import * as admin from "firebase-admin";
import { db } from "../../core/firebase";
import { config, assertLivePaymentsContext } from "../../config/env";
import { captureErrorSnapshot } from "../../core/errors";
import { getRazorpayClient } from "./razorpayClient";

export interface RoutePricingSplit {
  branchTransferPaise: number;
  brandRoyaltyPaise: number;
  totalAmountPaise: number;
}

export interface RouteTransferAttempt {
  ok: boolean;
  skipped?: boolean;
  result?: any;
  error?: string;
  /**
   * TRUE when the attempt's outcome is UNKNOWN (gateway timeout, ambiguous
   * network failure, or a failed pre-POST reconcile lookup). Callers MUST
   * park the order in `needs_reconciliation` — never blind-retry a money
   * POST that may have already landed.
   */
  unknown?: boolean;
  /** TRUE when an equivalent existing transfer was found and reused (no POST). */
  reconciled?: boolean;
  /**
   * TRUE for a CONFIGURATION error (e.g. malformed linked-account id): a
   * retry cannot fix a stored value, so the worker must park the order for
   * manual settlement instead of spending the 4-attempt retry budget (~20 min)
   * and then marking it terminally failed with no trail.
   */
  configError?: boolean;
}

/**
 * Explicit gateway request timeouts. Both are WELL under the 10-minute
 * transfer-claim lease: a hung-but-landed POST surfaces as `unknown` here
 * long before a stale-lease takeover could re-POST it, and the takeover
 * itself reconciles existing transfers first (below).
 */
const TRANSFER_POST_TIMEOUT_MS = 30_000;
const TRANSFER_RECONCILE_TIMEOUT_MS = 15_000;

/**
 * Linked-account shape, enforced at the money chokepoint (last line of
 * defense — some config surfaces validate loosely or not at all). Real
 * Razorpay Route account ids are `acc_` + alphanumerics (~14 chars); the
 * repo's documented demo fixtures use underscores (`acc_Rzp_Surat_01`), so
 * the accepted set is `[A-Za-z0-9_]` with a >=6-char suffix. This rejects
 * the actual defect class — bare `acc_`, `acc_x`, arbitrary text — before
 * any POST, while keeping the documented fixture shape working.
 */
const ROUTE_ACCOUNT_ID_SHAPE = /^acc_[A-Za-z0-9_]{6,}$/;

export function isRouteAccountIdShape(value: string | null | undefined): boolean {
  return typeof value === "string" && ROUTE_ACCOUNT_ID_SHAPE.test(value.trim());
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err: any = new Error(`${label} timed out after ${ms}ms — outcome unknown`);
      err.code = "GATEWAY_TIMEOUT";
      reject(err);
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * Reconcile-before-(re)POST: `payments.transfer` is NOT idempotent, so before
 * ANY POST (first attempt, retry worker, stale-lease takeover) we list the
 * payment's existing transfers and return an equivalent one (same internal
 * orderId in notes + same live paise amount, not failed/reversed) so callers
 * record it instead of double-paying the branch.
 *
 * Throws when the lookup itself fails — callers then treat the outcome as
 * UNKNOWN and park rather than POSTing blind.
 */
export async function findExistingTransferForPayment(
  razorpay: any,
  paymentId: string,
  want: { splitPaise: number; orderId: string }
): Promise<any | null> {
  if (!razorpay?.payments?.fetchTransfer) return null; // SDK without the endpoint — skip reconcile
  const res = await withTimeout(
    Promise.resolve(razorpay.payments.fetchTransfer(paymentId)),
    TRANSFER_RECONCILE_TIMEOUT_MS,
    "Razorpay payments.fetchTransfer"
  );
  const items = Array.isArray(res?.items)
    ? res.items
    : Array.isArray(res)
      ? (res as any[])
      : [];
  for (const t of items) {
    if (!t || typeof t.amount !== "number") continue;
    if (t.status === "failed" || t.status === "reversed") continue;
    if (Number(t.amount) !== want.splitPaise) continue;
    // Our transfers always stamp notes.orderId (buildRouteTransferPayload) —
    // a transfer without OUR marker is never assumed to be ours.
    if (t?.notes?.orderId === want.orderId) return t;
  }
  return null;
}

/** SDK/API errors that PROVE the transfer did not happen (safe to retry). */
function isDefiniteGatewayRejection(err: any): boolean {
  const status = Number(err?.statusCode);
  return Number.isInteger(status) && status >= 400 && status < 500;
}

/**
 * Calculates the branch/brand royalty split in paise.
 *
 * Fail-closed input gate: the split feeds a real money transfer, so a NaN,
 * fractional, or negative paise total (or a rate outside [0,1)) must throw
 * instead of producing `NaN` paise that a downstream `> 0` check could leak
 * past. `branchTransferPaise` is derived as `total - royalty` so the two legs
 * ALWAYS sum to the captured total — no rounding dust is created or lost.
 */
export function calculateRouteSplit(
  totalAmountPaise: number,
  royaltyRate = 0.05
): RoutePricingSplit {
  const total = Number(totalAmountPaise);
  const rate = Number(royaltyRate);
  if (!Number.isInteger(total) || total <= 0) {
    throw new Error(
      `calculateRouteSplit: totalAmountPaise must be a positive integer of whole paise (got ${String(totalAmountPaise)})`
    );
  }
  if (!Number.isFinite(rate) || rate < 0 || rate >= 1) {
    throw new Error(
      `calculateRouteSplit: royaltyRate must be a fraction in [0, 1) (got ${String(royaltyRate)})`
    );
  }
  const brandRoyaltyPaise = Math.round(total * rate);
  const branchTransferPaise = total - brandRoyaltyPaise;

  return {
    branchTransferPaise,
    brandRoyaltyPaise,
    totalAmountPaise: total,
  };
}

/**
 * Constructs the transfers array payload for Razorpay Route orders / transfers.
 */
export function buildRouteTransferPayload(
  accountId: string,
  amountPaise: number,
  orderId: string,
  branchId: string,
  brandRoyaltyPaise?: number
) {
  return [
    {
      account: accountId,
      amount: amountPaise,
      currency: "INR",
      notes: {
        orderId,
        branchId,
        brandRoyaltyPaise: brandRoyaltyPaise ?? 0,
      },
      linked_account_notes: ["orderId"],
      on_hold: false,
    },
  ];
}

/**
 * Executes a Razorpay Route transfer split for a captured payment.
 * Returns a structured attempt result so the caller can decide
 * how to persist the outcome (success, pending retry, or skipped).
 */
export async function attemptRouteTransfer(
  paymentId: string,
  branchId: string,
  pricingSplit: { branchTransferPaise: number; brandRoyaltyPaise?: number; brandRoyaltyAmount?: number },
  orderId: string,
  // Pre-resolved linked account from the worker's batched branch prefetch.
  // `undefined` (direct callers/tests) keeps the old inline branch read.
  preResolvedAccountId?: string | null,
  // Fail-closed ceiling: the gateway-captured amount in paise (B2-S1). When
  // provided, a split above what the customer actually paid is refused to
  // pending_retry — never clamped-and-sent (clamping would silently
  // underpay the branch with no trail) and never over-transferred (which
  // would pull brand money into the branch payout).
  capturedAmountPaise?: number
): Promise<RouteTransferAttempt> {
  // ZERO-MOCK production guard at the single choke point every Route payout
  // passes through (verify, webhook, retry worker). The entry guards on
  // verifyPayment/handleRazorpayWebhook do NOT cover the scheduled retry
  // worker — without this, a MOCK_PAYMENT_GATEWAY flipped on in a declared
  // production process would stamp `trf_mock_*` receipts as `transferred`
  // and silently never move a branch's money. Thrown (not returned as
  // ok:false) so callers fail LOUD instead of recording a fake attempt.
  assertLivePaymentsContext("attemptRouteTransfer");
  try {
    const rawAccountId =
      preResolvedAccountId !== undefined
        ? preResolvedAccountId
        : (await db.collection("branches").doc(branchId).get()).data()?.razorpayAccountId;
    // Narrow before money moves: a string-typed paise ("5000") coerces past
    // `> 0` and POSTs a wrong amount; a missing split must fail LOUD to
    // pending_retry (silent skip leaves the branch unpaid with no trail).
    const splitPaise = Number(pricingSplit?.branchTransferPaise);
    if (!Number.isInteger(splitPaise) || splitPaise <= 0) {
      return {
        ok: false,
        error: "Invalid pricing split: branchTransferPaise must be a positive integer",
      };
    }
    // Over-capture guard (B2-S1): runs BEFORE the mock success branch and
    // before any gateway POST, so neither path can move more than captured.
    if (
      capturedAmountPaise !== undefined &&
      Number.isFinite(capturedAmountPaise) &&
      capturedAmountPaise > 0 &&
      splitPaise > capturedAmountPaise
    ) {
      return {
        ok: false,
        error:
          `Transfer split exceeds captured payment amount — refusing over-transfer ` +
          `(split ${splitPaise} paise > captured ${capturedAmountPaise} paise)`,
      };
    }
    const razorpayAccountId = typeof rawAccountId === "string" && rawAccountId.trim() ? rawAccountId.trim() : null;

    if (!razorpayAccountId) {
      return {
        ok: false,
        skipped: true,
        error: "No linked Razorpay account for branch",
      };
    }

    // Shape guard before ANY money movement (mock branch included): a
    // typo'd/loose id would otherwise be POSTed (definite 4xx → endless
    // pending_retry with a misleading gateway error) or, in mock mode,
    // stamped as a successful transfer for an account that cannot receive
    // money. This is a CONFIG error — the worker parks the order for manual
    // settlement (configError) rather than burning its retry budget on a
    // value no retry can change.
    if (!isRouteAccountIdShape(razorpayAccountId)) {
      return {
        ok: false,
        configError: true,
        error:
          `Invalid Razorpay Route account id shape for branch ${branchId} — ` +
          `refusing transfer; fix branches.razorpayAccountId (acc_ + at least 6 chars)`,
      };
    }

    if (config.mock.paymentGateway) {
      return {
        ok: true,
        result: {
          id: `trf_mock_${Date.now()}`,
          account: razorpayAccountId,
          amount: splitPaise,
          status: "processed",
        },
      };
    }

    const razorpay = getRazorpayClient();

    // Reconcile BEFORE (re)POSTing: if an equivalent transfer already exists
    // (a hung-but-landed POST, a stale-lease takeover racing a completed
    // one), reuse its receipt — never double-pay the branch. A FAILED
    // lookup is outcome-UNKNOWN: refuse to POST blind (park callers do
    // needs_reconciliation).
    try {
      const existing = await findExistingTransferForPayment(razorpay, paymentId, {
        splitPaise,
        orderId,
      });
      if (existing) {
        return { ok: true, reconciled: true, result: existing };
      }
    } catch (err: any) {
      return {
        ok: false,
        unknown: true,
        error:
          `Transfer reconciliation failed (${err?.message || err}) — outcome unknown, ` +
          `refusing to risk a duplicate payout; park for reconciliation`,
      };
    }

    const transfers = buildRouteTransferPayload(
      razorpayAccountId,
      splitPaise,
      orderId,
      branchId,
      pricingSplit.brandRoyaltyPaise ?? pricingSplit.brandRoyaltyAmount
    );

    let result: any;
    try {
      // Explicit timeout well under the 10-min claim lease: a hung POST must
      // surface as `unknown` (callers park in needs_reconciliation) long
      // before a stale-lease takeover could double-POST it — and any future
      // attempt reconciles first anyway.
      result = await withTimeout(
        Promise.resolve(razorpay.payments.transfer(paymentId, { transfers })),
        TRANSFER_POST_TIMEOUT_MS,
        "Razorpay payments.transfer"
      );
    } catch (err: any) {
      if (err?.code === "GATEWAY_TIMEOUT") {
        return {
          ok: false,
          unknown: true,
          error: `${err.message} — a retry will reconcile existing transfers before re-POSTing`,
        };
      }
      if (isDefiniteGatewayRejection(err)) {
        // A 4xx rejection proves nothing moved — safe for the normal
        // pending_retry lane.
        return { ok: false, error: (err as any)?.message || String(err) };
      }
      // Ambiguous failure (network reset, 5xx, unreadable error): the POST
      // may have landed. NEVER blind-retry — park for reconciliation.
      return {
        ok: false,
        unknown: true,
        error:
          `Transfer POST failed ambiguously (${(err as any)?.message || err}) — outcome unknown, ` +
          `a retry will reconcile existing transfers before re-POSTing`,
      };
    }
    return { ok: true, result };
  } catch (err: any) {
    return { ok: false, error: (err as any)?.message || String(err) };
  }
}

/**
 * Retries pending Razorpay Route transfers for orders marked pending_retry.
 * Runs on a schedule and handles each order independently.
 */
export async function retryPendingRouteTransfersWorker() {
  // The composite index for (routeTransferStatus, routeTransferRetryCount)
  // may be missing on a fresh project — an unhandled throw would kill the
  // whole tick silently. Fail the tick LOUD with zero retried instead.
  let pendingSnap: any;
  try {
    pendingSnap = await db
      .collection("orders")
      .where("routeTransferStatus", "==", "pending_retry")
      .where("routeTransferRetryCount", "<=", 3)
      .limit(20)
      .get();
  } catch (err: any) {
    console.warn(
      "[Route Transfer Worker] initial query failed (missing composite index?) — skipping tick:",
      err?.message || err
    );
    return { retriedCount: 0 };
  }

  // Stale-claim TTL shared by the claim transaction below and the
  // crash-recovery sweep: both must agree on when a lease is dead.
  const CLAIM_TTL_MS = 10 * 60 * 1000;

  const docs = pendingSnap.docs as any[];

  // Crash-recovery sweep: an order claimed into `transferring` by a verify
  // call or a `payment.captured` webhook that then died has NO other retrier
  // — a webhook-only payer closes the tab and never calls verify again, so
  // the branch payout would sit untransferred forever. Pull parked,
  // expired-lease orders back into this tick. The claim transaction below
  // re-reads the lease, so a claim that is still live elsewhere is never
  // stolen (and overlapping ticks still serialize on the same lease).
  try {
    const parkedSnap = await db
      .collection("orders")
      .where("routeTransferStatus", "==", "transferring")
      .limit(20)
      .get();
    const nowMs = Date.now();
    for (const parked of (parkedSnap?.docs as any[]) || []) {
      const parkedData = parked?.data?.() as any;
      const claimedAtRaw = parkedData?.routeTransferClaimedAt;
      const claimedAt =
        typeof claimedAtRaw === "number" && Number.isFinite(claimedAtRaw)
          ? claimedAtRaw
          : claimedAtRaw && typeof claimedAtRaw.toMillis === "function"
            ? claimedAtRaw.toMillis()
            : 0;
      // Unreadable/absent lease = parked with nobody working it → stale.
      if (claimedAt === 0 || nowMs - claimedAt >= CLAIM_TTL_MS) docs.push(parked);
    }
  } catch (err: any) {
    // A datastore without a single-field chained where() (shimmed tests)
    // skips the sweep for this tick — pending_retry processing above is
    // unaffected and the tick must still drain.
    console.warn(
      "[Route Transfer Worker] stale-transferring sweep skipped:",
      err?.message || err
    );
  }

  // One batched prefetch for every distinct branch: the old code re-read the
  // same branch doc once per order (N orders × 1 read + 1 external POST,
  // all serial). External transfer POSTs then run in bounded chunks.
  const distinctBranchIds = [
    ...new Set(
      docs.map((d) => d.data()?.branchId).filter((b): b is string => typeof b === "string" && !!b)
    ),
  ];
  const branchAccounts = new Map<string, string | null>();
  await Promise.all(
    distinctBranchIds.map(async (branchId) => {
      try {
        const snap = await db.collection("branches").doc(branchId).get();
        branchAccounts.set(branchId, snap.data()?.razorpayAccountId ?? null);
      } catch {
        // Transient read blip: leave the branch ABSENT (not null) so
        // processDoc passes undefined and attemptRouteTransfer re-reads the
        // branch inline. Poisoning null here would mark the order terminally
        // "failed" (unlinked) over a momentary timeout — branch unpaid, no
        // retry trail. Only a present-but-empty account means unlinked.
      }
    })
  );

  // Claim-then-work (shared lease with verifyPayment's `transferring` flag):
  // overlapping scheduler ticks used to POST the same non-idempotent
  // transfer twice. Stale claims (>10 min) are take-over-able.
  const claimedDocs: any[] = [];
  if (db && typeof (db as any).runTransaction === "function") {
    try {
      const won: any[] = await (db as any).runTransaction(async (tx: any) => {
        const mine: any[] = [];
        for (const doc of docs) {
          const fresh = await tx.get(doc.ref);
          const data = (fresh.exists ? fresh.data() : undefined) as any;
          const status = data?.routeTransferStatus;
          // `pending_retry` is the scheduled lane; `transferring` is only
          // claimable when its lease below reads as expired (a verify or
          // webhook that crashed between claim and POST) — a LIVE
          // transferring lease is somebody else's in-flight money move.
          if (!data || (status !== "pending_retry" && status !== "transferring")) continue;
          // Numeric-first lease read (see porter claim): a serverTimestamp
          // sentinel has no toMillis and would read as 0, causing instant
          // false takeover and a double transfer POST.
          const claimedAtRaw = data.routeTransferClaimedAt;
          const claimedAt =
            typeof claimedAtRaw === "number" && Number.isFinite(claimedAtRaw)
              ? claimedAtRaw
              : claimedAtRaw && typeof claimedAtRaw.toMillis === "function"
                ? claimedAtRaw.toMillis()
                : 0;
          if (data.routeTransferClaimedAt && Date.now() - claimedAt < CLAIM_TTL_MS) continue;
          tx.set(
            doc.ref,
            {
              routeTransferStatus: "transferring",
              routeTransferClaimedAt: Date.now(),
            },
            { merge: true }
          );
          mine.push(doc);
        }
        return mine;
      });
      claimedDocs.push(...won);
    } catch (err: any) {
      console.warn("[Route Transfer Worker] claim transaction failed, skipping tick:", err?.message || err);
      return { retriedCount: 0 };
    }
  } else {
    claimedDocs.push(...docs);
  }

  let retriedCount = 0;

  const processDoc = async (doc: any): Promise<boolean> => {
    const order = doc.data();
    const orderId = doc.id;
    const branchId = order.branchId;
    const pricingSplit = order.pricing?.split;
    const paymentId =
      order.payment?.razorpayPaymentId || order.razorpayPaymentId || order["payment.razorpayPaymentId"];

    try {
      if (!branchId || !pricingSplit || pricingSplit.branchTransferPaise <= 0 || !paymentId) {
        await doc.ref.set(
          {
            routeTransferStatus: "failed",
            routeTransferError: "Missing branch, pricing split, or payment id for route transfer retry",
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        return false;
      }

      const attempt = await attemptRouteTransfer(
        paymentId,
        branchId,
        pricingSplit,
        orderId,
        branchAccounts.has(branchId) ? branchAccounts.get(branchId) ?? null : undefined,
        // Captured ceiling for the over-transfer guard: live gateway truth
        // when verify stored it, else the server-priced total. Undefined when
        // neither exists — the guard then skips (missing-data check above
        // already failed such orders out).
        typeof order.payment?.capturedAmountPaise === "number"
          ? order.payment.capturedAmountPaise
          : typeof (order as any)["payment.capturedAmountPaise"] === "number"
            ? (order as any)["payment.capturedAmountPaise"]
            : typeof order.pricing?.grandTotal === "number"
              ? Math.round(order.pricing.grandTotal * 100)
              : undefined
      );

      if (attempt.skipped) {
        await doc.ref.set(
          {
            routeTransferStatus: "failed",
            // Unlinked branch: retrying will not conjure a linked account.
            // Flag it so ops links the branch in the Razorpay dashboard and
            // settles this order by hand — the customer's CONFIRMED order is
            // never failed over a missing payout.
            routeTransferNeedsManualSettlement: true,
            routeTransferError: attempt.error,
            // Symmetry with the configError lane + flagManualSettlement:
            // release the claim lease (inert once the doc is `failed`, but
            // the lanes should not diverge).
            routeTransferClaimedAt: admin.firestore.FieldValue.delete(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        return false;
      }

      if (attempt.configError) {
        // Malformed linked-account id: a retry cannot fix a stored config
        // value. Park exactly like the unlinked lane (manual settlement
        // flag, no retry-budget spend, no terminal "failed"-without-trail
        // after ~20 min) so staff fix branches.razorpayAccountId and settle
        // by hand.
        await doc.ref.set(
          {
            routeTransferStatus: "failed",
            routeTransferNeedsManualSettlement: true,
            routeTransferError: attempt.error,
            routeTransferClaimedAt: admin.firestore.FieldValue.delete(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        return false;
      }

      if (attempt.unknown) {
        // Outcome UNKNOWN (timeout / ambiguous failure / reconcile lookup
        // failed): a blind retry could double-pay. Park for ops — the claim
        // lease is released and attemptRouteTransfer reconciles existing
        // transfers before any future POST.
        await captureErrorSnapshot({
          source: "payments",
          severity: "high",
          message: `Route transfer outcome UNKNOWN for order ${orderId} — parked in needs_reconciliation (no blind retry): ${attempt.error}`,
          orderId,
          branchId,
          razorpayPaymentId: paymentId,
        }).catch(() => undefined);
        await doc.ref.set(
          {
            routeTransferStatus: "needs_reconciliation",
            routeTransferError: attempt.error,
            routeTransferClaimedAt: admin.firestore.FieldValue.delete(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        return false;
      }

      if (!attempt.ok) {
        const prevRetryCount =
          typeof order.routeTransferRetryCount === "number" ? order.routeTransferRetryCount : 0;
        const nextRetryCount = prevRetryCount + 1;
        const exhausted = nextRetryCount > 3;

        await doc.ref.set(
          {
            routeTransferRetryCount: admin.firestore.FieldValue.increment(1),
            routeTransferError: attempt.error,
            routeTransferRetryAt: admin.firestore.FieldValue.serverTimestamp(),
            ...(exhausted
              ? {
                  routeTransferStatus: "failed",
                  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                }
              : {}),
          },
          { merge: true }
        );

        if (exhausted) {
          await captureErrorSnapshot({
            source: "payments",
            severity: "high",
            message: `Route transfer retries exhausted for order ${orderId}: ${attempt.error}`,
            orderId,
            branchId,
            razorpayPaymentId: paymentId,
          });
        }
        return false;
      }

      await doc.ref.set(
        {
          routeTransferStatus: "transferred",
          "payment.routeTransfer": attempt.result,
          routeTransferError: admin.firestore.FieldValue.delete(),
          routeTransferRetryAt: admin.firestore.FieldValue.delete(),
          routeTransferRetryCount: admin.firestore.FieldValue.delete(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      return true;
    } catch (err: any) {
      await captureErrorSnapshot({
        source: "payments",
        severity: "high",
        message: `Route transfer retry worker failed for order ${orderId}: ${err.message || err}`,
        orderId,
        branchId,
        razorpayPaymentId: paymentId,
      });
      return false;
    }
  };

  const CHUNK_SIZE = 4;
  for (let i = 0; i < claimedDocs.length; i += CHUNK_SIZE) {
    const chunk = claimedDocs.slice(i, i + CHUNK_SIZE);
    const results = await Promise.allSettled(chunk.map((doc) => processDoc(doc)));
    for (const res of results) {
      if (res.status === "fulfilled" && res.value) retriedCount += 1;
    }
  }

  return { retriedCount };
}
