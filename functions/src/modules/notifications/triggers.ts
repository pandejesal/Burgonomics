import { onDocumentUpdated, onDocumentCreated } from "firebase-functions/v2/firestore";
import { db } from "../../core/firebase";
import { buildKotAlertMessage, buildCustomerOrderUpdateMessage, buildTicketAlertMessage } from "./templates";
import { sendFcmMessage, sendMulticastFcm, writeCustomerInboxDoc } from "./fcmClient";
import { captureErrorSnapshot } from "../../core/errors";

const REGION = "asia-south1";

/**
 * Trigger: Fires when an order is first created in Firestore.
 * Transmits acoustic KOT push notification to branch KDS / POS terminals.
 */
export const onOrderCreatedNotificationTrigger = onDocumentCreated(
  {
    region: REGION,
    document: "orders/{orderId}",
  },
  async (event) => {
    const snap = event.data;
    if (!snap) return;

    const order = snap.data();
    const orderId = event.params.orderId;
    const branchId = order.branchId || order.store?.id;

    if (!branchId) {
      console.warn(`[onOrderCreatedTrigger] Order ${orderId} has no branchId`);
      return;
    }

    try {
      const kotMessage = buildKotAlertMessage(branchId, {
        id: orderId,
        orderNumber: order.shortCode || order.orderNumber || orderId.substring(0, 6).toUpperCase(),
        fulfillmentType: order.fulfillment || order.fulfillmentType || "DELIVERY",
        totalAmount: order.totals?.grandTotal || order.pricing?.grandTotal || order.total || 0,
        tableNumber: order.tableNumber,
      });

      const sent = await sendFcmMessage(kotMessage);
      if (sent) {
        console.log(`[onOrderCreatedTrigger] Dispatched acoustic KOT alert to branch_${branchId}_orders`);
      } else {
        // Loop 5: kitchen got no acoustic alert — snapshot so ops can
        // investigate / re-push; never pretend the chime went out.
        await captureErrorSnapshot({
          source: "notifications",
          severity: "high",
          message: `KOT push for order ${orderId} returned false (no transport or mock) — kitchen may be silent`,
          orderId,
          branchId,
        });
      }
    } catch (err: any) {
      // KDS-blind kitchen: snapshot LOUD with order+branch refs (was console-only).
      console.error("[onOrderCreatedTrigger] Failed to dispatch KOT notification:", err?.message || err);
      await captureErrorSnapshot({
        source: "notifications",
        severity: "high",
        message: `KOT push notification failed for order ${orderId} — kitchen may be blind`,
        orderId,
        branchId,
        errorStack: err?.stack,
      });
    }

    // Customer order confirmation (PLACED) — previously only the kitchen was
    // notified on create; customers heard nothing until the first status bump.
    // B5-S1: only backend-backed copy leaves this trigger (eta/partner from
    // the doc; veg/refund flags only when the doc actually carries them).
    const customerId = order.customerId || order.userId || order.customer?.id;
    try {
      if (customerId && typeof db.collection === "function") {
        const userDoc = await db.collection("users").doc(customerId).get();
        const fcmTokens: string[] = userDoc.data()?.fcmTokens || [];
        if (fcmTokens.length > 0) {
          const confirmMessage = buildCustomerOrderUpdateMessage(
            fcmTokens[0],
            {
              id: orderId,
              orderNumber: order.shortCode || order.orderNumber || orderId.substring(0, 6).toUpperCase(),
              fulfillmentType: order.fulfillment || order.fulfillmentType || "delivery",
              storeName: order.store?.name || "Burgonomics",
              etaMinutes: order.etaMinutes,
              deliveryPartnerName: order.deliveryPartner?.name,
              allVeg: order.allVeg === true ? true : undefined,
              refundInitiated: order.refundStatus === "refunded" || order.refundStatus === "INITIATED" ? true : undefined,
              paymentMethod: order.payment?.method,
            },
            "PLACED"
          );
          await sendMulticastFcm(
            fcmTokens,
            {
              notification: confirmMessage.notification,
              data: confirmMessage.data,
              android: confirmMessage.android,
              apns: confirmMessage.apns,
            },
            customerId
          ).then(async (result) => {
            // Loop 5: push-or-nothing left customers silent — fall back to
            // the in-app inbox when FCM delivers zero.
            if (result.successCount === 0) {
              const n = confirmMessage.notification;
              if (n && n.title && n.body) {
                await writeCustomerInboxDoc(
                  customerId,
                  n.title,
                  n.body,
                  confirmMessage.data as Record<string, string>
                );
              }
            }
          });
        }
      }
    } catch (err: any) {
      console.error("[onOrderCreatedTrigger] Failed to dispatch customer confirmation:", err?.message || err);
      await captureErrorSnapshot({
        source: "notifications",
        severity: "medium",
        message: `customer order-confirmation push failed for order ${orderId} — customer silent, kitchen already notified; check user fcmTokens then re-push from the order page`,
        orderId,
        branchId,
        customerId,
        errorStack: err?.stack,
      });
    }
  }
);

/**
 * Trigger: Fires when an existing order document is updated in Firestore.
 * Applies strict state-delta checks to prevent duplicate push loops.
 */
export const onOrderStatusChangedNotificationTrigger = onDocumentUpdated(
  {
    region: REGION,
    document: "orders/{orderId}",
  },
  async (event) => {
    const change = event.data;
    if (!change) return;

    const before = change.before.data();
    const after = change.after.data();
    const orderId = event.params.orderId;

    const beforeStatusCode =
      typeof before.status === "object" ? before.status?.code : before.status;
    const afterStatusCode =
      typeof after.status === "object" ? after.status?.code : after.status;

    // Strict state-delta check: Exit if status did not change
    if (beforeStatusCode === afterStatusCode) {
      return;
    }

    console.log(
      `[onOrderStatusChangedTrigger] Order ${orderId} status changed: ${beforeStatusCode} -> ${afterStatusCode}`
    );

    const customerId = after.customerId || after.userId || after.customer?.id;
    if (!customerId) return;

    try {
      // Fetch customer FCM tokens if Firestore db is available
      if (typeof db.collection === "function") {
        const userDoc = await db.collection("users").doc(customerId).get();
        const userData = userDoc.data();
        const fcmTokens: string[] = userData?.fcmTokens || [];

        if (fcmTokens.length > 0) {
          const sampleToken = fcmTokens[0];
          const updateMessage = buildCustomerOrderUpdateMessage(
            sampleToken,
            {
              id: orderId,
              orderNumber:
                after.shortCode || after.orderNumber || orderId.substring(0, 6).toUpperCase(),
              fulfillmentType: after.fulfillment || after.fulfillmentType || "delivery",
              storeName: after.store?.name || "Burgonomics",
              etaMinutes: after.etaMinutes || after.deliveryPartner?.etaMinutes,
              deliveryPartnerName: after.deliveryPartner?.name,
              allVeg: after.allVeg === true ? true : undefined,
              refundInitiated:
                after.refundStatus === "refunded" || after.refundStatus === "INITIATED"
                  ? true
                  : undefined,
              paymentMethod: after.payment?.method,
            },
            afterStatusCode
          );

          await sendMulticastFcm(
            fcmTokens,
            {
              notification: updateMessage.notification,
              data: updateMessage.data,
              android: updateMessage.android,
              apns: updateMessage.apns,
            },
            customerId
          ).then(async (result) => {
            // Loop 5: inbox fallback — see PLACED path above.
            if (result.successCount === 0) {
              const n = updateMessage.notification;
              if (n && n.title && n.body) {
                await writeCustomerInboxDoc(
                  customerId,
                  n.title,
                  n.body,
                  updateMessage.data as Record<string, string>
                );
              }
            }
          });
        }
      }
    } catch (err: any) {
      // Never interpolate raw customerId into log text (PII boundary).
      console.error("[onOrderStatusChangedTrigger] Error sending status push:", err?.message || err);
      await captureErrorSnapshot({
        source: "notifications",
        severity: "medium",
        message: `status push failed for order ${orderId}`,
        orderId,
        customerId,
        errorStack: err?.stack,
      });
    }
  }
);

/**
 * Trigger: Fires when a support ticket is CREATED already urgent.
 * The update trigger only catches escalation-to-urgent — without this,
 * born-urgent tickets never alert anyone.
 */
export const onTicketCreatedUrgentTrigger = onDocumentCreated(
  {
    region: REGION,
    // Canonical collection: tickets.service writes support_tickets. The old
    // `tickets/` path NEVER fired — born-urgent tickets alerted nobody.
    document: "support_tickets/{ticketId}",
  },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const ticket = snap.data();
    const ticketId = event.params.ticketId;
    if (ticket.priority !== "urgent") return;

    try {
      const branchId = ticket.branchId || "global";
      // B5-S1 (H17): the free-text subject stays in Firestore only — the
      // builder renders generic copy with IDs in data.
      const message = buildTicketAlertMessage(branchId, {
        id: ticketId,
        ticketNumber: ticket.ticketNumber || ticketId.substring(0, 6),
        priority: ticket.priority,
      });
      await sendFcmMessage(message);
    } catch (err: any) {
      console.error("[onTicketCreatedUrgentTrigger] Failed:", err?.message || err);
      await captureErrorSnapshot({
        source: "notifications",
        severity: "high",
        message: `urgent-ticket alert failed for ticket ${ticketId} — SLA clock runs silently`,
        errorStack: err?.stack,
      });
    }
  }
);

/**
 * Trigger: Fires when a support ticket is created or escalated.
 */
export const onTicketEscalatedNotificationTrigger = onDocumentUpdated(
  {
    region: REGION,
    // Canonical collection (see above) — the old path never fired.
    document: "support_tickets/{ticketId}",
  },
  async (event) => {
    const change = event.data;
    if (!change) return;

    const before = change.before.data();
    const after = change.after.data();
    const ticketId = event.params.ticketId;

    if (before.priority !== after.priority && after.priority === "urgent") {
      const branchId = after.branchId || "global";
      const message = buildTicketAlertMessage(branchId, {
        id: ticketId,
        ticketNumber: after.ticketNumber || ticketId.substring(0, 6),
        priority: after.priority,
      });

      await sendFcmMessage(message);
    }
  }
);
