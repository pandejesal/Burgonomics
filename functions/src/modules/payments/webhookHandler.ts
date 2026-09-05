import { Request, Response } from "express";
import * as admin from "firebase-admin";
import { db } from "../../core/firebase";
import { config } from "../../config/env";
import { verifyRazorpayWebhookSignature } from "../../core/security";
import { captureErrorSnapshot } from "../../core/errors";
import { pushOrderToPetpooja } from "../petpooja";
import { dispatchFCM } from "../notifications/fcm.service";

/**
 * Handles incoming webhooks from Razorpay with signature verification & idempotent execution.
 */
export async function handleRazorpayWebhook(req: Request, res: Response): Promise<void> {
  const signature = req.headers["x-razorpay-signature"] as string;
  const rawBody = (req as any).rawBody
    ? (req as any).rawBody.toString("utf8")
    : typeof req.body === "string"
    ? req.body
    : JSON.stringify(req.body);

  if (!config.mock.paymentGateway) {
    const isValid = verifyRazorpayWebhookSignature(
      rawBody,
      signature,
      config.razorpay.webhookSecret
    );
    if (!isValid) {
      console.warn("[Razorpay Webhook] Invalid signature received");
      res.status(400).json({ error: "Invalid webhook signature" });
      return;
    }
  }

  const payload = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const event = payload.event;
  const eventId = payload.id || `evt_${Date.now()}`;

  // Idempotency check
  const auditDocRef = db.collection("payment_audits").doc(`aud_evt_${eventId}`);
  const auditSnap = await auditDocRef.get();
  if (auditSnap.exists) {
    res.status(200).json({ status: "already_processed" });
    return;
  }

  try {
    if (event === "payment.captured" || event === "order.paid") {
      const paymentEntity = payload.payload?.payment?.entity;
      const orderId = paymentEntity?.notes?.orderId;
      const branchId = paymentEntity?.notes?.branchId;
      const razorpayPaymentId = paymentEntity?.id;

      if (orderId) {
        await db.collection("orders").doc(orderId).set(
          {
            paymentStatus: "completed",
            "payment.status": "completed",
            "payment.razorpayPaymentId": razorpayPaymentId,
            // Canonical object form (see verifyPayment): both apps + triggers
            // accept it; bare-string writes break Delivery tracking.
            status: {
              code: "CONFIRMED",
              label: "Order confirmed",
              kind: "upcoming",
              terminal: false,
            },
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

        // Auto-notify branch kitchen display system (KDS). Topic MUST match
        // what devices subscribe to (branch_<id>_orders) — the bare
        // branch_<id> topic has zero subscribers and alerts vanish silently.
        if (branchId) {
          try {
            await dispatchFCM({
              topic: `branch_${branchId}_orders`,
              title: "ðŸ”” Order Paid & Confirmed",
              body: `Order #${orderId.substring(0, 6)} confirmed. Start preparation!`,
              data: {
                type: "payment_captured",
                orderId,
                paymentId: razorpayPaymentId || "",
              },
            });
          } catch (fcmErr) {
            console.warn(`[Razorpay Webhook] FCM dispatch notice failed for order ${orderId}:`, fcmErr);
          }
        }

        // Auto-push KOT to Petpooja POS upon payment confirmation
        try {
          await pushOrderToPetpooja(orderId);
        } catch (err) {
          console.warn(`[Razorpay Webhook] KOT push queued for order ${orderId}:`, err);
        }
      }
    } else if (event === "payment.failed") {
      const paymentEntity = payload.payload?.payment?.entity;
      const orderId = paymentEntity?.notes?.orderId;
      if (orderId) {
        await db.collection("orders").doc(orderId).set(
          {
            paymentStatus: "failed",
            "payment.status": "failed",
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }
    } else if (event === "transfer.processed" || event === "transfer.failed" || event === "transfer.reversed") {
      const transferEntity = payload.payload?.transfer?.entity;
      const linkedAccount = transferEntity?.recipient;
      if (transferEntity?.id) {
        await db.collection("route_transfer_events").doc(`rtevt_${eventId}`).set(
          {
            eventId,
            event,
            transferId: transferEntity.id,
            recipient: linkedAccount || null,
            amount: transferEntity.amount ? transferEntity.amount / 100 : null,
            status: transferEntity.status || event,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        if (event === "transfer.failed") {
          await captureErrorSnapshot({
            source: "payments",
            severity: "high",
            message: `Razorpay Route transfer failed: ${transferEntity.id}`,
          });
        }
      }
    } else if (event === "refund.processed") {
      const refundEntity = payload.payload?.refund?.entity;
      const paymentId = refundEntity?.payment_id;
      const refundId = refundEntity?.id;
      const amount = refundEntity?.amount ? refundEntity.amount / 100 : 0;

      // Find order by paymentId
      const ordersSnap = await db
        .collection("orders")
        .where("payment.razorpayPaymentId", "==", paymentId)
        .limit(1)
        .get();

      if (!ordersSnap.empty) {
        const orderDoc = ordersSnap.docs[0];
        await orderDoc.ref.set(
          {
            refundStatus: "refunded",
            refundId,
            refundAmount: amount,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }
    }

    // Save audit log for idempotency
    await auditDocRef.set({
      eventId,
      event,
      payloadSummary: {
        paymentId: payload.payload?.payment?.entity?.id,
        orderId: payload.payload?.payment?.entity?.notes?.orderId,
      },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.status(200).json({ status: "ok" });
  } catch (err: any) {
    await captureErrorSnapshot({
      source: "payments",
      severity: "high",
      message: `Error processing Razorpay webhook event ${event}: ${err.message}`,
      errorStack: err.stack,
    });
    res.status(500).json({ error: "Failed to process webhook" });
  }
}

