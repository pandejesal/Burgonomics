import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  paymentRepository,
  usePaymentStore,
  razorpayAdapter,
} from "@/features/payments";
import type { PaymentMethod, PaymentResult } from "@/features/payments/models";
import { persistPaymentReconciliation, clearPaymentReconciliation } from "@/features/payments/state/paymentStore";
import {
  describePaymentRecovery,
  resolveVerifyOutcome,
  type RecoveryReason,
} from "@/features/payments/utils/paymentRecovery";
import { logger } from "@/core/logging/logger";
import { toUserMessage } from "@/core/errors/userMessages";
import { orderRepository } from "@/features/orders";
import { cartRepository } from "@/features/cart";
import { AudioService } from "@/core/services/audio";
import { HapticService } from "@/core/services/haptics";
import { useAuthStore } from "@/features/auth/state/authStore";

/**
 * P1-14: `PaymentRepository.createPaymentOrder` returns curated copy for the
 * codes below (PAYMENT_RECONCILIATION_PENDING carries the do-not-pay-again
 * instruction), while the pricing-engine passthrough and `paymentsService`'s
 * transport catch can wrap raw exception text in `PRICING_CALCULATION_ERROR`
 * / `GATEWAY_ERROR`. Only curated codes pass through verbatim; every other
 * code is logged and mapped so raw exception text never reaches the failure
 * panel or a toast.
 */
const CURATED_PAYMENT_ORDER_CODES = new Set([
  "MISSING_AUTH",
  "MISSING_CONTEXT",
  "AUTH_CHANGED",
  "PERSIST_FAILED",
  "PAYMENT_RECONCILIATION_PENDING",
  "INVALID_AMOUNT",
  // Money-time pricing-engine refusals (409). Kept consistent with
  // checkout.tsx / payment.tsx so any future consumer of this exported hook
  // renders the honest refusal instead of a generic gateway error.
  "ITEM_UNAVAILABLE",
  "ITEM_PRICE_UNVERIFIED",
]);

function paymentOrderFailureMessage(error: { code: string; message: string }): string {
  if (CURATED_PAYMENT_ORDER_CODES.has(error.code)) return error.message;
  console.error("[payments] create payment order failed:", error);
  return toUserMessage(error);
}

export interface UseRazorpayPaymentOptions {
  onSuccess?: (orderId: string) => void;
  onFailure?: (error: { code: string; message: string }) => void;
  onDismiss?: () => void;
}

export function useRazorpayPayment(options?: UseRazorpayPaymentOptions) {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);

  const status = usePaymentStore((s) => s.status);
  const method = usePaymentStore((s) => s.method);
  const failure = usePaymentStore((s) => s.failure);
  const setStatus = usePaymentStore((s) => s.setStatus);
  const setMethod = usePaymentStore((s) => s.setMethod);
  const setOrder = usePaymentStore((s) => s.setOrder);
  const setFailure = usePaymentStore((s) => s.setFailure);
  const setVerification = usePaymentStore((s) => s.setVerification);
  const resetPayment = usePaymentStore((s) => s.reset);

  const [abandonmentOpen, setAbandonmentOpen] = React.useState(false);

  const initiatePayment = async (preferredMethod: PaymentMethod = method) => {
    setFailure(null);
    setStatus("preparing");
    setAbandonmentOpen(false);

    try {
      // 1. Create payment order via backend
      const orderRes = await paymentRepository.createPaymentOrder();
      if (!orderRes.success) {
        setStatus("failed");
        const message = paymentOrderFailureMessage(orderRes.error);
        setFailure({
          code: orderRes.error.code,
          message,
          // A reconciliation block is not retryable: offering a retry there
          // would start a second payment for money the server already has.
          retryable: orderRes.error.code !== "PAYMENT_RECONCILIATION_PENDING",
        });
        toast.error("Could not initiate payment", { description: message });
        options?.onFailure?.({ code: orderRes.error.code, message });
        return;
      }

      setOrder(orderRes.data);
      setStatus("waiting");

      // 2. Initialize Razorpay SDK with #0E4825 brand palette & user prefill
      await razorpayAdapter.initialize({
        order: orderRes.data,
        prefill: {
          name: user?.name,
          email: (user as { email?: string } | null)?.email,
          contact: user?.phone,
        },
        theme: {
          color: "#0E4825",
        },
      });

      // 3. Open Checkout Sheet
      await razorpayAdapter.openCheckout(
        {
          onSuccess: async (result: PaymentResult) => {
            // Contract §3: bind the verification to the internal order that
            // was created before the gateway opened (paymentStore holds it).
            const internalOrderId = usePaymentStore.getState().internalOrderId;
            const reconUid = useAuthStore.getState().user?.id ?? null;
            /**
             * Every uncertain post-gateway outcome funnels through here:
             * persist the uid-scoped reconciliation record (blocks a new
             * payment now and after reload), surface the recovery copy —
             * never markPaymentFailed, never clear the cart, never navigate,
             * never invite a new payment (A08 B1/B9).
             */
            const enterReconciliation = (
              reason: RecoveryReason,
              confirmedInternal?: string | null,
            ) => {
              const store = usePaymentStore.getState();
              const boundInternal = confirmedInternal ?? internalOrderId ?? store.internalOrderId ?? null;
              const boundGateway = result.orderId ?? store.gatewayOrderId ?? null;
              store.setReconciliation(true, reason, boundInternal, boundGateway);
              persistPaymentReconciliation(reconUid, {
                internalOrderId: boundInternal,
                gatewayOrderId: boundGateway,
                reason,
              });
              const copy = describePaymentRecovery(reason);
              setStatus("waiting");
              setFailure({
                code: reason,
                message: copy.body,
                retryable: false,
                paymentId: result.paymentId,
              });
              toast.info(copy.title, {
                description: `${copy.body}${result.paymentId ? ` Payment ID ${result.paymentId}.` : ""}`,
              });
              // Historical contract: only the paid-but-unsynced / held-auth
              // outcomes report through `onFailure`; transfer races and
              // terminal orders stay informational.
              if (reason === "PAYMENT_SYNC_PENDING" || reason === "PAYMENT_NOT_CAPTURED") {
                options?.onFailure?.({ code: reason, message: copy.body });
              }
            };

            try {
              const verify = await paymentRepository.verifyPayment({
                ...result,
                internalOrderId: internalOrderId ?? undefined,
              });
              const outcome = resolveVerifyOutcome({
                verify,
                internalOrderId,
                gatewayOrderId: result.orderId,
                paymentId: result.paymentId,
              });

              if (outcome.kind === "uncaptured") {
                // Only a server-proven non-capture may flip the order to
                // failed — signature failures and unknown codes never reach
                // here (A08 B1).
                const message = outcome.message;
                setStatus("failed");
                setFailure({
                  code: outcome.code,
                  message,
                  retryable: outcome.retryable,
                  paymentId: result.paymentId,
                });
                toast.error("Payment verification failed", { description: message });
                void orderRepository.markPaymentFailed(outcome.internalOrderId).catch(() => undefined);
                options?.onFailure?.({ code: outcome.code, message });
                return;
              }

              if (outcome.kind === "reconciliation") {
                // 503 / bad signature / exhausted 202 / awaiting_capture /
                // terminal: honest recovery, no new payment.
                enterReconciliation(outcome.reason);
                return;
              }

              // Both non-verified kinds returned above; keep the fallthrough
              // fail-closed regardless.
              if (outcome.kind !== "verified") return;
              const verification = outcome.verification;
              setVerification(verification);
              // Same internal order id — the paid order replaces the pending
              // doc instead of creating a second one for the same payment.
              const created = await orderRepository.finalizePaidOrder({
                confirmedOrderId: internalOrderId ?? verification.confirmedOrderId,
                transactionId: result.paymentId,
              });

              // Paid-but-no-order must NEVER celebrate: mirror the fail-closed
              // branches in payment.tsx/checkout.tsx (support CTA, no cart
              // clear, no confirmation navigation).
              if (!created.success) {
                enterReconciliation("PAYMENT_SYNC_PENDING", verification.confirmedOrderId || null);
                return;
              }
              clearPaymentReconciliation(reconUid);
              usePaymentStore.getState().clearReconciliation();

              setStatus("success");
              AudioService.playSuccess();
              void HapticService.notification("success");
              void cartRepository.clear();
              const orderId = created.success ? created.data.id : verification.confirmedOrderId;

              if (options?.onSuccess) {
                options.onSuccess(orderId);
              } else {
                void navigate({
                  to: "/order-confirmation/$orderId",
                  params: { orderId },
                  replace: true,
                });
              }
            } catch (err) {
              // Post-gateway unknown exception (verify/finalize threw after
              // money may have moved): reconciliation, never failed/re-pay.
              logger.warn("payments.post_gateway_exception", {
                message: err instanceof Error ? err.message : String(err),
              });
              enterReconciliation("PAYMENT_SYNC_PENDING");
            }
          },
          onFailure: (err) => {
            setStatus("failed");
            // P1-8: a gateway description is provider text, not customer copy
            // (BAD_REQUEST_ERROR / bank decline strings, occasionally carrying
            // card fragments). Log it raw and render the curated mapper
            // output, exactly like `src/routes/payment.tsx`.
            console.error("[payment] gateway onFailure:", err);
            const message = toUserMessage(err);
            setFailure({ code: err.code, message, retryable: true });
            toast.error("Payment failed", { description: message });
            options?.onFailure?.({ code: err.code, message });
          },
          onCancel: () => {
            // `modal.ondismiss` is a late/duplicate callback surface: Razorpay
            // fires it after `payment.failed` (the adapter already suppresses
            // that one) and it can arrive for an attempt that has already
            // reached a paid or money-possible outcome. This hook is an
            // exported payments entrypoint, so it must not depend on adapter
            // internals to protect the money state: once the attempt is
            // terminal or reconciliation-pending, a dismiss is not a cancel.
            const current = usePaymentStore.getState();
            if (
              current.status === "failed" ||
              current.status === "success" ||
              current.status === "cancelled" ||
              current.reconciliationPending
            ) {
              return;
            }
            setStatus("cancelled");
            setFailure({
              code: "USER_CANCELLED",
              message: "Payment modal was dismissed.",
              retryable: true,
            });
            setAbandonmentOpen(true);
            options?.onDismiss?.();
          },
        },
        preferredMethod,
      );
    } catch (err) {
      setStatus("failed");
      // Raw exception text never reaches the failure panel/toast (P1-8).
      console.error("[payments] initiate exception:", err);
      const message = "We couldn't start the payment. Please try again.";
      setFailure({ code: "PAYMENT_EXCEPTION", message, retryable: true });
      toast.error("Payment gateway error", { description: message });
    }
  };

  const retry = async () => {
    setStatus("retrying");
    await initiatePayment(method);
  };

  return {
    status,
    method,
    failure,
    abandonmentOpen,
    isBusy: status === "preparing" || status === "waiting" || status === "retrying",
    setMethod,
    setAbandonmentOpen,
    initiatePayment,
    retry,
    resetPayment,
  };
}

export default useRazorpayPayment;
