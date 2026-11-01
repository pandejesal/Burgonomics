import { z } from "zod";

/**
 * Notification purpose registry (contract §2, §3, §9).
 *
 * `purpose` is the single classification authority for a send. It is supplied
 * by trusted server state (trigger/service/route), never inferred from a
 * client-controlled `data.type` — the gate treats `payloadType` as audit
 * context only.
 *
 * Two additional registries live here because they are the same vocabulary:
 * - category mapping for the client inbox/push payload;
 * - dispatch authorization (route-resolved staff actor vs recipient token).
 */

export const CUSTOMER_PURPOSES = [
  "orderUpdates",
  "supportReplies",
  "offers",
  "announcements",
] as const;

export const STAFF_PURPOSE = "operational" as const;
export const SYSTEM_PURPOSE = "system" as const;

export const NOTIFICATION_PURPOSES = [
  ...CUSTOMER_PURPOSES,
  STAFF_PURPOSE,
  SYSTEM_PURPOSE,
] as const;

export type CustomerPurpose = (typeof CUSTOMER_PURPOSES)[number];
export type StaffPurpose = typeof STAFF_PURPOSE;
export type SystemPurpose = typeof SYSTEM_PURPOSE;
export type NotificationPurpose = (typeof NOTIFICATION_PURPOSES)[number];
export type NotificationKind = "customer" | "staff" | "system";

/** Strict wire enum — unknown purposes are a validation failure, never a send. */
export const notificationPurposeSchema = z.enum(NOTIFICATION_PURPOSES);

const CUSTOMER_PURPOSE_SET: ReadonlySet<string> = new Set(CUSTOMER_PURPOSES);

export function isNotificationPurpose(value: unknown): value is NotificationPurpose {
  return (
    typeof value === "string" &&
    (NOTIFICATION_PURPOSES as readonly string[]).includes(value)
  );
}

export function isCustomerPurpose(value: unknown): value is CustomerPurpose {
  return typeof value === "string" && CUSTOMER_PURPOSE_SET.has(value);
}

export function classifyPurpose(purpose: unknown): NotificationKind | "unknown" {
  if (!isNotificationPurpose(purpose)) return "unknown";
  if (purpose === STAFF_PURPOSE) return "staff";
  if (purpose === SYSTEM_PURPOSE) return "system";
  return "customer";
}

/**
 * Client-facing category (C-02 maps these to bell icons). Kept separate from
 * the preference keys below: the wire category is display vocabulary, the
 * preference key is the stored toggle.
 */
export const CATEGORY_BY_CUSTOMER_PURPOSE: Record<CustomerPurpose, string> = {
  offers: "offer",
  orderUpdates: "order",
  announcements: "general",
  supportReplies: "support",
};

export type PrefCategory = "offers" | "orderUpdates" | "announcements" | "supportReplies";

export const PREF_CATEGORY_BY_PURPOSE: Record<CustomerPurpose, PrefCategory> = {
  offers: "offers",
  orderUpdates: "orderUpdates",
  announcements: "announcements",
  supportReplies: "supportReplies",
};

/** Purposes an admin may address to a customer token via /notifications/dispatch (§3.2). */
export const ADMIN_CUSTOMER_DISPATCH_PURPOSES: ReadonlySet<CustomerPurpose> = new Set([
  "orderUpdates",
  "supportReplies",
]);

/** Purposes the sole bulk exception may target (`all_devices`, §2). */
export const BROADCAST_PURPOSES: ReadonlySet<CustomerPurpose> = new Set([
  "offers",
  "announcements",
]);

/**
 * Staff role vocabulary. Dispatch scope is the ticket RBAC fact from
 * tickets.service.ts:36-40 — `support` is brand-global for STAFF tokens.
 * Customer accounts carry no staff role (undefined or "customer").
 */
export const DISPATCH_STAFF_ROLES: ReadonlySet<string> = new Set([
  "brand_owner",
  "developer",
  "support",
  "regional_manager",
  "branch_owner",
  "branch_staff",
]);

export const GLOBAL_DISPATCH_ROLES: ReadonlySet<string> = new Set([
  "brand_owner",
  "developer",
  "support",
]);

export interface DispatchCaller {
  uid?: string | null;
  role?: string | null;
  branchIds?: readonly string[] | null;
  isBrandAdmin?: boolean;
}

export interface DispatchTokenOwner {
  uid?: unknown;
  role?: unknown;
  branchIds?: unknown;
}

export type DispatchDenyReason =
  | "caller_unauthenticated"
  | "unknown_device"
  | "ambiguous_device_owner"
  | "role_not_permitted"
  | "purpose_not_permitted"
  | "customer_token_forbidden"
  | "staff_token_required"
  | "staff_outside_branch";

export interface DispatchAuthorization {
  allowed: boolean;
  reason?: DispatchDenyReason;
  purpose: NotificationPurpose;
  targetClass: "staff" | "customer";
  ownerUid?: string;
  /** Only customer-token admin sends require the `notification_admin_sends` row. */
  auditRequired: boolean;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && !!v) : [];
}

function effectiveCallerRole(caller: DispatchCaller): string | undefined {
  if (caller.role) return caller.role;
  return caller.isBrandAdmin === true ? "brand_owner" : undefined;
}

/**
 * Pure dispatch authorization (§3). No I/O: the route resolves the token owner
 * and passes it in, so the decision matrix is unit-testable without Firestore.
 *
 * Deny bodies are intentionally identical at the route layer (no existence
 * oracle); this function returns the internal reason for logs/tests only.
 */
export function authorizeDispatch(params: {
  caller: DispatchCaller | null | undefined;
  tokenOwner: DispatchTokenOwner | null | undefined;
  requestedPurpose?: unknown;
}): DispatchAuthorization {
  const caller = params.caller;
  const defaultDeny = (reason: DispatchDenyReason, targetClass: "staff" | "customer"): DispatchAuthorization => ({
    allowed: false,
    reason,
    purpose: "operational",
    targetClass,
    auditRequired: false,
  });

  if (!caller || typeof caller.uid !== "string" || !caller.uid) {
    return defaultDeny("caller_unauthenticated", "customer");
  }
  if (!params.tokenOwner) {
    return defaultDeny("unknown_device", "customer");
  }

  const ownerUid = params.tokenOwner.uid;
  if (typeof ownerUid !== "string" || !ownerUid) {
    return defaultDeny("ambiguous_device_owner", "customer");
  }

  const ownerRole =
    typeof params.tokenOwner.role === "string" ? params.tokenOwner.role : undefined;
  const targetClass: "staff" | "customer" =
    ownerRole && DISPATCH_STAFF_ROLES.has(ownerRole) ? "staff" : "customer";
  const ownerBranchIds = asStringArray(params.tokenOwner.branchIds);
  const callerRole = effectiveCallerRole(caller);

  // Unknown/previleged body purposes never widen scope.
  if (params.requestedPurpose !== undefined && !isNotificationPurpose(params.requestedPurpose)) {
    return defaultDeny("purpose_not_permitted", targetClass);
  }
  const requested = params.requestedPurpose as NotificationPurpose | undefined;

  if (targetClass === "customer") {
    // Only brand-wide admins may send to a customer token, and only for the
    // two account purposes (§3.2). support/branch roles always 403 (§3.3/3.4).
    if (callerRole !== "brand_owner" && callerRole !== "developer") {
      return defaultDeny("customer_token_forbidden", targetClass);
    }
    if (requested === undefined || !ADMIN_CUSTOMER_DISPATCH_PURPOSES.has(requested as CustomerPurpose)) {
      return defaultDeny("purpose_not_permitted", targetClass);
    }
    return {
      allowed: true,
      purpose: requested,
      targetClass,
      ownerUid,
      auditRequired: true,
    };
  }

  // Staff token: operational dispatch only. system is never a dispatch purpose.
  if (requested !== undefined && requested !== STAFF_PURPOSE) {
    return defaultDeny("purpose_not_permitted", targetClass);
  }

  if (callerRole && GLOBAL_DISPATCH_ROLES.has(callerRole)) {
    // brand_owner/developer: any staff token. support: brand-global for STAFF
    // tokens even with an empty branchIds claim (tickets.service.ts:54).
    return { allowed: true, purpose: STAFF_PURPOSE, targetClass, ownerUid, auditRequired: false };
  }

  if (callerRole === "branch_owner" || callerRole === "branch_staff" || callerRole === "regional_manager") {
    const callerBranchIds = asStringArray(caller.branchIds);
    if (callerBranchIds.length === 0 || ownerBranchIds.length === 0) {
      return defaultDeny("staff_outside_branch", targetClass);
    }
    const inScope = ownerBranchIds.some((branchId) => callerBranchIds.includes(branchId));
    if (!inScope) return defaultDeny("staff_outside_branch", targetClass);
    return { allowed: true, purpose: STAFF_PURPOSE, targetClass, ownerUid, auditRequired: false };
  }

  return defaultDeny("role_not_permitted", targetClass);
}
