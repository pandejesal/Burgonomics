import { db } from "../../core/firebase";
import * as admin from "firebase-admin";
import { truncatePushText, buildParityExtras } from "./templates";
import { getUnreadCount, sendFcmMessage, sendMulticastFcm } from "./fcmClient";
import {
  NotificationPurpose,
  STAFF_PURPOSE,
  SYSTEM_PURPOSE,
  isNotificationPurpose,
} from "./registry";
import { SendActor, resolveSend } from "./sendGate";

export interface FCMDispatchParams {
  topic?: string;
  token?: string;
  title: string;
  body: string;
  data?: Record<string, string>;
  sound?: string;
  recipientUid?: string;
  badge?: number;
  /**
   * Required at runtime. The route/trigger supplies it from server state;
   * a missing/unknown value is quarantined by the gate (zero sends).
   */
  purpose?: NotificationPurpose;
  actor?: SendActor | null;
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

  // Silent badge clear (best-effort, never throws into callers). The system
  // purpose is ownership-checked, never preference-gated, and badge-0 only.
  // Transport/timeout policy lives in fcmClient — this file never calls FCM.
  try {
    const userDoc = await db.collection("users").doc(recipientUid).get();
    const fcmTokens: string[] = userDoc.data()?.fcmTokens || [];
    if (fcmTokens.length > 0) {
      await sendMulticastFcm(
        fcmTokens,
        {
          data: { type: "badge_clear", badge: "0" },
          ...buildParityExtras("", "", { badge: 0 }),
        },
        recipientUid,
        { purpose: SYSTEM_PURPOSE }
      );
    }
  } catch {
    // Non-blocking: inbox is already marked read above.
  }
  return Math.min(ids.length, 200);
}

/**
 * Dispatches high-priority push notifications via FCM and writes to in-app
 * notification center.
 *
 * B5-S1: badge = unread count at send (H18 — explicit opts win, else counted
 * from the recipient inbox, else 1), bodies server-truncated, shared
 * apns+webpush parity on every send (H34).
 *
 * N-05: every account send resolves through the gate and the customer inbox
 * row is written BEFORE FCM by the shared multicast primitive (data carries
 * only purpose/category/recipientUid/ref). Topic/staff sends read zero prefs
 * and write no inbox row.
 */
export async function dispatchFCM(params: FCMDispatchParams): Promise<boolean> {
  const { topic, token, title, body, data, sound, recipientUid, badge } = params;
  const approved = await resolveSend({
    purpose: params.purpose,
    topic,
    token,
    recipientUid,
    actor: params.actor,
    payloadType: data?.type,
    source: "dispatchFCM",
  });

  const safeBody = truncatePushText(body);

  const isBranchAlert = topic && topic.startsWith("branch_");
  // Android res/raw sounds are referenced WITHOUT extension — "new_order.wav"
  // 404-silences the custom sound. The bundled asset is res/raw/new_order.
  const effectiveSound = sound || (isBranchAlert ? "new_order" : "default");

  // Badge = unread count at send: explicit param wins (callers that already
  // counted), else count the recipient inbox now, else legacy 1. System sends
  // are badge-0 ONLY (contract §2) — never derive or accept a nonzero badge.
  const isSystem = approved.kind === "system";
  let effectiveBadge = isSystem ? 0 : typeof badge === "number" ? badge : 1;
  if (!isSystem && typeof badge !== "number" && approved.recipientUid) {
    const counted = await getUnreadCount(approved.recipientUid);
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

  // Customer account send: the shared primitive persists the inbox row before
  // FCM, applies canonical device prefs and verifies token ownership.
  if (approved.kind === "customer") {
    if (!token || !approved.recipientUid) return false;
    const result = await sendMulticastFcm([token], basePayload, approved.recipientUid, {
      purpose: approved.purpose,
      actor: params.actor,
    });
    return result.successCount > 0 || result.inboxPersisted === true;
  }

  if (approved.kind === "system") {
    if (!approved.recipientUid) return false;
    const result = await sendMulticastFcm(
      token ? [token] : approved.tokens,
      { ...basePayload, data: { ...(data || {}), type: "badge_clear", badge: "0" } },
      approved.recipientUid,
      { purpose: SYSTEM_PURPOSE }
    );
    return result.successCount > 0;
  }

  // Staff operational: topic or single staff token. No inbox, no prefs.
  // Transport/timeout policy lives in fcmClient (sendFcmMessage): this module
  // never touches `messaging` directly (contract §2, enforced by
  // tests/notifications.transport-boundary.test.ts).
  if (topic) {
    return sendFcmMessage(
      { ...basePayload, topic },
      { purpose: STAFF_PURPOSE, actor: params.actor }
    );
  }
  if (token) {
    return sendFcmMessage(
      { ...basePayload, token },
      { purpose: STAFF_PURPOSE, actor: params.actor }
    );
  }
  return false;
}

/** Re-exported for sibling senders that only need the type guard. */
export { isNotificationPurpose };
