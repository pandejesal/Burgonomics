import { db } from "../../core/firebase";
import type {
  PricingBreakdown,
  PricingLineItem,
  SnapshotProduct,
} from "../payments/pricing.engine";
import {
  assertWalkInScope,
  priceWalkInLines,
  walkInBranchConfig,
  walkInLineFor,
} from "./walkInBill";
import { WalkInError } from "./walkInErrors";
import { walkInQuoteSchema } from "./walkInSchema";

/**
 * F4 (staging 2026-11-21, Test 7): HL Road's ₹15 packaging fee was missing from
 * the counter bill the till showed.
 *
 * The Partner modal derived the bill itself — food subtotal, an inline GST
 * calculation and `subtotal + packaging` where packaging came from a separate
 * order-level fee call — and posted that number as `expectedTotalPaise`. Two
 * independent money paths can disagree, and when they did the till showed one
 * bill and the server booked another.
 *
 * This is the ONE server quote the till may show and confirm: the same branch
 * config and the same `priceWalkInLines` call the create transaction uses, so
 * preview == charge by construction. It writes nothing.
 */
export interface WalkInQuoteResult {
  branchId: string;
  branchName: string;
  totals: PricingBreakdown;
}

/** Quotes a counter bill without writing anything. Staff scope only. */
export async function quoteWalkIn(
  actorUid: string,
  raw: unknown
): Promise<WalkInQuoteResult> {
  if (!actorUid) throw new WalkInError(401, "UNAUTHENTICATED", "Authentication required.");
  const parsed = walkInQuoteSchema.safeParse(raw);
  if (!parsed.success) {
    throw new WalkInError(400, "INVALID_INPUT", "Invalid walk-in quote request.");
  }
  const input = parsed.data;
  if (input.orderType === "delivery") {
    throw new WalkInError(
      422,
      "ORDER_TYPE_UNSUPPORTED",
      "Delivery is not supported for walk-ins."
    );
  }

  try {
    const adminSnap = await db.collection("admins").doc(actorUid).get();
    assertWalkInScope(
      adminSnap.exists ? adminSnap.data() : undefined,
      input.branchId,
      "quote"
    );
    const branchSnap = await db.collection("branches").doc(input.branchId).get();
    if (!branchSnap.exists) {
      throw new WalkInError(
        503,
        "BRANCH_UNAVAILABLE",
        "Branch configuration is unavailable."
      );
    }
    const branch = branchSnap.data() ?? {};

    const products = new Map<string, SnapshotProduct>();
    const lines: PricingLineItem[] = [];
    for (const item of input.items) {
      const snapshot = await db.collection("products").doc(item.productId).get();
      const { snapshot: product, line } = walkInLineFor(
        snapshot.data(),
        snapshot.exists,
        input.branchId,
        item.productId,
        item.quantity
      );
      products.set(item.productId, product);
      lines.push(line);
    }

    return {
      branchId: input.branchId,
      branchName:
        typeof branch.name === "string" && branch.name.trim() ? branch.name.trim() : "",
      totals: priceWalkInLines({
        lines,
        products,
        branchConfig: walkInBranchConfig(branch, input.branchId),
        branchId: input.branchId,
        orderType: input.orderType,
      }),
    };
  } catch (error: unknown) {
    if (error instanceof WalkInError) throw error;
    throw new WalkInError(
      503,
      "WALKIN_UNAVAILABLE",
      "Walk-in pricing is temporarily unavailable."
    );
  }
}
