import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
// v2/identity has no user-delete trigger — v1 auth.user().onDelete is the
// only Auth deletion hook. (beforeUserCreated/SignedIn are create/sign-in only.)
import * as functionsV1 from "firebase-functions/v1";
import express from "express";
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
} from "./modules/payments/razorpay.service";
import { handleRazorpayWebhook } from "./modules/payments/razorpay.webhook";
import {
  syncPetpoojaMenu,
  handlePetpoojaStockWebhook,
  handlePetpoojaWebhook,
  pushOrderToPetpooja,
  pushItemStockToPetpooja,
} from "./modules/petpooja";
import {
  syncAllBranchesPetpoojaMenu,
  retryPendingPetpoojaOrdersWorker,
} from "./modules/petpooja/petpooja.scheduler";
import {
  getDeliveryQuote,
  bookPorterRider,
  handlePorterWebhook,
  rebookPorterRider,
  verifyDeliveryOtp,
  manualBranchDispatch,
  pollActivePorterOrdersWorker,
} from "./modules/porter/porter.service";
import {
  createTicket,
  addTicketMessage,
  resolveTicket,
  escalateTicket,
} from "./modules/tickets/tickets.service";
import { checkTicketInactivityReminders } from "./modules/tickets/ticketReminder.scheduler";
import { dispatchFCM } from "./modules/notifications/fcm.service";
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
  createPaymentOrderSchema,
  verifyPaymentSchema,
  refundSchema,
  pushOrderSchema,
  syncMenuSchema,
  pushStockSchema,
  porterBookSchema,
  porterQuoteSchema,
  verifyDeliveryOtpSchema,
  manualDispatchSchema,
  adjustCoinsSchema,
} from "./core/validation";

// Enforce live production keys check on deployment
assertProductionKeys();

// Rate limiting middleware
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: { error: "Too many requests from this IP, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

const app = express();

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
    "/petpooja/syncMenu",
    "/petpooja/pushOrder",
    "/petpooja/pushStock",
    "/porter/quote",
    "/porter/book",
    "/porter/rebook",
    "/orders/verifyDeliveryOtp",
    "/orders/manualDispatch",
    "/tickets/create",
    "/tickets/message",
    "/tickets/resolve",
    "/tickets/escalate",
    "/notifications/dispatch",
    "/notifications/subscribe",
    "/auth/setClaims",
    "/auth/assignRole",
    "/auth/revokeRole",
    "/auth/migrateGuest",
    "/auth/verifyBonusEligibility",
  ],
  requireAppCheck
);

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "healthy", timestamp: new Date().toISOString(), service: "burgonomics-api" });
});

// ==========================================
// 1. PAYMENT ROUTES
// ==========================================

app.post("/payments/createPaymentOrder", optionalAuth, validateBody(createPaymentOrderSchema), async (req: AuthenticatedRequest, res) => {
  try {
    const customerId = req.user?.uid || req.body.customerId || "guest";
    const result = await createPaymentOrder({ ...req.body, customerId });
    res.status(200).json(result);
  } catch (err: any) {
    // Pass through service status codes (400 validation, 503 retryable
    // outage — the client retries the SAME idempotencyKey, never a fresh one).
    const status = err.statusCode === 400 || err.statusCode === 503 ? err.statusCode : 500;
    res.status(status).json({ error: err.message || "Failed to create payment order" });
  }
});

app.post("/payments/verifyPayment", optionalAuth, validateBody(verifyPaymentSchema), async (req: AuthenticatedRequest, res) => {
  try {
    const result = await verifyPayment(req.body);
    res.status(200).json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message || "Payment verification failed" });
  }
});

app.post(
  "/payments/refund",
  requireAuth,
  requireRole(["brand_owner", "developer", "support"]),
  validateBody(refundSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const result = await autoRefund(req.body);
      res.status(200).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Refund failed" });
    }
  }
);

app.post("/payments/webhook", handleRazorpayWebhook);

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
      const result = await syncPetpoojaMenu(branchId);
      res.status(200).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Menu sync failed" });
    }
  }
);

app.post("/petpooja/stockWebhook", verifyPetpoojaAuth, async (req, res) => {
  try {
    await handlePetpoojaStockWebhook(req.body);
    res.status(200).json({ status: "success" });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Stock webhook failed" });
  }
});

app.post("/petpooja/webhook", verifyPetpoojaAuth, async (req, res) => {
  try {
    await handlePetpoojaWebhook(req.body);
    res.status(200).json({ status: "success" });
  } catch (err: any) {
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
      const success = await pushOrderToPetpooja(orderId);
      res.status(200).json({ success });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "KOT push failed" });
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
      const success = await pushItemStockToPetpooja(branchId, itemId, inStock);
      res.status(200).json({ success });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Stock push failed" });
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
    res.status(500).json({ error: err.message || "Porter webhook failed" });
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

app.post("/tickets/create", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const customerId = req.user?.uid || req.body.customerId;
    const result = await createTicket({ ...req.body, customerId });
    res.status(200).json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to create support ticket" });
  }
});

app.post("/tickets/message", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const senderId = req.user?.uid || req.body.senderId;
    const senderRole = req.user?.role || req.body.senderRole || "customer";
    const result = await addTicketMessage({ ...req.body, senderId, senderRole });
    res.status(200).json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to add message" });
  }
});

app.post(
  "/tickets/resolve",
  requireAuth,
  requireRole(["brand_owner", "developer", "support", "branch_owner", "branch_staff"]),
  async (req: AuthenticatedRequest, res) => {
    try {
      const resolvedBy = req.user?.uid || req.body.resolvedBy;
      const result = await resolveTicket({ ...req.body, resolvedBy });
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
  async (req: AuthenticatedRequest, res) => {
    try {
      const escalatedBy = req.user?.uid || req.body.escalatedBy;
      const result = await escalateTicket({ ...req.body, escalatedBy });
      res.status(200).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to escalate ticket" });
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
  async (req: AuthenticatedRequest, res) => {
    try {
      const success = await dispatchFCM(req.body);
      res.status(200).json({ success });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to dispatch notification" });
    }
  }
);

// Device → branch topic subscription (FCM topics can only be subscribed
// server-side; clients call this after push registration and branch switch).
// Allowlisted to branch topics AND ownership-checked: any authed user could
// otherwise subscribe anyone's token to any topic (notification hijack).
app.post("/notifications/subscribe", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { token, topics } = req.body as { token?: string; topics?: string[] };
    if (!token || !Array.isArray(topics) || topics.length === 0) {
      res.status(400).json({ error: "token and non-empty topics[] are required" });
      return;
    }
    const clean = [...new Set(topics)]
      .filter((t) => /^branch_[A-Za-z0-9_-]+_(orders|tickets)$/.test(t))
      .slice(0, 10);
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

app.post(
  "/auth/setClaims",
  requireAuth,
  requireRole(["brand_owner", "developer"]),
  async (req: AuthenticatedRequest, res) => {
    try {
      const result = await setUserCustomClaims(req.body);
      res.status(200).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to set custom claims" });
    }
  }
);

app.post(
  "/auth/assignRole",
  requireAuth,
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

// Primary HTTP Entrypoint with Cloud Functions v2 resource bounds
export const api = onRequest(
  {
    region: REGION,
    cors: false,
    memory: "512MiB",
    maxInstances: 20,
    timeoutSeconds: 60,
    concurrency: 80,
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
    const result = await syncAllBranchesPetpoojaMenu();
    console.log(`[Hourly Sync] Processed ${result.syncedBranches} branches`);
  }
);

export const retryPetpoojaOrders = onSchedule(
  {
    region: REGION,
    schedule: "*/5 * * * *", // Every 5 minutes
    timeZone: "Asia/Kolkata",
  },
  async () => {
    const result = await retryPendingPetpoojaOrdersWorker();
    console.log(`[Retry Worker] Retried ${result.retriedCount} KOT orders`);
  }
);

export const retryRouteTransfers = onSchedule(
  {
    region: REGION,
    schedule: "*/5 * * * *", // Every 5 minutes
    timeZone: "Asia/Kolkata",
  },
  async () => {
    const result = await retryPendingRouteTransfersWorker();
    console.log(`[Route Transfer Retry Worker] Retried ${result.retriedCount} transfers`);
  }
);

export const ticketInactivityReminder = onSchedule(
  {
    region: REGION,
    schedule: "*/15 * * * *", // Every 15 minutes
    timeZone: "Asia/Kolkata",
  },
  async () => {
    const result = await checkTicketInactivityReminders();
    console.log(`[Ticket Inactivity Worker] Sent ${result.remindedCount} reminders`);
  }
);

export const pollActivePorterDeliveries = onSchedule(
  {
    region: REGION,
    schedule: "*/5 * * * *", // Every 5 minutes
    timeZone: "Asia/Kolkata",
  },
  async () => {
    const result = await pollActivePorterOrdersWorker();
    console.log(
      `[Porter Polling Worker] Polled ${result.polledCount} orders, updated ${result.updatedCount} orders`
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
    const result = await cleanupExpiredGuestSessionsWorker();
    console.log(`[Guest Cleanup Worker] Purged ${result.cleanedCartsCount} expired guest carts`);
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


