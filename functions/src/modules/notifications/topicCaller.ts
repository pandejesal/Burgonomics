import { db } from "../../core/firebase";
import * as logger from "firebase-functions/logger";
import {
  normalizeBranchScope,
  topicCallerFromClaims,
  type TopicCaller,
} from "./topics";

/**
 * Route-layer caller resolution for topic subscriptions.
 *
 * Claims are the primary scope, but the partner app still ships three legacy
 * scope shapes (array `branchIds`, string-shaped `branchIds`, singular
 * `branchId`). When a staff caller's claims carry none of them, the route
 * reads the same fields from the `users/{uid}` doc, then `admins/{uid}` — the
 * docs the partner app signs operators in from. `filterSubscribableTopics`
 * stays a pure function; this is the only I/O.
 *
 * Fail CLOSED: if every read fails, the caller keeps an empty scope (no branch
 * topics) and a warning is logged. It never widens to all branches.
 */
export async function resolveTopicCaller(user: any): Promise<TopicCaller> {
  const caller = topicCallerFromClaims(user);
  if (
    !caller.role ||
    caller.role === "customer" ||
    caller.isBrandAdmin === true ||
    caller.role === "support" ||
    (caller.branchIds || []).length > 0
  ) {
    return caller;
  }

  const uid = typeof user?.uid === "string" ? user.uid.trim() : "";
  if (!uid) return caller;

  for (const collection of ["users", "admins"] as const) {
    try {
      const snap = await db.collection(collection).doc(uid).get();
      if (!snap.exists) continue;
      const data = (snap.data() || {}) as any;
      const scope = normalizeBranchScope(
        data.branchIds,
        data.branchId,
        data.assignedStoreId
      );
      if (scope.length > 0) return { ...caller, branchIds: scope };
    } catch (err: any) {
      logger.warn(
        `[Topics] branch scope read failed for ${collection}/${uid}:`,
        err?.message || err
      );
    }
  }

  return caller;
}
