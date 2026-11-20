/**
 * The Petpooja "Update Order Status" (cancel) REQUEST BODY — one pure builder,
 * no imports, no Firestore, no config.
 *
 * Why it is its own file: the sandbox proof has to send the bytes the app sends,
 * not a hand-written lookalike. With no imports this module compiles on its own
 * (`tsc src/modules/petpooja/cancelPayload.ts`), so the probe script can load
 * the compiled builder and post exactly what production posts.
 *
 * Shape proven against the vendor sandbox on 2026-11-20
 * (`petpooja-sandbox-20261120/logs/02-update-order-status.json`):
 *   request  {app_key, app_secret, access_token, restID, orderID,
 *             clientorderID, cancelReason, status:"-1"}
 *   response {success:"1", message:"Order status updated successfully.",
 *             restID, clientOrderID, orderID, status:"-1"}
 */

/** Vendor `cancelReason` is free text; keep it short and PII-free. */
export const PETPOOJA_CANCEL_REASON_MAX_CHARS = 200;

/**
 * The reason that travels to the POS. Deliberately carries NO uid, name, phone
 * or free text typed by a customer: only the cancellation CLASS is sent.
 */
export function posCancelReasonText(reason?: string): string {
  const klass =
    reason === "staff_cancelled"
      ? "staff cancellation"
      : reason === "payment_not_completed"
        ? "payment not completed"
        : "customer cancellation";
  return `Order cancelled — ${klass} (Burgonomics)`.slice(
    0,
    PETPOOJA_CANCEL_REASON_MAX_CHARS
  );
}

export interface PosCancelRequestInput {
  /** OUR order id — the POS echoes it back as `clientOrderID`. */
  orderId: string;
  /** The POS's own id, when the vendor issued one. "" otherwise. */
  posOrderId?: string | null;
  /** `branches/{id}.petpoojaStoreId` — never the internal branch id. */
  restId: string;
  reason?: string;
  credentials: {
    appKey: string;
    appSecret: string;
    accessToken: string;
  };
}

/** Exactly the JSON body the outbound cancel POST carries. */
export function buildPosCancelRequestBody(
  input: PosCancelRequestInput
): Record<string, string> {
  return {
    app_key: input.credentials.appKey,
    app_secret: input.credentials.appSecret,
    access_token: input.credentials.accessToken,
    restID: input.restId,
    orderID: input.posOrderId ? String(input.posOrderId) : "",
    clientorderID: input.orderId,
    cancelReason: posCancelReasonText(input.reason),
    status: "-1",
  };
}

export interface PosCancelAck {
  ok: boolean;
  /** Vendor message, bounded — for the audit trail only. */
  message: string;
  /** Echoed POS order id, when the vendor returns one. */
  posOrderId: string;
}

/**
 * Read an `update_order_status` response body.
 *
 * Success is `success:"1"` / 1 / true (the documented shape, proven in the
 * sandbox). A body that ALSO says success "0"/0/false is a contradiction and is
 * NOT an acceptance — the same rule the KOT ack applies.
 */
export function readPosCancelAck(body: any): PosCancelAck {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "unreadable acknowledgement body", posOrderId: "" };
  }
  const message =
    typeof body.message === "string" ? body.message.slice(0, 200) : "";
  const posOrderId =
    body.orderID != null && body.orderID !== "" ? String(body.orderID) : "";
  const negative =
    body.success === "0" || body.success === 0 || body.success === false;
  const positive =
    body.success === "1" ||
    body.success === 1 ||
    body.success === true ||
    body.status === "success";
  if (negative && body.status === "success") {
    return {
      ok: false,
      message: "contradictory acknowledgement (refusal with a success status)",
      posOrderId,
    };
  }
  if (negative) return { ok: false, message: message || "vendor refusal", posOrderId };
  if (!positive) {
    return { ok: false, message: message || "no recognised acknowledgement", posOrderId };
  }
  return { ok: true, message, posOrderId };
}
