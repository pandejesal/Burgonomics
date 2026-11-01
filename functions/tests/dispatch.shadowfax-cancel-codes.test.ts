import { describe, it, expect, vi } from "vitest";

/**
 * Shadowfax cancellation cause CODES (mismatch #16).
 *
 * The docs' CANCELLED / CANCELLED_BY_CUSTOMER tables define `cancel_reason`
 * (0-24) with `cancel_reason_text` — and the CANCELLED_BY_CUSTOMER example
 * spells the same pair `reason` / `reason_text`. Until this, the classifier
 * read ONLY the free text, so a callback that omitted the text (the vendor's
 * own examples carry `"rider_contact": ""` and nulls, so sparse bodies are
 * normal) fell through to `unverified` = manual review.
 *
 * The two directions that matter:
 *   - Code 1 ("Rider Not Available or is Late") and 24 ("Delivery partner
 *     refused pickup") are EXPLICIT carrier faults. Without the code they were
 *     stuck in manual review, so the auto-rebook worker never replaced a rider
 *     who refused — a delivery that could recover itself waited for a human.
 *   - Code 0 ("Cancelled by Customer") and 6 ("Cancelled by Seller") are NOT
 *     carrier faults. Mapping them to `carrier` would buy a second rider for a
 *     delivery the customer or the branch already called off.
 *
 * Fixtures: the code table and both field spellings are copied from the
 * published docs; no captured provider body is involved.
 */

import { classifyCancelCause } from "../src/modules/dispatch/dispatch.webhooks";

describe("Shadowfax cancel_reason codes", () => {
  it("classifies documented carrier-fault codes as carrier even with no text", () => {
    // 1 = Rider Not Available or is Late, 24 = Delivery partner refused pickup.
    expect(classifyCancelCause("CANCELLED", "", 1)).toBe("carrier");
    expect(classifyCancelCause("CANCELLED", "", 24)).toBe("carrier");
    // 7 = Rider not having enough cash for purchase.
    expect(classifyCancelCause("CANCELLED", "", 7)).toBe("carrier");
  });

  it("classifies documented customer-side codes as customer even with no text", () => {
    // 0 = Cancelled by Customer, 2 = Customer Not Available,
    // 19 = Customer Not responding / Phone switched off.
    expect(classifyCancelCause("CANCELLED", "", 0)).toBe("customer");
    expect(classifyCancelCause("CANCELLED", "", 2)).toBe("customer");
    expect(classifyCancelCause("CANCELLED", "", 19)).toBe("customer");
    // 22 / 23 = the customer took a faster option / shorter wait.
    expect(classifyCancelCause("CANCELLED", "", 22)).toBe("customer");
    expect(classifyCancelCause("CANCELLED", "", 23)).toBe("customer");
  });

  it("never turns a seller-side or ambiguous code into an auto-rebook", () => {
    // 6 = Cancelled by Seller, 15 = Delivered by seller, 16 = Item not
    // available, 17 = Incorrect seller location, 3 = Duplicate Order,
    // 4 = Unserviceable address, 5 = Operational issue.
    for (const code of [3, 4, 5, 6, 15, 16, 17]) {
      expect(classifyCancelCause("CANCELLED", "", code)).not.toBe("carrier");
      expect(classifyCancelCause("CANCELLED", "", code)).not.toBe("customer");
    }
  });

  it("keeps the canonical post-pickup status authoritative over any code", () => {
    // CANCELLED_BY_CUSTOMER carries the same 0-24 table post-pickup; the status
    // itself is the cause (docs: post-pickup customer call-off).
    expect(classifyCancelCause("CANCELLED_BY_CUSTOMER", "", 1)).toBe("customer");
  });

  it("still uses the text when the payload carries no code", () => {
    expect(classifyCancelCause("CANCELLED", "Cancelled by Customer")).toBe("customer");
    expect(classifyCancelCause("CANCELLED", "Rider cancelled the order")).toBe("carrier");
    expect(classifyCancelCause("CANCELLED", "")).toBe("unverified");
  });
});
