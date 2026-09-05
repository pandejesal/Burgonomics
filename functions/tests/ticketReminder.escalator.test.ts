import { describe, it, expect } from "vitest";

// These tests import the REAL escalation engine (tier clocks) and the REAL
// topic router. The previous file re-implemented both locally — green while
// production drifted, including a real gap this rewrite also fixes: the old
// clock only understood Firestore Timestamp objects, so numeric/ISO
// timestamps silently never escalated.

import {
  currentTier,
  nextTierForInactivity,
} from "../src/modules/tickets/ticketReminder.scheduler";
import { resolveEscalationTopic } from "../src/modules/tickets/notificationDispatcher";

describe("Functions Backend — 3-Tier SLA Auto-Escalation Engine (real code)", () => {
  describe("1. Tier Resolution & Inactivity Calculations", () => {
    it("defaults unspecified tier to 'branch' (Tier 1)", () => {
      expect(currentTier({})).toBe("branch");
      expect(currentTier({ assignedTo: {} })).toBe("branch");
      expect(currentTier({ assignedTo: { tier: "invalid_tier" } })).toBe("branch");
      expect(currentTier({ assignedTo: { tier: "brand_support" } })).toBe("brand_support");
      expect(currentTier({ assignedTo: { tier: "developer_team" } })).toBe("developer_team");
    });

    it("escalates branch tier ticket to 'brand_support' after 60 min inactivity", () => {
      const now = Date.now();
      const ticket = {
        assignedTo: { tier: "branch" },
        createdAt: now - 65 * 60 * 1000, // 65 min ago (epoch millis)
      };

      expect(nextTierForInactivity(ticket, now)).toBe("brand_support");
    });

    it("does not escalate branch tier ticket within 60 min window", () => {
      const now = Date.now();
      const ticket = {
        assignedTo: { tier: "branch" },
        createdAt: now - 45 * 60 * 1000, // 45 min ago
      };

      expect(nextTierForInactivity(ticket, now)).toBeNull();
    });

    it("escalates brand_support tier ticket to 'developer_team' after 120 min inactivity", () => {
      const now = Date.now();
      const ticket = {
        assignedTo: { tier: "brand_support" },
        lastActivityAt: now - 130 * 60 * 1000, // 130 min ago
      };

      expect(nextTierForInactivity(ticket, now)).toBe("developer_team");
    });

    it("does not escalate developer_team tier (final tier)", () => {
      const now = Date.now();
      const ticket = {
        assignedTo: { tier: "developer_team" },
        lastActivityAt: now - 500 * 60 * 1000, // 500 min ago
      };

      expect(nextTierForInactivity(ticket, now)).toBeNull();
    });

    it("uses lastActivityAt preferentially over createdAt when both are present", () => {
      const now = Date.now();
      const ticket = {
        assignedTo: { tier: "branch" },
        createdAt: now - 120 * 60 * 1000, // created 2h ago
        lastActivityAt: now - 10 * 1000, // updated 10s ago (active)
      };

      expect(nextTierForInactivity(ticket, now)).toBeNull();
    });

    it("accepts ISO-string timestamps (writers disagree on clock shape)", () => {
      const now = Date.now();
      const ticket = {
        assignedTo: { tier: "branch" },
        createdAt: new Date(now - 70 * 60 * 1000).toISOString(),
      };

      expect(nextTierForInactivity(ticket, now)).toBe("brand_support");
    });
  });

  describe("2. Escalation FCM topic routing (real router)", () => {
    it("routes L1 alerts to branch staff topic", () => {
      expect(resolveEscalationTopic("L1_STORE", "cg_road")).toBe("branch_cg_road_tickets");
      expect(resolveEscalationTopic("L1_STORE")).toBe("branch_general_tickets");
    });

    it("routes L2 SLA breach alerts to regional operations topic", () => {
      expect(resolveEscalationTopic("L2_REGIONAL", "cg_road")).toBe("regional_managers");
    });

    it("routes L3 SLA breach alerts to superadmin topic", () => {
      expect(resolveEscalationTopic("L3_EXECUTIVE")).toBe("superadmins");
    });
  });
});
