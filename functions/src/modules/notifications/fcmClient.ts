import * as admin from "firebase-admin";
import { randomUUID } from "crypto";
import { db, messaging } from "../../core/firebase";
import { truncatePushText, buildParityExtras } from "./templates";
import {
  ApprovedSend,
  SendActor,
  assertSystemBadgeZero,
  resolveSend,
} from "./sendGate";
import {
  CATEGORY_BY_CUSTOMER_PURPOSE,
  CustomerPurpose,
  NotificationPurpose,
  isNotificationPurpose,
} from "./registry";
import {
  PrefDevice,
  filterTokensByPrefs,
  loadCanonicalPrefs,
} from "./devicePrefs";

export interface SendMulticastResult {
  successCount: number;
  failureCount: number;
  prunedTokens: string[];
  /** Provider acknowledgements only — never a "delivered" claim. */
  providerAccepted?: number;
  providerFailed?: number;
  suppressedCount?: number;
  suppressedAll?: boolean;
  legacyUnresolved?: number;
  /** Inbox row written before FCM (customer account sends). */
  inboxRef?: string | null;
  inboxPersisted?: boolean;
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

export interface FcmSendOptions {
  /** Registry purpose — supplied by trusted server state, never data.type. */
  purpose: NotificationPurpose;
  actor?: SendActor | null;
  critical?: boolean;
}

/**
 * Sends a single FCM message via HTTP v1 API.
 * Every call resolves through the send gate first: an unknown purpose or an
 * untrusted staff send is quarantined with ZERO transport calls.
 * Fail-closed for critical notifications: throws on failure so callers
 * can handle retry/alerting. Non-critical callers should wrap in try/catch.
 */
export async function sendFcmMessage(
  message: admin.messaging.Message,
  opts: FcmSendOptions
): Promise<boolean> {
  const approved = await resolveSend({
    purpose: opts.purpose,
    topic: (message as { topic?: string }).topic,
    token: (message as { token?: string }).token,
    actor: opts.actor,
    payloadType: (message.data as Record<string, unknown> | undefined)?.type,
    source: "sendFcmMessage",
  });
  if (approved.kind !== "staff") {
    throw new Error("sendFcmMessage only carries staff operational messages");
  }

  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return true;
  }

  try {
    if (messaging && typeof messaging.send === "function") {
      await withTimeout(messaging.send(message));
      return true;
    }
    // No transport available
    if (opts.critical) {
      throw new Error("FCM transport unavailable — critical notification cannot be sent");
    }
    return false;
  } catch (error: any) {
    if (opts.critical) {
      throw error;
    }
    console.warn("[FCM] Error sending message (non-blocking fallback):", error?.message || error);
    return false;
  }
}

/**
 * Ownership + installation resolution for recipient-bound sends. Profile
 * arrays are a fan-out index, not proof that a token still belongs to a UID;
 * the ledger is authoritative and an unreadable ledger withholds everything.
 */
async function ownedDestinations(
  tokens: string[],
  recipientUid: string
): Promise<{ owned: PrefDevice[]; failed: boolean }> {
  if (!recipientUid) return { owned: [], failed: false };
  try {
    const refs = tokens.map((token) => db.collection("device_tokens").doc(token));
    const snapshots = await withTimeout(db.getAll(...refs));
    const owned: PrefDevice[] = [];
    snapshots.forEach((snapshot: any, index: number) => {
      if (!snapshot?.exists) return;
      const data = snapshot.data?.() ?? {};
      if (data.userId !== recipientUid) return;
      owned.push({
        token: tokens[index],
        installationId:
          typeof data.installationId === "string" ? data.installationId : undefined,
      });
    });
    return { owned, failed: false };
  } catch {
    // No token, UID, or raw Firestore error in logs. Unverified destinations are
    // withheld; this is not permission to prune a newly rebound user's token.
    console.warn("[FCM] Recipient token ownership lookup failed; destinations withheld");
    return { owned: [], failed: true };
  }
}

interface InboxPersistence {
  ref: string;
  persisted: boolean;
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

/**
 * The inbox document id doubles as the push `ref`. It is generated ONCE per
 * account send and written BEFORE any FCM call; failure/suppression later
 * updates the same document (never a second dangling row).
 */
async function persistInboxDoc(params: {
  recipientUid: string | undefined;
  title: string;
  body: string;
  purpose: NotificationPurpose;
  data: Record<string, unknown>;
}): Promise<InboxPersistence> {
  const ref = randomUUID();
  const uid = params.recipientUid;
  if (!uid || !db || typeof db.collection !== "function") {
    return { ref, persisted: false };
  }

  const data = params.data;
  const targetId =
    typeof data.targetId === "string" && data.targetId
      ? data.targetId
      : typeof data.ticketId === "string" && data.ticketId
        ? data.ticketId
        : typeof data.orderId === "string" && data.orderId
          ? data.orderId
          : null;
  // `type` stays a compatibility alias for older clients; `purpose` is the
  // classification authority.
  const type = typeof data.type === "string" && data.type ? data.type : params.purpose;

  try {
    await db
      .collection("users")
      .doc(uid)
      .collection("notifications")
      .doc(ref)
      .set({
        id: ref,
        title: params.title,
        message: truncatePushText(params.body),
        purpose: params.purpose,
        targetId,
        type,
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    return { ref, persisted: true };
  } catch (err: any) {
    console.warn("[FCM] Inbox persistence failed (non-blocking):", err?.message || err);
    return { ref, persisted: false };
  }
}

async function updateInboxDelivery(
  inbox: { ref: string; uid?: string } | null | undefined,
  delivery: string
): Promise<void> {
  if (!inbox?.ref || !inbox.uid || !db || typeof db.collection !== "function") return;
  try {
    await db
      .collection("users")
      .doc(inbox.uid)
      .collection("notifications")
      .doc(inbox.ref)
      .update({
        delivery,
        deliveryUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
  } catch (err: any) {
    console.warn("[FCM] Inbox delivery update failed (non-blocking):", err?.message || err);
  }
}

export interface MulticastSendOptions {
  /** Registry purpose — required on every send primitive. */
  purpose: NotificationPurpose;
  actor?: SendActor | null;
  critical?: boolean;
  /** The sole bulk exception: offers/announcements to every registered device. */
  audience?: "all_devices";
}

function emptyResult(): SendMulticastResult {
  return { successCount: 0, failureCount: 0, prunedTokens: [] };
}

/**
 * Sends a multicast FCM message to a list of device tokens, and automatically
 * prunes unregistered or invalid tokens from the user's document in Firestore.
 *
 * Contract §11: for a customer account send this function persists
 * `users/{uid}/notifications/{ref}` BEFORE the transport call, injects only
 * `{purpose, category, recipientUid, ref}` into the wire data, and applies
 * canonical device prefs (`users/{uid}/device_prefs`) at send time. Withheld
 * (foreign) and suppressed tokens are measured, never retried with stale state.
 * Topic/staff sends read zero preference documents.
 */
export async function sendMulticastFcm(
  tokens: string[],
  payload: Omit<admin.messaging.MulticastMessage, "tokens">,
  userId?: string,
  opts: MulticastSendOptions = { purpose: "operational" }
): Promise<SendMulticastResult> {
  const payloadData = asRecord(payload.data);
  const approved: ApprovedSend = await resolveSend({
    purpose: opts.purpose,
    recipientUid: userId,
    tokens,
    audience: opts.audience,
    actor: opts.actor,
    payloadType: payloadData.type,
    source: "sendMulticastFcm",
  });

  if (approved.kind === "system") {
    assertSystemBadgeZero(payloadData);
  }

  const candidateTokens = [...new Set(tokens.filter((t) => typeof t === "string" && t))];

  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return {
      successCount: candidateTokens.length,
      failureCount: 0,
      prunedTokens: [],
      providerAccepted: candidateTokens.length,
      providerFailed: 0,
    };
  }
  if (candidateTokens.length === 0 && approved.kind !== "customer") {
    return emptyResult();
  }

  // Every account send gets its inbox row before FCM — including an empty
  // destination list (inbox is then the only channel).
  const notification = asRecord(payload.notification);
  const inbox =
    approved.kind === "customer"
      ? await persistInboxDoc({
          recipientUid: approved.recipientUid,
          title: typeof notification.title === "string" ? notification.title : "",
          body: typeof notification.body === "string" ? notification.body : "",
          purpose: approved.purpose,
          data: payloadData,
        })
      : null;

  if (inbox && !inbox.persisted) {
    // The ref must exist before the push: a write failure withholds the send
    // (no dangling ref, no unopenable notification).
    if (opts.critical) {
      throw new Error("notification inbox write failed — push withheld");
    }
    return {
      successCount: 0,
      failureCount: candidateTokens.length,
      prunedTokens: [],
      providerAccepted: 0,
      providerFailed: 0,
      inboxRef: inbox.ref,
      inboxPersisted: false,
    };
  }

  const result: SendMulticastResult = {
    successCount: 0,
    failureCount: 0,
    prunedTokens: [],
    providerAccepted: 0,
    providerFailed: 0,
    suppressedCount: 0,
    suppressedAll: false,
    legacyUnresolved: 0,
    inboxRef: inbox?.ref ?? null,
    inboxPersisted: inbox?.persisted ?? false,
  };
  let transportFailures = 0;

  if (candidateTokens.length === 0) {
    await updateInboxDelivery(inbox ? { ref: inbox.ref, uid: approved.recipientUid } : null, "no_devices");
    return result;
  }

  const requiresOwnership = approved.kind === "customer" || approved.kind === "system";
  const canonicalSnapshot =
    approved.preferenceGated && approved.kind === "customer" && approved.recipientUid
      ? await loadCanonicalPrefs(approved.recipientUid)
      : null;
  const accountData: Record<string, string> =
    approved.kind === "customer" && approved.recipientUid && inbox
      ? {
          purpose: approved.purpose,
          category:
            CATEGORY_BY_CUSTOMER_PURPOSE[approved.purpose as CustomerPurpose] ?? "general",
          recipientUid: approved.recipientUid,
          ref: inbox.ref,
        }
      : payloadData;

  // FCM caps multicast at 500 tokens per call — chunk, or large fan-outs
  // throw and NOBODY gets the push.
  const CHUNK_SIZE = 500;
  const chunks: string[][] = [];
  for (let i = 0; i < candidateTokens.length; i += CHUNK_SIZE) {
    chunks.push(candidateTokens.slice(i, i + CHUNK_SIZE));
  }

  try {
    if (messaging && typeof messaging.sendEachForMulticast === "function") {
      for (const chunk of chunks) {
        const ownership = requiresOwnership
          ? await ownedDestinations(chunk, approved.recipientUid as string)
          : { owned: chunk.map((token) => ({ token })), failed: false };

        let destinations = ownership.owned;
        let suppressedInChunk = 0;
        if (canonicalSnapshot && approved.kind === "customer") {
          const suppression = filterTokensByPrefs(
            approved.purpose,
            destinations,
            canonicalSnapshot
          );
          suppressedInChunk = suppression.suppressed.length;
          result.suppressedCount = (result.suppressedCount ?? 0) + suppressedInChunk;
          result.legacyUnresolved =
            (result.legacyUnresolved ?? 0) + suppression.legacyUnresolved;
          const eligible = new Set(suppression.eligible);
          destinations = destinations.filter((device) => eligible.has(device.token));
        }

        const withheld = chunk.length - ownership.owned.length;
        result.failureCount += withheld + suppressedInChunk;
        if (destinations.length === 0) continue;

        const response: any = await withTimeout(
          messaging.sendEachForMulticast(
            approved.kind === "customer"
              ? {
                  ...payload,
                  data: accountData,
                  tokens: destinations.map((device) => device.token),
                }
              : {
                  ...payload,
                  ...(payload.data !== undefined ? { data: payload.data } : {}),
                  tokens: destinations.map((device) => device.token),
                }
          )
        );
        result.successCount += response.successCount;
        result.failureCount += response.failureCount;
        transportFailures += response.failureCount;

        response.responses.forEach((resp: any, idx: number) => {
          if (!resp.success && resp.error) {
            const errorCode = resp.error.code;
            if (
              errorCode === "messaging/registration-token-not-registered" ||
              errorCode === "messaging/invalid-registration-token" ||
              errorCode === "messaging/invalid-argument"
            ) {
              result.prunedTokens.push(destinations[idx].token);
            }
          }
        });
      }

      result.providerAccepted = result.successCount;
      result.providerFailed = transportFailures;
      result.suppressedAll =
        approved.kind === "customer" &&
        candidateTokens.length > 0 &&
        (result.suppressedCount ?? 0) === candidateTokens.length;

      // Automatically prune invalid tokens from Firestore
      if (result.prunedTokens.length > 0 && approved.recipientUid) {
        try {
          await db.collection("users").doc(approved.recipientUid).update({
            fcmTokens: admin.firestore.FieldValue.arrayRemove(...result.prunedTokens),
          });
          console.log(`[FCM Prune] Removed ${result.prunedTokens.length} dead token(s)`);
        } catch (pruneErr) {
          console.warn("[FCM Prune] Failed to remove tokens from user:", pruneErr);
        }
      }

      if (inbox?.persisted) {
        await updateInboxDelivery(
          { ref: inbox.ref, uid: approved.recipientUid },
          result.successCount > 0 ? "sent" : result.suppressedAll ? "suppressed" : "failed"
        );
      }

      // A fully suppressed account send is an expected outcome (the customer
      // turned the category off) — no throw, inbox already persisted.
      if (result.successCount === 0 && opts.critical && !result.suppressedAll) {
        throw new Error("FCM multicast delivered zero messages — critical notification failed");
      }

      return result;
    }

    // No transport available
    if (opts.critical) {
      throw new Error("FCM transport unavailable — critical notification cannot be sent");
    }

    // Loop 5: no transport = nothing delivered. Report all-failed so callers
    // (dashboards, retry logic) never celebrate an unsent fan-out.
    result.failureCount = candidateTokens.length;
    result.providerFailed = 0;
    if (inbox?.persisted) {
      await updateInboxDelivery({ ref: inbox.ref, uid: approved.recipientUid }, "failed");
    }
    return result;
  } catch (error: any) {
    if (opts.critical) {
      throw error;
    }
    console.warn("[FCM Multicast] Error sending multicast message:", error?.message || error);
    result.successCount = 0;
    result.failureCount = candidateTokens.length;
    result.providerAccepted = 0;
    result.providerFailed = 0;
    if (inbox?.persisted) {
      await updateInboxDelivery({ ref: inbox.ref, uid: approved.recipientUid }, "failed");
    }
    return result;
  }
}

/**
 * Legacy inbox writer kept as a compatibility alias. New account sends route
 * through `sendMulticastFcm`/`dispatchFCM`, which persist before FCM. This maps
 * sender-supplied `data.ticketId`/`data.orderId` to `targetId` and keeps
 * `data.type` as the inbox type alias.
 */
export async function writeCustomerInboxDoc(
  customerId: string | undefined,
  title: string,
  body: string,
  data: Record<string, string> = {}
): Promise<boolean> {
  const purpose: NotificationPurpose = isNotificationPurpose(data.purpose)
    ? data.purpose
    : "orderUpdates";
  const inbox = await persistInboxDoc({
    recipientUid: customerId,
    title,
    body,
    purpose,
    data,
  });
  return inbox.persisted;
}

export interface CustomerPushOptions {
  /**
   * Required at runtime. Kept optional in the type so sibling writers can
   * migrate their call sites independently; an absent value is quarantined by
   * the gate (zero sends), never defaulted.
   */
  purpose?: NotificationPurpose;
  actor?: SendActor | null;
  badge?: number;
  critical?: boolean;
}

/**
 * Customer push by users/{uid} fcmTokens.
 *
 * Gate -> inbox ref (before FCM) -> ledger ownership -> canonical prefs ->
 * chunked send. Critical sends still fail closed on a zero-delivery outcome,
 * except when the customer explicitly suppressed the category.
 */
export async function pushToCustomer(
  customerId: string | undefined,
  title: string,
  body: string,
  data: Record<string, string>,
  opts: CustomerPushOptions = {}
): Promise<void> {
  try {
    // Gate even when the uid is missing: a customer purpose with no resolved
    // recipient quarantines with zero transport calls, never a silent no-op.
    const approved = await resolveSend({
      purpose: opts.purpose,
      recipientUid: customerId,
      actor: opts.actor,
      payloadType: data?.type,
      source: "pushToCustomer",
    });
    if (approved.kind !== "customer") {
      throw new Error("pushToCustomer only carries customer account purposes");
    }
    if (!customerId || !db || typeof db.collection !== "function") {
      if (opts.critical) throw new Error("FCM unavailable — critical notification cannot be sent");
      return;
    }
    const safeBody = truncatePushText(body);
    const badge = typeof opts.badge === "number" ? opts.badge : await getUnreadCount(customerId);
    const userDoc = await db.collection("users").doc(customerId).get();
    const fcmTokens: string[] = userDoc.data()?.fcmTokens || [];
    await sendMulticastFcm(
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
      customerId,
      { purpose: approved.purpose, actor: opts.actor, critical: opts.critical }
    );
  } catch (err: any) {
    if (opts.critical) {
      throw err;
    }
    console.warn("[FCM] Customer push failed (non-blocking):", err?.message || err);
  }
}
