import { db, messaging } from "../../core/firebase";
import * as admin from "firebase-admin";
import { truncatePushText, buildParityExtras } from "./templates";
import { getUnreadCount } from "./fcmClient";

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
 * B5-S1 (H18) clear-on-read: marks the recipient's inbox notifications read
 * (server-side, works under the locked rules where clients may only flip
 * read/readAt/updatedAt) and best-effort pushes a silent badge-0 update so
 * the device badge clears immediately instead of lingering until next push.
 * Returns the number of inbox docs marked read.
 */
export async function markNotificationsRead(
  recipientUid: string,
  notificationIds?: string[]
): Promise<number> {
  if (!recipientUid || !db || typeof db.collection !== "function") return 0;
  const col = db.collection("users").doc(recipientUid).collection("notifications");
  let ids = notificationIds;
  if (!ids) {
    try {
      const snap = await col.where("read", "==", false).limit(200).get();
      ids = snap.docs.map((d: any) => d.id);
    } catch {
      return 0;
    }
  }
  if (!ids || ids.length === 0) return 0;

  const batch = db.batch();
  for (const id of ids.slice(0, 200)) {
    batch.update(col.doc(id), {
      read: true,
      readAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  try {
    await batch.commit();
  } catch {
    return 0;
  }

  // Silent badge clear (best-effort, never throws into callers).
  try {
    if (messaging && typeof messaging.send === "function") {
      const userDoc = await db.collection("users").doc(recipientUid).get();
      const fcmTokens: string[] = userDoc.data()?.fcmTokens || [];
      if (fcmTokens.length > 0) {
        const { sendMulticastFcm } = await import("./fcmClient");
        await sendMulticastFcm(
          fcmTokens,
          {
            data: { type: "badge_clear", badge: "0" },
            ...buildParityExtras("", "", { badge: 0 }),
          },
          recipientUid
        );
      }
    }
  } catch {
    // Non-blocking: inbox is already marked read above.
  }
  return Math.min(ids.length, 200);
}

/**
 * Dispatches high-priority push notifications via FCM and writes to in-app notification center.
 *
 * B5-S1: badge = unread count at send (H18 — explicit opts win, else counted
 * from the recipient inbox, else 1), bodies server-truncated, shared
 * apns+webpush parity on every send (H34).
 */
export async function dispatchFCM(params: FCMDispatchParams): Promise<boolean> {
  const { topic, token, title, body, data, sound, recipientUid, badge } = params;
  const safeBody = truncatePushText(body);

  const isBranchAlert = topic && topic.startsWith("branch_");
  // Android res/raw sounds are referenced WITHOUT extension — "new_order.wav"
  // 404-silences the custom sound. The bundled asset is res/raw/new_order.
  const effectiveSound = sound || (isBranchAlert ? "new_order" : "default");

  // Badge = unread count at send: explicit param wins (callers that already
  // counted), else count the recipient inbox now, else legacy 1.
  let effectiveBadge = typeof badge === "number" ? badge : 1;
  if (typeof badge !== "number" && recipientUid) {
    const counted = await getUnreadCount(recipientUid);
    // +1: this dispatch writes its inbox doc below, so count the doc about
    // to land (capped at 99 like getUnreadCount).
    effectiveBadge = Math.min(counted + 1, 99);
  }

  const basePayload = {
    notification: {
      title,
      body: safeBody,
    },
    data: data || {},
    android: {
      priority: "high" as const,
      notification: {
        sound: effectiveSound,
        channelId: isBranchAlert ? "burgonomics_orders_channel" : "burgonomics_updates_channel",
      },
    },
    // Shared iOS/Web parity (H34): same title/body + server-computed badge.
    ...buildParityExtras(title, safeBody, { badge: effectiveBadge }),
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
        message: safeBody,
        type: data?.type || "system",
        targetId: data?.targetId || null,
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    inboxWritten = true;
  }

  return pushDelivered || inboxWritten;
}
