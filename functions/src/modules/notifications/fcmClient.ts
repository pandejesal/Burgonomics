import * as admin from "firebase-admin";
import { db, messaging } from "../../core/firebase";
import { config } from "../../config/env";

export interface SendMulticastResult {
  successCount: number;
  failureCount: number;
  prunedTokens: string[];
}

/**
 * Sends a single FCM message via HTTP v1 API.
 */
export async function sendFcmMessage(message: admin.messaging.Message): Promise<boolean> {
  if (process.env.NODE_ENV === "test" || process.env.VITEST || config.mock.porterDispatch) {
    return true;
  }

  try {
    if (messaging && typeof messaging.send === "function") {
      await messaging.send(message);
      return true;
    }
    return true;
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

  if (process.env.NODE_ENV === "test" || process.env.VITEST || config.mock.porterDispatch) {
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
        const response = await messaging.sendEachForMulticast({
          ...payload,
          tokens: chunk,
        });
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

    return {
      successCount: tokens.length,
      failureCount: 0,
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
 * Best-effort customer push by users/{uid} fcmTokens. Non-blocking by design:
 * notification loss must never fail the calling flow (payment/refund/ticket).
 */
export async function pushToCustomer(
  customerId: string | undefined,
  title: string,
  body: string,
  data: Record<string, string>
): Promise<void> {
  try {
    if (!customerId || !db || typeof db.collection !== "function") return;
    const userDoc = await db.collection("users").doc(customerId).get();
    const fcmTokens: string[] = userDoc.data()?.fcmTokens || [];
    if (fcmTokens.length === 0) return;
    await sendMulticastFcm(
      fcmTokens,
      {
        notification: { title, body },
        data,
        android: {
          priority: "high",
          notification: { sound: "default", channelId: "burgonomics_updates_channel" },
        },
      },
      customerId
    );
  } catch (err: any) {
    console.warn("[FCM] Customer push failed (non-blocking):", err?.message || err);
  }
}
