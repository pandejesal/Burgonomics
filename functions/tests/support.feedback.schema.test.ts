import { describe, it, expect } from "vitest";
import { supportFeedbackSchema } from "../src/core/validation";

/**
 * Behavioural coverage for the real supportFeedbackSchema (the route test only
 * pins its source shape). Proves the bounds actually hold.
 */
describe("supportFeedbackSchema behaviour", () => {
  it("accepts ratings 1..5 inclusive", () => {
    for (const rating of [1, 2, 3, 4, 5]) {
      expect(supportFeedbackSchema.safeParse({ rating }).success, `rating ${rating}`).toBe(true);
    }
  });

  it("rejects 0, 6, non-integers, strings and a missing rating", () => {
    expect(supportFeedbackSchema.safeParse({ rating: 0 }).success).toBe(false);
    expect(supportFeedbackSchema.safeParse({ rating: 6 }).success).toBe(false);
    expect(supportFeedbackSchema.safeParse({ rating: 3.5 }).success).toBe(false);
    expect(supportFeedbackSchema.safeParse({ rating: "5" }).success).toBe(false);
    expect(supportFeedbackSchema.safeParse({}).success).toBe(false);
  });

  it("treats comment as optional and caps it at 2000 characters", () => {
    expect(supportFeedbackSchema.safeParse({ rating: 4 }).success).toBe(true);
    expect(supportFeedbackSchema.safeParse({ rating: 4, comment: "x".repeat(2000) }).success).toBe(
      true,
    );
    expect(supportFeedbackSchema.safeParse({ rating: 4, comment: "x".repeat(2001) }).success).toBe(
      false,
    );
  });

  it("trims the comment", () => {
    const parsed = supportFeedbackSchema.parse({ rating: 4, comment: "  hi  " });
    expect(parsed.comment).toBe("hi");
  });

  it("treats orderId as optional, 1..128 characters", () => {
    expect(supportFeedbackSchema.safeParse({ rating: 4 }).success).toBe(true);
    expect(supportFeedbackSchema.safeParse({ rating: 4, orderId: "a".repeat(128) }).success).toBe(
      true,
    );
    expect(supportFeedbackSchema.safeParse({ rating: 4, orderId: "a".repeat(129) }).success).toBe(
      false,
    );
    expect(supportFeedbackSchema.safeParse({ rating: 4, orderId: "" }).success).toBe(false);
  });

  it("drops a client-supplied customerId (identity must come from the token)", () => {
    const parsed = supportFeedbackSchema.parse({ rating: 4, customerId: "attacker" });
    expect("customerId" in parsed).toBe(false);
  });
});
