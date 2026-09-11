import { db } from "../../core/firebase";
import { captureErrorSnapshot } from "../../core/errors";
import { config } from "../../config/env";
import { getPetpoojaConfig } from "./client";
import { autoRefund } from "../payments/razorpay.service";
import * as admin from "firebase-admin";

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
  const { rest_id, item_id, in_stock } = payload;
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

  if (item_id) {
    // Same branch-scoped id scheme as the menu sync — and attributed with
    // branchId/restId so the doc never becomes an unscoped orphan.
    const branchId = await resolveBranchIdForRestId(rest_id);
    const productId = branchId ? `prod_${branchId}_${item_id}` : `prod_unlinked_${item_id}`;
    await db.collection("products").doc(productId).set(
      {
        petpoojaItemId: item_id,
        ...(branchId ? { branchId, restId: rest_id } : {}),
        inStock: inStockBool,
        lastPetpoojaSync: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    if (!branchId) {
      console.warn(`[Petpooja 86ing] rest_id ${rest_id} unlinked — stock staged on orphan doc ${productId}`);
    }
  }

  console.log(`[Petpooja 86ing] Item ${item_id} at branch ${rest_id} set inStock=${inStockBool}`);
}

/**
 * Outgoing stock toggle from Partner POS App to Petpooja Cloud API.
 * Resolves the branch's Petpooja restID (ops-linked) — never sends the
 * internal branchId as rest_id.
 */
export async function pushItemStockToPetpooja(
  branchId: string,
  itemId: string,
  inStock: boolean
): Promise<boolean> {
  if (config.mock.petpoojaPos) {
    console.log(`[Mock Petpooja 86ing] Pushed branch=${branchId} item=${itemId} inStock=${inStock}`);
    return true;
  }

  try {
    // Loop 6: outlet binding is strict in live mode — the old fallback sent
    // our internal branchId as rest_id, and unlike KOT pushes (rejected on
    // unknown rest), a stock toggle against a wrong-but-valid outlet
    // SUCCEEDS remotely and 86s someone else's item silently. Mock mode
    // keeps the lenient path (no outlet queried).
    let restId: string;
    if (config.mock.petpoojaPos) {
      try {
        const branchSnap = await db.collection("branches").doc(branchId).get();
        restId = (branchSnap.data() as any)?.petpoojaStoreId || branchId;
      } catch {
        restId = branchId;
      }
    } else {
      let linked: string | null = null;
      try {
        const branchSnap = await db.collection("branches").doc(branchId).get();
        linked = (branchSnap.data() as any)?.petpoojaStoreId || null;
      } catch (err: any) {
        console.warn(`[Petpooja Stock Push] Branch lookup failed for ${branchId}:`, err?.message || err);
        return false;
      }
      if (!linked) {
        console.warn(
          `[Petpooja Stock Push] Branch ${branchId} has no linked outlet — refusing wrong-outlet toggle (link per Runbook §5)`
        );
        return false;
      }
      restId = linked;
    }

    const petpoojaConfig = getPetpoojaConfig();
    const response = await fetch(petpoojaConfig.stockUrl, {
            method: "POST",
            // Loop: hung gateway held the function until platform timeout.
            signal: AbortSignal.timeout(15_000),
      headers: {
        "Content-Type": "application/json",
        Content_key: petpoojaConfig.appKey,
        Authorization: `Bearer ${petpoojaConfig.accessToken}`,
      },
      body: JSON.stringify({
        app_key: petpoojaConfig.appKey,
        app_secret: petpoojaConfig.appSecret,
        access_token: petpoojaConfig.accessToken,
        rest_id: restId,
        item_id: itemId,
        in_stock: inStock ? 1 : 0,
      }),
    });

    const result = await response.json();
    // Petpooja acks vary (success:"1"/1/true or status:"success") — accept
    // all documented forms, like orderPush does. Anything else is a failure.
    return (
      result.success === "1" ||
      result.success === 1 ||
      result.success === true ||
      result.status === "success"
    );
  } catch (err: any) {
    console.warn(`[Petpooja Stock Push Error] Failed for item ${itemId}:`, err.message);
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

export async function handlePetpoojaWebhook(payload: any): Promise<void> {
  const orderId = payload.order_id || payload.clientOrderID || payload.client_order_id;
  if (!orderId) {
    throw new Error("Missing order_id in Petpooja status webhook payload");
  }

  const orderDoc = await db.collection("orders").doc(orderId).get();
  if (!orderDoc.exists) {
    console.warn(`[Petpooja Webhook] Order ${orderId} not found in Firestore.`);
    try {
      await db
        .collection("unmatched_petpooja_orders")
        .doc(`upo_${orderId}`)
        .set(
          {
            orderId,
            rawStatus: payload.status || payload.order_status || null,
            restId: payload.rest_id || payload.restId || null,
            status: "needs_review",
            receivedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      await captureErrorSnapshot({
        source: "petpooja",
        severity: "medium",
        message: `Petpooja webhook for unknown order ${orderId} parked for review`,
        orderId,
      });
    } catch (err) {
      console.warn(`[Petpooja Webhook] Failed to park unknown order ${orderId}:`, (err as any)?.message || err);
    }
    return;
  }

  const rawStatus = payload.status || payload.order_status;
  const canonicalStatus = normalizePetpoojaStatus(rawStatus);

  const updateData: Record<string, any> = {
    petpoojaKitchenStatus: rawStatus,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  // Canonical object form (both apps + triggers accept it; bare strings with
  // lowercase codes break Delivery tracking).
  const statusMeta: Record<string, { code: string; label: string; kind: string; terminal: boolean }> = {
    accepted: { code: "CONFIRMED", label: "Order confirmed", kind: "upcoming", terminal: false },
    ready: { code: "READY_FOR_PICKUP", label: "Ready for pickup", kind: "in_progress", terminal: false },
    out_for_delivery: { code: "OUT_FOR_DELIVERY", label: "Out for delivery", kind: "in_progress", terminal: false },
    delivered: { code: "DELIVERED", label: "Delivered", kind: "completed", terminal: true },
    cancelled: { code: "CANCELLED", label: "Cancelled", kind: "cancelled", terminal: true },
  };

  if (canonicalStatus !== "unknown" && statusMeta[canonicalStatus]) {
    updateData.status = statusMeta[canonicalStatus];
  }

  if (canonicalStatus === "cancelled") {
    updateData.cancelledAt = admin.firestore.FieldValue.serverTimestamp();
    updateData.cancellationReason =
      payload.cancel_reason || payload.reason || "Cancelled by kitchen operator in Petpooja POS";

    const orderData = orderDoc.data()!;
    const payment = orderData.payment;
    if (payment?.razorpayPaymentId && !payment.refunded) {
      try {
        await autoRefund({
          orderId,
          razorpayPaymentId: payment.razorpayPaymentId,
          reason: "POS_CANCELLED",
        });
        updateData["payment.refundStatus"] = "INITIATED";
      } catch (err) {
        console.error(`Auto-refund failed on Petpooja cancel for ${orderId}:`, (err as any)?.message || err);
      }
    }
  }

  await orderDoc.ref.set(updateData, { merge: true });
}
