import { db } from "../../core/firebase";
import * as logger from "firebase-functions/logger";
import { dispatchFCM } from "../notifications/fcm.service";

/**
 * Paid-but-POS-pending staff alerts.
 *
 * The order can be paid and the KOT relay can still be unconfirmed (POS down,
 * ambiguous timeout, exhausted retry queue). Staff must not discover that only
 * when the customer calls. D21/D22:
 *   - alert the branch at 2 minutes;
 *   - escalate to the staff escalation topic at 5 minutes;
 *   - never auto-refund or blindly re-push from this worker.
 *
 * This worker is read/alert-only. The existing Petpooja retry worker owns
 * retries and its leases; this worker only observes `pending_retry` /
 * `processing` orders and writes idempotency markers.
 */

export const POS_PENDING_ALERT_MS = 2 * 60 * 1000;
export const POS_PENDING_ESCALATION_MS = 5 * 60 * 1000;
const SCAN_LIMIT = 100;

function timestampMs(value: any): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value && typeof value.toMillis === "function") {
    const ms = Number(value.toMillis());
    return Number.isFinite(ms) ? ms : 0;
  }
  if (value && typeof value === "object" && typeof value.seconds === "number") {
    return value.seconds * 1000;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/** When the server confirmed the money, not when the customer opened the app. */
function paidAtMs(order: any): number {
  return (
    timestampMs(order?.payment?.verifiedAt) ||
    timestampMs(order?.paidAt) ||
    timestampMs(order?.payment?.paidAt) ||
    timestampMs(order?.confirmedAt) ||
    timestampMs(order?.createdAt)
  );
}

function isPaid(order: any): boolean {
  return (
    order?.paymentStatus === "completed" ||
    order?.payment?.status === "completed" ||
    order?.["payment.status"] === "completed"
  );
}

function orderLabel(order: any, orderId: string): string {
  const shortCode =
    typeof order?.shortCode === "string" && order.shortCode.trim()
      ? order.shortCode.trim()
      : orderId.slice(-6).toUpperCase();
  return `Order ${shortCode}`;
}

async function scanStatus(status: "pending_retry" | "processing"): Promise<any[]> {
  const snap = await db
    .collection("orders")
    .where("petpoojaStatus", "==", status)
    .limit(SCAN_LIMIT)
    .get();
  return snap.docs || [];
}

export async function posPendingAlertsWorker(): Promise<{
  alerts2m: number;
  escalations5m: number;
}> {
  let alerts2m = 0;
  let escalations5m = 0;

  // No composite-order scan here: a single-field status query is enough, and
  // the age filter is applied in code. The retry worker still owns the
  // oldest-first retry ordering.
  const candidates = new Map<string, any>();
  for (const status of ["pending_retry", "processing"] as const) {
    try {
      for (const doc of await scanStatus(status)) {
        candidates.set(doc.id, doc);
      }
    } catch (err: any) {
      logger.warn(
        `[POS Pending Alerts] ${status} scan failed:`,
        err?.message || err
      );
    }
  }

  for (const doc of candidates.values()) {
    const order = (doc.data ? doc.data() : undefined) || {};
    if (order.petpoojaOrderId || order.petpoojaAcceptedNoId) continue;
    if (!isPaid(order)) continue;

    const branchId =
      typeof order.branchId === "string" && order.branchId.trim()
        ? order.branchId.trim()
        : "";
    if (!branchId) continue;

    const paidAt = paidAtMs(order);
    if (!paidAt) continue;
    const age = Date.now() - paidAt;
    if (age < POS_PENDING_ALERT_MS) continue;

    const label = orderLabel(order, doc.id);
    const minutes = Math.floor(age / 60_000);

    if (age >= POS_PENDING_ESCALATION_MS) {
      if (order.posPendingEscalated5mAt) continue;
      const branchOk = await dispatchFCM({
        topic: `branch_${branchId}_orders`,
        title: "ESCALATION: paid order still not in Petpooja",
        body: `${label} was paid ${minutes} min ago and still has no POS acceptance. Verify the POS connection and push the order manually.`,
        data: {
          type: "pos_pending_escalation",
          orderId: doc.id,
          branchId,
          stage: "5m",
        },
      });
      const escalationOk = await dispatchFCM({
        topic: "tickets_escalated",
        title: "POS pending escalation",
        body: `${label} at ${branchId} was paid ${minutes} min ago with no POS acceptance.`,
        data: {
          type: "pos_pending_escalation",
          orderId: doc.id,
          branchId,
          stage: "5m",
        },
      });
      // At least one staff channel must have accepted the push before the
      // marker is written; otherwise the next tick retries the alert.
      if (branchOk || escalationOk) {
        await doc.ref.set(
          {
            // The 2-minute marker is also set so a later tick cannot send a
            // second, lower-stage alert after the escalation.
            posPendingAlert2mAt: order.posPendingAlert2mAt || Date.now(),
            posPendingEscalated5mAt: Date.now(),
          },
          { merge: true }
        );
        escalations5m++;
      }
      continue;
    }

    if (order.posPendingAlert2mAt) continue;
    const ok = await dispatchFCM({
      topic: `branch_${branchId}_orders`,
      title: "Paid order waiting for Petpooja",
      body: `${label} was paid ${minutes} min ago but has no POS acceptance. Check the POS connection.`,
      data: {
        type: "pos_pending_alert",
        orderId: doc.id,
        branchId,
        stage: "2m",
      },
    });
    if (ok) {
      await doc.ref.set({ posPendingAlert2mAt: Date.now() }, { merge: true });
      alerts2m++;
    }
  }

  return { alerts2m, escalations5m };
}
