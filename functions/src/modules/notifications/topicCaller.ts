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
 * reads the same fields from `admins/{uid}` — a server-owned registry clients
 * cannot write.
 *
 * NEVER read `users/{uid}` here: firestore.rules does not mask branchId /
 * assignedStoreId on that doc, so a staffer could write their own branchId and
 * grant themselves another outlet's topics (SEC-01c).
 *
 * `filterSubscribableTopics` stays a pure function; this is the only I/O.
 * Fail CLOSED: if the read fails, the caller keeps an empty scope (no branch
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

  try {
    const snap = await db.collection("admins").doc(uid).get();
    if (!snap.exists) return caller;
    const data = (snap.data() || {}) as any;
    const scope = normalizeBranchScope(
      data.branchIds,
      data.branchId,
      data.assignedStoreId
    );
    if (scope.length > 0) return { ...caller, branchIds: scope };
  } catch (err: any) {
    logger.warn(
      `[Topics] branch scope read failed for admins/${uid}:`,
      err?.message || err
    );
  }

  return caller;
}
