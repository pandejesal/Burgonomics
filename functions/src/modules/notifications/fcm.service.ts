import { db, messaging } from "../../core/firebase";
import * as admin from "firebase-admin";

export interface FCMDispatchParams {
  topic?: string;
  token?: string;
  title: string;
  body: string;
  data?: Record<string, string>;
  sound?: string;
  recipientUid?: string;
  badge?: number;
}

/**
 * Dispatches high-priority push notifications via FCM and writes to in-app notification center.
 */
export async function dispatchFCM(params: FCMDispatchParams): Promise<boolean> {
  const { topic, token, title, body, data, sound, recipientUid, badge } = params;

  const isBranchAlert = topic && topic.startsWith("branch_");
  const effectiveSound = sound || (isBranchAlert ? "new_order.wav" : "default");

  const basePayload = {
    notification: {
      title,
      body,
    },
    data: data || {},
    android: {
      priority: "high" as const,
      notification: {
        sound: effectiveSound,
        channelId: isBranchAlert ? "burgonomics_orders_channel" : "burgonomics_updates_channel",
      },
    },
    apns: {
      payload: {
        aps: {
          sound: effectiveSound,
          ...(typeof badge === "number" && badge > 0 ? { badge } : { badge: 1 }),
        },
      },
    },
  };

  let messagePayload: admin.messaging.Message | null = null;
  if (topic) {
    messagePayload = { ...basePayload, topic };
  } else if (token) {
    messagePayload = { ...basePayload, token };
  }

  // Return value is the actual delivery outcome — callers (dashboard
  // indicators, retry logic) must not report "sent" on failure.
  let pushDelivered = false;
  try {
    if (messagePayload && typeof messaging.send === "function") {
      await messaging.send(messagePayload);
      pushDelivered = true;
    }
  } catch (err) {
    console.warn("[FCM] Failed to send push message (non-blocking for app):", err);
  }

  // Write to recipient's in-app notification collection if provided
  let inboxWritten = false;
  if (recipientUid) {
    const notifId = `notif_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    await db
      .collection("users")
      .doc(recipientUid)
      .collection("notifications")
      .doc(notifId)
      .set({
        id: notifId,
        title,
        message: body,
        type: data?.type || "system",
        targetId: data?.targetId || null,
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    inboxWritten = true;
  }

  return pushDelivered || inboxWritten;
}
