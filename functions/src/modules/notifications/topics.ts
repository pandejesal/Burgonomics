/**
 * FCM topic allowlist (Loop 4/120).
 *
 * Branch operational topics (branch_<id>_orders / branch_<id>_tickets) carry
 * KOT + escalation pushes. They were subscribable by ANY authenticated caller
 * (including customers): the route filter checked the topic SHAPE but never
 * the caller ROLE, so a customer could attach their own token to any branch
 * and receive that outlet's order-flow pushes. Branch topics are now
 * staff-only AND branch-scoped: non-admin staff may only subscribe to their
 * own branchIds, while brand admins and support keep all outlets. Role-gated
 * fan-out topics keep their existing checks. Pure function — unit tested in
 * tests/fcm.topics.test.ts.
 */
export interface TopicCaller {
  role?: string;
  isBrandAdmin?: boolean;
  /** Assigned branch ids from the caller's claims (never a new claim). */
  branchIds?: string[];
}

/**
 * Normalizes the legacy claim shapes the partner app still ships: a string[]
 * `branchIds`, a string-shaped `branchIds`, and a singular `branchId`. Blanks
 * and duplicates are dropped so a scope can never widen by accident.
 */
export function normalizeBranchScope(...sources: unknown[]): string[] {
  const out: string[] = [];
  for (const source of sources) {
    const values = Array.isArray(source) ? source : [source];
    for (const value of values) {
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      if (!trimmed || out.includes(trimmed)) continue;
      out.push(trimmed);
    }
  }
  return out;
}

/**
 * Builds the topic caller from the authenticated claims already on `req.user`
 * (role / isBrandAdmin / branchIds / legacy branchId). No new claim is
 * introduced.
 */
export function topicCallerFromClaims(user: any): TopicCaller {
  const role = typeof user?.role === "string" ? user.role : undefined;
  return {
    role,
    isBrandAdmin: user?.isBrandAdmin === true || role === "brand_owner" || role === "developer",
    branchIds: normalizeBranchScope(user?.branchIds, user?.branchId),
  };
}

const BRANCH_TOPIC_RE = /^branch_([A-Za-z0-9_-]+)_(orders|tickets)$/;
export const MAX_TOPICS_PER_CALL = 12;

export function filterSubscribableTopics(topics: unknown, caller: TopicCaller): string[] {
  if (!Array.isArray(topics)) return [];
  const { role, isBrandAdmin } = caller;
  const isStaff = !!role && role !== "customer";
  // Brand admins and support observe every outlet; every other staff role is
  // limited to the branchIds already carried by its claims.
  const seesAllBranches = isBrandAdmin === true || role === "support";
  const assignedBranches = Array.isArray(caller.branchIds)
    ? caller.branchIds.filter((b): b is string => typeof b === "string")
    : [];
  return [...new Set(topics)]
    .filter((t): t is string => typeof t === "string")
    .filter((t) => {
      // Staff-only: KOT order flow + ticket escalation pushes. Customers have
      // no legitimate use and must never observe another outlet's flow.
      if (BRANCH_TOPIC_RE.test(t)) {
        if (!isStaff) return false;
        if (seesAllBranches) return true;
        const branchId = BRANCH_TOPIC_RE.exec(t)?.[1] ?? "";
        return assignedBranches.includes(branchId);
      }
      if (t === "regional_managers") {
        return role === "regional_manager" || isBrandAdmin === true || role === "support";
      }
      if (t === "superadmins") return isBrandAdmin === true;
      if (t === "tickets_escalated") return isStaff;
      return false;
    })
    .slice(0, MAX_TOPICS_PER_CALL);
}
