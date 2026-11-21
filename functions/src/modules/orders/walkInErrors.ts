import type { PricingBreakdown } from "../payments/pricing.engine";

/**
 * A refused counter request. Shared by the create route and the preview so
 * both answer with the same status/code/totals contract.
 */
export class WalkInError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly totals?: PricingBreakdown
  ) {
    super(message);
    this.name = "WalkInError";
  }
}
