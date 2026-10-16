import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
// v2/identity has no user-delete trigger — v1 auth.user().onDelete is the
// only Auth deletion hook. (beforeUserCreated/SignedIn are create/sign-in only.)
import * as functionsV1 from "firebase-functions/v1";
import * as admin from "firebase-admin";
import express from "express";
import type { Response } from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";

// Security Middleware
import {
  requireAuth,
  optionalAuth,
  requireRole,
  requireAppCheck,
  verifyPetpoojaAuth,
  staffErrorStatus,
  AuthenticatedRequest,
} from "./core/middleware";

// Modules
import {
  createPaymentOrder,
  verifyPayment,
  autoRefund,
  retryPendingRouteTransfersWorker,
  type CreateOrderParams,
} from "./modules/payments/razorpay.service";
import { handleRazorpayWebhook } from "./modules/payments/webhookHandler";
import { disposeRefundRequest } from "./modules/payments/refundRequests";
import { resolveDiscrepancy } from "./modules/payments/discrepancies";
import {
  syncPetpoojaMenu,
  handlePetpoojaMenuWebhook,
  handlePetpoojaStockWebhook,
  handlePetpoojaWebhook,
  pushOrderToPetpooja,
  pushItemStockToPetpooja,
  runPetpoojaTestScenario,
} from "./modules/petpooja";
import { auditPetpoojaWebhook } from "./modules/petpooja/webhookAudit";
import {
  syncAllBranchesPetpoojaMenu,
  retryPendingPetpoojaOrdersWorker,
} from "./modules/petpooja/petpooja.scheduler";
import {
  getDeliveryQuote,
  bookPorterRider,
  handlePorterWebhook,
  rebookPorterRider,
  cancelPorterBooking,
  verifyDeliveryOtp,
  manualBranchDispatch,
  pollActivePorterOrdersWorker,
} from "./modules/porter/porter.service";
import {
  dispatchQuote,
  dispatchBook,
  dispatchRebook,
  dispatchCancel,
  savePorterManualBooking,
  autoRebookDispatchWorker,
  handleDispatchWebhook,
} from "./modules/dispatch";
import { bumpOrderStatus } from "./modules/orders/orderStatus";
import {
  createTicket,
  addTicketMessage,
  resolveTicket,
  resolveTicketNote,
  escalateTicket,
} from "./modules/tickets/tickets.service";
import { checkTicketInactivityReminders } from "./modules/tickets/ticketReminder.scheduler";
import { deleteUserAccount } from "./modules/auth/accountDeletion";
import {
  inviteStaffMember,
  InviteStaffSchema,
} from "./modules/auth/staffInvite";
import {
  broadcastToDevices,
  BroadcastSchema,
} from "./modules/notifications/broadcast";
import { withSchedulerLock } from "./core/schedulerLock";
import { dispatchFCM } from "./modules/notifications/fcm.service";
import { unregisterDeviceToken } from "./modules/notifications/unregisterToken";
import { filterSubscribableTopics } from "./modules/notifications/topics";
import {
  setUserCustomClaims,
  assignUserRole,
  revokeUserRole,
  migrateGuestAccount,
  verifyBonusEligibility,
  cleanupExpiredGuestSessionsWorker,
  onUserDeletedCleanup,
} from "./modules/auth";
import { adjustCustomerCoins } from "./modules/customers/customerCoins";
import { assertProductionKeys } from "./config/env";
import {
  validateBody,
  normalizeOrderType,
  createPaymentOrderSchema,
  verifyPaymentSchema,
  refundSchema,
  disposeRefundSchema,
  resolveDiscrepancySchema,
  pushOrderSchema,
  syncMenuSchema,
  pushStockSchema,
  petpoojaTestRunnerSchema,
  porterBookSchema,
  porterCancelSchema,
  porterQuoteSchema,
  dispatchQuoteSchema,
  dispatchBookSchema,
  dispatchRebookSchema,
  dispatchPorterManualSchema,
  dispatchCancelSchema,
  verifyDeliveryOtpSchema,
  manualDispatchSchema,
  orderBumpSchema,
  adjustCoinsSchema,
  createTicketSchema,
  ticketMessageSchema,
  resolveTicketSchema,
  escalateTicketSchema,
  resolveNoteSchema,
  dispatchNotificationSchema,
  registerTokenSchema,
  unregisterTokenSchema,
  topicSubscriptionSchema,
  setClaimsSchema,
  assignRoleSchema,
  revokeRoleSchema,
  migrateGuestSchema,
  verifyBonusSchema,
  deleteAccountSchema,
} from "./core/validation";

// Live production-key enforcement.
//
// DELIBERATELY LAZY (runs on the first request, not at module import).
// Import-time enforcement made every `firebase deploy` fail: Firebase's
// deploy-time source analysis loads this module in a bare node process with no
// env injected, so `assertProductionKeys()` threw and the CLI reported
// "User code failed to load. Cannot determine backend specification. Timeout
// after 10000" — no backend could ever ship. The fail-closed guarantee is
// unchanged: a booted process refuses to serve while production keys are
// missing — and because the flag flips only after a PASSING check, it keeps
// refusing on every later request too (in dev the check is a no-op by design).
let productionKeysAsserted = false;
function enforceProductionKeysOnce(): void {
  if (productionKeysAsserted) return;
  // Assert BEFORE flipping the flag: if assertProductionKeys() throws, the
  // guard must keep failing closed on every subsequent request, not fall open.
  assertProductionKeys();
  productionKeysAsserted = true;
}

// Rate limiting middleware
// F4: provider webhooks arrive from shared egress IPs and monitors poll
// /health from one IP — a single global budget 429s them during lunch rush.
// Webhook + health/config paths skip this limiter (webhooks have their own
// HMAC auth + event-id dedup; health is public by design).
const WEBHOOK_RATE_LIMIT_EXEMPT_PREFIXES = [
  "/payments/webhook",
  "/porter/webhook",
  "/dispatch/webhooks/borzo",
  "/dispatch/webhooks/shadowfax",
  "/petpooja/webhook",
  "/petpooja/stockWebhook",
  "/petpooja/menu-sync",
  "/health",
  "/config/app",
];
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: { error: "Too many requests from this IP, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => WEBHOOK_RATE_LIMIT_EXEMPT_PREFIXES.some((p) => req.path === p),
});

const app = express();

// Fail-closed production-key guard (see enforceProductionKeysOnce above): the
// first request through this process boots the assert, so a misconfigured
// production deploy refuses to serve instead of silently running in mock mode.
app.use((req, res, next) => {
  try {
    enforceProductionKeysOnce();
    next();
  } catch (err: any) {
    res.status(503).json({ error: err?.message || "Production keys not configured" });
  }
});

// Whitelisted CORS origins (Strict 60-30-10 & Production Security)
const allowedOrigins = [
  "https://burgonomics.com",
  "https://partner.burgonomics.com",
  "https://burgonomics.netlify.app",
  "capacitor://localhost",
];

// Plain-http dev origins must never be credentialed in production: auth is
// Bearer-based (no cookies to steal), but there is no reason to widen the
// surface. Preview deploys use the exact host below, not a wildcard.
const devOrigins =
  process.env.NODE_ENV === "production"
    ? []
    : ["http://localhost:8080", "http://localhost:5173", "http://localhost:3000"];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow non-browser agents (mobile apps, server curls) or whitelisted web origins
      if (!origin || allowedOrigins.includes(origin) || devOrigins.includes(origin || "")) {
        callback(null, true);
      } else {
        callback(new Error("CORS origin not allowed by Burgonomics security policy"));
      }
    },
    credentials: true,
  })
);

app.use(limiter);

app.use(
  express.json({
    limit: "2mb",
    verify: (req, _res, buf) => {
      (req as any).rawBody = buf;
    },
  })
);

const REGION = "asia-south1";

// App Check attestation on app-originated routes only (monitor by default,
// enforced with APP_CHECK_ENFORCEMENT=true). Webhooks and /health are
// third-party/public and intentionally excluded.
app.use(
  [
    "/payments/createPaymentOrder",
    "/payments/verifyPayment",
    "/payments/refund",
    "/refunds/dispose",
    "/discrepancies/resolve",
    "/staff/invite",
    "/notifications/broadcast",
    "/petpooja/syncMenu",
    "/petpooja/pushOrder",
    "/petpooja/pushStock",
    "/porter/quote",
    "/porter/book",
    "/porter/rebook",
    "/porter/cancel",
    "/dispatch/quote",
    "/dispatch/book",
    "/dispatch/rebook",
    "/dispatch/porter-manual",
    "/dispatch/cancel",
    "/orders/bumpStatus",
    "/orders/verifyDeliveryOtp",
    "/orders/manualDispatch",
    "/tickets/create",
    "/tickets/message",
    "/tickets/resolve",
    "/tickets/resolveNote",
    "/tickets/escalate",
    "/notifications/dispatch",
    "/notifications/subscribe",
    "/notifications/unsubscribe",
    "/notifications/registerToken",
    "/notifications/unregisterToken",
    "/auth/setClaims",
    "/auth/assignRole",
    "/auth/revokeRole",
    "/auth/migrateGuest",
    "/auth/verifyBonusEligibility",
    "/auth/deleteAccount",
  ],
  requireAppCheck
);

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "healthy", timestamp: new Date().toISOString(), service: "burgonomics-api" });
});

// Minimum native versions, served from Firestore app_config/native (seeded by
// ops; permissive defaults keep old builds working until ops sets minimums).
// Clients compare their build and force-update when below minimum.
app.get("/config/app", async (_req, res) => {
  try {
    const { db } = await import("./core/firebase");
    const snap = await db.collection("app_config").doc("native").get();
    const data = (snap.exists ? snap.data() : undefined) as any;
    res.status(200).json({
      iosMin: data?.iosMin || "0.0.0",
      androidMin: data?.androidMin || "0.0.0",
      iosLatest: data?.iosLatest || null,
      androidLatest: data?.androidLatest || null,
      forceUpdateMessage:
        data?.forceUpdateMessage || "Please update Burgonomics to the latest version to continue.",
    });
  } catch (err: any) {
    // Config unreadable: stay permissive (clients proceed), log server-side.
    console.warn("[Config] app_config/native read failed, serving permissive defaults:", err?.message || err);
    res.status(200).json({
      iosMin: "0.0.0",
      androidMin: "0.0.0",
      iosLatest: null,
      androidLatest: null,
      forceUpdateMessage: "Please update Burgonomics to the latest version to continue.",
    });
  }
});

// ==========================================
// 1. PAYMENT ROUTES
// ==========================================

app.post("/payments/createPaymentOrder", optionalAuth, validateBody(createPaymentOrderSchema), async (req: AuthenticatedRequest, res) => {
  try {
    // P0 (auth-bound customer identity): an authenticated caller ALWAYS pays
    // as themselves — the body customerId is never honoured (it used to let
    // an anonymous caller debit ANOTHER user's loyalty coins). Unauthenticated
    // callers are "guest" only, never a body-supplied id.
    const customerId = req.user?.uid || "guest";
    // `fulfillment` is a legacy alias for orderType (spec §1) — normalize and
    // strip before the service sees the body.
    const { fulfillment: _fulfillmentAlias, ...rest } = req.body as Record<string, any>;
    const orderType = normalizeOrderType(req.body as any);
    // validateBody(createPaymentOrderSchema) guarantees items/orderType at
    // runtime; the rest-spread widens to Record<string, any>, hence the cast.
    const result = await createPaymentOrder({ ...rest, orderType, customerId } as CreateOrderParams);
    res.status(200).json(result);
  } catch (err: any) {
    // Pass through service status codes (400 validation, 503 retryable
    // outage — the client retries the SAME idempotencyKey, never a fresh one).
    const status = err.statusCode === 400 || err.statusCode === 404 || err.statusCode === 409 || err.statusCode === 503 ? err.statusCode : 500;
    res.status(status).json({ error: err.message || "Failed to create payment order", ...(err.code ? { code: err.code } : {}) });
  }
});

app.post("/payments/verifyPayment", optionalAuth, validateBody(verifyPaymentSchema), async (req: AuthenticatedRequest, res) => {
  try {
    const body = req.body as Record<string, any>;
    // Legacy shape { paymentId, orderId, signature }: the lone orderId is the
    // GATEWAY order id — the internal id resolves server-side through the
    // payment intent (spec §2). Canonical shape carries both ids.
    const params =
      typeof body.razorpayPaymentId === "string"
        ? {
            orderId: body.orderId as string,
            razorpayOrderId: body.razorpayOrderId as string,
            razorpayPaymentId: body.razorpayPaymentId as string,
            razorpaySignature: body.razorpaySignature as string,
          }
        : {
            orderId: "",
            razorpayOrderId: body.orderId as string,
            razorpayPaymentId: body.paymentId as string,
            razorpaySignature: body.signature as string,
          };
    // Ownership gating (spec §2): null = unauthenticated caller (guest) — the
    // response then carries NO order payload unless a matching guest intent
    // binds the payment. undefined would mean "trusted internal path", which
    // the HTTP surface can never produce.
    const result = await verifyPayment(
      params,
      req.user?.uid ? { uid: req.user.uid } : null
    );
    res.status(200).json(result);
  } catch (err: any) {
    // Pass through service status codes — notably 202 TRANSFER_IN_PROGRESS
    // (client retries verify with the same key in ~2s). Degrading it to 400
    // makes clients treat a live transfer as a hard failure and re-pay.
    // 401 INVALID_SIGNATURE must also pass through: collapsing a forged or
    // empty signature into a generic 400 hides an auth failure behind a
    // validation error (Track-2 mandate: signature refusals answer 401).
    const status = err.statusCode === 202 || err.statusCode === 401 || err.statusCode === 404 || err.statusCode === 409 || err.statusCode === 502 || err.statusCode === 503 ? err.statusCode : 400;
    if (err.statusCode === 202 && Number.isFinite(err.retryAfterMs)) {
      res.setHeader("Retry-After", String(Math.ceil(err.retryAfterMs / 1000)));
    }
    res.status(status).json({ error: err.message || "Payment verification failed", code: err.code });
  }
});

app.post(
  "/payments/refund",
  requireAuth,
  requireRole(["brand_owner", "developer", "support"]),
  validateBody(refundSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const result = await autoRefund(req.body, req.user);
      res.status(200).json(result);
    } catch (err: any) {
      // Pass through service status codes (400 validation, 404 not found,
      // 409 already-refunded, 502 gateway failure) so the UI can distinguish
      // "already refunded — do not retry" from retryable outages.
      const status = err.statusCode === 400 || err.statusCode === 404 || err.statusCode === 409 || err.statusCode === 502 ? err.statusCode : 500;
      res.status(status).json({ error: err.message || "Refund failed", code: err.code });
    }
  }
);

app.post("/payments/webhook", handleRazorpayWebhook);

// Loop 7/120: refund-request disposition (reject path). Staff-only, validated
// (reason required), fail-closed 404/409 from the service. Approval never
// flows through here — money release is POST /payments/refund only.
app.post(
  "/refunds/dispose",
  requireAuth,
  requireRole(["brand_owner", "developer", "support", "branch_owner", "branch_staff"]),
  validateBody(disposeRefundSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const decidedBy = req.user?.email || req.user?.uid || "staff";
      const result = await disposeRefundRequest({ ...req.body, decidedBy, caller: req.user });
      res.status(200).json(result);
    } catch (err: any) {
      const status = err.statusCode === 404 || err.statusCode === 409 ? err.statusCode : staffErrorStatus(err, 500);
      res.status(status).json({ error: err.message || "Failed to dispose refund request" });
    }
  }
);

// Loop 25/120: discrepancy resolution. Staff-only, validated, fail-closed
// 404/409 from the service. Resolving parks the ops review row as resolved
// with an attributed record — never a local-only clear.
app.post(
  "/discrepancies/resolve",
  requireAuth,
  requireRole(["brand_owner", "developer", "support", "branch_owner", "branch_staff"]),
  validateBody(resolveDiscrepancySchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const decidedBy = req.user?.email || req.user?.uid || "staff";
      const result = await resolveDiscrepancy({ ...req.body, decidedBy, caller: req.user });
      res.status(200).json(result);
    } catch (err: any) {
      const status = err.statusCode === 404 || err.statusCode === 409 ? err.statusCode : staffErrorStatus(err, 500);
      res.status(status).json({ error: err.message || "Failed to resolve discrepancy" });
    }
  }
);

// Readiness-6: server staff invite. Brand-only (route + in-function assert),
// validated (strict schema rejects PINs and unknown keys), idempotent per
// email (re-invite updates claims). Closes the Loop 43 carryover — the
// partner invite wrote rules-denied docs and failed with nowhere to go.
app.post(
  "/staff/invite",
  requireAuth,
  requireRole(["brand_owner", "developer"]),
  validateBody(InviteStaffSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const result = await inviteStaffMember(req.body, req.user);
      res.status(200).json(result);
    } catch (err: any) {
      const status =
        err.statusCode === 400 || err.statusCode === 403 || err.statusCode === 409
          ? err.statusCode
          : 500;
      res.status(status).json({ error: err.message || "Failed to invite staff member" });
    }
  }
);

// Readiness-8: customer broadcast (queued since Loop 22). Brand-only,
// validated, measured counts only — the partner drafts page finally has a
// real send path to call. Audience is all registered devices until
// segmentation lands (documented in the service).
app.post(
  "/notifications/broadcast",
  requireAuth,
  requireRole(["brand_owner", "developer"]),
  validateBody(BroadcastSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const result = await broadcastToDevices(req.body, req.user);
      res.status(200).json(result);
    } catch (err: any) {
      const status = err.statusCode === 400 ? err.statusCode : 500;
      res.status(status).json({ error: err.message || "Failed to send broadcast" });
    }
  }
);

// ==========================================
// 2. PETPOOJA POS ROUTES
// ==========================================

app.post(
  "/petpooja/syncMenu",
  requireAuth,
  requireRole(["brand_owner", "developer", "regional_manager", "branch_owner"]),
  validateBody(syncMenuSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const branchId = req.body.branchId;
      if (!branchId) {
        res.status(400).json({ error: "branchId is required" });
        return;
      }
      const result = await syncPetpoojaMenu(branchId, req.user);
      res.status(200).json(result);
    } catch (err: any) {
      res.status(staffErrorStatus(err, 500)).json({ error: err.message || "Menu sync failed" });
    }
  }
);

app.post("/petpooja/stockWebhook", verifyPetpoojaAuth, async (req, res) => {
  const p = req.body || {};
  try {
    await handlePetpoojaStockWebhook(p);
    await auditPetpoojaWebhook({
      endpoint: "/petpooja/stockWebhook",
      outcome: "ok",
      restId: p.rest_id ?? p.restID ?? p.restId ?? null,
      itemId: p.item_id ?? p.itemID ?? p.itemId ?? null,
    });
    res.status(200).json({ status: "success" });
  } catch (err: any) {
    await auditPetpoojaWebhook({
      endpoint: "/petpooja/stockWebhook",
      outcome: "error",
      restId: p.rest_id ?? p.restID ?? p.restId ?? null,
      itemId: p.item_id ?? p.itemID ?? p.itemId ?? null,
      detail: err?.message,
    });
    res.status(500).json({ error: err.message || "Stock webhook failed" });
  }
});

// Menu push webhook: Petpooja desktop POS notifies us of catalog changes and
// we re-pull the authoritative menu for the linked outlet. Fail-closed auth
// (verifyPetpoojaAuth) like every other inbound POS webhook — an
// unauthenticated menu-sync trigger would let anyone fan out catalog pulls.
app.post("/petpooja/menu-sync", verifyPetpoojaAuth, async (req, res) => {
  const p = req.body || {};
  try {
    const result = await handlePetpoojaMenuWebhook(p);
    await auditPetpoojaWebhook({
      endpoint: "/petpooja/menu-sync",
      outcome: "ok",
      restId: p.rest_id ?? p.res_id ?? p.restID ?? p.restId ?? null,
      itemCount: result.itemCount,
      detail: result.success ? undefined : "outlet not linked — catalog pull skipped",
    });
    // success:false (unlinked outlet) is still a 200 — the payload was valid,
    // there is nothing for Petpooja to retry; the skip was logged loudly.
    res.status(200).json(result);
  } catch (err: any) {
    await auditPetpoojaWebhook({
      endpoint: "/petpooja/menu-sync",
      outcome: "error",
      restId: p.rest_id ?? p.res_id ?? p.restID ?? p.restId ?? null,
      detail: err?.message,
    });
    res.status(400).json({ error: err.message || "Menu webhook failed" });
  }
});

app.post("/petpooja/webhook", verifyPetpoojaAuth, async (req, res) => {
  const p = req.body || {};
  try {
    // `petpoojaAuthenticated` is false only when the middleware admitted the call
    // by callback SHAPE (the vendor sends no credential header). The handler uses
    // it to keep sync state — the POS id and "synced" — out of reach of an
    // unauthenticated caller.
    await handlePetpoojaWebhook(p, {
      authenticated: (req as any).petpoojaAuthenticated !== false,
    });
    await auditPetpoojaWebhook({
      endpoint: "/petpooja/webhook",
      outcome: "ok",
      restId: p.rest_id ?? p.restId ?? null,
      orderId: p.order_id ?? p.clientOrderID ?? p.client_order_id ?? null,
    });
    res.status(200).json({ status: "success" });
  } catch (err: any) {
    await auditPetpoojaWebhook({
      endpoint: "/petpooja/webhook",
      outcome: "error",
      restId: p.rest_id ?? p.restId ?? null,
      orderId: p.order_id ?? p.clientOrderID ?? p.client_order_id ?? null,
      detail: err?.message,
    });
    res.status(500).json({ error: err.message || "Petpooja webhook failed" });
  }
});

app.post(
  "/petpooja/pushOrder",
  requireAuth,
  requireRole(["brand_owner", "developer", "branch_owner", "branch_staff"]),
  validateBody(pushOrderSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const orderId = req.body.orderId;
      const success = await pushOrderToPetpooja(orderId, req.user);
      res.status(200).json({ success });
    } catch (err: any) {
      res.status(staffErrorStatus(err, 500)).json({ error: err.message || "KOT push failed" });
    }
  }
);

app.post(
  "/petpooja/pushStock",
  requireAuth,
  requireRole(["brand_owner", "developer", "branch_owner", "branch_staff"]),
  validateBody(pushStockSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { branchId, itemId, inStock } = req.body;
      const success = await pushItemStockToPetpooja(branchId, itemId, inStock, req.user);
      if (!success) {
        // Fail-closed to the KDS: apiRequest only throws on non-2xx, so a
        // 200 {success:false} would read as "synced" in the Partner app and
        // the kitchen would believe a rejected/unreachable POS toggle landed.
        // 502 is retryable client-side; the failure snapshot is already
        // written server-side (item86ingSync).
        res.status(502).json({
          success: false,
          error: "Petpooja POS did not confirm the stock toggle — not synced",
        });
        return;
      }
      res.status(200).json({ success: true });
    } catch (err: any) {
      res.status(staffErrorStatus(err, 500)).json({ error: err.message || "Stock push failed" });
    }
  }
);

// MT-01: sandbox 5-scenario relay (dine-in KOT / modifiers / delivery GST+fee /
// cancel+discount / bulk). Falls back to a `pp_test_*` order id ONLY in mock
// mode; a live relay must return a real Petpooja order id or it throws.
app.post(
  "/petpooja/testRunner",
  requireAuth,
  requireRole([
    "brand_owner",
    "developer",
    "branch_owner",
    "branch_staff",
    "superadmin",
    "manager",
  ]),
  validateBody(petpoojaTestRunnerSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const result = await runPetpoojaTestScenario(req.body, req.user);
      res.status(200).json(result);
    } catch (err: any) {
      // 403 = the zero-mock production refusal raised by the runner itself;
      // any other failure stays 500.
      res
        .status(err.statusCode === 403 ? 403 : 500)
        .json({ error: err.message || "Petpooja test runner failed" });
    }
  }
);

// ==========================================
// 3. PORTER DELIVERY ROUTES
// ==========================================

app.post("/porter/quote", optionalAuth, validateBody(porterQuoteSchema), async (req: AuthenticatedRequest, res) => {
  try {
    const quote = await getDeliveryQuote(req.body);
    res.status(200).json(quote);
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to calculate Porter quote" });
  }
});

app.post(
  "/porter/book",
  requireAuth,
  requireRole(["brand_owner", "developer", "branch_owner", "branch_staff"]),
  validateBody(porterBookSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { orderId, staffName } = req.body;
      const result = await bookPorterRider(
        orderId,
        staffName || req.user?.email || "Branch Staff",
        req.user
      );
      res.status(200).json(result);
    } catch (err: any) {
      res.status(staffErrorStatus(err, 500)).json({ error: err.message || "Failed to dispatch Porter rider" });
    }
  }
);

app.post(
  "/porter/rebook",
  requireAuth,
  requireRole(["brand_owner", "developer", "branch_owner", "branch_staff"]),
  validateBody(porterBookSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { orderId, staffName } = req.body;
      const result = await rebookPorterRider(
        orderId,
        staffName || req.user?.email || "Branch Staff",
        req.user
      );
      res.status(200).json(result);
    } catch (err: any) {
      res.status(staffErrorStatus(err, 500)).json({ error: err.message || "Failed to re-book Porter rider" });
    }
  }
);

app.post(
  "/porter/cancel",
  requireAuth,
  requireRole(["brand_owner", "developer", "branch_owner", "branch_staff"]),
  validateBody(porterCancelSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { orderId, staffName } = req.body;
      const result = await cancelPorterBooking(
        orderId,
        staffName || req.user?.email || "Branch Staff",
        req.user
      );
      res.status(200).json(result);
    } catch (err: any) {
      const status =
        err.statusCode === 404 || err.statusCode === 409
          ? err.statusCode
          : staffErrorStatus(err, 500);
      res.status(status).json({ error: err.message || "Failed to cancel Porter booking" });
    }
  }
);

// ==========================================
// 3b. MULTI-PROVIDER DISPATCH ROUTES (delivery_routing.md)
// ==========================================

// Typed dispatch errors carry an explicit statusCode (202/400/404/409/422/
// 502/503) so staff UI can branch on the exact failure; everything else
// falls back to staffErrorStatus. 202 = dispatch already in flight; carries
// Retry-After so the client's retry lands after the claim settles.
function dispatchErrorStatus(err: any): number {
  const known = [202, 400, 404, 409, 422, 502, 503];
  return known.includes(err?.statusCode) ? err.statusCode : staffErrorStatus(err, 500);
}

function sendDispatchError(res: Response, err: any, fallback: string): void {
  const status = dispatchErrorStatus(err);
  if (status === 202) {
    res.setHeader("Retry-After", String(Math.ceil((err?.retryAfterMs || 2000) / 1000)));
  }
  const extra: Record<string, any> = {};
  if (err?.attempts) extra.attempts = err.attempts;
  if (err?.providers) extra.providers = err.providers;
  if (err?.retryAfterMs) extra.retryAfterMs = err.retryAfterMs;
  res.status(status).json({ error: err?.message || fallback, ...extra });
}

app.post("/dispatch/quote", optionalAuth, validateBody(dispatchQuoteSchema), async (req: AuthenticatedRequest, res) => {
  try {
    const quote = await dispatchQuote(req.body);
    res.status(200).json(quote);
  } catch (err: any) {
    sendDispatchError(res, err, "Failed to calculate dispatch quote");
  }
});

app.post(
  "/dispatch/book",
  requireAuth,
  requireRole(["brand_owner", "developer", "branch_owner", "branch_staff"]),
  validateBody(dispatchBookSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const result = await dispatchBook({
        ...req.body,
        staffName: req.body.staffName || req.user?.email || "Branch Staff",
        caller: req.user,
      });
      res.status(200).json(result);
    } catch (err: any) {
      sendDispatchError(res, err, "Failed to dispatch order");
    }
  }
);

app.post(
  "/dispatch/rebook",
  requireAuth,
  requireRole(["brand_owner", "developer", "branch_owner", "branch_staff"]),
  validateBody(dispatchRebookSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const result = await dispatchRebook({
        ...req.body,
        staffName: req.body.staffName || req.user?.email || "Branch Staff",
        caller: req.user,
      });
      res.status(200).json(result);
    } catch (err: any) {
      sendDispatchError(res, err, "Failed to rebook dispatch");
    }
  }
);

app.post(
  "/dispatch/porter-manual",
  requireAuth,
  requireRole(["brand_owner", "developer", "branch_owner", "branch_staff"]),
  validateBody(dispatchPorterManualSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const result = await savePorterManualBooking({
        ...req.body,
        staffName: req.body.staffName || req.user?.email || "Branch Staff",
        caller: req.user,
      });
      res.status(200).json(result);
    } catch (err: any) {
      sendDispatchError(res, err, "Failed to save Porter booking");
    }
  }
);

app.post(
  "/dispatch/cancel",
  requireAuth,
  requireRole(["brand_owner", "developer", "branch_owner", "branch_staff"]),
  validateBody(dispatchCancelSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const result = await dispatchCancel({
        orderId: req.body.orderId,
        staffName: req.body.staffName || req.user?.email || "Branch Staff",
        caller: req.user,
      });
      res.status(200).json(result);
    } catch (err: any) {
      sendDispatchError(res, err, "Failed to cancel dispatch");
    }
  }
);

app.post("/dispatch/webhooks/borzo", async (req, res) => {
  try {
    // Official header is X-DV-Signature (HMAC-SHA256 with the Callback Secret
    // Key); x-borzo-signature kept as a fallback for pre-doc wiring/tests.
    const signature =
      (req.headers["x-dv-signature"] as string) ||
      (req.headers["x-borzo-signature"] as string) ||
      "";
    const rawBody = (req as any).rawBody
      ? (req as any).rawBody.toString("utf8")
      : typeof req.body === "string"
      ? req.body
      : JSON.stringify(req.body);
    await handleDispatchWebhook("borzo", rawBody, signature, req.body);
    res.status(200).json({ status: "success" });
  } catch (err: any) {
    res.status(err?.statusCode || staffErrorStatus(err, 500)).json({ error: err.message || "Borzo webhook failed" });
  }
});

app.post("/dispatch/webhooks/shadowfax", async (req, res) => {
  try {
    const signature = (req.headers["x-shadowfax-signature"] as string) || "";
    const rawBody = (req as any).rawBody
      ? (req as any).rawBody.toString("utf8")
      : typeof req.body === "string"
      ? req.body
      : JSON.stringify(req.body);
    await handleDispatchWebhook("shadowfax", rawBody, signature, req.body);
    res.status(200).json({ status: "success" });
  } catch (err: any) {
    res.status(err?.statusCode || staffErrorStatus(err, 500)).json({ error: err.message || "Shadowfax webhook failed" });
  }
});

app.post(
  "/orders/bumpStatus",
  requireAuth,
  requireRole(["brand_owner", "developer", "branch_owner", "branch_staff"]),
  validateBody(orderBumpSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const result = await bumpOrderStatus({ ...req.body, caller: req.user });
      res.status(200).json(result);
    } catch (err: any) {
      const status =
        err.statusCode === 400 || err.statusCode === 404
          ? err.statusCode
          : staffErrorStatus(err, 500);
      res.status(status).json({ error: err.message || "Failed to update order status" });
    }
  }
);

app.post("/porter/webhook", async (req, res) => {
  try {
    const signature = req.headers["x-porter-signature"] as string;
    const rawBody = (req as any).rawBody
      ? (req as any).rawBody.toString("utf8")
      : typeof req.body === "string"
      ? req.body
      : JSON.stringify(req.body);
    await handlePorterWebhook(rawBody, signature, req.body);
    res.status(200).json({ status: "success" });
  } catch (err: any) {
    // F1: auth failures (bad signature → 401) must not 500 — Porter would
    // retry a permanently-invalid request forever and ops sees a fake outage.
    // statusCode passthrough first (the handler sets 401 explicitly);
    // staffErrorStatus covers message-prefixed errors as fallback.
    res.status((err as any)?.statusCode || staffErrorStatus(err, 500)).json({ error: err.message || "Porter webhook failed" });
  }
});

app.post("/orders/verifyDeliveryOtp",
  // Staff-only: the OTP is a customer-possession secret read off the customer
  // screen. Anonymous verification would let anyone burn attempts or flip an
  // order to DELIVERED with a guessed 4-digit code.
  requireAuth,
  requireRole(["brand_owner", "developer", "branch_owner", "branch_staff"]),
  validateBody(verifyDeliveryOtpSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const staffName = req.user?.email || req.body.staffName || "Branch Staff";
      const result = await verifyDeliveryOtp({ ...req.body, staffName, caller: req.user });
      res.status(200).json(result);
    } catch (err: any) {
      res.status(staffErrorStatus(err, 400)).json({ error: err.message || "OTP verification failed" });
    }
  }
);

app.post(
  "/orders/manualDispatch",
  requireAuth,
  requireRole(["brand_owner", "developer", "branch_owner", "branch_staff"]),
  validateBody(manualDispatchSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const staffName = req.user?.email || req.body.staffName || "Branch Staff";
      const result = await manualBranchDispatch({ ...req.body, staffName, caller: req.user });
      res.status(200).json(result);
    } catch (err: any) {
      res.status(staffErrorStatus(err, 500)).json({ error: err.message || "Manual dispatch failed" });
    }
  }
);

// ==========================================
// 4. SUPPORT TICKETING & ESCALATOR ROUTES
// ==========================================

app.post("/tickets/create", requireAuth, validateBody(createTicketSchema), async (req: AuthenticatedRequest, res) => {
  try {
    const customerId = req.user?.uid || req.body.customerId;
    // Bind the verified caller so customerId cannot be stamped for another
    // user and per-customer spam guards key on the real uid.
    const result = await createTicket({ ...req.body, customerId, caller: req.user });
    res.status(200).json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to create support ticket" });
  }
});

app.post("/tickets/message", requireAuth, validateBody(ticketMessageSchema), async (req: AuthenticatedRequest, res) => {
  try {
    // Role is derived from auth claims ONLY. The old req.body.senderRole
    // fallback let any authed caller post as any role to any ticket
    // (Loop 57/58 adversarial finding) — the service enforces visibility.
    const senderId = req.user?.uid || req.body.senderId;
    const senderRole = (req.user as any)?.role || "customer";
    const caller = req.user
      ? {
          uid: req.user.uid,
          role: (req.user as any)?.role as string | undefined,
          branchIds: (req.user as any)?.branchIds as string[] | undefined,
        }
      : undefined;
    const result = await addTicketMessage({ ...req.body, senderId, senderRole, caller });
    res.status(200).json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to add message" });
  }
});

app.post(
  "/tickets/resolve",
  requireAuth,
  requireRole(["brand_owner", "developer", "support", "branch_owner", "branch_staff"]),
  validateBody(resolveTicketSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const resolvedBy = req.user?.uid || req.body.resolvedBy;
      // Loop 7: pass the authenticated caller so the in-function staff +
      // branch guards actually execute (never rely on req.body roles).
      const caller = req.user
        ? {
            uid: req.user.uid,
            role: (req.user as any)?.role as string | undefined,
            branchIds: (req.user as any)?.branchIds as string[] | undefined,
          }
        : undefined;
      const result = await resolveTicket({ ...req.body, resolvedBy, caller });
      res.status(200).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to resolve ticket" });
    }
  }
);

app.post(
  "/tickets/escalate",
  requireAuth,
  requireRole(["brand_owner", "developer", "support", "branch_owner", "branch_staff"]),
  validateBody(escalateTicketSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const escalatedBy = req.user?.uid || req.body.escalatedBy;
      // Loop 7: same caller passthrough as /tickets/resolve (see above).
      const caller = req.user
        ? {
            uid: req.user.uid,
            role: (req.user as any)?.role as string | undefined,
            branchIds: (req.user as any)?.branchIds as string[] | undefined,
          }
        : undefined;
      const result = await escalateTicket({ ...req.body, escalatedBy, caller });
      res.status(200).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to escalate ticket" });
    }
  }
);

// Non-money ticket resolution note (staff-only, branch-scoped, timeline-
// appended). Money actions stay on /tickets/resolve; this route must never
// move funds.
app.post(
  "/tickets/resolveNote",
  requireAuth,
  requireRole(["brand_owner", "developer", "support", "branch_owner", "branch_staff"]),
  validateBody(resolveNoteSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const result = await resolveTicketNote({ ...req.body, caller: req.user });
      res.status(200).json(result);
    } catch (err: any) {
      const status =
        err.statusCode === 404 || err.statusCode === 409
          ? err.statusCode
          : staffErrorStatus(err, 500);
      res.status(status).json({ error: err.message || "Failed to resolve ticket" });
    }
  }
);

// Staff Grill-Coins compensation. Branch-scoped server-side: the partner app
// must never write loyaltyPoints directly (rules forbid non-brand writes, and
// local-only "success" toasts were compensating nobody).
app.post(
  "/customers/adjustCoins",
  requireAuth,
  requireRole(["brand_owner", "developer", "support", "branch_owner", "branch_staff"]),
  validateBody(adjustCoinsSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const result = await adjustCustomerCoins(req.body, req.user);
      res.status(200).json(result);
    } catch (err: any) {
      res.status(staffErrorStatus(err, 500)).json({ error: err.message || "Failed to adjust Grill Coins" });
    }
  }
);

// ==========================================
// 5. FCM NOTIFICATIONS & AUTH ROUTES
// ==========================================

app.post(
  "/notifications/dispatch",
  requireAuth,
  requireRole(["brand_owner", "developer", "support", "branch_owner"]),
  validateBody(dispatchNotificationSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      // Topic/token validation already done by schema; enforce role scoping
      const { topic, token, title, body, data } = req.body as {
        topic?: string;
        token?: string;
        title: string;
        body: string;
        data?: Record<string, string>;
      };
      const role = (req.user as any)?.role as string | undefined;
      const isBrandAdmin =
        (req.user as any)?.isBrandAdmin === true || role === "brand_owner" || role === "developer";
      if (topic) {
        const clean = filterSubscribableTopics([topic], { role, isBrandAdmin });
        if (clean.length === 0) {
          res.status(403).json({ error: "Forbidden: topic is outside your role scope" });
          return;
        }
        if (!isBrandAdmin) {
          const m = /^branch_([A-Za-z0-9_-]+)_(orders|tickets)$/.exec(topic);
          const branchIds = Array.isArray((req.user as any)?.branchIds)
            ? ((req.user as any).branchIds as unknown[]).filter((b): b is string => typeof b === "string")
            : [];
          if (m && !branchIds.includes(m[1])) {
            res.status(403).json({ error: "Forbidden: topic is outside your assigned branches" });
            return;
          }
        }
      } else {
        // Token path
        if (!isBrandAdmin) {
          const { db } = await import("./core/firebase");
          const tokenDoc = await db.collection("device_tokens").doc(token as string).get();
          if (!tokenDoc.exists) {
            res.status(403).json({ error: "Forbidden: token is not a registered device" });
            return;
          }
        }
      }
      const success = await dispatchFCM({ topic, token, title, body, data });
      res.status(200).json({ success });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to dispatch notification" });
    }
  }
);

// Device token registration: the single server-owned entry point for push
// identity. Clients previously wrote users/{uid}.fcmTokens + device_tokens
// directly (no validation, no platform/version metadata, no ownership proof
// beyond rules). This endpoint validates, stamps metadata, and links both.
app.post("/notifications/registerToken", requireAuth, validateBody(registerTokenSchema), async (req: AuthenticatedRequest, res) => {
  try {
    const { token, platform, appVersion } = req.body as {
      token?: string;
      platform?: string;
      appVersion?: string;
    };
    if (!token || typeof token !== "string" || token.length < 10 || token.length > 500) {
      res.status(400).json({ error: "valid token is required" });
      return;
    }
    if (platform !== undefined && !["ios", "android", "web"].includes(platform)) {
      res.status(400).json({ error: "platform must be ios, android, or web" });
      return;
    }
    const { db } = await import("./core/firebase");
    const uid = req.user?.uid;
    if (!uid) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const now = admin.firestore.FieldValue.serverTimestamp();
    await db
      .collection("device_tokens")
      .doc(token)
      .set(
        { token, userId: uid, platform: platform || "unknown", appVersion: appVersion || null, updatedAt: now },
        { merge: true }
      );
    await db
      .collection("users")
      .doc(uid)
      .set(
        { fcmTokens: admin.firestore.FieldValue.arrayUnion(token), updatedAt: now },
        { merge: true }
      );
    res.status(200).json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to register token" });
  }
});

// Device detach on logout (Loop 37/120): deletes the token identity and
// scrubs every fan-out list via Admin SDK. RequireAuth (call pre-signout).
// Unknown tokens succeed — logout must never fail on already-clean state.
app.post("/notifications/unregisterToken", requireAuth, validateBody(unregisterTokenSchema), async (req: AuthenticatedRequest, res) => {
  try {
    const { token } = req.body as { token?: string };
    if (!token || typeof token !== "string" || token.length < 10 || token.length > 500) {
      res.status(400).json({ error: "valid token is required" });
      return;
    }
    const result = await unregisterDeviceToken({ token, uid: req.user?.uid });
    res.status(200).json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to unregister token" });
  }
});

// Device → topic subscription (FCM topics can only be subscribed
// server-side; clients call this after push registration and branch switch).
// Escalation fan-out topics (regional_managers, superadmins, tickets_escalated)
// were published but UNSUBSCRIBABLE — every push went nowhere. They are now
// subscribable with role checks; branch topics stay ownership-checked via token.
app.post("/notifications/subscribe", requireAuth, validateBody(topicSubscriptionSchema), async (req: AuthenticatedRequest, res) => {
  try {
    const { token, topics } = req.body as { token?: string; topics?: string[] };
    if (!token || !Array.isArray(topics) || topics.length === 0) {
      res.status(400).json({ error: "token and non-empty topics[] are required" });
      return;
    }
    const role = (req.user as any)?.role as string | undefined;
    const isBrandAdmin =
      (req.user as any)?.isBrandAdmin === true || role === "brand_owner" || role === "developer";
    // Loop 4/120: branch operational topics are staff-only (customers could
    // attach any branch's KOT/ticket pushes to their own token).
    const clean = filterSubscribableTopics(topics, { role, isBrandAdmin });
    if (clean.length === 0) {
      res.status(400).json({ error: "no subscribable branch topics" });
      return;
    }
    const { db, messaging } = await import("./core/firebase");
    const tokenDoc = await db.collection("device_tokens").doc(token).get();
    const ownerId = tokenDoc.exists ? (tokenDoc.data() as any)?.userId : undefined;
    if (ownerId && ownerId !== req.user?.uid) {
      res.status(403).json({ error: "token belongs to a different user" });
      return;
    }
    const results = await Promise.all(
      clean.map((topic) => messaging.subscribeToTopic(token, topic))
    );
    const failures = results.filter((r) => r.failureCount > 0).length;
    res.status(200).json({ success: failures === 0, subscribed: clean, failures });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to subscribe topics" });
  }
});

// Release stale branch topics on account/branch switch or sign-out —
// otherwise the previous outlet keeps paging this terminal. Same shape,
// same guards as subscribe.
app.post("/notifications/unsubscribe", requireAuth, validateBody(topicSubscriptionSchema), async (req: AuthenticatedRequest, res) => {
  try {
    const { token, topics } = req.body as { token?: string; topics?: string[] };
    if (!token || !Array.isArray(topics) || topics.length === 0) {
      res.status(400).json({ error: "token and non-empty topics[] are required" });
      return;
    }
    const role = (req.user as any)?.role as string | undefined;
    const isBrandAdmin =
      (req.user as any)?.isBrandAdmin === true || role === "brand_owner" || role === "developer";
    // Loop 4/120: same staff-only branch-topic filter as subscribe, plus the
    // token-ownership check subscribe already had (unsubscribing someone
    // else's token must 403, not silently detach their kitchen alerts).
    const clean = filterSubscribableTopics(topics, { role, isBrandAdmin });
    if (clean.length === 0) {
      res.status(400).json({ error: "no unsubscribable topics" });
      return;
    }
    const { db, messaging } = await import("./core/firebase");
    const tokenDoc = await db.collection("device_tokens").doc(token).get();
    const ownerId = tokenDoc.exists ? (tokenDoc.data() as any)?.userId : undefined;
    if (ownerId && ownerId !== req.user?.uid) {
      res.status(403).json({ error: "token belongs to a different user" });
      return;
    }
    const results = await Promise.all(
      clean.map((topic) => messaging.unsubscribeFromTopic(token, topic))
    );
    const failures = results.filter((r) => r.failureCount > 0).length;
    res.status(200).json({ success: failures === 0, unsubscribed: clean, failures });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to unsubscribe topics" });
  }
});

app.post(
  "/auth/setClaims",
  requireAuth,
  requireRole(["brand_owner", "developer"]),
  validateBody(setClaimsSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      // Loop 7: pass the caller — without it the in-function
      // assertCallerCanAssignRole always throws (legit brand calls 500).
      const result = await setUserCustomClaims(req.body, req.user as any);
      res.status(200).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to set custom claims" });
    }
  }
);

app.post(
  "/auth/assignRole",
  requireAuth,
  validateBody(assignRoleSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const result = await assignUserRole(req.user, req.body);
      res.status(200).json(result);
    } catch (err: any) {
      const status = err.message?.includes("Permission denied") ? 403 : 400;
      res.status(status).json({ error: err.message || "Failed to assign user role" });
    }
  }
);

app.post(
  "/auth/revokeRole",
  requireAuth,
  validateBody(revokeRoleSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const targetUid = req.body.targetUid || req.body.uid;
      const result = await revokeUserRole(req.user, targetUid);
      res.status(200).json(result);
    } catch (err: any) {
      const status = err.message?.includes("Permission denied") ? 403 : 400;
      res.status(status).json({ error: err.message || "Failed to revoke user role" });
    }
  }
);

app.post(
  "/auth/migrateGuest",
  requireAuth,
  validateBody(migrateGuestSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const permanentUid = req.user?.uid || req.body.permanentUid;
      if (!permanentUid) {
        res.status(400).json({ error: "Missing authenticated customer UID" });
        return;
      }
      const result = await migrateGuestAccount({
        ...req.body,
        permanentUid,
        phone: req.body.phone || (req.user as any)?.phone_number,
        email: req.body.email || (req.user as any)?.email,
      });
      res.status(200).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to migrate guest session" });
    }
  }
);

app.post(
  "/auth/verifyBonusEligibility",
  requireAuth,
  validateBody(verifyBonusSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const phone = req.body.phone || (req.user as any)?.phone_number;
      const uid = req.user?.uid || req.body.uid;
      const result = await verifyBonusEligibility(phone, uid);
      res.status(200).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to verify bonus eligibility" });
    }
  }
);

// Account erasure (Loop 50/120 — DPDP right): deletes the caller's own Auth
// user ONLY (uid from verified token, never the body) after explicit
// confirmation. The deletion trigger scrubs carts/admins/PII.
app.post(
  "/auth/deleteAccount",
  requireAuth,
  validateBody(deleteAccountSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      if (req.body?.confirm !== true) {
        res.status(400).json({ error: "Account deletion requires explicit confirmation." });
        return;
      }
      const uid = req.user?.uid;
      if (!uid) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      const result = await deleteUserAccount(uid);
      res.status(200).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to delete account" });
    }
  }
);

// Primary HTTP Entrypoint with Cloud Functions v2 resource bounds
export const api = onRequest(
  {
    region: REGION,
    cors: false,
    memory: "512MiB",
    maxInstances: 20,
    timeoutSeconds: 60,
    concurrency: 80,
    invoker: "public",
  },
  app
);

// ==========================================
// 6. CLOUD SCHEDULERS
// ==========================================

export const hourlyPetpoojaMenuSync = onSchedule(
  {
    region: REGION,
    schedule: "0 * * * *", // Hourly
    timeZone: "Asia/Kolkata",
  },
  async () => {
    // Whole-run overlap guard (TTL < cadence, >> 60s function timeout):
    // a still-running tick makes the next one skip instead of double-scan.
    const { ran, result } = await withSchedulerLock(
      "hourly-petpooja-menu-sync",
      30 * 60 * 1000,
      () => syncAllBranchesPetpoojaMenu()
    );
    if (!ran) {
      console.log("[Hourly Sync] previous tick still running — skipped");
      return;
    }
    console.log(`[Hourly Sync] Processed ${result!.syncedBranches} branches`);
  }
);

export const retryPetpoojaOrders = onSchedule(
  {
    region: REGION,
    schedule: "*/5 * * * *", // Every 5 minutes
    timeZone: "Asia/Kolkata",
  },
  async () => {
    const { ran, result } = await withSchedulerLock(
      "retry-petpooja-orders",
      4 * 60 * 1000,
      () => retryPendingPetpoojaOrdersWorker()
    );
    if (!ran) {
      console.log("[Retry Worker] previous tick still running — skipped");
      return;
    }
    console.log(`[Retry Worker] Retried ${result!.retriedCount} KOT orders`);
  }
);

export const retryRouteTransfers = onSchedule(
  {
    region: REGION,
    schedule: "*/5 * * * *", // Every 5 minutes
    timeZone: "Asia/Kolkata",
  },
  async () => {
    const { ran, result } = await withSchedulerLock(
      "retry-route-transfers",
      4 * 60 * 1000,
      () => retryPendingRouteTransfersWorker()
    );
    if (!ran) {
      console.log("[Route Transfer Retry Worker] previous tick still running — skipped");
      return;
    }
    console.log(`[Route Transfer Retry Worker] Retried ${result!.retriedCount} transfers`);
  }
);

export const ticketInactivityReminder = onSchedule(
  {
    region: REGION,
    schedule: "*/15 * * * *", // Every 15 minutes
    timeZone: "Asia/Kolkata",
  },
  async () => {
    const { ran, result } = await withSchedulerLock(
      "ticket-inactivity-reminder",
      10 * 60 * 1000,
      () => checkTicketInactivityReminders()
    );
    if (!ran) {
      console.log("[Ticket Inactivity Worker] previous tick still running — skipped");
      return;
    }
    console.log(`[Ticket Inactivity Worker] Sent ${result!.remindedCount} reminders`);
  }
);

export const pollActivePorterDeliveries = onSchedule(
  {
    region: REGION,
    schedule: "*/5 * * * *", // Every 5 minutes
    timeZone: "Asia/Kolkata",
  },
  async () => {
    const { ran, result } = await withSchedulerLock(
      "poll-active-porter",
      4 * 60 * 1000,
      () => pollActivePorterOrdersWorker()
    );
    if (!ran) {
      console.log("[Porter Polling Worker] previous tick still running — skipped");
      return;
    }
    console.log(
      `[Porter Polling Worker] Polled ${result!.polledCount} orders, updated ${result!.updatedCount} orders`
    );
  }
);

// Auto-rebook worker (mission §3): sweeps orders a CARRIER cancelled (or a
// dispatch that failed) and re-dispatches with the NEXT alternative provider —
// never the one that cancelled, never a staff cancel, never past
// AUTO_REBOOK_MAX_ATTEMPTS. Dead code until this wiring: without a schedule a
// `carrier_cancelled` order sat waiting for a manual rebook forever.
export const autoRebookCancelledDispatches = onSchedule(
  {
    region: REGION,
    schedule: "*/5 * * * *", // Every 5 minutes
    timeZone: "Asia/Kolkata",
  },
  async () => {
    const { ran, result } = await withSchedulerLock(
      "auto-rebook-dispatch",
      4 * 60 * 1000,
      () => autoRebookDispatchWorker()
    );
    if (!ran) {
      console.log("[Auto Rebook Worker] previous tick still running — skipped");
      return;
    }
    console.log(
      `[Auto Rebook Worker] scanned ${result!.scanned} — rebooked ${result!.rebooked}, failed ${result!.failed}, busy ${result!.busy}, skipped ${result!.skipped}, exhausted ${result!.exhausted}`
    );
  }
);

export const cleanupExpiredGuestSessions = onSchedule(
  {
    region: REGION,
    schedule: "0 3 * * *", // Daily at 3:00 AM IST
    timeZone: "Asia/Kolkata",
  },
  async () => {
    const { ran, result } = await withSchedulerLock(
      "cleanup-guest-sessions",
      12 * 60 * 60 * 1000,
      () => cleanupExpiredGuestSessionsWorker()
    );
    if (!ran) {
      console.log("[Guest Cleanup Worker] previous run still active — skipped");
      return;
    }
    console.log(`[Guest Cleanup Worker] Purged ${result!.cleanedCartsCount} expired guest carts`);
  }
);

// ==========================================
// 7. AUTH + FIRESTORE TRIGGERS
// ==========================================

// Revokes staff access and strips PII when an Auth account is deleted.
// onUserDeletedCleanup was dead code until this wiring — no trigger existed.
export const onAuthUserDeletedCleanup = functionsV1
  .region(REGION)
  .auth.user()
  .onDelete(async (deletedUser) => {
    const ok = await onUserDeletedCleanup(deletedUser.uid);
    console.log(`[Auth Cleanup] User deletion cleanup ${ok ? "done" : "FAILED"}`);
  });

export {
  onOrderCreatedNotificationTrigger,
  onOrderStatusChangedNotificationTrigger,
  onTicketCreatedUrgentTrigger,
  onTicketEscalatedNotificationTrigger,
} from "./modules/notifications";


