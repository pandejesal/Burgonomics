import { createHash } from "crypto";
import * as admin from "firebase-admin";
import { auth, db } from "../../core/firebase";
import { captureErrorSnapshot } from "../../core/errors";
import { writeAuditLog } from "../audit/auditLog";
import {
  BROADCAST_PURPOSES,
  CustomerPurpose,
  NotificationKind,
  NotificationPurpose,
  SYSTEM_PURPOSE,
  STAFF_PURPOSE,
  classifyPurpose,
  isCustomerPurpose,
} from "./registry";

/**
 * The single send gate (contract §2, §11).
 *
 * Every FCM primitive (`sendFcmMessage`, `sendMulticastFcm`, `dispatchFCM`)
 * resolves through here BEFORE touching the transport. The gate answers:
 *   - is `purpose` a known registry value (never inferred from data.type)?
 *   - does a customer send carry a server-resolved recipient uid?
 *   - is a staff send from a trusted actor?
 *   - is the sole bulk exception (`all_devices` broadcasts) in scope?
 *
 * A violation quarantines + audits + snapshots and throws `SendGateError`
 * before any messaging call: zero sends, never a silent fallback.
 */

export type SendGateReason =
  | "unknown_purpose"
  | "customer_recipient_missing"
  | "customer_topic_forbidden"
  | "broadcast_purpose_forbidden"
  | "untrusted_actor"
  | "system_recipient_missing"
  | "system_topic_forbidden"
  | "system_badge_nonzero"
  | "continuation_without_customer_purpose";

export class SendGateError extends Error {
  readonly code: SendGateReason;
  readonly purpose: unknown;

  constructor(code: SendGateReason, message: string, purpose?: unknown) {
    super(message);
    this.name = "SendGateError";
    this.code = code;
    this.purpose = purpose;
  }
}

export interface SendActor {
  uid?: string | null;
  role?: string | null;
  branchIds?: readonly string[] | null;
  /** Set only by trusted server/route code — never by an HTTP body. */
  trusted?: boolean;
}

/** Convenience marker for trigger/scheduler/service senders. */
export const TRUSTED_SERVER_ACTOR: Readonly<SendActor> = Object.freeze({ trusted: true });

export interface SendRequest {
  /** Required. Unknown values are quarantined; `data.type` is never consulted. */
  purpose: unknown;
  recipientUid?: unknown;
  topic?: unknown;
  token?: unknown;
  tokens?: unknown;
  /** `all_devices` is the only bulk audience and broadcast's sole exception. */
  audience?: unknown;
  actor?: SendActor | null;
  /** Audit context only. Never classifies the send. */
  payloadType?: unknown;
  source?: string;
}

export interface ApprovedSend {
  kind: NotificationKind | "broadcast";
  purpose: NotificationPurpose;
  recipientUid?: string;
  topic?: string;
  tokens: string[];
  /** True only for the `all_devices` broadcast exception. */
  broadcast: boolean;
  /** Customer account sends persist an inbox row before FCM. */
  writesInbox: boolean;
  /** Staff topics/system reads zero preference documents. */
  preferenceGated: boolean;
  /** System sends are badge-0 only. */
  badge?: number;
}

export interface QuarantineInput {
  reason: SendGateReason;
  purpose?: unknown;
  recipientUid?: unknown;
  token?: string | null;
  actorUid?: string | null;
  source?: string;
  payloadType?: unknown;
  message: string;
}

function normalizeTokens(request: SendRequest): string[] {
  const candidates: unknown[] = [];
  if (typeof request.token === "string") candidates.push(request.token);
  if (Array.isArray(request.tokens)) candidates.push(...request.tokens);
  return [
    ...new Set(
      candidates.filter((value): value is string => typeof value === "string" && value.length > 0)
    ),
  ];
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function tokenPrefix(token: string | null | undefined): string {
  if (!token) return "";
  return token.length <= 8 ? token : `${token.slice(0, 8)}...`;
}

/**
 * Deterministic id keeps a repeated bad send to ONE quarantine row (no spam,
 * no second dangling document). The key never contains a full token or copy.
 */
function quarantineId(input: QuarantineInput): string {
  const raw = [
    input.reason,
    typeof input.purpose === "string" ? input.purpose : "unknown",
    asNonEmptyString(input.recipientUid) ?? "none",
    tokenPrefix(input.token),
  ].join("|");
  return `nq_${createHash("sha256").update(raw).digest("hex").slice(0, 32)}`;
}

/** Best-effort forensic trail: quarantine row + audit + error snapshot. */
export async function quarantineSendFailure(input: QuarantineInput): Promise<string> {
  const id = quarantineId(input);
  const truncatedPurpose =
    typeof input.purpose === "string" ? input.purpose.slice(0, 64) : null;

  try {
    if (db && typeof db.collection === "function") {
      await db
        .collection("notification_quarantine")
        .doc(id)
        .set(
          {
            id,
            reason: input.reason,
            purpose: truncatedPurpose,
            recipientUid: asNonEmptyString(input.recipientUid) ?? null,
            tokenPrefix: tokenPrefix(input.token) || null,
            actorUid: input.actorUid ?? null,
            source: input.source ?? null,
            payloadType:
              typeof input.payloadType === "string" ? input.payloadType.slice(0, 64) : null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
    }
  } catch (err: any) {
    console.warn("[SendGate] quarantine write failed (non-blocking):", err?.message || err);
  }

  await writeAuditLog({
    actorUid: input.actorUid ?? null,
    action: "notification_quarantined",
    targetType: "notification",
    targetId: id,
    metadata: {
      reason: input.reason,
      purpose: truncatedPurpose,
      payloadType:
        typeof input.payloadType === "string" ? input.payloadType.slice(0, 64) : null,
    },
  });

  await captureErrorSnapshot({
    source: "notifications",
    severity: "medium",
    message: input.message,
    context: { reason: input.reason, quarantineId: id },
  });

  return id;
}

function violation(request: SendRequest): { reason: SendGateReason; message: string } | null {
  if (classifyPurpose(request.purpose) === "unknown") {
    return {
      reason: "unknown_purpose",
      message: "notification send blocked: purpose is missing or not in the registry",
    };
  }

  const purpose = request.purpose as NotificationPurpose;
  const kind = classifyPurpose(purpose);
  const broadcast = request.audience === "all_devices";
  const hasTopic = typeof request.topic === "string" && request.topic.length > 0;

  if (broadcast) {
    if (!isCustomerPurpose(purpose) || !BROADCAST_PURPOSES.has(purpose as CustomerPurpose)) {
      return {
        reason: "broadcast_purpose_forbidden",
        message: "notification send blocked: all_devices audience allows offers/announcements only",
      };
    }
    return null;
  }

  if (kind === "customer") {
    if (!asNonEmptyString(request.recipientUid)) {
      return {
        reason: "customer_recipient_missing",
        message: "notification send blocked: customer purpose without a resolved recipient uid",
      };
    }
    if (hasTopic) {
      return {
        reason: "customer_topic_forbidden",
        message: "notification send blocked: customer purpose cannot target a topic",
      };
    }
    return null;
  }

  if (kind === "staff") {
    if (request.actor?.trusted !== true) {
      return {
        reason: "untrusted_actor",
        message: "notification send blocked: staff purpose requires a trusted server/route actor",
      };
    }
    return null;
  }

  // system (badge clear)
  if (!asNonEmptyString(request.recipientUid)) {
    return {
      reason: "system_recipient_missing",
      message: "notification send blocked: system purpose requires a recipient uid",
    };
  }
  if (hasTopic) {
    return {
      reason: "system_topic_forbidden",
      message: "notification send blocked: system purpose cannot target a topic",
    };
  }
  return null;
}

/**
 * Resolves a send request. Policy violations quarantine and throw; no I/O
 * against the messaging transport is performed here.
 */
export async function resolveSend(request: SendRequest): Promise<ApprovedSend> {
  const blocked = violation(request);
  if (blocked) {
    await quarantineSendFailure({
      reason: blocked.reason,
      purpose: request.purpose,
      recipientUid: request.recipientUid,
      token: typeof request.token === "string" ? request.token : null,
      actorUid: request.actor?.uid ?? null,
      source: request.source,
      payloadType: request.payloadType,
      message: blocked.message,
    });
    throw new SendGateError(blocked.reason, blocked.message, request.purpose);
  }

  const purpose = request.purpose as NotificationPurpose;
  const kind = classifyPurpose(purpose);
  const broadcast = request.audience === "all_devices";
  const tokens = normalizeTokens(request);
  const recipientUid = asNonEmptyString(request.recipientUid);
  const topic = asNonEmptyString(request.topic);

  if (broadcast) {
    return {
      kind: "broadcast",
      purpose,
      tokens,
      broadcast: true,
      writesInbox: false,
      preferenceGated: true,
    };
  }
  if (kind === "customer") {
    return {
      kind: "customer",
      purpose,
      recipientUid,
      tokens,
      broadcast: false,
      writesInbox: true,
      preferenceGated: true,
    };
  }
  if (kind === "staff") {
    return {
      kind: "staff",
      purpose: STAFF_PURPOSE,
      recipientUid,
      topic,
      tokens,
      broadcast: false,
      writesInbox: false,
      preferenceGated: false,
    };
  }
  return {
    kind: "system",
    purpose: SYSTEM_PURPOSE,
    recipientUid,
    tokens,
    broadcast: false,
    writesInbox: false,
    preferenceGated: false,
    badge: 0,
  };
}

/**
 * Shared badge-0 assertion for the system purpose. A badge clear must never
 * increment: reject anything that is not exactly zero before FCM.
 */
export function assertSystemBadgeZero(data: Record<string, unknown> | undefined): void {
  const raw = data?.badge;
  const numeric = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(numeric) || numeric !== 0) {
    throw new SendGateError(
      "system_badge_nonzero",
      "notification send blocked: system purpose may only carry badge 0"
    );
  }
}

export interface ResolvedDispatchTarget {
  ownerUid: string;
  role?: string;
  branchIds: string[];
}

/**
 * Route-side resolution for §3: device_tokens/{token} -> ownerUid (+ the
 * owner's current role/branch claims from users/{uid}). Returns null for an
 * unknown token; a token with no usable owner is reported as ambiguous so the
 * caller can answer one generic 403.
 */
export async function resolveDispatchTarget(
  token: string
): Promise<ResolvedDispatchTarget | null> {
  if (!token || !db || typeof db.collection !== "function") return null;
  let tokenData: Record<string, unknown> = {};
  try {
    const tokenSnap = await db.collection("device_tokens").doc(token).get();
    if (!tokenSnap?.exists) return null;
    tokenData = (tokenSnap.data() ?? {}) as Record<string, unknown>;
  } catch {
    return null;
  }

  const ownerUid = tokenData.userId;
  if (typeof ownerUid !== "string" || !ownerUid) return null;

  let role: string | undefined =
    typeof tokenData.role === "string" ? tokenData.role : undefined;
  let branchIds: string[] = Array.isArray(tokenData.branchIds)
    ? (tokenData.branchIds as unknown[]).filter((b): b is string => typeof b === "string")
    : [];

  try {
    const userSnap = await db.collection("users").doc(ownerUid).get();
    if (userSnap?.exists) {
      const userData = (userSnap.data() ?? {}) as Record<string, unknown>;
      if (typeof userData.role === "string") role = userData.role;
      if (Array.isArray(userData.branchIds)) {
        branchIds = userData.branchIds.filter((b): b is string => typeof b === "string");
      }
    }
    // requireRole's documented fallback: an unrefreshed claim may still have
    // its admin role recorded in admins/{uid}.
    if (!role) {
      const adminSnap = await db.collection("admins").doc(ownerUid).get();
      if (adminSnap?.exists) {
        const adminRole = (adminSnap.data() ?? {})?.role;
        if (typeof adminRole === "string") role = adminRole;
      }
    }
    // Canonical role source: custom claims. Only reached when Firestore has no
    // role, so the common path costs no Auth round-trip.
    if (!role && auth && typeof auth.getUser === "function") {
      const record = await auth.getUser(ownerUid);
      const claimRole = record?.customClaims?.role;
      if (typeof claimRole === "string") role = claimRole;
      const claimBranches = record?.customClaims?.branchIds;
      if (branchIds.length === 0 && Array.isArray(claimBranches)) {
        branchIds = claimBranches.filter((b: unknown): b is string => typeof b === "string");
      }
    }
  } catch {
    // Fail closed for staff dispatch: an unreadable role stays customer-class.
  }

  return { ownerUid, role, branchIds };
}

/** Audit row for an admin customer-token dispatch (never the full token/copy). */
export async function auditAdminDispatch(params: {
  actorUid: string;
  purpose: NotificationPurpose;
  recipientUid: string;
  token: string;
}): Promise<void> {
  await writeAuditLog({
    actorUid: params.actorUid,
    action: "notification_admin_sends",
    targetType: "customer_device",
    targetId: params.recipientUid,
    metadata: {
      purpose: params.purpose,
      targetClass: "customer",
      tokenPrefix: tokenPrefix(params.token),
    },
  });
}
