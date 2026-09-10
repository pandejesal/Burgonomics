import * as admin from "firebase-admin";
import { db, messaging } from "../../core/firebase";
import { config } from "../../config/env";
import { truncatePushText, buildParityExtras } from "./templates";

export interface SendMulticastResult {
  successCount: number;
  failureCount: number;
  prunedTokens: string[];
}

/** B5-S1 (M21 server half): FCM fan-outs are time-bounded — a hung socket
 * must never stall the calling ticket/order flow. */
export const FCM_SEND_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, ms = FCM_SEND_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`FCM send timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * B5-S1 (H18): unread inbox count at send time. Reads the server-owned
 * users/{uid}/notifications collection (client writes are read-receipts
 * only per firestore.rules) and caps at 99 for the APNs badge.
 */
export async function getUnreadCount(customerId: string | undefined): Promise<number> {
  try {
    if (!customerId || !db || typeof db.collection !== "function") return 0;
    const snap = await db
      .collection("users")
      .doc(customerId)
      .collection("notifications")
      .where("read", "==", false)
      .limit(500)
      .get();
    const size = typeof snap?.size === "number" ? snap.size : snap?.docs?.length || 0;
    return Math.min(Math.max(size, 0), 99);
  } catch {
    return 0;
  }
}

/**
 * Sends a single FCM message via HTTP v1 API.
 */
export async function sendFcmMessage(message: admin.messaging.Message): Promise<boolean> {
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return true;
  }

  try {
    if (messaging && typeof messaging.send === "function") {
      await withTimeout(messaging.send(message));
      return true;
    }
    // Loop 5: no transport = not sent. The old `return true` here claimed
    // delivery while sending nothing (fake success on notify paths).
    return false;
  } catch (error: any) {
    console.warn("[FCM] Error sending message (non-blocking fallback):", error?.message || error);
    return false;
  }
}

/**
 * Sends a multicast FCM message to a list of device tokens, and automatically
 * prunes unregistered or invalid tokens from the user's document in Firestore.
 */
export async function sendMulticastFcm(
  tokens: string[],
  payload: Omit<admin.messaging.MulticastMessage, "tokens">,
  userId?: string
): Promise<SendMulticastResult> {
  if (!tokens || tokens.length === 0) {
    return { successCount: 0, failureCount: 0, prunedTokens: [] };
  }

  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return {
      successCount: tokens.length,
      failureCount: 0,
      prunedTokens: [],
    };
  }

  const prunedTokens: string[] = [];
  let successCount = 0;
  let failureCount = 0;

  // FCM caps multicast at 500 tokens per call — chunk, or large fan-outs
  // throw and NOBODY gets the push.
  const CHUNK_SIZE = 500;
  const chunks: string[][] = [];
  for (let i = 0; i < tokens.length; i += CHUNK_SIZE) {
    chunks.push(tokens.slice(i, i + CHUNK_SIZE));
  }

  try {
    if (messaging && typeof messaging.sendEachForMulticast === "function") {
      for (const chunk of chunks) {
        const response: any = await withTimeout(
          messaging.sendEachForMulticast({
            ...payload,
            tokens: chunk,
          })
        );
        successCount += response.successCount;
        failureCount += response.failureCount;

        response.responses.forEach((resp: any, idx: number) => {
          if (!resp.success && resp.error) {
            const errorCode = resp.error.code;
            if (
              errorCode === "messaging/registration-token-not-registered" ||
              errorCode === "messaging/invalid-registration-token" ||
              errorCode === "messaging/invalid-argument"
            ) {
              prunedTokens.push(chunk[idx]);
            }
          }
        });
      }

      // Automatically prune invalid tokens from Firestore
      if (prunedTokens.length > 0 && userId) {
        try {
          await db.collection("users").doc(userId).update({
            fcmTokens: admin.firestore.FieldValue.arrayRemove(...prunedTokens),
          });
          console.log(`[FCM Prune] Removed ${prunedTokens.length} dead token(s)`);
        } catch (pruneErr) {
          console.warn("[FCM Prune] Failed to remove tokens from user:", pruneErr);
        }
      }

      return { successCount, failureCount, prunedTokens };
    }

    // Loop 5: no transport = nothing delivered. Report all-failed so callers
    // (dashboards, retry logic) never celebrate an unsent fan-out.
    return {
      successCount: 0,
      failureCount: tokens.length,
      prunedTokens: [],
    };
  } catch (error: any) {
    console.warn("[FCM Multicast] Error sending multicast message:", error?.message || error);
    return {
      successCount: 0,
      failureCount: tokens.length,
      prunedTokens: [],
    };
  }
}

/**
 * Best-effort inbox fallback: persists a notification doc so push-or-nothing
 * paths (Loop 5) still reach the customer in the in-app tray when FCM
 * delivers zero. Never throws into callers.
 */
export async function writeCustomerInboxDoc(
  customerId: string | undefined,
  title: string,
  body: string,
  data: Record<string, string> = {}
): Promise<boolean> {
  try {
    if (!customerId || !db || typeof db.collection !== "function") return false;
    const notifId = `notif_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    await db
      .collection("users")
      .doc(customerId)
      .collection("notifications")
      .doc(notifId)
      .set({
        id: notifId,
        title,
        message: truncatePushText(body),
        type: data?.type || "system",
        targetId: data?.targetId || null,
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    return true;
  } catch (err: any) {
    console.warn("[FCM] Inbox fallback write failed (non-blocking):", err?.message || err);
    return false;
  }
}

/**
 * Best-effort customer push by users/{uid} fcmTokens. Non-blocking by design:
 * notification loss must never fail the calling flow (payment/refund/ticket).
 *
 * B5-S1: bodies are server-truncated (~120ch), badge = unread count at send
 * (H18), and every push carries shared apns+webpush parity (H34) so iOS/web
 * render the same copy as Android. Callers pass display copy only — free-text
 * subject/names/phones must never reach `body` (H17).
 *
 * Loop 5: when multicast delivers zero, the message is persisted to the
 * recipient inbox (same fallback contract as dispatchFCM) instead of
 * vanishing silently.
 */
export async function pushToCustomer(
  customerId: string | undefined,
  title: string,
  body: string,
  data: Record<string, string>,
  opts: { badge?: number } = {}
): Promise<void> {
  try {
    if (!customerId || !db || typeof db.collection !== "function") return;
    const safeBody = truncatePushText(body);
    const badge = typeof opts.badge === "number" ? opts.badge : await getUnreadCount(customerId);
    const userDoc = await db.collection("users").doc(customerId).get();
    const fcmTokens: string[] = userDoc.data()?.fcmTokens || [];
    if (fcmTokens.length === 0) {
      // No push target at all — inbox is the only channel.
      await writeCustomerInboxDoc(customerId, title, body, data);
      return;
    }
    const result = await sendMulticastFcm(
      fcmTokens,
      {
        notification: { title, body: safeBody },
        data,
        android: {
          priority: "high",
          notification: { sound: "default", channelId: "burgonomics_updates_channel" },
        },
        ...buildParityExtras(title, safeBody, { badge }),
      },
      customerId
    );
    if (result.successCount === 0) {
      await writeCustomerInboxDoc(customerId, title, body, data);
    }
  } catch (err: any) {
    console.warn("[FCM] Customer push failed (non-blocking):", err?.message || err);
  }
}
