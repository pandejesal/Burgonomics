import { z } from "zod";

/**
 * The counter-order request contract, shared by the create route and the
 * read-only quote so a bill can never be quoted from one shape and booked from
 * another.
 */
const documentId = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine((value) => !value.includes("/") && value !== "." && value !== "..");

export const createWalkInSchema = z
  .object({
    requestId: z.string().trim().min(1).max(128),
    branchId: documentId,
    // Delivery parses so that it can be refused explicitly as unsupported.
    orderType: z.enum(["takeaway", "dinein", "delivery"]),
    tender: z.enum(["cash", "upi"]),
    items: z
      .array(
        z
          .object({ productId: documentId, quantity: z.number().int().min(1).max(99) })
          .strict()
      )
      .min(1)
      .max(100),
    expectedTotalPaise: z.number().int().nonnegative().safe(),
    tableNumber: z.string().trim().min(1).max(64).optional(),
    notes: z.string().trim().max(1000).optional(),
    customerName: z.string().trim().max(200).optional(),
    customerPhone: z.string().trim().max(32).optional(),
  })
  .strict();
export type CreateWalkInRequest = z.infer<typeof createWalkInSchema>;

/**
 * The till's price preview: the same cart/outlet/order-type contract minus the
 * fields that only make sense when booking (the request id and the confirmed
 * total).
 */
export const walkInQuoteSchema = createWalkInSchema
  .omit({ requestId: true, expectedTotalPaise: true, tender: true })
  .strict();
export type WalkInQuoteRequest = z.infer<typeof walkInQuoteSchema>;
