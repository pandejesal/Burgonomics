import { db } from "../../core/firebase";
import { captureErrorSnapshot } from "../../core/errors";
import { config, assertLivePetpoojaContext } from "../../config/env";
import { getPetpoojaConfig, assertPetpoojaEnabled } from "./client";
import * as admin from "firebase-admin";
import { assertBranchAccess, type StaffCaller } from "../../core/middleware";
import { isSafeDocId } from "../../core/security";
import { createHash } from "crypto";
import {
  resolveStorefrontForBranch,
  staffCloseOverrideInForce,
  type StorefrontMatch,
} from "../stores/storeStatus";

/**
 * Computes a deterministic, bounded, Firestore-safe document ID for quarantined 86ing payloads.
 * Never interpolates unsafe restId (slashes, path escapes, unbounded length) into Firestore paths.
 */
export function computeStockQuarantineDocId(restId: any, itemId: any): string {
  const normRest = typeof restId === "string" ? restId.trim() : restId != null ? String(restId).trim() : "unlinked";
  const normItem = typeof itemId === "string" ? itemId.trim() : itemId != null ? String(itemId).trim() : "";
  const rawKey = `${normRest}:::${normItem}`;
  const hash = createHash("sha256").update(rawKey).digest("hex").slice(0, 32);
  return `ups_${hash}`;
}

/**
 * Bounds an untrusted callback string before it is written to the review
 * queue — an unauthenticated caller must not be able to store an unbounded
 * field. Numbers keep their string form; null/undefined stay null.
 */
const PARKED_STATUS_MAX_CHARS = 200;
const PARKED_REF_MAX_CHARS = 200;
function boundedParkedString(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null;
  const text = typeof value === "string" ? value : String(value);
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * Deterministic doc id for a parked review record. A value that fits keeps the
 * plain `prefix<value>` id (existing dedupe unchanged); a TRUNCATED value also
 * gets a short hash of the FULL raw value, so two distinct refs sharing their
 * first 200 chars produce two records instead of one merge-overwritten event.
 * The whole id stays within PARKED_REF_MAX_CHARS.
 */
function parkedDocId(prefix: "upo_" | "ss_", raw: unknown): string {
  const text = raw === undefined || raw === null ? "" : typeof raw === "string" ? raw : String(raw);
  const bounded = boundedParkedString(text, PARKED_REF_MAX_CHARS) || "unknown";
  if (text.length <= PARKED_REF_MAX_CHARS) return `${prefix}${bounded}`;
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 12);
  const capped = bounded.slice(0, PARKED_REF_MAX_CHARS - hash.length - 1);
  return `${prefix}${capped}_${hash}`;
}

/**
 * Normalizes Petpooja order status codes into canonical Burgonomics order statuses.
 */
export function normalizePetpoojaStatus(rawStatus: any): string {
  if (rawStatus === null || rawStatus === undefined) {
    return "unknown";
  }

  const statusStr = String(rawStatus).toUpperCase().trim();

  // Numeric codes
  if (statusStr === "-1") return "cancelled";
  if (statusStr === "1" || statusStr === "2" || statusStr === "3") return "accepted";
  if (statusStr === "4") return "out_for_delivery";
  if (statusStr === "5") return "ready";
  if (statusStr === "10") return "delivered";

  // Named constants
  if (statusStr.includes("CANCEL")) return "cancelled";
  if (statusStr.includes("ACCEPT") || statusStr.includes("KITCHEN")) return "accepted";
  if (statusStr.includes("READY")) return "ready";
  if (statusStr.includes("DISPATCH") || statusStr.includes("OUT_FOR_DELIVERY"))
    return "out_for_delivery";
  if (statusStr.includes("DELIVER")) return "delivered";

  return "unknown";
}

/**
 * Forward-only rank of the canonical order lifecycle
 * (`references/order_flow.md` §1; `PARTNER_TO_DELIVERY`/`ALIAS_TO_CANONICAL` in
 * `modules/orders/orderStatus.ts`). READY_TO_SERVE is the dine-in fork of the
 * READY rank, so a generic READY must not overwrite it. Terminal codes
 * (DELIVERED/CANCELLED) and unknown/legacy literals are deliberately unranked:
 * they keep their existing handling rather than acquiring an invented position.
 */
const CANONICAL_STATUS_RANK: Record<string, number> = {
  PLACED: 0,
  PENDING: 0,
  CONFIRMED: 1,
  PREPARING: 2,
  READY_FOR_PICKUP: 3,
  READY_TO_SERVE: 3,
  OUT_FOR_DELIVERY: 4,
};

/** Rank of a canonical status code, or null when the vocabulary does not rank it. */
function canonicalStatusRank(code: unknown): number | null {
  if (typeof code !== "string") return null;
  const rank = CANONICAL_STATUS_RANK[code.trim().toUpperCase()];
  return typeof rank === "number" ? rank : null;
}

/**
 * Outcome of an inbound 86ing webhook.
 *
 * `retryable` is the ONLY signal the route uses to answer non-2XX: a
 * version-conflict (or an unclassified local write failure) means the toggle
 * was NOT applied and nothing in-process will ever drain the park document, so
 * Petpooja must redeliver. Answering 200 for that shape is a silent 86ing loss
 * — the item stays orderable on the customer app while the kitchen believes it
 * is out.
 */
export interface PetpoojaStockWebhookResult {
  /**
   * `partial` means some ids in the batch landed and some were parked
   * permanently. It is NOT a success: the reply is the documented failure body
   * and the audit row records `partial` with the n/m count, because a caller
   * told "success" would never learn that part of the batch was dropped.
   */
  outcome: "applied" | "ignored" | "retry" | "partial";
  retryable: boolean;
  reason?: string;
}

const stockIgnored = (reason?: string): PetpoojaStockWebhookResult => ({
  outcome: "ignored",
  retryable: false,
  ...(reason ? { reason } : {}),
});

const stockRetry = (reason: string): PetpoojaStockWebhookResult => ({
  outcome: "retry",
  retryable: true,
  reason,
});

/**
 * Documented Item On/Off success and failure bodies (vendor 200 OK section).
 * The vendor's own example pairs the failure body with HTTP 400, so the route
 * answers 200 + success only when the toggle actually landed.
 */
export const PETPOOJA_STOCK_OK = {
  code: 200,
  status: "success",
  message: "Stock status updated successfully",
} as const;

export const PETPOOJA_STOCK_FAILED = {
  code: 400,
  status: "failed",
  message: "Stock status not updated successfully",
} as const;

/**
 * Maps a handler outcome onto the documented reply. A redelivery request keeps
 * the fail-closed non-2XX (503) it has always had — the vendor must resend —
 * but the body is the documented failure body rather than an internal marker.
 */
export function stockWebhookReply(result: PetpoojaStockWebhookResult): {
  httpStatus: number;
  body: typeof PETPOOJA_STOCK_OK | typeof PETPOOJA_STOCK_FAILED;
} {
  if (result?.retryable === true) {
    return { httpStatus: 503, body: PETPOOJA_STOCK_FAILED };
  }
  if (result?.outcome === "applied") {
    return { httpStatus: 200, body: PETPOOJA_STOCK_OK };
  }
  return { httpStatus: 200, body: PETPOOJA_STOCK_FAILED };
}

/**
 * The documented `itemID` is an ARRAY of ids ("itemID": ["7532306", "7865402"]).
 * Older payloads and our own route contract used a single scalar. Normalise
 * both to a bounded list of trimmed strings; anything else is "no reference".
 * A non-string entry is dropped rather than stringified into a fake id.
 *
 * `total` counts every usable id the caller sent, so a caller that exceeds the
 * cap can be TOLD so. Truncating and still answering success would silently
 * leave part of the kitchen's update unapplied.
 */
export const MAX_STOCK_BATCH = 200;

export interface NormalizedStockIds {
  ids: string[];
  /** Every usable id the caller sent (may exceed `ids.length`). */
  total: number;
  /** True when `ids` was capped below `total`. */
  truncated: boolean;
}

export function normalizeStockItemIds(raw: unknown): NormalizedStockIds {
  const asArray = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  const ids: string[] = [];
  let total = 0;
  for (const entry of asArray) {
    let value: string | null = null;
    if (typeof entry === "string") {
      const trimmed = entry.trim();
      if (trimmed) value = trimmed;
    } else if (typeof entry === "number" && Number.isFinite(entry)) {
      value = String(entry);
    }
    if (value === null) continue;
    total++;
    if (ids.length < MAX_STOCK_BATCH) ids.push(value);
  }
  return { ids, total, truncated: total > ids.length };
}

/**
 * A bounded, human-readable reference for the audit row. The raw `itemID` is
 * caller-controlled and unbounded, so it must NEVER be stored whole: a 5,000-id
 * array would be a payload-sized write into `pos_webhook_audits`. One id passes
 * through (truncated); several are summarised as `first…+N more`.
 */
export function summariseStockItemRef(raw: unknown): string | null {
  const { ids, total } = normalizeStockItemIds(raw);
  if (ids.length === 0) return null;
  if (ids.length === 1) return ids[0].slice(0, 64);
  const extra = total - 1;
  return `${ids[0].slice(0, 48)}…+${extra} more`.slice(0, 96);
}

/**
 * The `pos_webhook_audits.outcome` for a stock toggle. A batch that only PARTLY
 * applied is recorded as `partial` (not `ok`, which would hide the dropped ids,
 * and not plain `error`, which would hide that some SKUs DID change) so the row
 * carries both the verdict and the `n/m` count.
 */
export function stockAuditOutcome(
  result: PetpoojaStockWebhookResult
): "ok" | "error" | "partial" {
  if (result?.outcome === "applied") return "ok";
  if (result?.outcome === "partial") return "partial";
  return "error";
}

/**
 * The `n/m` slice of a partial batch's reason (`"3/5 applied (...)"` → `"3/5"`),
 * for the audit row. Null when the result is not partial.
 */
export function stockAuditPartialCount(result: PetpoojaStockWebhookResult): string | null {
  if (result?.outcome !== "partial") return null;
  const match = /(\d+)\/(\d+)/.exec(result.reason || "");
  return match ? `${match[1]}/${match[2]}` : null;
}


/**
 * True ONLY when the verified webhook context proves the caller presented a
 * credential `verifyPetpoojaAuth` accepted (static app-key token or an
 * HMAC-SHA256 signature over the raw body).
 *
 * Default-deny: an omitted context (`{}` by default), `null`, a non-object, a
 * non-boolean `authenticated`, or an explicit `false` is UNTRUSTED. A caller
 * cannot opt in with a truthy string/number — only the boolean `true` the
 * middleware itself sets authorises canonical writes.
 */
export function isTrustedPetpoojaAuth(auth: unknown): boolean {
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) return false;
  return (auth as { authenticated?: unknown }).authenticated === true;
}

/**
 * Instant stock-out (86ing) webhook handler from Petpooja physical POS.
 *
 * Default-deny: `auth` is the verified context from `verifyPetpoojaAuth`.
 * Without an explicit `authenticated: true` the toggle is recorded as a hint
 * row for review and NO product stock is written.
 */
export async function handlePetpoojaStockWebhook(
  payload: any,
  auth: unknown = {}
): Promise<PetpoojaStockWebhookResult> {
  // Field-name tolerance: the published callback samples and our own route
  // contract disagree on `rest_id`/`restID` and `in_stock`/`inStock`. Read
  // both so a rename on Petpooja's side can never silently drop an 86ing
  // toggle (the payload still has to authenticate through verifyPetpoojaAuth).
  const p = payload || {};
  const rest_id = p.rest_id ?? p.restID ?? p.restId;
  const rawItemRef = p.item_id ?? p.itemID ?? p.itemId;
  const in_stock = p.in_stock ?? p.inStock;

  // The documented Item On/Off payload carries `itemID` as an ARRAY of ids.
  // Older callers sent one scalar. Both are accepted; every listed id is
  // applied, and a caller cannot smuggle a batch past the doc-id guard because
  // each id is validated individually below.
  const batch = normalizeStockItemIds(rawItemRef);
  const itemIds = batch.ids;

  if (!isTrustedPetpoojaAuth(auth)) {
    // Hint row only. An unverified caller must not 86 (or un-86) a live item:
    // a wrong "available" sells food the kitchen cannot make, and a wrong
    // "86" hides sellable inventory. `isSafeDocId` is enforced because the id
    // comes straight from the payload; an unsafe id gets a fixed marker.
    const hinted = itemIds.filter((id) => isSafeDocId(id));
    const hintKeys = hinted.length > 0 ? hinted : [null];
    for (const hintItemId of hintKeys) {
      try {
        await db
          .collection("petpooja_stock_hints")
          .doc(`sh_${hintItemId ?? "unidentified"}`)
          .set(
            {
              restId: boundedParkedString(rest_id ?? null, PARKED_REF_MAX_CHARS),
              itemId: boundedParkedString(hintItemId, PARKED_REF_MAX_CHARS),
              rawInStock: typeof in_stock === "object" ? null : in_stock ?? null,
              trusted: false,
              reason: "unauthenticated Petpooja 86ing webhook — stock not applied",
              receivedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
      } catch (err: any) {
        console.warn(
          "[Petpooja 86ing] failed to record unauthenticated hint:",
          err?.message || err
        );
      }
    }
    console.warn(
      `[Petpooja 86ing] REFUSED unauthenticated stock toggle item=${
        hinted.join(",") || "unknown"
      } rest=${rest_id ?? "unknown"} — hint recorded, stock unchanged`
    );
    return stockIgnored("unauthenticated");
  }

  if (itemIds.length === 0) {
    // Loop 6: a malformed 86ing payload (no item_id) used to log-and-drop —
    // silent stock-toggle loss. Snapshot loud so ops sees it; return (no
    // throw — the payload will never become valid on retry).
    await captureErrorSnapshot({
      source: "petpooja",
      severity: "medium",
      message: "Petpooja 86ing webhook arrived without item_id — stock toggle dropped, manual review required",
    });
    return stockIgnored("missing item_id");
  }

  if (batch.truncated) {
    // NEVER answer success for a batch we did not fully process. Applying the
    // first MAX_STOCK_BATCH ids and replying `success` would leave the rest of
    // the kitchen's update silently unapplied — the exact "mock-as-live" class
    // of lie this integration is supposed to avoid. Refuse the whole batch
    // with the documented failure body; the vendor splits it, and nothing is
    // half-applied.
    console.error(
      `[Petpooja 86ing] REFUSED a ${batch.total}-id batch (cap ${MAX_STOCK_BATCH}) — no id applied, documented failure answered`
    );
    await captureErrorSnapshot({
      source: "petpooja",
      severity: "medium",
      message: `Petpooja 86ing webhook carried ${batch.total} item ids, over the ${MAX_STOCK_BATCH} cap — batch refused, nothing applied`,
    });
    return stockIgnored(
      `batch of ${batch.total} item ids exceeds the ${MAX_STOCK_BATCH} cap — nothing applied`
    );
  }

  const inStockBool = in_stock === 1 || in_stock === "1" || in_stock === true;

  // Every listed id is applied independently: one unknown SKU must not discard
  // the rest of the batch, and one failing SKU must not turn a landed toggle
  // into a silent success. The caller sees one aggregate outcome.
  const outcomes: PetpoojaStockWebhookResult[] = [];
  for (const item_id of itemIds) {
    outcomes.push(
      await applyStockToggleForItem(rest_id, item_id, in_stock, inStockBool)
    );
  }

  const retry = outcomes.find((o) => o.retryable);
  if (retry) return retry;
  const applied = outcomes.filter((o) => o.outcome === "applied").length;
  if (applied === outcomes.length) return { outcome: "applied", retryable: false };
  if (applied > 0) {
    // Partial: at least one id landed, at least one was parked/failed
    // permanently. Redelivery cannot fix the parked one, so this is not
    // retryable — but it is also NOT a clean success, and it is not reported as
    // one (`partial` in the audit, documented failure body to the caller).
    return {
      outcome: "partial",
      retryable: false,
      reason: `${applied}/${outcomes.length} applied (${outcomes
        .map((o) => o.reason || o.outcome)
        .join("; ")})`,
    };
  }
  return outcomes[0] ?? stockIgnored("stock toggle not applied");
}

/**
 * Applies one documented stock toggle to one branch-scoped product.
 * Split out of the batch handler so every id goes through the SAME identity,
 * ownership, version-precondition and parking rules.
 */
async function applyStockToggleForItem(
  rest_id: any,
  item_id: string,
  in_stock: any,
  inStockBool: boolean
): Promise<PetpoojaStockWebhookResult> {
  // Fail-closed id shape: item_id comes from the POS vendor — slashes or
  // empties would throw/path-escape the doc write below and 500-retry.
  if (!isSafeDocId(String(item_id))) {
    await captureErrorSnapshot({
      source: "petpooja",
      severity: "medium",
      message: "Petpooja 86ing webhook arrived with an unsafe item_id — stock toggle dropped, manual review required",
    });
    return stockIgnored("unsafe item_id");
  }

  // Same branch-scoped id scheme as the menu sync
  const branchId = await resolveBranchIdForRestId(rest_id);
  if (!branchId) {
    console.warn(`[Petpooja 86ing] rest_id ${rest_id || "(empty)"} unlinked — capturing review evidence, no canonical mutation`);
    const qDocId = computeStockQuarantineDocId(rest_id, item_id);
    await db.collection("unmatched_petpooja_stock").doc(qDocId).set(
      {
        restId: typeof rest_id === "string" ? rest_id.slice(0, 128) : rest_id != null ? String(rest_id).slice(0, 128) : null,
        branchId: null,
        itemId: String(item_id).slice(0, 128),
        inStock: inStockBool,
        rawInStock: in_stock !== undefined ? (typeof in_stock === "object" ? null : in_stock) : null,
        status: "needs_review",
        reason: `restID ${typeof rest_id === "string" ? rest_id.slice(0, 64) : "(empty)"} did not resolve to a linked branch`,
        receivedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    await captureErrorSnapshot({
      source: "petpooja",
      severity: "medium",
      message: `Petpooja 86ing webhook for unlinked outlet ${typeof rest_id === "string" ? rest_id.slice(0, 64) : "(empty)"} item ${item_id} parked for review — no canonical inventory mutated`,
    });
    return stockIgnored("unlinked outlet");
  }

  const productId = `prod_${branchId}_${item_id}`;
  const productRef = db.collection("products").doc(productId);
  const prodSnap = await productRef.get();
  if (!prodSnap.exists) {
    console.warn(`[Petpooja 86ing] Product ${productId} does not exist at branch ${branchId} — parked for review, no orphan created`);
    const qDocId = computeStockQuarantineDocId(branchId, item_id);
    await db.collection("unmatched_petpooja_stock").doc(qDocId).set(
      {
        restId: typeof rest_id === "string" ? rest_id.slice(0, 128) : rest_id != null ? String(rest_id).slice(0, 128) : null,
        branchId,
        itemId: String(item_id).slice(0, 128),
        inStock: inStockBool,
        rawInStock: in_stock !== undefined ? (typeof in_stock === "object" ? null : in_stock) : null,
        status: "needs_review",
        reason: `product ${productId} does not exist in canonical products`,
        receivedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    await captureErrorSnapshot({
      source: "petpooja",
      severity: "medium",
      message: `Petpooja 86ing webhook for missing product ${productId} parked for review — no orphan created`,
      branchId,
    });
    return stockIgnored("product does not exist");
  }

  const prodData = prodSnap.data() || {};
  const branchMismatch = !prodData.branchId || prodData.branchId !== branchId;
  const itemMismatch =
    (prodData.petpoojaItemId && String(prodData.petpoojaItemId) !== String(item_id)) ||
    (prodData.itemId && String(prodData.itemId) !== String(item_id));

  if (branchMismatch || itemMismatch) {
    console.warn(
      `[Petpooja 86ing] Incoming stock webhook product ownership mismatch for ${productId} (doc branch: ${prodData.branchId}, item: ${prodData.petpoojaItemId || prodData.itemId}) — parking for review, refusing to overwrite ownership`
    );
    const qDocId = computeStockQuarantineDocId(branchId, item_id);
    await db.collection("unmatched_petpooja_stock").doc(qDocId).set(
      {
        restId: typeof rest_id === "string" ? rest_id.slice(0, 128) : rest_id != null ? String(rest_id).slice(0, 128) : null,
        branchId,
        itemId: String(item_id).slice(0, 128),
        inStock: inStockBool,
        rawInStock: in_stock !== undefined ? (typeof in_stock === "object" ? null : in_stock) : null,
        status: "needs_review",
        reason: `product ${productId} ownership mismatch (branch: ${prodData.branchId} vs ${branchId}, item: ${prodData.petpoojaItemId || prodData.itemId} vs ${item_id})`,
        receivedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    await captureErrorSnapshot({
      source: "petpooja",
      severity: "high",
      message: `Petpooja 86ing webhook for product ${productId} has contradictory ownership — parked for review, no ownership overwritten`,
      branchId,
    });
    return stockIgnored("ownership mismatch");
  }

  const initialUpdateTime = prodSnap.updateTime;
  let committed = false;
  let unchangedOnCommit = false;
  let conflictReason: string | null = null;

  if (db && typeof (db as any).runTransaction === "function") {
    try {
      const txOutcome = await (db as any).runTransaction(async (tx: any) => {
        const freshSnap = await tx.get(productRef);
        if (!freshSnap.exists) {
          return "missing";
        }
        const freshData = freshSnap.data() || {};
        const freshBranchMismatch = !freshData.branchId || freshData.branchId !== branchId;
        const freshItemMismatch =
          (freshData.petpoojaItemId && String(freshData.petpoojaItemId) !== String(item_id)) ||
          (freshData.itemId && String(freshData.itemId) !== String(item_id));
        if (freshBranchMismatch || freshItemMismatch) {
          return "ownership_mismatch";
        }

        const freshUpdateTime = freshSnap.updateTime;
        const versionMatches =
          initialUpdateTime && freshUpdateTime
            ? typeof initialUpdateTime.isEqual === "function"
              ? initialUpdateTime.isEqual(freshUpdateTime)
              : initialUpdateTime === freshUpdateTime
            : true;

        if (!versionMatches) {
          return "stale_conflict";
        }

        const updateData = {
          petpoojaItemId: String(item_id),
          branchId,
          restId: typeof rest_id === "string" ? rest_id.slice(0, 128) : rest_id ?? null,
          inStock: inStockBool,
          lastPetpoojaSync: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        // Idempotence: the value ALREADY held by the canonical doc is the
        // requested one, so there is nothing to commit. Checked on the FRESH
        // read (not the outer snapshot) so a concurrent staff write is still
        // seen as a version conflict above, never silently "already applied".
        // A replayed toggle must not bump updatedAt/lastPetpoojaSync, which
        // would invalidate concurrent readers' version preconditions and
        // re-drive downstream listeners for a state change that did not happen.
        if (freshData.inStock === inStockBool) {
          return "unchanged";
        }

        // F6: the version precondition is the whole point of this commit. The
        // old code caught a rejected precondition and re-issued an UNCONDITIONAL
        // tx.update, which silently overwrote the fresher local toggle the check
        // had just refused to clobber. A rejected precondition must surface as a
        // conflict (→ retryable), never be retried without it.
        if (initialUpdateTime) {
          tx.update(productRef, updateData, { lastUpdateTime: initialUpdateTime });
        } else {
          tx.update(productRef, updateData);
        }
        return "committed";
      });

      if (txOutcome === "committed") {
        committed = true;
      } else if (txOutcome === "unchanged") {
        unchangedOnCommit = true;
      } else {
        conflictReason = txOutcome;
      }
    } catch (txErr: any) {
      console.warn(`[Petpooja 86ing] Transaction update failed for ${productId}:`, txErr?.message || txErr);
      conflictReason = txErr?.message || "transaction_failed";
    }
  } else {
    // Fallback path without runTransaction: check updateTime / precondition
    try {
      const freshSnap = await productRef.get();
      if (!freshSnap.exists) {
        conflictReason = "missing";
      } else {
        const freshData = freshSnap.data() || {};
        const freshBranchMismatch = !freshData.branchId || freshData.branchId !== branchId;
        const freshItemMismatch =
          (freshData.petpoojaItemId && String(freshData.petpoojaItemId) !== String(item_id)) ||
          (freshData.itemId && String(freshData.itemId) !== String(item_id));
        if (freshBranchMismatch || freshItemMismatch) {
          conflictReason = "ownership_mismatch";
        } else {
          const freshUpdateTime = freshSnap.updateTime;
          const versionMatches =
            initialUpdateTime && freshUpdateTime
              ? typeof initialUpdateTime.isEqual === "function"
                ? initialUpdateTime.isEqual(freshUpdateTime)
                : initialUpdateTime === freshUpdateTime
              : true;

          if (!versionMatches) {
            conflictReason = "stale_conflict";
          } else if (freshData.inStock === inStockBool) {
            // Idempotent: the canonical value already matches (same fresh-read
            // reasoning as the transactional path above).
            unchangedOnCommit = true;
          } else {
            const updateData = {
              petpoojaItemId: String(item_id),
              branchId,
              restId: typeof rest_id === "string" ? rest_id.slice(0, 128) : rest_id ?? null,
              inStock: inStockBool,
              lastPetpoojaSync: admin.firestore.FieldValue.serverTimestamp(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            };
            if (initialUpdateTime) {
              await productRef.update(updateData, { lastUpdateTime: initialUpdateTime });
            } else {
              await productRef.update(updateData);
            }
            committed = true;
          }
        }
      }
    } catch (updateErr: any) {
      conflictReason = updateErr?.message || "update_failed";
    }
  }


  if (committed) {
    console.log(`[Petpooja 86ing] Item ${item_id} at branch ${rest_id} set inStock=${inStockBool}`);
    return { outcome: "applied", retryable: false };
  }

  if (unchangedOnCommit) {
    // Already in the requested state: a successful no-op, not a rewrite.
    console.log(
      `[Petpooja 86ing] Item ${item_id} at branch ${rest_id} already inStock=${inStockBool} — nothing to write`
    );
    return { outcome: "applied", retryable: false };
  }

  if (
    conflictReason === "stale_conflict" ||
    (conflictReason && conflictReason.includes("PRECONDITION")) ||
    (conflictReason && conflictReason.includes("conflict"))
  ) {
    console.warn(
      `[Petpooja 86ing] Concurrent stock update detected for ${productId} — parking webhook for review AND asking Petpooja to redeliver (a 200 here would silently drop the 86ing)`
    );
    const qDocId = computeStockQuarantineDocId(branchId, item_id);
    await db.collection("unmatched_petpooja_stock").doc(qDocId).set(
      {
        restId: typeof rest_id === "string" ? rest_id.slice(0, 128) : rest_id != null ? String(rest_id).slice(0, 128) : null,
        branchId,
        itemId: String(item_id).slice(0, 128),
        inStock: inStockBool,
        rawInStock: in_stock !== undefined ? (typeof in_stock === "object" ? null : in_stock) : null,
        status: "needs_review",
        reason: "concurrent stock update",
        receivedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    await captureErrorSnapshot({
      source: "petpooja",
      // The toggle did NOT land. The park doc is evidence for an operator; the
      // vendor redelivery is what actually repairs it, so this is not a silent
      // success and not a silent drop.
      severity: "high",
      message: `Petpooja 86ing webhook for product ${productId} conflicted with concurrent stock update — not applied, quarantined and answered retryable for redelivery`,
      branchId,
    });
    return stockRetry("concurrent stock update — redeliver");
  }

  if (conflictReason === "ownership_mismatch") {
    const qDocId = computeStockQuarantineDocId(branchId, item_id);
    await db.collection("unmatched_petpooja_stock").doc(qDocId).set(
      {
        restId: typeof rest_id === "string" ? rest_id.slice(0, 128) : rest_id != null ? String(rest_id).slice(0, 128) : null,
        branchId,
        itemId: String(item_id).slice(0, 128),
        inStock: inStockBool,
        rawInStock: in_stock !== undefined ? (typeof in_stock === "object" ? null : in_stock) : null,
        status: "needs_review",
        reason: `product ${productId} ownership mismatch on write`,
        receivedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    await captureErrorSnapshot({
      source: "petpooja",
      severity: "high",
      message: `Petpooja 86ing webhook for product ${productId} rejected — ownership mismatch on write`,
      branchId,
    });
    // Redelivery cannot fix contradictory ownership; an operator has to.
    return stockIgnored("ownership mismatch on write");
  }

  // F6 (previously a SILENT DROP): `missing` (the doc vanished between the two
  // reads) and any unclassified transaction/update failure reached here and fell
  // off the end of the function — no write, no park, no retry, and the route
  // still answered 200. Ask for a redelivery: the next attempt re-reads the
  // product (a genuinely deleted SKU then parks as "does not exist") and a
  // transient datastore error simply clears.
  console.warn(
    `[Petpooja 86ing] Could not apply stock toggle for ${productId} (${conflictReason || "unknown"}) — asking Petpooja to redeliver`
  );
  await captureErrorSnapshot({
    source: "petpooja",
    severity: "high",
    message: `Petpooja 86ing webhook for product ${productId} was NOT applied (${conflictReason || "unknown failure"}) — answered retryable for redelivery`,
    branchId,
  });
  return stockRetry(conflictReason || "stock toggle not applied");
}

/**
 * Outgoing stock toggle from Partner POS App to Petpooja Cloud API.
 * Resolves the branch's Petpooja restID (ops-linked) — never sends the
 * internal branchId as rest_id.
 */
export async function pushItemStockToPetpooja(
  branchId: string,
  itemId: string,
  inStock: boolean,
  caller?: StaffCaller
): Promise<boolean> {
  // Validate safe branch/item identifiers before vendor I/O
  if (
    !branchId ||
    typeof branchId !== "string" ||
    !isSafeDocId(branchId) ||
    !itemId ||
    typeof itemId !== "string" ||
    !isSafeDocId(itemId)
  ) {
    console.warn(`[Petpooja Stock Push] Invalid or unsafe identifiers: branchId=${branchId}, itemId=${itemId}`);
    return false;
  }

  // Staff boundary: branch-A staff cannot 86 Branch-B's items.
  if (caller) assertBranchAccess(caller, branchId);
  // ZERO-MOCK runtime gate: a declared-production process must never "push"
  // a toggle it never sent (the mock branch below would return true).
  assertLivePetpoojaContext(`stock push for branch ${branchId} item ${itemId}`);

  const prefix = `prod_${branchId}_`;
  const rawItemId = itemId.startsWith(prefix) ? itemId.slice(prefix.length) : itemId;
  const productId = itemId.startsWith(prefix) ? itemId : `prod_${branchId}_${itemId}`;

  if (!isSafeDocId(rawItemId) || !isSafeDocId(productId)) {
    console.warn(`[Petpooja Stock Push] Unsafe normalized identifier: raw=${rawItemId}, prod=${productId}`);
    return false;
  }

  // DISABLED BRIDGE: PETPOOJA_ENABLED=false must not reach the vendor NOR
  // write a local stock stamp. Placed after identifier validation, the staff
  // branch boundary and the zero-mock production gate (so an invalid id, a
  // cross-branch caller or a production mock still get their existing answer
  // first) and BEFORE the mock branch and every branch/product read — a
  // disabled integration therefore costs no vendor POST and leaves the product
  // doc's inStock/lastPetpoojaStockPush untouched. Throwing is deliberate: this
  // is the outbound push, and a silent `false` would read as "rejected toggle"
  // rather than "capability off". Authenticated INBOUND 86ing
  // (handlePetpoojaStockWebhook) is a different entrypoint and is NOT gated.
  assertPetpoojaEnabled(`stock push for branch ${branchId} item ${itemId}`);

  if (config.mock.petpoojaPos) {
    console.log(`[Mock Petpooja 86ing] Pushed branch=${branchId} item=${rawItemId} inStock=${inStock}`);
    try {
      const prodSnap = await db.collection("products").doc(productId).get();
      if (prodSnap.exists) {
        await db.collection("products").doc(productId).update({
          inStock: inStock,
          lastPetpoojaStockPush: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    } catch {
      // Best-effort in mock mode
    }
    return true;
  }

  try {
    let linked: string | null = null;
    try {
      const branchSnap = await db.collection("branches").doc(branchId).get();
      linked = (branchSnap.data() as any)?.petpoojaStoreId || null;
    } catch (err: any) {
      console.warn(`[Petpooja Stock Push] Branch lookup failed for ${branchId}:`, err?.message || err);
      // Fail-closed AND loud: the KDS reports this toggle as not synced,
      // so ops needs an alert (not a log line nobody reads).
      await captureErrorSnapshot({
        source: "petpooja",
        severity: "high",
        message: `Stock push for item ${rawItemId} aborted — branch lookup failed for ${branchId}: ${err?.message || err}`,
        branchId,
      });
      return false;
    }
    if (!linked) {
      console.warn(
        `[Petpooja Stock Push] Branch ${branchId} has no linked outlet — refusing wrong-outlet toggle (link per Runbook §5)`
      );
      await captureErrorSnapshot({
        source: "petpooja",
        severity: "high",
        message: `Stock push for item ${rawItemId} refused — branch ${branchId} has no linked Petpooja outlet (link per Runbook §5)`,
        branchId,
      });
      return false;
    }
    const restId = linked;

    // Guard branch/product ownership & missing product BEFORE vendor I/O
    const productRef = db.collection("products").doc(productId);
    let initialProductSnap: any;
    try {
      initialProductSnap = await productRef.get();
    } catch (err: any) {
      console.warn(`[Petpooja Stock Push] Product read failed for ${productId}:`, err?.message || err);
      return false;
    }
    if (!initialProductSnap.exists) {
      console.warn(
        `[Petpooja Stock Push] Product ${productId} does not exist — refusing stock push (no orphan/partial doc creation)`
      );
      await captureErrorSnapshot({
        source: "petpooja",
        severity: "high",
        message: `Stock push for item ${rawItemId} refused — product ${productId} does not exist at branch ${branchId}`,
        branchId,
      });
      return false;
    }
    const prodData = initialProductSnap.data() || {};
    // Require matching branch and vendor-item ownership BEFORE wire
    if (!prodData.branchId || prodData.branchId !== branchId) {
      console.warn(
        `[Petpooja Stock Push] Product ${productId} missing or mismatched branch ownership (${prodData.branchId} vs ${branchId}) — refusing`
      );
      await captureErrorSnapshot({
        source: "petpooja",
        severity: "high",
        message: `Stock push for item ${rawItemId} refused — product ${productId} missing or mismatched branch ownership (${prodData.branchId} vs ${branchId})`,
        branchId,
      });
      return false;
    }
    if (
      (prodData.petpoojaItemId && String(prodData.petpoojaItemId) !== String(rawItemId)) ||
      (prodData.itemId && String(prodData.itemId) !== String(rawItemId))
    ) {
      console.warn(
        `[Petpooja Stock Push] Product ${productId} contradictory vendor-item ownership (${prodData.petpoojaItemId || prodData.itemId} vs ${rawItemId}) — refusing`
      );
      await captureErrorSnapshot({
        source: "petpooja",
        severity: "high",
        message: `Stock push for item ${rawItemId} refused — product ${productId} contradictory vendor-item ownership (${prodData.petpoojaItemId || prodData.itemId} vs ${rawItemId})`,
        branchId,
      });
      return false;
    }

    const requestInitiatedAt = Date.now();
    const petpoojaConfig = getPetpoojaConfig();
    const response = await fetch(petpoojaConfig.stockUrl, {
      method: "POST",
      // Loop: hung gateway held the function until platform timeout.
      signal: AbortSignal.timeout(15_000),
      headers: {
        "Content-Type": "application/json",
        // Legacy headers (Content_key + Bearer) AND the documented
        // app-key/app-secret/access-token trio: the published
        // update_item_stock contract authenticates with the latter, our
        // integration shipped with the former. Dual-send until the sandbox
        // probe pins exactly one — an 86 that never lands is a lie to the
        // kitchen either way.
        "Content_key": petpoojaConfig.appKey,
        "app-key": petpoojaConfig.appKey,
        "app-secret": petpoojaConfig.appSecret,
        "access-token": petpoojaConfig.accessToken,
        Authorization: `Bearer ${petpoojaConfig.accessToken}`,
      },
      body: JSON.stringify({
        app_key: petpoojaConfig.appKey,
        app_secret: petpoojaConfig.appSecret,
        access_token: petpoojaConfig.accessToken,
        // Dual key spelling (rest_id/restID, item_id/itemID, in_stock/inStock,
        // scalar + array item id) — same values, whichever the POS reads.
        rest_id: restId,
        restID: restId,
        item_id: rawItemId,
        itemID: [rawItemId],
        in_stock: inStock ? 1 : 0,
        inStock: inStock,
        type: "item",
      }),
    });

    const result: any = await response.json().catch(() => null);
    // Petpooja acks vary (success:"1"/1/true or status:"success") — accept
    // all documented forms, like orderPush does. Anything else (HTTP error,
    // empty/garbage body, explicit reject) is a FAILURE, and a failure must
    // leave an alert behind: the KDS is about to show "not synced".
    const acked =
      response.ok &&
      !!result &&
      (result.success === "1" ||
        result.success === 1 ||
        result.success === true ||
        result.status === "success");
    if (!acked) {
      await captureErrorSnapshot({
        source: "petpooja",
        severity: "high",
        message:
          `Petpooja stock push rejected/unreachable — branch ${branchId} item ${rawItemId} inStock=${inStock} ` +
          `(HTTP ${response.status}${result?.message ? `: ${result.message}` : ""})`,
        branchId,
      });
      return false;
    }

    // On acknowledged live POS success, atomically verify version/precondition and commit
    const initialUpdateTime = initialProductSnap.updateTime;
    let committed = false;
    let conflictReason: string | null = null;

    if (db && typeof (db as any).runTransaction === "function") {
      try {
        const txOutcome = await (db as any).runTransaction(async (tx: any) => {
          const freshSnap = await tx.get(productRef);
          if (!freshSnap.exists) {
            return "missing";
          }
          const freshData = freshSnap.data() || {};
          if (!freshData.branchId || freshData.branchId !== branchId) {
            return "ownership_mismatch";
          }
          if (
            (freshData.petpoojaItemId && String(freshData.petpoojaItemId) !== String(rawItemId)) ||
            (freshData.itemId && String(freshData.itemId) !== String(rawItemId))
          ) {
            return "ownership_mismatch";
          }

          // Strict version check against immutable initial snapshot:
          // Check updateTime if available; check inStock conflict or updatedAt
          const freshUpdateTime = freshSnap.updateTime;
          const versionMatches =
            initialUpdateTime && freshUpdateTime
              ? typeof initialUpdateTime.isEqual === "function"
                ? initialUpdateTime.isEqual(freshUpdateTime)
                : initialUpdateTime === freshUpdateTime
              : true;

          if (!versionMatches) {
            return "stale_conflict";
          }

          const updateData = {
            inStock: inStock,
            lastPetpoojaStockPush: admin.firestore.FieldValue.serverTimestamp(),
            lastPetpoojaSync: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          };

          if (initialUpdateTime) {
            try {
              tx.update(productRef, updateData, { lastUpdateTime: initialUpdateTime });
            } catch {
              tx.update(productRef, updateData);
            }
          } else {
            tx.update(productRef, updateData);
          }
          return "committed";
        });

        if (txOutcome === "committed") {
          committed = true;
        } else {
          conflictReason = txOutcome;
        }
      } catch (txErr: any) {
        console.warn(`[Petpooja Stock Push] Transaction commit failed for ${productId}:`, txErr?.message || txErr);
        conflictReason = txErr?.message || "transaction_failed";
      }
    } else {
      // Fallback path without runTransaction
      try {
        const freshSnap = await productRef.get();
        if (!freshSnap.exists) {
          conflictReason = "missing";
        } else {
          const freshData = freshSnap.data() || {};
          if (!freshData.branchId || freshData.branchId !== branchId) {
            conflictReason = "ownership_mismatch";
          } else {
            const freshUpdateTime = freshSnap.updateTime;
            const versionMatches =
              initialUpdateTime && freshUpdateTime
                ? typeof initialUpdateTime.isEqual === "function"
                ? initialUpdateTime.isEqual(freshUpdateTime)
                : initialUpdateTime === freshUpdateTime
                : true;

            if (!versionMatches) {
              conflictReason = "stale_conflict";
            } else {
              const updateData = {
                inStock: inStock,
                lastPetpoojaStockPush: admin.firestore.FieldValue.serverTimestamp(),
                lastPetpoojaSync: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              };
              if (initialUpdateTime) {
                await productRef.update(updateData, { lastUpdateTime: initialUpdateTime });
              } else {
                await productRef.update(updateData);
              }
              committed = true;
            }
          }
        }
      } catch (updateErr: any) {
        conflictReason = updateErr?.message || "update_failed";
      }
    }

    if (committed) {
      return true;
    }

    if (conflictReason === "stale_conflict") {
      console.warn(
        `[Petpooja Stock Push] Newer stock toggle detected for ${productId} (version conflict) — skipping stale POS ack overwrite`
      );
      await captureErrorSnapshot({
        source: "petpooja",
        severity: "high",
        message: `Petpooja POS acknowledged stock push for item ${rawItemId} at branch ${branchId}, but local product ${productId} was updated concurrently — preserving newer local state, manual reconciliation required`,
        branchId,
      });
      return false;
    }

    if (conflictReason === "missing") {
      console.warn(`[Petpooja Stock Push] Product ${productId} vanished after POS ack — reconciliation warning`);
      await captureErrorSnapshot({
        source: "petpooja",
        severity: "high",
        message: `POS acknowledged stock push for item ${rawItemId} at branch ${branchId}, but local product ${productId} vanished — manual reconciliation required`,
        branchId,
      });
      return false;
    }

    if (conflictReason === "ownership_mismatch") {
      console.warn(`[Petpooja Stock Push] Product ${productId} ownership mismatch on write — refusing`);
      return false;
    }

    console.error(`[Petpooja Stock Push] POS acknowledged but local write failed for ${productId}: ${conflictReason}`);
    await captureErrorSnapshot({
      source: "petpooja",
      severity: "high",
      message: `Petpooja POS acknowledged stock push for item ${rawItemId} at branch ${branchId}, but local product write failed: ${conflictReason} — manual reconciliation required`,
      branchId,
    });
    return false;
  } catch (err: any) {
    console.warn(`[Petpooja Stock Push Error] Failed for item ${itemId}:`, err.message);
    await captureErrorSnapshot({
      source: "petpooja",
      severity: "high",
      message: `Petpooja stock push failed for item ${itemId} at branch ${branchId}: ${err?.message || err}`,
      branchId,
    });
    return false;
  }
}

/**
 * Handles incoming order lifecycle webhook updates (e.g. food ready, driver assigned, cancellation).
 *
 * Petpooja identifies outlets by restID, not our branchId. Resolve it through
 * branches/{petpoojaStoreId} FIRST — using rest_id as branchId writes orders
 * no branch-scoped view can ever find.
 */
export async function resolveBranchIdForRestId(restId: string): Promise<string | null> {
  if (!restId) return null;
  try {
    const col = db.collection("branches") as any;
    // Indexed query ONLY (single-field petpoojaStoreId == restId, limit 1).
    // The old bounded full-scan fallback read up to 100 branch docs per
    // webhook on datastores without query support (H10/M30 cost + latency) —
    // removed in B4-S1. Unlinked outlets resolve to null and callers skip
    // loudly (menu webhook) or stage an orphan doc (86ing) instead.
    if (typeof col.where !== "function") {
      console.warn(`[Petpooja] branch reverse-lookup skipped for rest ${restId}: no indexed query support`);
      return null;
    }
    const snap = await col.where("petpoojaStoreId", "==", restId).limit(1).get();
    const docs = snap.docs || [];
    if (docs.length > 0) return docs[0].id;
  } catch (err) {
    console.warn(`[Petpooja] branch reverse-lookup failed for rest ${restId}:`, (err as any)?.message || err);
  }
  return null;
}

/** Documented 200 body for Get Store Status (vendor 200 OK section). */
export const PETPOOJA_STORE_STATUS_FETCHED_MESSAGE =
  "Store Delivery Status fetched successfully";

/**
 * Cap on the caller-controlled `turn_on_time` we persist. The vendor sends a
 * datetime; anything longer is not a datetime, it is payload padding that would
 * otherwise be written whole into the branch document.
 */
export const MAX_TURN_ON_TIME_CHARS = 64;

export interface PetpoojaStoreStatusReply {
  kind: "get" | "update";
  httpStatus: number;
  body: Record<string, any>;
}

/**
 * The storefront document the CUSTOMER app gates ordering on.
 *
 * `branches/{id}.acceptingOrdersStatus` is the Partner-app flag, and NO
 * customer ordering path reads it — the live gate is `stores/{id}.isOpen`
 * (`storesService.mapStoreDoc` → `PaymentRepository` closed-store gate →
 * checkout/cart `kitchen.isOpen` disabled states). Writing only the branch flag
 * left customers able to order from an outlet the POS had closed, so the POS
 * update has to land HERE.
 *
 * Resolution and the staff-override predicate live in `../stores/storeStatus`
 * so the Partner open/close route resolves the SAME storefront with the SAME
 * rules: two implementations would drift, and drift here means the POS and the
 * operator disagree about which document stops ordering.
 */
export { resolveStorefrontForBranch, staffCloseOverrideInForce, type StorefrontMatch } from "../stores/storeStatus";

/**
 * The vendor's documented store-status encoding: `"1"` is open/accepting,
 * `"0"` is closed. Derived from the storefront the customer app reads (falling
 * back to the branch flags when no storefront is linked) — never from the
 * request — so a merchant reading us back sees what we would actually serve.
 */
/**
 * The vendor's documented store-status encoding: `"1"` open, `"0"` closed.
 * Derived from stored state — never from the request.
 *
 * CLOSED WINS. Two independent signals can say "closed": the branch lifecycle /
 * Partner flag (`branches/*`) and the storefront gate the customer app reads
 * (`stores/*.isOpen`). If either says closed we answer `0`, because an outlet
 * that any authoritative signal has closed must never be advertised to the POS
 * as open — a wrong "1" invites orders we would then have to reject.
 */
function storeStatusFromState(storefront: any, branch: any): "1" | "0" {
  if (branch && typeof branch === "object") {
    if (branch.active === false) return "0";
    const lifecycle =
      typeof branch.status === "string" ? branch.status.trim().toLowerCase() : "";
    if (lifecycle === "paused" || lifecycle === "inactive") return "0";
    const accepting =
      typeof branch.acceptingOrdersStatus === "string"
        ? branch.acceptingOrdersStatus.trim().toLowerCase()
        : "";
    if (accepting === "closed") return "0";
  }

  // The storefront doc is the gate the customer app actually reads.
  if (storefront && typeof storefront === "object" && typeof storefront.isOpen === "boolean") {
    if (storefront.isOpen === false) return "0";
  }
  return "1";
}

/** `"0"`/`"1"` as sent by the vendor, or null when the value is undocumented. */
function normalizeStoreStatusValue(raw: unknown): "0" | "1" | null {
  if (raw === 0 || raw === "0") return "0";
  if (raw === 1 || raw === "1") return "1";
  return null;
}

function storeStatusFailure(
  message: string,
  kind: "get" | "update",
  reason?: string
): PetpoojaStoreStatusReply {
  return {
    kind,
    httpStatus: 200,
    body: {
      http_code: 400,
      status: "failed",
      store_status: "",
      message,
      ...(reason ? { reason } : {}),
    },
  };
}

/** The capped `turn_on_time`, or null when absent/unusable. */
export function normalizeTurnOnTime(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_TURN_ON_TIME_CHARS);
}

/**
 * Get / Update Store Status callbacks (vendor documents them as
 * `{ restID }` and `{ restID, store_status, turn_on_time, reason }`).
 *
 * Returns `null` when the payload is NOT one of those two shapes — an order
 * callback (it carries an order reference), a bare legacy `{ restID, status }`
 * ping, or anything without a restID — so the caller keeps its existing path:
 * the legacy ping stays "recorded, not applied" (its encoding was never
 * confirmed) and an order event still reaches the order-lifecycle handler.
 *
 * Default-deny is preserved: an update is APPLIED only with a verified auth
 * context. Without one the callback is recorded (so real traffic is visible)
 * and answered with the failure body, and no branch is touched.
 */
export async function handlePetpoojaStoreStatus(
  payload: any,
  auth: unknown = {}
): Promise<PetpoojaStoreStatusReply | null> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;

  // An order event also carries restID (+ status) — it is never a store ping.
  const orderRef =
    payload.orderID ??
    payload.order_id ??
    payload.clientOrderID ??
    payload.client_order_id ??
    payload.petpooja_order_id;
  if (orderRef !== undefined && orderRef !== null && orderRef !== "") return null;

  const restIdClaim =
    payload.restID ?? payload.rest_id ?? payload.restId ?? payload.restaurantid;
  if (restIdClaim === undefined || restIdClaim === null) return null;
  const restIdText = String(restIdClaim).trim();
  if (!restIdText) return null;

  const hasStoreStatus =
    Object.prototype.hasOwnProperty.call(payload, "store_status") ||
    Object.prototype.hasOwnProperty.call(payload, "storeStatus");
  const hasLegacyStatus = Object.prototype.hasOwnProperty.call(payload, "status");

  // Legacy `{ restID, status }` ping — handed back to the caller's
  // record-only path on purpose.
  if (!hasStoreStatus && hasLegacyStatus) return null;

  // A bare `{ restID }` is the documented Get Store Status request.
  if (!hasStoreStatus) {
    // Read-only by construction: this branch answers from stored state and
    // never writes a branch/store/product. `trusted` is the REAL auth verdict —
    // the documented request arrives without a credential, so a hardcoded
    // `true` would forge trust in the evidence row.
    const trustedRead = isTrustedPetpoojaAuth(auth);
    const branchId = await resolveBranchIdForRestId(restIdText);
    if (!branchId) {
      console.warn(
        `[Petpooja Store Status] GET for unlinked outlet ${boundedParkedString(
          restIdText,
          PARKED_REF_MAX_CHARS
        )} — answering the failure body, no state claimed`
      );
      await recordStoreStatusEvent(restIdText, null, null, trustedRead);
      return storeStatusFailure(
        `Store ${boundedParkedString(restIdText, PARKED_REF_MAX_CHARS)} is not linked to a branch`,
        "get"
      );
    }
    let branchData: any = null;
    try {
      const snap = await db.collection("branches").doc(branchId).get();
      branchData = snap?.exists ? snap.data() : null;
    } catch (err: any) {
      console.warn(
        `[Petpooja Store Status] GET could not read branch ${branchId}:`,
        err?.message || err
      );
      await recordStoreStatusEvent(restIdText, branchId, null, trustedRead);
      return storeStatusFailure("Store status could not be read", "get");
    }
    // Report the state the CUSTOMER is actually served: the storefront gate
    // first, the branch flags only as a fallback when no storefront is linked.
    let storefrontData: any = null;
    try {
      const resolved = await resolveStorefrontForBranch(branchId, restIdText);
      storefrontData = resolved.match?.data ?? null;
    } catch (err: any) {
      // A lookup failure must not be reported as "closed" — fall through to the
      // branch flags, which are readable state, and let the branch answer.
      console.warn(
        `[Petpooja Store Status] GET storefront lookup failed for branch ${branchId}:`,
        err?.message || err
      );
    }
    const storeStatus = storeStatusFromState(storefrontData, branchData);
    await recordStoreStatusEvent(restIdText, branchId, storeStatus, trustedRead);
    return {
      kind: "get",
      httpStatus: 200,
      body: {
        http_code: 200,
        status: "success",
        store_status: storeStatus,
        message: PETPOOJA_STORE_STATUS_FETCHED_MESSAGE,
      },
    };
  }

  const rawStatus = payload.store_status ?? payload.storeStatus;
  const requested = normalizeStoreStatusValue(rawStatus);
  const trusted = isTrustedPetpoojaAuth(auth);

  if (requested === null) {
    await recordStoreStatusEvent(restIdText, null, boundedParkedString(rawStatus ?? null, PARKED_STATUS_MAX_CHARS), trusted);
    return storeStatusFailure(
      `Unsupported store_status ${JSON.stringify(
        boundedParkedString(rawStatus ?? null, PARKED_STATUS_MAX_CHARS)
      )} — documented values are 0 (closed) and 1 (open)`,
      "update"
    );
  }

  const branchId = await resolveBranchIdForRestId(restIdText);
  if (!branchId) {
    await recordStoreStatusEvent(restIdText, null, requested, trusted);
    return storeStatusFailure(
      `Store ${boundedParkedString(restIdText, PARKED_REF_MAX_CHARS)} is not linked to a branch`,
      "update"
    );
  }

  if (!trusted) {
    // Recorded, not applied: closing a live outlet is a canonical write and
    // only a verified credential may make it.
    console.warn(
      `[Petpooja Store Status] REFUSED unauthenticated update rest=${boundedParkedString(
        restIdText,
        PARKED_REF_MAX_CHARS
      )} requested=${requested} — recorded for review, branch unchanged`
    );
    await recordStoreStatusEvent(restIdText, branchId, requested, false);
    return storeStatusFailure(
      "Store status update requires a verified Petpooja credential",
      "update"
    );
  }

  const acceptingOrdersStatus = requested === "1" ? "open" : "closed";
  const turnOnAt = normalizeTurnOnTime(payload.turn_on_time);
  const reason =
    typeof payload.reason === "string" && payload.reason.trim()
      ? payload.reason.trim().slice(0, 500)
      : null;

  // Which document actually stops ordering? The storefront (`stores/{id}.isOpen`).
  // Resolve it BEFORE any write so an unlinked or ambiguous outlet fails cleanly
  // instead of half-applying the branch flag.
  let branchData: Record<string, any> = {};
  try {
    const branchSnap = await db.collection("branches").doc(branchId).get();
    branchData = branchSnap?.exists ? branchSnap.data() || {} : {};
  } catch (err: any) {
    // The branch read is only needed for the staff-override check below. A
    // failure must not silently treat an override as absent (that would let a
    // POS open undo a staff close), so refuse and touch nothing.
    console.warn(
      `[Petpooja Store Status] could not read branch ${branchId}:`,
      err?.message || err
    );
    await recordStoreStatusEvent(restIdText, branchId, requested, true);
    return storeStatusFailure("Store status could not be updated", "update");
  }

  let storefront: StorefrontMatch | null = null;
  let ambiguous = false;
  try {
    const resolved = await resolveStorefrontForBranch(branchId, restIdText);
    storefront = resolved.match;
    ambiguous = resolved.ambiguous;
  } catch (err: any) {
    console.warn(
      `[Petpooja Store Status] storefront lookup failed for branch ${branchId}:`,
      err?.message || err
    );
    await recordStoreStatusEvent(restIdText, branchId, requested, true);
    return storeStatusFailure("Store status could not be updated", "update");
  }

  if (ambiguous) {
    // Two storefronts claim this outlet/branch. Closing the wrong outlet is a
    // worse outcome than a failed callback, so refuse and leave both untouched.
    console.error(
      `[Petpooja Store Status] AMBIGUOUS storefront for branch ${branchId} / rest ${boundedParkedString(
        restIdText,
        PARKED_REF_MAX_CHARS
      )} — update refused, nothing written`
    );
    await captureErrorSnapshot({
      source: "petpooja",
      severity: "high",
      message: `Petpooja store-status update refused: more than one store doc claims branch ${branchId} / rest ${restIdText}`,
      branchId,
    });
    await recordStoreStatusEvent(restIdText, branchId, requested, true);
    return storeStatusFailure(
      `Store ${boundedParkedString(restIdText, PARKED_REF_MAX_CHARS)} resolves to more than one storefront — update refused`,
      "update"
    );
  }

  if (!storefront) {
    // "Success" here would be the exact bug this follow-up fixes: the POS thinks
    // it closed the outlet while customers keep ordering. Answer the documented
    // failure and leave the branch flag alone so nothing is half-applied.
    console.error(
      `[Petpooja Store Status] no storefront linked to branch ${branchId} (rest ${boundedParkedString(
        restIdText,
        PARKED_REF_MAX_CHARS
      )}) — update refused, nothing written`
    );
    await captureErrorSnapshot({
      source: "petpooja",
      severity: "high",
      message: `Petpooja store-status update refused: no stores/* doc carries branch ${branchId} or rest ${restIdText}; customers would still be able to order`,
      branchId,
    });
    await recordStoreStatusEvent(restIdText, branchId, requested, true);
    return storeStatusFailure(
      `Store ${boundedParkedString(restIdText, PARKED_REF_MAX_CHARS)} is not linked to a storefront — update refused`,
      "update"
    );
  }

  const desiredOpen = requested === "1";

  // RULE C (owner decision 2026-11-20): a staff "close" in the Partner app wins
  // until staff reopen. The override is stamped by the Partner open/close route
  // on both the storefront and the branch, and ONLY a staff reopen clears it —
  // so a POS "open" must not undo it. A POS "close" while the override stands is
  // a no-op agreement: it keeps the override AND must not rewrite the gate, or
  // its own idempotence would erase the staff reason.
  const staffClosed = staffCloseOverrideInForce(storefront.data, branchData);
  if (staffClosed && desiredOpen) {
    console.warn(
      `[Petpooja Store Status] POS open REFUSED for branch ${branchId}: a staff close is in force (override set)`
    );
    await recordStoreStatusEvent(restIdText, branchId, requested, true);
    return storeStatusFailure(
      `Store ${boundedParkedString(
        restIdText,
        PARKED_REF_MAX_CHARS
      )} was closed from the Burgonomics Partner app — reopen it there before accepting orders`,
      "update"
    );
  }

  if (staffClosed) {
    // Staff already closed it and the POS agrees. Touch NOTHING: rewriting the
    // gate with `storeStatusSource: "petpooja"` would relabel a staff decision
    // as a POS one and could drop the staff reason on a later replay.
    await recordStoreStatusEvent(restIdText, branchId, requested, true);
    return {
      kind: "update",
      httpStatus: 200,
      body: {
        http_code: 200,
        status: "success",
        message: `Store Status updated successfully for store ${boundedParkedString(
          restIdText,
          PARKED_REF_MAX_CHARS
        )}`,
      },
    };
  }

  try {
    // (1) The customer gate. `isOpen` is the single field the customer app reads
    //     (`storesService.mapStoreDoc` → `PaymentRepository` closed-store gate →
    //     cart/checkout disabled states), so this write is what actually stops
    //     and restarts ordering. It goes to the SAME collection the storefront
    //     was resolved from: `stores` is authoritative, but the customer
    //     directory falls back to `admin_stores` when `stores` is empty
    //     (`storesService.fetchFirestoreStores`), and in that deployment
    //     `admin_stores` IS the gate.
    const storeRef = db.collection(storefront.collection).doc(storefront.storeId);
    const storeSnap = await storeRef.get();
    const storeCurrent = storeSnap?.exists ? storeSnap.data() || {} : null;
    const storeUnchanged =
      storeCurrent !== null &&
      storeCurrent.isOpen === desiredOpen &&
      storeCurrent.storeStatusSource === "petpooja" &&
      (turnOnAt === null ? true : (storeCurrent.storeTurnOnAt ?? null) === turnOnAt) &&
      (reason === null ? true : (storeCurrent.storeStatusReason ?? null) === reason);
    if (!storeUnchanged) {
      await storeRef.set(
        {
          isOpen: desiredOpen,
          storeStatusSource: "petpooja",
          storeStatusReason: reason,
          storeTurnOnAt: turnOnAt,
          storeStatusUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    // (2) The Partner-app flag. Kept in step because operators read it in the
    //     branch screens, and because a stale "open" there is what a human would
    //     trust over the POS.
    const branchRef = db.collection("branches").doc(branchId);
    const snap = await branchRef.get();
    const current = snap?.exists ? snap.data() || {} : {};
    // Idempotent: a repeated identical update must not rewrite the branch (a
    // rewrite would invalidate every concurrent reader's version and re-drive
    // listeners for no state change).
    const unchanged =
      current.acceptingOrdersStatus === acceptingOrdersStatus &&
      (turnOnAt === null ? true : (current.turnOnAt ?? null) === turnOnAt) &&
      (reason === null ? true : (current.storeStatusReason ?? null) === reason);
    if (!unchanged) {
      await branchRef.set(
        {
          acceptingOrdersStatus,
          turnOnAt,
          storeStatusReason: reason,
          storeStatusSource: "petpooja",
          storeStatusUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    // (3) The Partner directory copy, when one exists. Only an EXISTING doc is
    //     touched: creating a partial `admin_stores` record from a POS callback
    //     would fabricate a directory entry the operator never created.
    try {
      const adminRef = db.collection("admin_stores").doc(storefront.storeId);
      const adminSnap = await adminRef.get();
      if (adminSnap?.exists) {
        const adminCurrent = adminSnap.data() || {};
        if (adminCurrent.isOpen !== desiredOpen) {
          await adminRef.set(
            {
              isOpen: desiredOpen,
              storeStatusSource: "petpooja",
              storeStatusUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        }
      }
    } catch (err: any) {
      // The Partner directory is a mirror, not the gate: a failure here must not
      // turn a successful close into a failure reply.
      console.warn(
        `[Petpooja Store Status] admin_stores mirror update failed for ${storefront.storeId}:`,
        err?.message || err
      );
    }
  } catch (err: any) {
    console.warn(
      `[Petpooja Store Status] update failed for branch ${branchId}:`,
      err?.message || err
    );
    await captureErrorSnapshot({
      source: "petpooja",
      severity: "high",
      message: `Petpooja store-status update for branch ${branchId} could not be applied`,
      branchId,
    });
    await recordStoreStatusEvent(restIdText, branchId, requested, true);
    return storeStatusFailure("Store status could not be updated", "update");
  }

  await recordStoreStatusEvent(restIdText, branchId, requested, true);
  return {
    kind: "update",
    httpStatus: 200,
    body: {
      http_code: 200,
      status: "success",
      message: `Store Status updated successfully for store ${boundedParkedString(
        restIdText,
        PARKED_REF_MAX_CHARS
      )}`,
    },
  };
}

/** Non-blocking evidence row; a recording failure must never fail the reply. */
async function recordStoreStatusEvent(
  restIdClaim: string,
  branchId: string | null,
  storeStatus: string | null,
  trusted: boolean
): Promise<void> {
  try {
    await db
      .collection("petpooja_store_status_events")
      .doc(parkedDocId("ss_", restIdClaim))
      .set(
        {
          restId: boundedParkedString(restIdClaim, PARKED_REF_MAX_CHARS),
          branchId,
          storeStatus,
          trusted,
          receivedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
  } catch (err: any) {
    console.warn(
      "[Petpooja Store Status] failed to record event:",
      err?.message || err
    );
  }
}

/**
 * Petpooja's Configuration page points BOTH "Get Store Status" and "Update
 * Store Status" at this same webhook, and those payloads carry no order id —
 * e.g. `{"restID":"31z58ciw0h","status":"1"}`. Recognise that shape so the
 * order-lifecycle path does not throw on it (it used to answer HTTP 500, which
 * Petpooja reads as a broken webhook and retries or disables).
 *
 * Only consulted when no order id is present: a real order event also carries
 * `restID` + `status`, so this must never be allowed to shadow one.
 */
function isStoreStatusPayload(payload: any): boolean {
  if (!payload || typeof payload !== "object") return false;
  const restId = payload.rest_id ?? payload.restId ?? payload.restID ?? payload.restaurantid;
  const status = payload.status ?? payload.store_status ?? payload.storeStatus;
  return Boolean(restId) && status !== undefined && status !== null && status !== "";
}

/**
 * Resolve an order from the POS-assigned id Petpooja sends in the callback's
 * `orderID` field.
 *
 * The inbound handler previously never read that key, and nothing in the
 * codebase was keyed on `petpoojaOrderId` (only the outbound success branch ever
 * wrote it), so a genuine status update could not find the order it referred to.
 *
 * Single-field equality only — `petpoojaOrderId` needs no composite index. When
 * the callback also names a resolvable branch, a match outside that branch is
 * refused rather than applied, so a POS id cannot be used to move another
 * outlet's order.
 */
async function resolveOrderByPosOrderId(posOrderId: string, branchId: string | null): Promise<any> {
  if (!posOrderId) return null;
  try {
    const col = db.collection("orders") as any;
    if (typeof col.where !== "function") return null;
    const snap = await col.where("petpoojaOrderId", "==", posOrderId).limit(5).get();
    const docs = snap.docs || [];
    if (!docs.length) return null;
    // Fail CLOSED when the branch cannot be resolved: a bare `orderID` with no
    // usable `restID` must not be able to reach an arbitrary outlet's order.
    // Genuine callbacks always carry restID — the middleware gate requires it.
    if (!branchId) {
      console.warn(
        `[Petpooja Webhook] POS id ${posOrderId} refused: restID unresolved, cannot scope to an outlet`
      );
      return null;
    }
    const match = docs.find((d: any) => ((d.data() || {}) as any).branchId === branchId);
    if (!match) {
      console.warn(
        `[Petpooja Webhook] POS id ${posOrderId} matched only orders outside branch ${branchId} — refused`
      );
      return null;
    }
    return match;
  } catch (err) {
    console.warn(
      `[Petpooja Webhook] POS-id lookup failed for ${posOrderId}:`,
      (err as any)?.message || err
    );
    return null;
  }
}

/**
 * The verified auth context callers SHOULD pass. The handlers accept `unknown`
 * at the parameter boundary so a malformed value cannot bypass the runtime
 * default-deny check (a compile-time-only contract would not protect a
 * JavaScript caller or an untyped route).
 */
export interface PetpoojaWebhookAuth {
  /**
   * True ONLY when `verifyPetpoojaAuth` proved the caller's credential (static
   * app-key token or a valid HMAC signature over the raw body) or otherwise
   * admitted a verified call. Every other value — omitted, `{}`, `null`, a
   * non-boolean, or an explicit false (the middleware's credential-less
   * SHAPE admission) — is UNTRUSTED and may not write canonical state.
   */
  authenticated?: boolean;
}

export async function handlePetpoojaWebhook(
  payload: any,
  auth: unknown = {}
): Promise<PetpoojaStoreStatusReply | void> {
  // Default-deny. This used to read `auth.authenticated === false`, so an
  // omitted/empty/malformed auth context fell through to the trusted path and
  // could rewrite canonical order status, POS acceptance, refunds and payment
  // facts. Only the boolean `true` set after verification is trusted.
  const trusted = isTrustedPetpoojaAuth(auth);
  const untrusted = !trusted;
  // Documented Get / Update Store Status callbacks share this route. The
  // handler returns their documented reply (or null when the payload is not
  // one of those shapes), so the route can answer with the vendor's body.
  const storeStatusReply = await handlePetpoojaStoreStatus(payload, auth);
  if (storeStatusReply) return storeStatusReply;
  // Our own order references. `order_id` / `clientOrderID` are the legacy
  // client fields. The documented order-status callback instead carries
  // `orderID` = "Unique client order id which is used to update order status at
  // client side" (vendor Apiary V2.1 blueprint), so it is a CLIENT reference
  // first — not automatically the POS's own id.
  const legacyClientRef = payload.order_id || payload.clientOrderID || payload.client_order_id;
  const callbackOrderId =
    payload.orderID != null && payload.orderID !== "" ? String(payload.orderID) : "";
  // Explicit POS id field, when the vendor sends one.
  const explicitPosOrderId =
    payload.petpooja_order_id != null && payload.petpooja_order_id !== ""
      ? String(payload.petpooja_order_id)
      : "";
  // Candidate POS id: the callback `orderID` is only treated as POS-issued when
  // the POS-id fallback below proves it (a matching branch-scoped order), or
  // when the payload carries the explicit petpooja_order_id field.
  const posOrderId = callbackOrderId || explicitPosOrderId;
  let orderId = legacyClientRef;

  // A payload carrying a POS order id is an ORDER event, never a store-status
  // ping, so it must not be swallowed by the store-status branch below. (A real
  // order event also carries restID + status, which is that branch's shape.)
  if (!orderId && !posOrderId && isStoreStatusPayload(payload)) {
    const restIdClaim = String(
      payload.rest_id ?? payload.restId ?? payload.restID ?? payload.restaurantid
    );
    // Caller-controlled: look up with the exact claim (a padded id must not
    // collide with a real outlet) but store a bounded copy and doc id.
    const restId =
      boundedParkedString(restIdClaim, PARKED_REF_MAX_CHARS) || "(absent)";
    const rawStatus = payload.status ?? payload.store_status ?? payload.storeStatus;
    const branchId = await resolveBranchIdForRestId(restIdClaim);
    console.log(
      `[Petpooja Webhook] Store-status ping restID=${restId} status=${JSON.stringify(
        boundedParkedString(rawStatus ?? null, PARKED_STATUS_MAX_CHARS)
      )} ${branchId ? `branch=${branchId}` : "branch=UNLINKED"}`
    );
    // Recorded, not applied. Petpooja's status encoding for this webhook is
    // unverified, and closing a live outlet on a guessed value is worse than
    // not acting; the recording gives the real encoding to confirm against.
    try {
      await db
        .collection("petpooja_store_status_events")
        .doc(parkedDocId("ss_", restIdClaim))
        .set(
          {
            restId,
            branchId: branchId ?? null,
            rawStatus: boundedParkedString(rawStatus ?? null, PARKED_STATUS_MAX_CHARS),
            // A hint row is allowed for an unverified caller (it changes no
            // canonical state), but triage must be able to tell them apart.
            trusted,
            receivedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
    } catch (err) {
      console.warn(
        "[Petpooja Webhook] Failed to record store-status event:",
        (err as any)?.message || err
      );
    }
    return;
  }

  if (!orderId && !posOrderId) {
    throw new Error(
      "Missing order_id / orderID in Petpooja status webhook payload"
    );
  }

  const restIdRaw = String(
    payload.rest_id ?? payload.restId ?? payload.restID ?? payload.restaurantid ?? ""
  );

  // Resolve the order: CLIENT references first (the documented callback shape),
  // then the POS-assigned id. The POS path stays for callbacks that genuinely
  // carry a POS id, but it must not be used to bypass a contradictory client
  // reference — an id that names another outlet's order is a contradiction, not
  // a miss. Every reference is branch-scoped by the callback's restID.
  let orderDoc: any = null;
  let resolvedBy: "client-callback" | "client-legacy" | "pos" | null = null;
  let parkReason: string | null = null;
  const scopedBranchId = restIdRaw ? await resolveBranchIdForRestId(restIdRaw) : null;

  // A callback that CLAIMS an outlet we cannot resolve must not fall back to an
  // unscoped client lookup: the claim cannot be verified, so park it. (A payload
  // with no restID at all keeps the legacy behaviour below; the store-status
  // shape was already handled above.)
  if (restIdRaw && !scopedBranchId) {
    parkReason = `restID ${boundedParkedString(
      restIdRaw,
      PARKED_REF_MAX_CHARS
    )} did not resolve to a linked branch`;
  }

  const clientCandidates: Array<{
    ref: string;
    kind: "client-callback" | "client-legacy";
  }> = [];
  if (legacyClientRef != null && legacyClientRef !== "") {
    clientCandidates.push({ ref: String(legacyClientRef), kind: "client-legacy" });
  }
  // The documented `orderID` client ref is only resolvable when the callback
  // names an outlet we can scope it to; a bare id must never reach an order.
  if (
    callbackOrderId &&
    scopedBranchId &&
    !clientCandidates.some((candidate) => candidate.ref === callbackOrderId)
  ) {
    clientCandidates.push({ ref: callbackOrderId, kind: "client-callback" });
  }

  const clientMatches: Array<{
    doc: any;
    kind: "client-callback" | "client-legacy";
  }> = [];
  for (const candidate of clientCandidates) {
    const snap = await db.collection("orders").doc(candidate.ref).get();
    if (!snap.exists) continue;
    const docBranch = String(((snap.data() || {}) as any).branchId ?? "");
    if (scopedBranchId && docBranch !== scopedBranchId) {
      // Contradictory client ref/outlet: PARK. Falling through to the POS-id
      // path could apply this callback to a different outlet's order.
      parkReason = `client ref ${boundedParkedString(
        candidate.ref,
        PARKED_REF_MAX_CHARS
      )} belongs to branch ${docBranch || "none"}, outside callback outlet ${scopedBranchId}`;
      clientMatches.length = 0;
      break;
    }
    clientMatches.push({ doc: snap, kind: candidate.kind });
  }

  if (!parkReason && clientMatches.length > 0) {
    const distinct = new Set(
      clientMatches.map((match) => match.doc.id || match.doc.ref?.id)
    );
    if (distinct.size > 1) {
      // Two references naming two different orders is ambiguous — never pick.
      parkReason = `conflicting client refs ${[...distinct]
        .map((ref) => boundedParkedString(ref, PARKED_REF_MAX_CHARS))
        .join(", ")} in one callback`;
    } else {
      orderDoc = clientMatches[0].doc;
      resolvedBy = clientMatches[0].kind;
    }
  }

  if (!orderDoc && !parkReason && posOrderId) {
    orderDoc = await resolveOrderByPosOrderId(posOrderId, scopedBranchId);
    if (orderDoc) {
      resolvedBy = "pos";
    } else {
      console.warn(
        `[Petpooja Webhook] POS id ${posOrderId} did not match a tracked order (restID ${
          restIdRaw || "absent"
        }, ${scopedBranchId ? `branch ${scopedBranchId}` : "UNLINKED"})`
      );
    }
  }

  if (!orderDoc) {
    const refKeyRaw = orderId || callbackOrderId || posOrderId;
    // Caller-controlled reference: bound the log, the parked fields and the
    // deterministic doc id so an oversized id cannot fail or abuse the write.
    const refKey = boundedParkedString(refKeyRaw, PARKED_REF_MAX_CHARS) || "unknown";
    console.warn(
      `[Petpooja Webhook] Order ${refKey} not resolved${
        parkReason ? ` (${parkReason})` : ""
      }.`
    );
    try {
      await db
        .collection("unmatched_petpooja_orders")
        .doc(parkedDocId("upo_", refKeyRaw))
        .set(
          {
            orderId: boundedParkedString(orderId ?? null, PARKED_REF_MAX_CHARS),
            // Never label a client ref as a POS id in the review queue.
            posOrderId: boundedParkedString(
              (resolvedBy === "pos" ? posOrderId : explicitPosOrderId) || null,
              PARKED_REF_MAX_CHARS
            ),
            callbackOrderId: boundedParkedString(
              callbackOrderId || null,
              PARKED_REF_MAX_CHARS
            ),
            rawStatus: boundedParkedString(
              payload.status || payload.order_status || null,
              PARKED_STATUS_MAX_CHARS
            ),
            restId: boundedParkedString(restIdRaw || null, PARKED_REF_MAX_CHARS),
            status: "needs_review",
            trusted,
            reason: parkReason,
            receivedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      await captureErrorSnapshot({
        source: "petpooja",
        severity: "medium",
        message: `Petpooja webhook for ${
          parkReason ? "conflicting/unknown" : "unknown"
        } order ${refKey} parked for review${parkReason ? `: ${parkReason}` : ""}`,
        orderId: refKey,
      });
    } catch (err) {
      console.warn(`[Petpooja Webhook] Failed to park unknown order ${refKey}:`, (err as any)?.message || err);
    }
    return;
  }

  // Everything downstream keys on OUR order id (refund lookups, doc writes), so
  // normalise to the resolved document's id now that the order is known. `ref.id`
  // is the fallback for a snapshot whose `id` is absent.
  const resolvedOrderId: string =
    orderDoc.id || orderDoc.ref?.id || String(orderId ?? posOrderId);
  orderId = resolvedOrderId;

  const claimedBranch = scopedBranchId;

  // ---- Default-deny gate ----
  // Only a VERIFIED auth context may reach canonical writes. Everything else
  // (omitted auth, `{}`, a malformed value, or an explicit false from the
  // middleware's credential-less SHAPE admission) is a HINT: the event is
  // parked for human review and returns here — before status, POS acceptance,
  // refunds, payment facts or any other canonical field can be touched. The
  // store-status recording above is unchanged because it changes no canonical
  // state.
  if (!trusted) {
    const terminalIntent =
      normalizePetpoojaStatus(payload.status || payload.order_status) === "cancelled" ||
      normalizePetpoojaStatus(payload.status || payload.order_status) === "delivered";
    console.warn(
      `[Petpooja Webhook] UNTRUSTED callback for order ${boundedParkedString(
        resolvedOrderId,
        PARKED_REF_MAX_CHARS
      )} — hint recorded, canonical state unchanged`
    );
    try {
      await db
        .collection("unmatched_petpooja_orders")
        .doc(`upo_${resolvedOrderId}`)
        .set(
          {
            orderId: boundedParkedString(resolvedOrderId, PARKED_REF_MAX_CHARS),
            // Same rule as the primary park: a client ref is never labelled a
            // POS id in the review queue.
            posOrderId: boundedParkedString(
              (resolvedBy === "pos" ? posOrderId : explicitPosOrderId) || null,
              PARKED_REF_MAX_CHARS
            ),
            callbackOrderId: boundedParkedString(callbackOrderId || null, PARKED_REF_MAX_CHARS),
            rawStatus: boundedParkedString(
              payload.status || payload.order_status || null,
              PARKED_STATUS_MAX_CHARS
            ),
            restId: boundedParkedString(restIdRaw || null, PARKED_REF_MAX_CHARS),
            status: "needs_review",
            trusted: false,
            // POS-03's machine-readable label is kept for terminal intents
            // (operators/tests key on it); every other unverified event gets
            // the neutral label. Either way NOTHING canonical is written.
            reason: terminalIntent
              ? "untrusted_terminal_status"
              : "unauthenticated_callback",
            detail: terminalIntent
              ? `unauthenticated terminal status "${String(
                  boundedParkedString(payload.status || payload.order_status, PARKED_STATUS_MAX_CHARS)
                )}" refused — a credential is required to complete or cancel an order`
              : "unauthenticated Petpooja callback — canonical state not applied",
            receivedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
    } catch (err) {
      console.warn(
        `[Petpooja Webhook] Failed to park untrusted order ${resolvedOrderId}:`,
        (err as any)?.message || err
      );
    }
    return;
  }

  // First PRESENT status wins. `||` dropped a real `0` (a vendor code, not
  // absence) and let an empty string shadow a populated `order_status`;
  // `??` alone would let `""` shadow it instead. Absence - both keys
  // missing, null, or empty - is `null`, never `undefined`, because an
  // explicitly-undefined value fails the whole Firestore write below.
  const pickStatus = (value: any): any =>
    value !== undefined && value !== null && value !== "" ? value : null;
  const rawStatus = pickStatus(payload.status) ?? pickStatus(payload.order_status);
  const canonicalStatus = normalizePetpoojaStatus(rawStatus);
  const docTarget = db.collection("orders").doc(resolvedOrderId);
  const orderRef =
    orderDoc.ref && typeof orderDoc.ref.get === "function"
      ? orderDoc.ref
      : docTarget;

  // SECURITY (POS-03): a shape-admitted (untrusted) callback must not apply a
  // TERMINAL status. CANCELLED would cancel a real order and park a refund;
  // DELIVERED would close it. Park the event for review exactly like the
  // refused-callback path above and leave the order untouched. Bounded
  // non-terminal status changes still apply below.
  if (untrusted && (canonicalStatus === "cancelled" || canonicalStatus === "delivered")) {
    console.warn(
      `[Petpooja Webhook] untrusted callback for order ${boundedParkedString(
        resolvedOrderId,
        PARKED_REF_MAX_CHARS
      )} carried terminal status "${String(
        boundedParkedString(rawStatus, PARKED_STATUS_MAX_CHARS)
      )}" (${canonicalStatus}) — parked, order untouched`
    );
    try {
      await db
        .collection("unmatched_petpooja_orders")
        .doc(`upo_${resolvedOrderId}`)
        .set(
          {
            orderId: boundedParkedString(resolvedOrderId, PARKED_REF_MAX_CHARS),
            posOrderId: boundedParkedString(
              (resolvedBy === "pos" ? posOrderId : explicitPosOrderId) || null,
              PARKED_REF_MAX_CHARS
            ),
            callbackOrderId: boundedParkedString(callbackOrderId || null, PARKED_REF_MAX_CHARS),
            rawStatus: boundedParkedString(rawStatus ?? null, PARKED_STATUS_MAX_CHARS),
            restId: boundedParkedString(restIdRaw || null, PARKED_REF_MAX_CHARS),
            status: "needs_review",
            reason: "untrusted_terminal_status",
            detail: `unauthenticated terminal status "${String(
              boundedParkedString(rawStatus, PARKED_STATUS_MAX_CHARS)
            )}" refused — a credential is required to complete or cancel an order`,
            receivedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
    } catch (err) {
      console.warn(
        `[Petpooja Webhook] Failed to park untrusted terminal event for order ${boundedParkedString(
          resolvedOrderId,
          PARKED_REF_MAX_CHARS
        )}:`,
        (err as any)?.message || err
      );
    }
    return;
  }

  // ---- Replay defense (finding: duplicate POS redeliveries) ----
  // When the POS supplies an event id, an id already processed on this order
  // within the freshness window is a REDelivery — applying it again re-runs
  // side effects (refund-request parking) and rewrites status. The window
  // bounds how long the marker is authoritative (same convention as the
  // dispatch webhook freshness guard).
  const eventId =
    payload.id != null && payload.id !== ""
      ? String(payload.id)
      : typeof payload.event_id === "string" && payload.event_id
        ? payload.event_id
        : null;
  const EVENT_FRESHNESS_MS = 15 * 60 * 1000;

  // Canonical object form (both apps + triggers accept it; bare strings with
  // lowercase codes break Delivery tracking).
  const statusMeta: Record<string, { code: string; label: string; kind: string; terminal: boolean }> = {
    accepted: { code: "CONFIRMED", label: "Order confirmed", kind: "upcoming", terminal: false },
    ready: { code: "READY_FOR_PICKUP", label: "Ready for pickup", kind: "in_progress", terminal: false },
    out_for_delivery: { code: "OUT_FOR_DELIVERY", label: "Out for delivery", kind: "in_progress", terminal: false },
    delivered: { code: "DELIVERED", label: "Delivered", kind: "completed", terminal: true },
    cancelled: { code: "CANCELLED", label: "Cancelled", kind: "cancelled", terminal: true },
  };

  interface PlanStatusUpdateParams {
    freshOrderData: Record<string, any>;
    payload: any;
    canonicalStatus: string;
    rawStatus: any;
    eventId: string | null;
    eventFreshnessMs: number;
    resolvedOrderId: string;
    resolvedBy: "client-callback" | "client-legacy" | "pos" | null;
    posOrderId: string;
    explicitPosOrderId: string;
    callbackOrderId: string;
    claimedBranch: string | null;
    untrusted: boolean;
    hasExistingPendingRefund: boolean;
    statusMeta: Record<string, { code: string; label: string; kind: string; terminal: boolean }>;
  }

  type StatusPlanResult =
    | { action: "untrusted_branch_mismatch"; claimedBranch: string | null; orderBranch: string }
    | {
        action: "untrusted_terminal_refused";
        canonicalStatus: string;
        claimedBranch: string | null;
      }
    | { action: "pos_binding_mismatch"; posOrderId: string; currentPosOrderId: string }
    | { action: "replay_ignored"; eventId: string }
    | { action: "terminal_ignored"; currentCode?: string; currentKind?: string }
    | {
        action: "apply";
        updateData: Record<string, any>;
        refundData: Record<string, any> | null;
        untrustedCancellation: boolean;
      };

  const planStatusUpdate = (params: PlanStatusUpdateParams): StatusPlanResult => {
    const {
      freshOrderData,
      payload,
      canonicalStatus,
      rawStatus,
      eventId,
      eventFreshnessMs,
      resolvedOrderId,
      resolvedBy,
      posOrderId,
      explicitPosOrderId,
      callbackOrderId,
      claimedBranch,
      untrusted,
      hasExistingPendingRefund,
      statusMeta,
    } = params;

    // 1. Untrusted branch re-check on fresh snapshot:
    // An unauthenticated callback must not steer an order re-linked concurrently to another branch
    if (untrusted) {
      const freshOrderBranch = String(freshOrderData.branchId ?? "");
      if (!claimedBranch || !freshOrderBranch || freshOrderBranch !== claimedBranch) {
        return {
          action: "untrusted_branch_mismatch",
          claimedBranch,
          orderBranch: freshOrderBranch,
        };
      }
    }

    // 2. F8 (terminal-flip integrity): an unauthenticated caller — admitted only
    // by callback SHAPE (the vendor's documented callbacks carry no credential
    // header) — could still mark an order DELIVERED or CANCELLED. A terminal flip
    // is irreversible here (the terminal guard refuses every later callback, and
    // a cancel additionally parks a refund), so a shape-only caller must not be
    // able to end a live order. Non-terminal kitchen claims (accepted / ready /
    // out_for_delivery) stay allowed: they are bounded, non-destructive, and
    // carry no money movement. Wire the credential header to apply a terminal
    // status.
    if (untrusted && statusMeta[canonicalStatus]?.terminal === true) {
      return { action: "untrusted_terminal_refused", canonicalStatus, claimedBranch };
    }

    // 3. POS binding re-check on fresh snapshot:
    // An order resolved purely by POS id must still be bound to that exact POS id
    if (resolvedBy === "pos") {
      const freshPosId = String(freshOrderData.petpoojaOrderId ?? "");
      if (freshPosId !== posOrderId) {
        return {
          action: "pos_binding_mismatch",
          posOrderId,
          currentPosOrderId: freshPosId,
        };
      }
    }

    // 3. Replay defense on fresh snapshot
    if (eventId) {
      const lastId = freshOrderData.petpoojaWebhookEventId;
      const lastRaw = freshOrderData.petpoojaWebhookReceivedAtMs;
      const lastMs =
        typeof lastRaw === "number" && Number.isFinite(lastRaw)
          ? lastRaw
          : lastRaw && typeof lastRaw.toMillis === "function"
            ? lastRaw.toMillis()
            : 0;
      if (lastId === eventId && lastMs > 0 && Date.now() - lastMs < eventFreshnessMs) {
        return { action: "replay_ignored", eventId };
      }
    }

    // 4. Terminal-state guard on fresh snapshot
    const currentStatus = freshOrderData.status;
    const currentCode =
      typeof currentStatus === "string" ? currentStatus : (currentStatus?.code as string | undefined);
    const currentKind =
      typeof currentStatus === "object" && currentStatus ? (currentStatus.kind as string | undefined) : undefined;
    const terminalNow =
      (typeof currentStatus === "object" && currentStatus?.terminal === true) ||
      currentKind === "completed" ||
      currentKind === "cancelled" ||
      // COMPLETED (dine-in delivered, orderStatus.ts:201) and PICKED_UP
      // (takeaway delivered, orderStatus.ts:205) are the other two terminal
      // codes in this repository; keep this list in step with
      // `isCancelledOrTerminal` (orderPush.ts) so a row carrying only the code —
      // no `kind`, no `terminal` flag — still cannot be rewound by a late
      // vendor callback. Known writers do set `kind:"completed"`, so this
      // closes a vocabulary gap rather than a reachable live path.
      (typeof currentCode === "string" &&
        ["DELIVERED", "CANCELLED", "COMPLETED", "PICKED_UP"].includes(
          currentCode.toUpperCase()
        )) ||
      freshOrderData.deliveryStatus === "delivered";

    if (terminalNow) {
      return { action: "terminal_ignored", currentCode, currentKind };
    }

    // 5. Mutation & refund planning on fresh snapshot
    // A callback that resolved to a real order but carried NO status field (or
    // only empty-string status keys) must not plant `undefined` here: the Admin
    // SDK rejects an explicitly-undefined value anywhere in the merged payload,
    // so the WHOLE write throws, the webhook answers 500, and every vendor
    // redelivery fails identically - the order never even records
    // `petpoojaWebhookEventId`. Absence is recorded as `null` (a value that
    // says "the POS sent no status"), and a falsy-but-real `0` is preserved.
    const updateData: Record<string, any> = {
      petpoojaKitchenStatus: rawStatus ?? null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const accepting = canonicalStatus !== "cancelled" && canonicalStatus !== "unknown";
    // An accepted-but-id-less order (POS-01) holds no POS id yet. It is already
    // at the POS, so a later CREDENTIALED callback that supplies the POS id can
    // only add traceability — it can never drop a genuinely un-pushed order from
    // the retry queue, because no retry exists for this state.
    const acceptedUnconfirmed = freshOrderData.petpoojaStatus === "accepted_unconfirmed";
    // Only an id the lookup PROVED may be stamped. An explicit field is a claim:
    // it is accepted only when it already equals this order's stored POS id, or
    // when the order is accepted_unconfirmed and the id arrives on an
    // authenticated callback (explicit POS-id field, never the client-ref field).
    const posDerivedId =
      resolvedBy === "pos"
        ? (freshOrderData.petpoojaOrderId === posOrderId ? posOrderId : "")
        : explicitPosOrderId &&
            (freshOrderData.petpoojaOrderId === explicitPosOrderId || acceptedUnconfirmed)
          ? explicitPosOrderId
          : "";

    if (
      !untrusted &&
      posDerivedId &&
      (freshOrderData.petpoojaOrderId !== posDerivedId || acceptedUnconfirmed) &&
      accepting
    ) {
      updateData.petpoojaOrderId = posDerivedId;
      updateData.petpoojaStatus = "synced";
      updateData.petpoojaSyncStatus = "synced";
    } else if (
      !untrusted &&
      accepting &&
      !freshOrderData.petpoojaOrderId &&
      (resolvedBy === "client-callback" ||
        (resolvedBy === "client-legacy" && callbackOrderId))
    ) {
      updateData.petpoojaAcceptedNoId = true;
      updateData.petpoojaAcceptedNoIdAt = admin.firestore.FieldValue.serverTimestamp();
      updateData.petpoojaCallbackAck = JSON.stringify(payload).slice(0, 500);
      updateData.petpoojaAcceptedNoIdSource =
        resolvedBy === "client-callback" ? "callback_client_ref" : "callback_unproven_id";
      updateData.petpoojaStatus = "synced";
      updateData.petpoojaSyncStatus = "synced";
      if (resolvedBy === "client-callback") {
        updateData.petpoojaCallbackClientRef = callbackOrderId;
        if (explicitPosOrderId) {
          updateData.petpoojaCallbackOrderId = explicitPosOrderId;
        }
      } else if (callbackOrderId) {
        updateData.petpoojaCallbackOrderId = callbackOrderId;
      }
    } else if (untrusted) {
      const claimedId =
        posDerivedId ||
        (callbackOrderId && resolvedBy !== "client-callback" ? callbackOrderId : "");
      if (claimedId && freshOrderData.petpoojaOrderId !== claimedId) {
        updateData.petpoojaCallbackOrderId = claimedId;
      } else if (resolvedBy === "client-callback" && callbackOrderId) {
        updateData.petpoojaCallbackClientRef = callbackOrderId;
      }
    }

    if (eventId) {
      updateData.petpoojaWebhookEventId = eventId;
      updateData.petpoojaWebhookReceivedAtMs = Date.now();
    }

    // Stale vendor status is not applied (F4): an authenticated but delayed
    // callback must not rewind the kitchen lifecycle. `currentCode` is read from
    // the FRESH transactional snapshot above; when both codes are ranked, a
    // same-or-lower incoming rank leaves `status` untouched (the raw kitchen
    // status, event marker and POS binding above are still recorded). A code the
    // vocabulary does not rank — legacy/unknown current, or an unranked vendor
    // status — keeps the existing apply behaviour.
    if (canonicalStatus !== "unknown" && statusMeta[canonicalStatus]) {
      const incomingRank = canonicalStatusRank(statusMeta[canonicalStatus].code);
      const currentRank = canonicalStatusRank(currentCode);
      if (incomingRank === null || currentRank === null || incomingRank > currentRank) {
        updateData.status = statusMeta[canonicalStatus];
      }
    }

    let refundData: Record<string, any> | null = null;
    if (canonicalStatus === "cancelled") {
      updateData.cancelledAt = admin.firestore.FieldValue.serverTimestamp();
      updateData.cancellationReason =
        payload.cancel_reason || payload.reason || "Cancelled by kitchen operator in Petpooja POS";

      if (!untrusted) {
        const payment = freshOrderData.payment;
        const alreadyRefunded = freshOrderData.refundStatus === "refunded" || payment?.refunded === true;
        if (payment?.razorpayPaymentId && !alreadyRefunded && !hasExistingPendingRefund) {
          refundData = {
            orderId: resolvedOrderId,
            branchId: freshOrderData.branchId ?? null,
            razorpayPaymentId: payment.razorpayPaymentId,
            amountPaise:
              typeof payment?.amount === "number"
                ? payment.amount
                : typeof freshOrderData.pricing?.grandTotal === "number"
                  ? Math.round(freshOrderData.pricing.grandTotal * 100)
                  : null,
            reason: "POS_CANCELLED",
            detail:
              payload.cancel_reason || payload.reason || "Cancelled by kitchen operator in Petpooja POS",
            status: "PENDING",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          };
          updateData["payment.refundStatus"] = "PENDING_APPROVAL";
        }
      }
    }

    return {
      action: "apply",
      updateData,
      refundData,
      untrustedCancellation: untrusted && canonicalStatus === "cancelled",
    };
  };

  /**
   * F8: park + alert a terminal status we refused because the caller presented
   * no credential. Kept out of the transaction (a refusal must never write to
   * the order) and best-effort so a park failure cannot turn a refusal into a 5xx.
   */
  const parkUntrustedTerminal = async (refusedStatus: string): Promise<void> => {
    console.warn(
      `[Petpooja Webhook] untrusted callback for order ${boundedParkedString(
        resolvedOrderId,
        PARKED_REF_MAX_CHARS
      )} refused: terminal status "${String(
        boundedParkedString(refusedStatus, PARKED_STATUS_MAX_CHARS)
      )}" requires an authenticated caller — no status change applied`
    );
    try {
      await db
        .collection("unmatched_petpooja_orders")
        .doc(`upo_${resolvedOrderId}`)
        .set(
          {
            orderId: boundedParkedString(resolvedOrderId, PARKED_REF_MAX_CHARS),
            posOrderId: boundedParkedString(
              (resolvedBy === "pos" ? posOrderId : explicitPosOrderId) || null,
              PARKED_REF_MAX_CHARS
            ),
            callbackOrderId: boundedParkedString(callbackOrderId || null, PARKED_REF_MAX_CHARS),
            rawStatus: boundedParkedString(
              payload.status || payload.order_status || null,
              PARKED_STATUS_MAX_CHARS
            ),
            restId: boundedParkedString(restIdRaw || null, PARKED_REF_MAX_CHARS),
            status: "needs_review",
            // POS-03: the review queue's terminal-refusal label (unchanged for
            // operators/tests); the human detail rides alongside it.
            reason: "untrusted_terminal_status",
            detail: `unauthenticated terminal status "${String(
              boundedParkedString(refusedStatus, PARKED_STATUS_MAX_CHARS)
            )}" refused — a credential is required to complete or cancel an order`,
            receivedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
    } catch (err) {
      console.warn(
        `[Petpooja Webhook] Failed to park refused unauthenticated terminal status for ${boundedParkedString(
          resolvedOrderId,
          PARKED_REF_MAX_CHARS
        )}:`,
        (err as any)?.message || err
      );
    }
    await captureErrorSnapshot({
      source: "petpooja",
      severity: "high",
      message: `Unauthenticated Petpooja callback attempted a terminal status "${refusedStatus}" for order ${resolvedOrderId} — refused and parked for review`,
      orderId: resolvedOrderId,
    });
  };

  if (db && typeof (db as any).runTransaction === "function") {
    const txOutcome = await (db as any).runTransaction(async (tx: any) => {
      // 1. ALL READS FIRST: Fresh snapshot of the order document
      const freshSnap = await tx.get(orderRef);
      if (!freshSnap.exists) {
        return { action: "not_found" as const };
      }
      const freshOrderData = (freshSnap.data() || {}) as Record<string, any>;

      // Read existing pending refunds if cancellation (all reads before writes)
      let hasExistingPendingRefund = false;
      const refundDocRef = db.collection("refunds").doc(`refund_pos_cancel_${resolvedOrderId}`);

      if (canonicalStatus === "cancelled" && !untrusted) {
        const payment = freshOrderData.payment;
        const alreadyRefunded = freshOrderData.refundStatus === "refunded" || payment?.refunded === true;
        if (payment?.razorpayPaymentId && !alreadyRefunded) {
          const existingRefundSnap = await tx.get(refundDocRef);
          hasExistingPendingRefund = existingRefundSnap.exists;
          if (!hasExistingPendingRefund) {
            // NO try-catch: if index missing or datastore down, error propagates to abort tx (fail closed)
            const pendingQuery = db
              .collection("refunds")
              .where("orderId", "==", resolvedOrderId)
              .where("status", "==", "PENDING")
              .limit(1);
            const querySnap = await tx.get(pendingQuery);
            if (querySnap && !querySnap.empty) {
              hasExistingPendingRefund = true;
            }
          }
        }
      }

      // 2. Evaluate plan on fresh snapshot
      const plan = planStatusUpdate({
        freshOrderData,
        payload,
        canonicalStatus,
        rawStatus,
        eventId,
        eventFreshnessMs: EVENT_FRESHNESS_MS,
        resolvedOrderId,
        resolvedBy,
        posOrderId,
        explicitPosOrderId,
        callbackOrderId,
        claimedBranch,
        untrusted,
        hasExistingPendingRefund,
        statusMeta,
      });

      if (plan.action !== "apply") {
        return plan;
      }

      // 3. ALL WRITES AFTER ALL READS
      if (plan.refundData) {
        tx.set(refundDocRef, plan.refundData);
      }
      tx.set(orderRef, plan.updateData, { merge: true });

      return plan;
    });

    // Logging & side-effects outside retryable transaction
    if (txOutcome.action === "not_found") {
      return;
    }
    if (txOutcome.action === "untrusted_terminal_refused") {
      await parkUntrustedTerminal(txOutcome.canonicalStatus);
      return;
    }
    if (txOutcome.action === "untrusted_branch_mismatch") {
      console.warn(
        `[Petpooja Webhook] untrusted callback for order ${resolvedOrderId} refused: restID ${restIdRaw || "absent"} resolves to ${
          txOutcome.claimedBranch || "UNLINKED"
        }, order belongs to ${txOutcome.orderBranch || "none"}`
      );
      try {
        await db
          .collection("unmatched_petpooja_orders")
          .doc(`upo_${resolvedOrderId}`)
          .set(
            {
              orderId: resolvedOrderId,
              posOrderId: (resolvedBy === "pos" ? posOrderId : explicitPosOrderId) || null,
              callbackOrderId: callbackOrderId || null,
              rawStatus: payload.status || payload.order_status || null,
              restId: restIdRaw || null,
              status: "needs_review",
              reason: `order belongs to branch ${txOutcome.orderBranch || "none"}, outside callback outlet ${txOutcome.claimedBranch || "UNLINKED"}`,
              receivedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
      } catch (err) {
        console.warn(
          `[Petpooja Webhook] Failed to park refused untrusted order ${resolvedOrderId}:`,
          (err as any)?.message || err
        );
      }
      return;
    }
    if (txOutcome.action === "pos_binding_mismatch") {
      console.warn(
        `[Petpooja Webhook] POS id ${txOutcome.posOrderId} no longer bound to order ${resolvedOrderId} (current: ${
          txOutcome.currentPosOrderId || "none"
        }) — ignored`
      );
      try {
        await db
          .collection("unmatched_petpooja_orders")
          .doc(`upo_${txOutcome.posOrderId || resolvedOrderId}`)
          .set(
            {
              orderId: resolvedOrderId,
              posOrderId: txOutcome.posOrderId || null,
              callbackOrderId: callbackOrderId || null,
              rawStatus: payload.status || payload.order_status || null,
              restId: restIdRaw || null,
              status: "needs_review",
              reason: `POS id ${txOutcome.posOrderId} binding mismatch in transaction (current: ${txOutcome.currentPosOrderId || "none"})`,
              receivedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
      } catch (err) {
        console.warn(
          `[Petpooja Webhook] Failed to park POS binding mismatch order ${resolvedOrderId}:`,
          (err as any)?.message || err
        );
      }
      return;
    }
    if (txOutcome.action === "replay_ignored") {
      console.warn(
        `[Petpooja Webhook] Replay of event ${txOutcome.eventId} for order ${resolvedOrderId} inside freshness window — ignored`
      );
      return;
    }
    if (txOutcome.action === "terminal_ignored") {
      console.warn(
        `[Petpooja Webhook] Ignoring kitchen status "${String(rawStatus)}" for TERMINAL order ${resolvedOrderId} ` +
          `(current: ${txOutcome.currentCode || txOutcome.currentKind || "unknown"}) — no rewind, no refund side effects`
      );
      return;
    }
    if (txOutcome.action === "apply") {
      if (txOutcome.untrustedCancellation) {
        console.warn(
          `[Petpooja Webhook] Unauthenticated cancellation for order ${resolvedOrderId} — refund injection refused`
        );
      }
      return;
    }

    // CRITICAL: UNCONDITIONAL RETURN — NEVER FALL THROUGH TO PLAIN WRITE
    return;
  } else {
    // Shim/no-tx fallback ONLY for datastores without runTransaction
    const freshSnap =
      orderRef && typeof orderRef.get === "function"
        ? await orderRef.get()
        : typeof docTarget.get === "function"
          ? await docTarget.get()
          : orderDoc;

    if (!freshSnap?.exists) {
      return;
    }
    const freshOrderData = (freshSnap.data() || {}) as Record<string, any>;

    let hasExistingPendingRefund = false;
    const refundDocRef = db.collection("refunds").doc(`refund_pos_cancel_${resolvedOrderId}`);

    if (canonicalStatus === "cancelled" && !untrusted) {
      const payment = freshOrderData.payment;
      const alreadyRefunded = freshOrderData.refundStatus === "refunded" || payment?.refunded === true;
      if (payment?.razorpayPaymentId && !alreadyRefunded) {
        try {
          const existingRefundSnap = await refundDocRef.get();
          hasExistingPendingRefund = existingRefundSnap.exists;
          if (!hasExistingPendingRefund) {
            const pendingQuery = db
              .collection("refunds")
              .where("orderId", "==", resolvedOrderId)
              .where("status", "==", "PENDING")
              .limit(1);
            const querySnap = await pendingQuery.get();
            if (querySnap && !querySnap.empty) {
              hasExistingPendingRefund = true;
            }
          }
        } catch (err) {
          console.error(
            `Refund-request lookup failed on Petpooja cancel for ${resolvedOrderId}:`,
            (err as any)?.message || err
          );
        }
      }
    } else {
      console.warn(
        `[Petpooja Webhook] Unauthenticated cancellation for order ${orderId} — refund injection refused`
      );
    }

    const plan = planStatusUpdate({
      freshOrderData,
      payload,
      canonicalStatus,
      rawStatus,
      eventId,
      eventFreshnessMs: EVENT_FRESHNESS_MS,
      resolvedOrderId,
      resolvedBy,
      posOrderId,
      explicitPosOrderId,
      callbackOrderId,
      claimedBranch,
      untrusted,
      hasExistingPendingRefund,
      statusMeta,
    });

    if (plan.action === "apply") {
      if (plan.refundData) {
        await refundDocRef.set(plan.refundData);
      }
      if (orderDoc.ref && typeof orderDoc.ref.set === "function") {
        await orderDoc.ref.set(plan.updateData, { merge: true });
      } else {
        await docTarget.set(plan.updateData, { merge: true });
      }
      if (plan.untrustedCancellation) {
        console.warn(
          `[Petpooja Webhook] Unauthenticated cancellation for order ${resolvedOrderId} — refund injection refused`
        );
      }
      return;
    } else if (plan.action === "untrusted_terminal_refused") {
      await parkUntrustedTerminal(plan.canonicalStatus);
      return;
    } else if (plan.action === "untrusted_branch_mismatch") {
      console.warn(
        `[Petpooja Webhook] untrusted callback for order ${resolvedOrderId} refused: restID ${restIdRaw || "absent"} resolves to ${
          plan.claimedBranch || "UNLINKED"
        }, order belongs to ${plan.orderBranch || "none"}`
      );
      try {
        await db
          .collection("unmatched_petpooja_orders")
          .doc(`upo_${resolvedOrderId}`)
          .set(
            {
              orderId: resolvedOrderId,
              posOrderId: (resolvedBy === "pos" ? posOrderId : explicitPosOrderId) || null,
              callbackOrderId: callbackOrderId || null,
              rawStatus: payload.status || payload.order_status || null,
              restId: restIdRaw || null,
              status: "needs_review",
              reason: `order belongs to branch ${plan.orderBranch || "none"}, outside callback outlet ${plan.claimedBranch || "UNLINKED"}`,
              receivedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
      } catch (err) {
        console.warn(
          `[Petpooja Webhook] Failed to park refused untrusted order ${resolvedOrderId}:`,
          (err as any)?.message || err
        );
      }
      return;
    } else if (plan.action === "pos_binding_mismatch") {
      console.warn(
        `[Petpooja Webhook] POS id ${plan.posOrderId} no longer bound to order ${resolvedOrderId} (current: ${
          plan.currentPosOrderId || "none"
        }) — ignored`
      );
      try {
        await db
          .collection("unmatched_petpooja_orders")
          .doc(`upo_${plan.posOrderId || resolvedOrderId}`)
          .set(
            {
              orderId: resolvedOrderId,
              posOrderId: plan.posOrderId || null,
              callbackOrderId: callbackOrderId || null,
              rawStatus: payload.status || payload.order_status || null,
              restId: restIdRaw || null,
              status: "needs_review",
              reason: `POS id ${plan.posOrderId} binding mismatch in fallback (current: ${plan.currentPosOrderId || "none"})`,
              receivedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
      } catch (err) {
        console.warn(
          `[Petpooja Webhook] Failed to park POS binding mismatch order ${resolvedOrderId}:`,
          (err as any)?.message || err
        );
      }
      return;
    } else if (plan.action === "replay_ignored") {
      console.warn(
        `[Petpooja Webhook] Replay of event ${plan.eventId} for order ${resolvedOrderId} inside freshness window — ignored`
      );
      return;
    } else if (plan.action === "terminal_ignored") {
      console.warn(
        `[Petpooja Webhook] Ignoring kitchen status "${String(rawStatus)}" for TERMINAL order ${resolvedOrderId} ` +
          `(current: ${plan.currentCode || plan.currentKind || "unknown"}) — no rewind, no refund side effects`
      );
      return;
    }

    return;
  }
}
