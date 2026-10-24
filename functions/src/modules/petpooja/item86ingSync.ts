import { db } from "../../core/firebase";
import { captureErrorSnapshot } from "../../core/errors";
import { config, assertLivePetpoojaContext } from "../../config/env";
import { getPetpoojaConfig } from "./client";
import * as admin from "firebase-admin";
import { assertBranchAccess, type StaffCaller } from "../../core/middleware";
import { isSafeDocId } from "../../core/security";
import { createHash } from "crypto";

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
 * Instant stock-out (86ing) webhook handler from Petpooja physical POS.
 */
export async function handlePetpoojaStockWebhook(payload: any): Promise<void> {
  // Field-name tolerance: the published callback samples and our own route
  // contract disagree on `rest_id`/`restID` and `in_stock`/`inStock`. Read
  // both so a rename on Petpooja's side can never silently drop an 86ing
  // toggle (the payload still has to authenticate through verifyPetpoojaAuth).
  const p = payload || {};
  const rest_id = p.rest_id ?? p.restID ?? p.restId;
  const item_id = p.item_id ?? p.itemID ?? p.itemId;
  const in_stock = p.in_stock ?? p.inStock;
  if (!item_id) {
    // Loop 6: a malformed 86ing payload (no item_id) used to log-and-drop —
    // silent stock-toggle loss. Snapshot loud so ops sees it; return (no
    // throw — the payload will never become valid on retry).
    await captureErrorSnapshot({
      source: "petpooja",
      severity: "medium",
      message: "Petpooja 86ing webhook arrived without item_id — stock toggle dropped, manual review required",
    });
    return;
  }
  const inStockBool = in_stock === 1 || in_stock === "1" || in_stock === true;

  // Fail-closed id shape: item_id comes from the POS vendor — slashes or
  // empties would throw/path-escape the doc write below and 500-retry.
  if (!isSafeDocId(String(item_id))) {
    await captureErrorSnapshot({
      source: "petpooja",
      severity: "medium",
      message: "Petpooja 86ing webhook arrived with an unsafe item_id — stock toggle dropped, manual review required",
    });
    return;
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
    return;
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
    return;
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
    return;
  }

  const initialUpdateTime = prodSnap.updateTime;
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
    return;
  }

  if (
    conflictReason === "stale_conflict" ||
    (conflictReason && conflictReason.includes("PRECONDITION")) ||
    (conflictReason && conflictReason.includes("conflict"))
  ) {
    console.warn(
      `[Petpooja 86ing] Concurrent stock update detected for ${productId} — parking webhook for review to preserve newer local toggle`
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
      severity: "medium",
      message: `Petpooja 86ing webhook for product ${productId} conflicted with concurrent stock update — quarantined, newer state preserved`,
      branchId,
    });
    return;
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
    return;
  }
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

export interface PetpoojaWebhookAuth {
  /**
   * False when `verifyPetpoojaAuth` admitted the call by callback SHAPE rather
   * than by credential. An untrusted call may still apply a bounded status
   * change, but must not write sync state (the POS id / "synced") that the retry
   * worker and the outbound dedupe key off — a forged one would silently drop a
   * genuinely un-pushed order from the retry queue.
   */
  authenticated?: boolean;
}

export async function handlePetpoojaWebhook(
  payload: any,
  auth: PetpoojaWebhookAuth = {}
): Promise<void> {
  const untrusted = auth.authenticated === false;
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
    const restId = String(
      payload.rest_id ?? payload.restId ?? payload.restID ?? payload.restaurantid
    );
    const rawStatus = payload.status ?? payload.store_status ?? payload.storeStatus;
    const branchId = await resolveBranchIdForRestId(restId);
    console.log(
      `[Petpooja Webhook] Store-status ping restID=${restId} status=${JSON.stringify(
        rawStatus
      )} ${branchId ? `branch=${branchId}` : "branch=UNLINKED"}`
    );
    // Recorded, not applied. Petpooja's status encoding for this webhook is
    // unverified, and closing a live outlet on a guessed value is worse than
    // not acting; the recording gives the real encoding to confirm against.
    try {
      await db
        .collection("petpooja_store_status_events")
        .doc(`ss_${restId}`)
        .set(
          {
            restId,
            branchId: branchId ?? null,
            rawStatus: rawStatus ?? null,
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
    parkReason = `restID ${restIdRaw} did not resolve to a linked branch`;
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
      parkReason = `client ref ${candidate.ref} belongs to branch ${
        docBranch || "none"
      }, outside callback outlet ${scopedBranchId}`;
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
      parkReason = `conflicting client refs ${[...distinct].join(", ")} in one callback`;
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
    const refKey = orderId || callbackOrderId || posOrderId;
    console.warn(
      `[Petpooja Webhook] Order ${refKey} not resolved${
        parkReason ? ` (${parkReason})` : ""
      }.`
    );
    try {
      await db
        .collection("unmatched_petpooja_orders")
        .doc(`upo_${refKey}`)
        .set(
          {
            orderId: orderId ?? null,
            // Never label a client ref as a POS id in the review queue.
            posOrderId: (resolvedBy === "pos" ? posOrderId : explicitPosOrderId) || null,
            callbackOrderId: callbackOrderId || null,
            rawStatus: payload.status || payload.order_status || null,
            restId: restIdRaw || null,
            status: "needs_review",
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

  // An unauthenticated caller (a callback admitted by SHAPE) must not steer
  // another outlet's order. The POS-id path already scopes by branch; this
  // covers the doc-id path, where the caller supplied our internal order id
  // directly: require a restID that resolves to a linked branch AND an order
  // that belongs to it.
  if (untrusted) {
    const orderBranch = String(((orderDoc.data() || {}) as Record<string, any>).branchId ?? "");
    if (!claimedBranch || !orderBranch || orderBranch !== claimedBranch) {
      console.warn(
        `[Petpooja Webhook] untrusted callback for order ${resolvedOrderId} refused: restID ${restIdRaw || "absent"} resolves to ${
          claimedBranch || "UNLINKED"
        }, order belongs to ${orderBranch || "none"}`
      );
      try {
        await db
          .collection("unmatched_petpooja_orders")
          .doc(`upo_${resolvedOrderId}`)
          .set(
            {
              orderId: resolvedOrderId,
              // Same rule as the primary park: a client ref is never labelled a
              // POS id in the review queue.
              posOrderId: (resolvedBy === "pos" ? posOrderId : explicitPosOrderId) || null,
              callbackOrderId: callbackOrderId || null,
              rawStatus: payload.status || payload.order_status || null,
              restId: restIdRaw || null,
              status: "needs_review",
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
  }

  const rawStatus = payload.status || payload.order_status;
  const canonicalStatus = normalizePetpoojaStatus(rawStatus);
  const docTarget = db.collection("orders").doc(resolvedOrderId);
  const orderRef =
    orderDoc.ref && typeof orderDoc.ref.get === "function"
      ? orderDoc.ref
      : docTarget;

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

    // 2. POS binding re-check on fresh snapshot:
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
      (typeof currentCode === "string" &&
        ["DELIVERED", "CANCELLED"].includes(currentCode.toUpperCase())) ||
      freshOrderData.deliveryStatus === "delivered";

    if (terminalNow) {
      return { action: "terminal_ignored", currentCode, currentKind };
    }

    // 5. Mutation & refund planning on fresh snapshot
    const updateData: Record<string, any> = {
      petpoojaKitchenStatus: rawStatus,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const accepting = canonicalStatus !== "cancelled" && canonicalStatus !== "unknown";
    const posDerivedId =
      resolvedBy === "pos"
        ? (freshOrderData.petpoojaOrderId === posOrderId ? posOrderId : "")
        : explicitPosOrderId && freshOrderData.petpoojaOrderId === explicitPosOrderId
          ? explicitPosOrderId
          : "";

    if (
      !untrusted &&
      posDerivedId &&
      freshOrderData.petpoojaOrderId !== posDerivedId &&
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

    if (canonicalStatus !== "unknown" && statusMeta[canonicalStatus]) {
      updateData.status = statusMeta[canonicalStatus];
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
