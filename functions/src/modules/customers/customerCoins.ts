import { z } from "zod";
import { db } from "../../core/firebase";
import * as admin from "firebase-admin";
import { isBrandAdminClaim, type StaffCaller } from "../../core/middleware";

export const AdjustCustomerCoinsSchema = z.object({
  customerId: z.string().min(1, "customerId is required"),
  delta: z
    .number()
    .int()
    .min(-5000)
    .max(5000)
    .refine((n) => n !== 0, { message: "delta cannot be zero" }),
  reason: z.string().trim().min(3).max(200),
  notes: z.string().max(500).optional(),
});

export type AdjustCustomerCoinsInput = z.infer<typeof AdjustCustomerCoinsSchema>;

/**
 * Staff Grill-Coins compensation with an audit trail. The partner app used to
 * apply adjustments to LOCAL state only and toast success — the balance
 * evaporated on reload and no ledger existed. All coin movement now goes
 * through here: branch-scoped authorization, non-negative clamp, and one
 * coin_transactions ledger row per adjustment (actor-attributed).
 */
export async function adjustCustomerCoins(
  rawInput: unknown,
  caller: StaffCaller | undefined
): Promise<{ success: boolean; customerId: string; applied: number; balanceAfter: number }> {
  const input = AdjustCustomerCoinsSchema.parse(rawInput);
  if (!caller) {
    throw new Error("Unauthorized: staff authentication required");
  }

  // Atomic balance+ledger transaction: the old split-write (get → set →
  // add as three separate awaits) lost credits under concurrency (two
  // adjusters read 100, both wrote 150) and orphaned balances when the
  // ledger add threw after the set. Everything happens in one transaction.
  const ref = db.collection("customers").doc(input.customerId);
  const ledgerRef = db.collection("coin_transactions").doc();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await db.runTransaction(async (tx: any) => {
    const snap = await tx.get(ref as any);
    if (!snap.exists) {
      throw new Error(`Customer ${input.customerId} not found`);
    }
    const customer = snap.data()!;

    // Branch scope via the customer's home outlet (transaction-safe: no
    // extra reads — the outlet id is on the doc we already hold).
    // Unknown-outlet customers are brand-admin-only (fail closed).
    if (!isBrandAdminClaim(caller)) {
      const branchIds = Array.isArray(caller?.branchIds) ? caller.branchIds : [];
      const home = customer.favoriteBranchId;
      if (typeof home !== "string" || !home || !branchIds.includes(home)) {
        throw new Error("Forbidden: customer is outside your assigned branches");
      }
    }

    const current = Number(customer.loyaltyPoints || 0);
    const next = Math.max(0, current + input.delta);
    const applied = next - current;

    tx.set(
      ref as any,
      {
        loyaltyPoints: next,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    tx.set(ledgerRef as any, {
      customerId: input.customerId,
      delta: applied,
      balanceAfter: next,
      type: "staff_adjustment",
      reason: input.reason,
      notes: input.notes || null,
      actorUid: caller?.uid || null,
      actorEmail: (caller as any)?.email || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return { applied, balanceAfter: next };
  });

  return { success: true, customerId: input.customerId, ...result };
}

/**
 * Loop 63/120: idempotent confirm-time debit for redeemed Grill Coins.
 * Loop 62 clamped redemption to verified balances at intent time, but
 * nothing ever reduced the balance — earned coins stayed reusable forever.
 * This runs once per captured payment: deterministic ledger id
 * `coin_redemption_{razorpayOrderId}` makes webhook retries and dual
 * verify+webhook confirms converge on a single debit. Concurrent spends
 * clamp at zero (brand absorbs the sliver; balances never go negative).
 * No-ops for guests, unknown customers, and zero amounts. Never throws
 * for missing docs — callers must not fail a captured payment over this.
 */
export async function debitRedeemedCoins(input: {
  customerId: string;
  coins: number;
  orderId: string;
  razorpayOrderId: string;
}): Promise<{ debited: number; balanceAfter: number; alreadyDone: boolean }> {
  const want =
    typeof input.coins === "number" && Number.isFinite(input.coins)
      ? Math.floor(input.coins)
      : 0;
  if (want <= 0) return { debited: 0, balanceAfter: 0, alreadyDone: true };
  if (!input.customerId || input.customerId === "guest") {
    return { debited: 0, balanceAfter: 0, alreadyDone: true };
  }
  const ledgerId = `coin_redemption_${input.razorpayOrderId}`;
  const customerRef = db.collection("customers").doc(input.customerId);
  const ledgerRef = db.collection("coin_transactions").doc(ledgerId);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return db.runTransaction(async (tx: any) => {
    const doneSnap = await tx.get(ledgerRef as any);
    if (doneSnap.exists) {
      const done = (doneSnap.data() || {}) as any;
      return {
        debited: Math.abs(Number(done.delta) || 0),
        balanceAfter: Number(done.balanceAfter) || 0,
        alreadyDone: true,
      };
    }
    const custSnap = await tx.get(customerRef as any);
    const current = custSnap.exists
      ? Math.max(0, Math.floor(Number((custSnap.data() as any)?.loyaltyPoints) || 0))
      : 0;
    const debit = Math.min(current, want);
    const next = current - debit;
    if (custSnap.exists) {
      tx.set(
        customerRef as any,
        {
          loyaltyPoints: next,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
    tx.set(ledgerRef as any, {
      customerId: input.customerId,
      delta: -debit,
      balanceAfter: custSnap.exists ? next : 0,
      type: "redemption",
      reason: `Redeemed on order ${input.orderId}`,
      orderId: input.orderId,
      razorpayOrderId: input.razorpayOrderId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { debited: debit, balanceAfter: custSnap.exists ? next : 0, alreadyDone: false };
  });
}
