/**
 * FCM topic allowlist (Loop 4/120).
 *
 * Branch operational topics (branch_<id>_orders / branch_<id>_tickets) carry
 * KOT + escalation pushes. They were subscribable by ANY authenticated caller
 * (including customers): the route filter checked the topic SHAPE but never
 * the caller ROLE, so a customer could attach their own token to any branch
 * and receive that outlet's order-flow pushes. Branch topics are now
 * staff-only (any non-customer role); role-gated fan-out topics keep their
 * existing checks. Pure function — unit tested in tests/fcm.topics.test.ts.
 */
export interface TopicCaller {
  role?: string;
  isBrandAdmin?: boolean;
}

const BRANCH_TOPIC_RE = /^branch_[A-Za-z0-9_-]+_(orders|tickets)$/;
export const MAX_TOPICS_PER_CALL = 12;

export function filterSubscribableTopics(topics: unknown, caller: TopicCaller): string[] {
  if (!Array.isArray(topics)) return [];
  const { role, isBrandAdmin } = caller;
  const isStaff = !!role && role !== "customer";
  return [...new Set(topics)]
    .filter((t): t is string => typeof t === "string")
    .filter((t) => {
      // Staff-only: KOT order flow + ticket escalation pushes. Customers have
      // no legitimate use and must never observe another outlet's flow.
      if (BRANCH_TOPIC_RE.test(t)) return isStaff;
      if (t === "regional_managers") {
        return role === "regional_manager" || isBrandAdmin === true || role === "support";
      }
      if (t === "superadmins") return isBrandAdmin === true;
      if (t === "tickets_escalated") return isStaff;
      return false;
    })
    .slice(0, MAX_TOPICS_PER_CALL);
}
