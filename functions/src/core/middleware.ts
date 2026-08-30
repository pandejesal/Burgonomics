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
 * Webhook authentication for Petpooja POS bridge with timing-safe comparison.
 */
export function verifyPetpoojaAuth(req: Request, res: Response, next: NextFunction): void {
  if (config.mock.petpoojaPos) {
    next();
    return;
  }

  const tokenHeader =
    (req.headers["x-petpooja-token"] as string) ||
    (req.headers["content_key"] as string) ||
    (req.headers["content-key"] as string) ||
    (req.headers["authorization"] as string) ||
    req.body?.app_key ||
    req.body?.access_token;

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
