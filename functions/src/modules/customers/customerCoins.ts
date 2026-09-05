import { z } from "zod";
import { db } from "../../core/firebase";
import * as admin from "firebase-admin";
import { assertOrderBranchAccess, type StaffCaller } from "../../core/middleware";

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

  const ref = db.collection("customers").doc(input.customerId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new Error(`Customer ${input.customerId} not found`);
  }
  const customer = snap.data()!;

  // Branch scope via the customer's home outlet. Unknown-outlet customers
  // are brand-admin-only (fail closed for scoped staff).
  await assertOrderBranchAccess(caller, { branchId: customer.favoriteBranchId });

  const current = Number(customer.loyaltyPoints || 0);
  const next = Math.max(0, current + input.delta);
  const applied = next - current;

  await ref.set(
    {
      loyaltyPoints: next,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  await db.collection("coin_transactions").add({
    customerId: input.customerId,
    delta: applied,
    balanceAfter: next,
    type: "staff_adjustment",
    reason: input.reason,
    notes: input.notes || null,
    actorUid: caller.uid || null,
    actorEmail: (caller as any)?.email || null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { success: true, customerId: input.customerId, applied, balanceAfter: next };
}
