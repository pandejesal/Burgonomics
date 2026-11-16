import { createHash } from "node:crypto";
import * as admin from "firebase-admin";
import { z } from "zod";
import { db } from "../../core/firebase";
import { DEFAULT_MONTHLY_FEE_RUPEES, DEFAULT_PACKAGING_FEE, type BranchPricingConfig } from "../payments/branchPricing";
import { computeSnapshotPricing, type PricingBreakdown, type PricingLineItem, type SnapshotProduct } from "../payments/pricing.engine";

const documentId = z.string().trim().min(1).max(128).refine((value) => !value.includes("/") && value !== "." && value !== "..");
export const createWalkInSchema = z.object({
  requestId: z.string().trim().min(1).max(128),
  branchId: documentId,
  // Delivery parses so that it can be refused explicitly as unsupported.
  orderType: z.enum(["takeaway", "dinein", "delivery"]),
  tender: z.enum(["cash", "upi"]),
  items: z.array(z.object({ productId: documentId, quantity: z.number().int().min(1).max(99) }).strict()).min(1).max(100),
  expectedTotalPaise: z.number().int().nonnegative().safe(),
  tableNumber: z.string().trim().min(1).max(64).optional(),
  notes: z.string().trim().max(1000).optional(),
  customerName: z.string().trim().max(200).optional(),
  customerPhone: z.string().trim().max(32).optional(),
}).strict();
export type CreateWalkInRequest = z.infer<typeof createWalkInSchema>;
export interface WalkInReceipt {
  orderId: string;
  replayed: boolean;
  status: { code: "PLACED"; label: "Order placed"; kind: "upcoming"; terminal: false };
  paymentStatus: "pending";
  totals: PricingBreakdown;
  settlementAvailable: false;
}
export class WalkInError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string, public readonly totals?: PricingBreakdown) {
    super(message);
  }
}

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const placed: WalkInReceipt["status"] = { code: "PLACED", label: "Order placed", kind: "upcoming", terminal: false };

/** Re-checks authoritative role and assignment even on an idempotent replay. */
function assertScope(data: FirebaseFirestore.DocumentData | undefined, branchId: string): void {
  const role = data?.role;
  if (role === "brand_owner" || role === "developer") return;
  if ((role === "branch_owner" || role === "branch_staff") && Array.isArray(data?.branchIds) && data.branchIds.includes(branchId)) return;
  throw new WalkInError(403, "FORBIDDEN", "You cannot create an order for this branch.");
}

/** Creates a pending-payment walk-in and audit receipt atomically. */
export async function createWalkIn(actorUid: string, raw: unknown): Promise<WalkInReceipt> {
  if (!actorUid) throw new WalkInError(401, "UNAUTHENTICATED", "Authentication required.");
  const parsed = createWalkInSchema.safeParse(raw);
  if (!parsed.success) throw new WalkInError(400, "INVALID_INPUT", "Invalid walk-in request.");
  const input = parsed.data;
  if (input.orderType === "delivery") throw new WalkInError(422, "ORDER_TYPE_UNSUPPORTED", "Delivery is not supported for walk-ins.");
  const orderType = input.orderType;
  // Reconstruct a fixed-key object so JSON property ordering sent by clients is irrelevant.
  const canonical = { requestId: input.requestId, branchId: input.branchId, orderType, tender: input.tender, items: input.items.map(({ productId, quantity }) => ({ productId, quantity })), expectedTotalPaise: input.expectedTotalPaise, tableNumber: input.tableNumber ?? null, notes: input.notes ?? null, customerName: input.customerName ?? null, customerPhone: input.customerPhone ?? null };
  const requestHash = digest(JSON.stringify(canonical));
  const orderId = `walkin_${digest(JSON.stringify([actorUid, input.requestId]))}`;
  const orderRef = db.collection("orders").doc(orderId);
  const auditRef = db.collection("admin_audit_logs").doc(orderId);
  try {
    return await db.runTransaction(async (tx) => {
      const adminSnap = await tx.get(db.collection("admins").doc(actorUid));
      assertScope(adminSnap.exists ? adminSnap.data() : undefined, input.branchId);
      const branchSnap = await tx.get(db.collection("branches").doc(input.branchId));
      if (!branchSnap.exists) throw new WalkInError(503, "BRANCH_UNAVAILABLE", "Branch configuration is unavailable.");
      const orderSnap = await tx.get(orderRef);
      if (orderSnap.exists) {
        const existing = orderSnap.data();
        if (existing?.walkInRequestHash !== requestHash) throw new WalkInError(409, "IDEMPOTENCY_CONFLICT", "Request ID was already used for a different order.");
        if (!existing?.walkInReceipt) throw new WalkInError(503, "RECEIPT_UNAVAILABLE", "Original receipt is unavailable.");
        return { ...(existing.walkInReceipt as WalkInReceipt), replayed: true };
      }
      const products = new Map<string, SnapshotProduct>();
      const lines: PricingLineItem[] = [];
      for (const item of input.items) {
        const snapshot = await tx.get(db.collection("products").doc(item.productId));
        const product = snapshot.data();
        if (!snapshot.exists || !product || product.branchId !== input.branchId || product.inStock !== true || typeof product.price !== "number" || !Number.isFinite(product.price) || product.price < 0 || product.price > 100000 || typeof product.name !== "string" || !product.name.trim() || product.priceAvailable === false) {
          throw new WalkInError(503, "ITEM_UNAVAILABLE", "An item is unavailable or cannot be verified.");
        }
        if ((product.customizations !== undefined && (!Array.isArray(product.customizations) || product.customizations.length > 0)) || product.priceFromVariation === true) {
          throw new WalkInError(422, "PRODUCT_UNSUPPORTED", "Configurable products are not supported for walk-ins.");
        }
        products.set(item.productId, { price: product.price, inStock: product.inStock });
        lines.push({ id: item.productId, productId: item.productId, name: product.name, price: product.price, quantity: item.quantity, ...(typeof product.petpoojaItemId === "string" && product.petpoojaItemId.trim() ? { petpoojaItemId: product.petpoojaItemId } : {}) });
      }
      const branch = branchSnap.data() ?? {};
      const branchFee = branch.packagingFee;
      if (branchFee !== undefined && (typeof branchFee !== "number" || !Number.isFinite(branchFee) || branchFee < 0)) throw new WalkInError(503, "BRANCH_UNAVAILABLE", "Branch pricing is unavailable.");
      const config: BranchPricingConfig = { packagingFee: branchFee ?? DEFAULT_PACKAGING_FEE, monthlyFeePaise: DEFAULT_MONTHLY_FEE_RUPEES * 100, ...(branchFee !== undefined ? { branchPackagingFee: branchFee } : {}), packaging: branch.packaging ?? null };
      const { packagingUsedFallback: _fallback, ...totals } = computeSnapshotPricing({ items: lines, products, branchConfig: config, branchId: input.branchId, orderType });
      if (totals.split.totalAmountPaise !== input.expectedTotalPaise) throw new WalkInError(409, "PRICE_CHANGED", "The order price changed; please reconfirm.", totals);
      const receipt: WalkInReceipt = { orderId, replayed: false, status: placed, paymentStatus: "pending", totals, settlementAvailable: false };
      const timestamp = admin.firestore.FieldValue.serverTimestamp();
      tx.create(orderRef, { customerId: "cust_walkin", userId: actorUid, branchId: input.branchId, orderType, fulfillmentType: orderType, items: lines, status: placed, paymentMethod: input.tender === "cash" ? "cod" : "upi", paymentStatus: "pending", payment: { method: input.tender === "cash" ? "cod" : "upi", status: "pending" }, pricing: totals, totals, ...(input.tableNumber !== undefined ? { tableNumber: input.tableNumber } : {}), ...(input.notes !== undefined ? { notes: input.notes } : {}), ...(input.customerName !== undefined ? { customerName: input.customerName } : {}), ...(input.customerPhone !== undefined ? { customerPhone: input.customerPhone } : {}), walkInRequestHash: requestHash, walkInReceipt: receipt, createdAt: timestamp, updatedAt: timestamp });
      tx.create(auditRef, { actorUid, actorEmail: null, action: "walkin_created", targetType: "order", targetId: orderId, metadata: { branchId: input.branchId, tender: input.tender }, createdAt: timestamp });
      return receipt;
    });
  } catch (error: unknown) {
    if (error instanceof WalkInError) throw error;
    throw new WalkInError(503, "WALKIN_UNAVAILABLE", "Walk-in creation is temporarily unavailable.");
  }
}
