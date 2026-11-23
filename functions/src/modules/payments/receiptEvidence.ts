/**
 * Server-only receipt evidence stamp.
 *
 * A downloaded receipt may say "Paid"/"Collected" only when the stamp written
 * by the capture or cash-collection path is present and matches the money
 * field. It is written in the SAME transaction/payload as `capturedAmountPaise`
 * or `cashCollectedPaise`, so a client can never plant it on its own. Legacy
 * orders without the stamp render a neutral order total.
 */
export type ReceiptEvidenceKind = "capture" | "cash";

export interface ReceiptEvidence {
  kind: ReceiptEvidenceKind;
  /** Integer paise actually captured or collected. */
  paise: number;
  /** Server clock, milliseconds. */
  stampedAtMs: number;
  /** Always "server" — a client value is never accepted by the receipt. */
  by: "server";
}

export function receiptEvidenceStamp(kind: ReceiptEvidenceKind, paise: number): ReceiptEvidence {
  return { kind, paise, stampedAtMs: Date.now(), by: "server" };
}
