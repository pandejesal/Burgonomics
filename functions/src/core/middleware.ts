import { Request, Response, NextFunction } from "express";
import { auth, db } from "./firebase";
import { config } from "../config/env";
import { timingSafeEqual } from "./security";
import * as admin from "firebase-admin";

export interface AuthenticatedRequest extends Request {
  user?: admin.auth.DecodedIdToken;
}

/**
 * Enforces Firebase ID token authentication with checkRevoked enabled.
 */
export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized: Missing or invalid Bearer token" });
    return;
  }

  const token = authHeader.split("Bearer ")[1].trim();
  if (!token) {
    res.status(401).json({ error: "Unauthorized: Empty token provided" });
    return;
  }

  try {
    const decoded = await auth.verifyIdToken(token, true); // checkRevoked = true
    req.user = decoded;
    next();
  } catch (err: any) {
    res.status(401).json({ error: "Unauthorized: Token verification failed or revoked" });
  }
}

/**
 * Optional authentication middleware: populates req.user if valid token provided, but doesn't block guests.
 */
export async function optionalAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.split("Bearer ")[1].trim();
    if (token) {
      try {
        const decoded = await auth.verifyIdToken(token, false);
        req.user = decoded;
      } catch {
        // Continue unauthenticated
      }
    }
  }
  next();
}

/**
 * Role-Based Access Control (RBAC) middleware.
 * Checks if authenticated caller has one of the allowed roles in custom claims or admins collection.
 */
export function requireRole(allowedRoles: string[]) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: "Unauthorized: Authentication required" });
      return;
    }

    const userRole = req.user.role as string | undefined;
    const isBrandAdmin =
      req.user.isBrandAdmin === true ||
      userRole === "brand_owner" ||
      userRole === "developer";

    if (isBrandAdmin) {
      next();
      return;
    }

    if (userRole && allowedRoles.includes(userRole)) {
      next();
      return;
    }

    // Fallback: check admins collection if claims not yet refreshed
    try {
      const adminDoc = await db.collection("admins").doc(req.user.uid).get();
      if (adminDoc.exists) {
        const adminData = adminDoc.data();
        const role = adminData?.role as string | undefined;
        if (
          role &&
          (allowedRoles.includes(role) ||
            role === "brand_owner" ||
            role === "developer")
        ) {
          next();
          return;
        }
      }
    } catch {
      // Fallback check failed
    }

    res.status(403).json({ error: "Forbidden: Insufficient privileges for this operation" });
  };
}

/**
 * Least-privilege caller presented to staff-only services. Services enforce
 * order.branchId ∈ caller.branchIds unless the caller is a brand admin.
 * The HTTP routes ALWAYS pass req.user — an omitted caller means "trusted
 * internal path" (schedulers/tests), never an anonymous request.
 */
export interface StaffCaller {
  uid?: string;
  role?: string | undefined;
  branchIds?: string[] | undefined;
  isBrandAdmin?: boolean | undefined;
  email?: string | undefined;
}

export function isBrandAdminClaim(caller: StaffCaller | undefined): boolean {
  return (
    !!caller &&
    (caller.isBrandAdmin === true ||
      caller.role === "brand_owner" ||
      caller.role === "developer")
  );
}

function callerBranchIds(caller: StaffCaller | undefined): string[] {
  const ids = caller?.branchIds;
  return Array.isArray(ids) ? ids.filter((b): b is string => typeof b === "string") : [];
}

/** Effective branch of an order doc: explicit branchId, else linked delivery store. */
export async function resolveOrderBranchId(
  order: Record<string, any>
): Promise<string | null> {
  if (typeof order.branchId === "string" && order.branchId) return order.branchId;
  const storeId = order.storeId;
  if (typeof storeId === "string" && storeId) {
    try {
      const snap = await db.collection("stores").doc(storeId).get();
      const linked = snap.exists ? (snap.data() as any)?.partnerBranchId : undefined;
      if (typeof linked === "string" && linked) return linked;
    } catch {
      // Fall through to null — unresolvable means deny for scoped callers.
    }
  }
  return null;
}

/**
 * Throws when the caller may not act on this order. Brand admins pass any
 * resolvable order; scoped staff must hold the order's branch. Anonymous
 * (undefined caller) is rejected — services are never reachable without a
 * route, and every staff route passes req.user.
 */
export async function assertOrderBranchAccess(
  caller: StaffCaller | undefined,
  order: Record<string, any>
): Promise<string> {
  if (!caller || (!caller.uid && !caller.email && !caller.role)) {
    throw new Error("Unauthorized: staff authentication required");
  }
  const branchId = await resolveOrderBranchId(order);
  if (!branchId) {
    throw new Error("Forbidden: order has no resolvable branch — link the outlet first");
  }
  if (isBrandAdminClaim(caller)) return branchId;
  if (!callerBranchIds(caller).includes(branchId)) {
    throw new Error("Forbidden: order is outside your assigned branches");
  }
  return branchId;
}

/**
 * Maps staff-service errors to HTTP status codes for routes.
 */
export function staffErrorStatus(err: any, fallback: number): number {
  const msg = String(err?.message || "");
  if (msg.startsWith("Unauthorized")) return 401;
  if (msg.startsWith("Forbidden")) return 403;
  return fallback;
}

/**
 * Firebase App Check attestation for app-originated routes.
 *
 * Monitor by default: missing/invalid tokens are logged, never rejected, so
 * enabling clients can never break the apps. Set APP_CHECK_ENFORCEMENT=true
 * (after enrolling web + registering the reCAPTCHA key) to reject.
 * NEVER applied to webhook routes — third parties cannot mint App Check tokens.
 */
export async function requireAppCheck(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const token = req.headers["x-firebase-appcheck"] as string | undefined;
  if (!token) {
    if (config.appCheck.enforcement) {
      res.status(403).json({ error: "Forbidden: missing App Check token" });
      return;
    }
    next();
    return;
  }
  try {
    await admin.appCheck().verifyToken(token);
    next();
  } catch (err: any) {
    if (config.appCheck.enforcement) {
      res.status(403).json({ error: "Forbidden: invalid App Check token" });
      return;
    }
    console.warn("[AppCheck] invalid token (monitor mode):", err?.message || err);
    next();
  }
}

/**
 * Webhook authentication for Petpooja POS bridge with timing-safe comparison.
 */
export function verifyPetpoojaAuth(req: Request, res: Response, next: NextFunction): void {
  if (config.mock.petpoojaPos) {
    next();
    return;
  }

  // Headers first. Body fallback is app_key ONLY: Petpooja's own protocol
  // echoes app_key in callback bodies, but access_token/app_secret must never
  // be accepted from a caller-supplied body (they are OUR outbound bearers —
  // accepting them inbound lets anyone who glimpsed one call webhooks).
  const tokenHeader =
    (req.headers["x-petpooja-token"] as string) ||
    (req.headers["content_key"] as string) ||
    (req.headers["content-key"] as string) ||
    (req.headers["authorization"] as string) ||
    req.body?.app_key;

  if (!tokenHeader || typeof tokenHeader !== "string") {
    res.status(401).json({ error: "Unauthorized: Missing or invalid Petpooja credentials" });
    return;
  }

  const token = tokenHeader.startsWith("Bearer ")
    ? tokenHeader.split("Bearer ")[1].trim()
    : tokenHeader.trim();

  const validTokens = [
    config.petpooja.appKey,
    config.petpooja.accessToken,
    config.petpooja.appSecret,
  ].filter((t): t is string => Boolean(t) && typeof t === "string");

  const isValid = validTokens.some((validToken) => timingSafeEqual(token, validToken));

  if (isValid) {
    next();
    return;
  }

  res.status(401).json({ error: "Unauthorized: Invalid Petpooja webhook credentials" });
}
