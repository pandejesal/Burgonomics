import { db } from "../../core/firebase";
import { captureErrorSnapshot } from "../../core/errors";
import { config, assertLivePetpoojaContext } from "../../config/env";
import { getPetpoojaConfig } from "./client";
import * as admin from "firebase-admin";
import { assertBranchAccess, type StaffCaller } from "../../core/middleware";
import { isSafeDocId } from "../../core/security";

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
  inStock: boolean,
  caller?: StaffCaller
): Promise<boolean> {
  // Staff boundary: branch-A staff cannot 86 Branch-B's items.
  if (caller) assertBranchAccess(caller, branchId);
  // ZERO-MOCK runtime gate: a declared-production process must never "push"
  // a toggle it never sent (the mock branch below would return true).
  assertLivePetpoojaContext(`stock push for branch ${branchId} item ${itemId}`);
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
        // Fail-closed AND loud: the KDS reports this toggle as not synced,
        // so ops needs an alert (not a log line nobody reads).
        await captureErrorSnapshot({
          source: "petpooja",
          severity: "high",
          message: `Stock push for item ${itemId} aborted — branch lookup failed for ${branchId}: ${err?.message || err}`,
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
          message: `Stock push for item ${itemId} refused — branch ${branchId} has no linked Petpooja outlet (link per Runbook §5)`,
          branchId,
        });
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
        item_id: itemId,
        itemID: [itemId],
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
          `Petpooja stock push rejected/unreachable — branch ${branchId} item ${itemId} inStock=${inStock} ` +
          `(HTTP ${response.status}${result?.message ? `: ${result.message}` : ""})`,
        branchId,
      });
    }
    return acked;
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

  // An unauthenticated caller (a callback admitted by SHAPE) must not steer
  // another outlet's order. The POS-id path already scopes by branch; this
  // covers the doc-id path, where the caller supplied our internal order id
  // directly: require a restID that resolves to a linked branch AND an order
  // that belongs to it.
  if (untrusted) {
    const claimedBranch = restIdRaw ? await resolveBranchIdForRestId(restIdRaw) : null;
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
              posOrderId: posOrderId || null,
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
  const orderData = (orderDoc.data() || {}) as Record<string, any>;

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
  if (eventId) {
    const lastId = orderData.petpoojaWebhookEventId;
    const lastRaw = orderData.petpoojaWebhookReceivedAtMs;
    const lastMs =
      typeof lastRaw === "number" && Number.isFinite(lastRaw)
        ? lastRaw
        : lastRaw && typeof lastRaw.toMillis === "function"
          ? lastRaw.toMillis()
          : 0;
    if (lastId === eventId && lastMs > 0 && Date.now() - lastMs < EVENT_FRESHNESS_MS) {
      console.warn(
        `[Petpooja Webhook] Replay of event ${eventId} for order ${orderId} inside freshness window — ignored`
      );
      return;
    }
  }

  // ---- Terminal-state guard (mirrors dispatch.webhooks delivery guard) ----
  // POS retries replay stale kitchen updates OUT OF ORDER: a late "accepted"
  // would resurrect a DELIVERED order as CONFIRMED, and a late CANCELLED
  // would cancel a handed-over order AND park a refund — moving money on a
  // replay. A terminal order (DELIVERED or CANCELLED) is never moved by any
  // later event. Legacy bare-string statuses are honored too.
  const currentStatus = orderData.status;
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
    orderData.deliveryStatus === "delivered";
  if (terminalNow) {
    console.warn(
      `[Petpooja Webhook] Ignoring kitchen status "${String(rawStatus)}" for TERMINAL order ${orderId} ` +
        `(current: ${currentCode || currentKind || "unknown"}) — no rewind, no refund side effects`
    );
    return;
  }

  const updateData: Record<string, any> = {
    petpoojaKitchenStatus: rawStatus,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  // A callback is the only place a POS-assigned id can arrive when save_order
  // echoed an empty one, so record what we learn here and promote the order out
  // of `pending_retry` — otherwise the retry worker would keep re-pushing an
  // order the POS has demonstrably already accepted.
  //
  // Gated on a CREDENTIALED callback and on an accepting status:
  // - untrusted (shape-admitted) callers must not write `petpoojaOrderId` /
  //   `synced`, because the retry worker and the outbound dedupe both key off
  //   those — a forged value would silently drop a genuinely un-pushed order
  //   from the retry queue. What they claim is recorded under a separate field.
  // - a `Reject`/unknown status must not be promoted to a plain `synced` state
  //   with no signal that the KOT was refused.
  //
  // PROVENANCE: only a POS-DERIVED id may become `petpoojaOrderId`. When the
  // callback only carried our client reference (`orderID` per the documented
  // contract), the order is known to the POS but we still hold no POS-issued id:
  // record the existing accepted-no-id marker (truthful, keeps dedupe/retry from
  // re-pushing) and NEVER stamp the client reference as a POS id.
  const accepting = canonicalStatus !== "cancelled" && canonicalStatus !== "unknown";
  // Only an id the lookup PROVED may be stamped. An explicit field is a claim:
  // it is accepted only when it already equals this order's stored POS id.
  const posDerivedId =
    resolvedBy === "pos"
      ? posOrderId
      : explicitPosOrderId && orderData.petpoojaOrderId === explicitPosOrderId
        ? explicitPosOrderId
        : "";
  if (
    !untrusted &&
    posDerivedId &&
    orderData.petpoojaOrderId !== posDerivedId &&
    accepting
  ) {
    updateData.petpoojaOrderId = posDerivedId;
    updateData.petpoojaStatus = "synced";
    updateData.petpoojaSyncStatus = "synced";
  } else if (
    !untrusted &&
    accepting &&
    !orderData.petpoojaOrderId &&
    (resolvedBy === "client-callback" ||
      (resolvedBy === "client-legacy" && callbackOrderId))
  ) {
    updateData.petpoojaAcceptedNoId = true;
    updateData.petpoojaAcceptedNoIdAt = admin.firestore.FieldValue.serverTimestamp();
    // Do NOT overwrite `petpoojaAcceptedNoIdAck`: that field holds the raw
    // save_order response recorded at push time (kot-race pins it). A callback
    // payload is a different audit fact.
    updateData.petpoojaCallbackAck = JSON.stringify(payload).slice(0, 500);
    updateData.petpoojaAcceptedNoIdSource =
      resolvedBy === "client-callback" ? "callback_client_ref" : "callback_unproven_id";
    updateData.petpoojaStatus = "synced";
    updateData.petpoojaSyncStatus = "synced";
    // Visibility only: an id the callback claimed but we could not prove is
    // POS-issued. It never becomes `petpoojaOrderId` and never drives dedupe.
    if (resolvedBy === "client-callback") {
      updateData.petpoojaCallbackClientRef = callbackOrderId;
    } else if (callbackOrderId) {
      updateData.petpoojaCallbackOrderId = callbackOrderId;
    }
  } else if (untrusted) {
    const claimedId =
      posDerivedId ||
      (callbackOrderId && resolvedBy !== "client-callback" ? callbackOrderId : "");
    if (claimedId && orderData.petpoojaOrderId !== claimedId) {
      updateData.petpoojaCallbackOrderId = claimedId;
    } else if (resolvedBy === "client-callback" && callbackOrderId) {
      updateData.petpoojaCallbackClientRef = callbackOrderId;
    }
  }
  if (eventId) {
    // Replay marker rides on the order doc so a redelivery of the SAME event
    // id short-circuits above (only while fresh).
    updateData.petpoojaWebhookEventId = eventId;
    updateData.petpoojaWebhookReceivedAtMs = Date.now();
  }

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

    const payment = orderData.payment;
    // Product decision 2026-09-23: kitchen-cancelled orders PARK a refund
    // request for staff approval instead of auto-refunding. The old code
    // POSTed the refund with no human and no branch check — a compromised
    // or mistaken POS cancel moved real money silently.
    const alreadyRefunded = orderData.refundStatus === "refunded" || payment?.refunded === true;
    if (payment?.razorpayPaymentId && !alreadyRefunded) {
      try {
        const existing = await db
          .collection("refunds")
          .where("orderId", "==", orderId)
          .where("status", "==", "PENDING")
          .limit(1)
          .get();
        if (existing.empty) {
          // DETERMINISTIC doc id: two concurrent replays of the same cancel
          // used to both pass the `existing.empty` probe above (read-then-
          // write race) and park TWO PENDING refunds for one payment. One
          // order id can only ever name ONE POS-cancel refund request.
          await db.collection("refunds").doc(`refund_pos_cancel_${orderId}`).set({
            orderId,
            branchId: orderData.branchId ?? null,
            razorpayPaymentId: payment.razorpayPaymentId,
            amountPaise:
              typeof payment?.amount === "number"
                ? payment.amount
                : typeof orderData.pricing?.grandTotal === "number"
                  ? Math.round(orderData.pricing.grandTotal * 100)
                  : null,
            reason: "POS_CANCELLED",
            detail:
              payload.cancel_reason || payload.reason || "Cancelled by kitchen operator in Petpooja POS",
            status: "PENDING",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          updateData["payment.refundStatus"] = "PENDING_APPROVAL";
        }
      } catch (err) {
        console.error(`Refund-request parking failed on Petpooja cancel for ${orderId}:`, (err as any)?.message || err);
      }
    }
  }

  await orderDoc.ref.set(updateData, { merge: true });
}
