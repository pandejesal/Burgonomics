import { db } from "./firebase";
import { config } from "../config/env";
import * as admin from "firebase-admin";

export interface DevErrorSnapshot {
  id?: string;
  source: "payments" | "petpooja" | "porter" | "dispatch" | "tickets" | "notifications" | "auth" | "system";
  severity: "low" | "medium" | "high" | "p0_critical";
  message: string;
  errorStack?: string;
  context?: Record<string, any>;
  orderId?: string;
  branchId?: string;
  customerId?: string;
  razorpayPaymentId?: string;
  porterOrderId?: string;
  petpoojaOrderId?: string;
  createdAt: admin.firestore.FieldValue;
}

/**
 * Masks sensitive customer PII in compliance with India's Digital Personal Data Protection (DPDP) Act 2023.
 */
function maskIdentifier(val?: string): string {
  if (!val) return "";
  if (val.length <= 4) return "****";
  return val.substring(0, 2) + "****" + val.substring(val.length - 2);
}

/**
 * Keys that must never persist in a snapshot context (PII / secrets).
 * Callers pass operational refs (orderId/branchId); anything looking like
 * contact data, credentials, or raw bodies is dropped at the boundary.
 */
const FORBIDDEN_CONTEXT_KEYS = /phone|address|token|secret|otp|password|card|cvv|rawbody/i;

export interface AlertDeliveryReport {
  /** Channels configured for this process (0 means nothing could ever send). */
  channelsConfigured: number;
  /** Channels whose transport ACKNOWLEDGED (res.ok only). */
  channelsAcknowledged: number;
  /**
   * Sanitized failure codes only — e.g. `slack_http_503`, `slack_transport`,
   * `discord_http_500`. Never a URL, body, or provider response text.
   */
  failures: string[];
}

export interface CaptureErrorSnapshotOptions {
  /**
   * Opt-in delivery proof. When true, the promise REJECTS with a typed error
   * unless at least one alert transport acknowledged the send. Default false
   * keeps every existing caller's behaviour (resolve, even on transport
   * failure).
   */
  requireAlertDelivery?: boolean;
  /** Deterministic snapshot id, so a retry overwrites one row instead of spamming. */
  snapshotId?: string;
}

/** Typed rejection from `captureErrorSnapshot(..., { requireAlertDelivery: true })`. */
export interface AlertDeliveryError extends Error {
  code: "ALERT_NO_CHANNEL" | "ALERT_DELIVERY_FAILED";
  detail: AlertDeliveryReport;
}

/**
 * Captures an error snapshot into Firestore dev_error_snapshots collection
 * and triggers developer alert channels (Slack/Discord) for P0/high severity errors.
 *
 * PII boundary: customerId and payment/porter/POS ids are masked before
 * persistence (DPDP Act 2023) — orderId/branchId stay raw so ops can still
 * find the order. Forbidden context keys are dropped, not stored.
 *
 * DELIVERY PROOF: by default this resolves with the snapshot id whatever the
 * transport did (the historical contract — a resolved id is NOT proof of
 * delivery). Callers that must know use `requireAlertDelivery`.
 */
export async function captureErrorSnapshot(
  snapshot: Omit<DevErrorSnapshot, "createdAt">,
  opts?: CaptureErrorSnapshotOptions
): Promise<string> {
  const snapshotId =
    typeof opts?.snapshotId === "string" && opts.snapshotId.trim()
      ? opts.snapshotId.trim()
      : `err_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const scrubbedContext: Record<string, any> | undefined = snapshot.context
    ? Object.fromEntries(
        Object.entries(snapshot.context).filter(([k]) => !FORBIDDEN_CONTEXT_KEYS.test(k))
      )
    : undefined;
  // Caller-built messages often interpolate raw payment ids
  // (e.g. "Unmatched captured payment pay_...") — mask those too, along
  // with any pasted Indian mobile numbers and email addresses (DPDP:
  // free-text fields routinely carry contact PII into snapshots).
  const scrubbedMessage = snapshot.message
    // A payment id may be embedded in a longer token (`ump_gate_pay_abc`), where
    // `\b` does NOT fire after the underscore — that was leaking raw ids into
    // alert text. Anchor on the id shape itself instead.
    .replace(/(pay_[A-Za-z0-9]+)/g, (_m, id) => maskIdentifier(id))
    .replace(/\b(\+91[\s-]?)?[6-9]\d{9}\b/g, (m) =>
      m.length <= 4 ? "****" : `${m.slice(0, 2)}****${m.slice(-2)}`
    )
    .replace(
      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
      (m) => {
        const [local, domain] = m.split("@");
        return `${(local || "").slice(0, 2)}****@${domain}`;
      }
    );
  const maskedSnapshot: DevErrorSnapshot = {
    ...snapshot,
    message: scrubbedMessage,
    customerId: snapshot.customerId ? maskIdentifier(snapshot.customerId) : undefined,
    razorpayPaymentId: snapshot.razorpayPaymentId
      ? maskIdentifier(snapshot.razorpayPaymentId)
      : undefined,
    porterOrderId: snapshot.porterOrderId ? maskIdentifier(snapshot.porterOrderId) : undefined,
    petpoojaOrderId: snapshot.petpoojaOrderId
      ? maskIdentifier(snapshot.petpoojaOrderId)
      : undefined,
    context: scrubbedContext,
    id: snapshotId,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  // Firestore rejects an explicitly-`undefined` field value, so every optional
  // key has to be OMITTED rather than set to undefined — including any key a
  // caller passed as `undefined` through the `...snapshot` spread above.
  // Writing the object as-is made EVERY snapshot insert throw
  // `Cannot use "undefined" as a Firestore value (found in field "customerId")`.
  // That throw was swallowed by the catch below, so no `dev_error_snapshots`
  // row was ever persisted for a Petpooja failure — the "manual review
  // required" / "KOT push failed" trail ops relies on silently did not exist.
  const fullSnapshot = Object.fromEntries(
    Object.entries(maskedSnapshot).filter(([, value]) => value !== undefined)
  ) as DevErrorSnapshot;

  try {
    if (db && typeof db.collection === "function") {
      await db.collection("dev_error_snapshots").doc(snapshotId).set(fullSnapshot);
    }
  } catch (err) {
    console.error("[Errors] Failed to write dev_error_snapshot to Firestore:", err);
  }

  // If high or P0, dispatch webhook notification with sanitized PII.
  // NOTE: alert on fullSnapshot (masked), never the raw caller snapshot.
  let report: AlertDeliveryReport = {
    channelsConfigured: 0,
    channelsAcknowledged: 0,
    failures: [],
  };
  if (snapshot.severity === "high" || snapshot.severity === "p0_critical") {
    report = await dispatchDeveloperAlert(snapshotId, fullSnapshot);
  }

  if (opts?.requireAlertDelivery) {
    // Proving delivery is only meaningful for an alerting severity; a `medium`
    // snapshot has no alert lane to acknowledge, so requiring one would always
    // fail. Report that honestly rather than pretending it was sent.
    if (snapshot.severity !== "high" && snapshot.severity !== "p0_critical") {
      const wrongSeverity: AlertDeliveryError = Object.assign(
        new Error("Alert delivery was required for a non-alerting severity"),
        { code: "ALERT_NO_CHANNEL" as const, detail: report }
      );
      throw wrongSeverity;
    }
    if (report.channelsAcknowledged === 0) {
      const typed: AlertDeliveryError = Object.assign(
        new Error(
          report.channelsConfigured === 0
            ? "No developer-alert channel is configured — nowhere to deliver"
            : `No developer-alert transport acknowledged the send (${report.failures.join(",")})`
        ),
        {
          code:
            report.channelsConfigured === 0
              ? ("ALERT_NO_CHANNEL" as const)
              : ("ALERT_DELIVERY_FAILED" as const),
          detail: report,
        }
      );
      throw typed;
    }
  }

  return snapshotId;
}

/**
 * B5-S1 (H36) user-safe error copy map: technical detail (gateway ids, raw
 * provider text, stack hints) is logs-only. Routes expose ONLY these strings
 * via toUserSafeMessage() — never err.message from money/auth/dispatch paths.
 */
export const USER_SAFE_ERROR_COPY: Record<string, string> = {
  // Tickets
  TICKET_NOT_FOUND: "Support ticket not found. Please refresh and try again.",
  TICKET_REFUND_NO_ORDER: "This ticket has no linked order, so an automatic refund is not possible. Our team will help you another way.",
  TICKET_REFUND_NO_PAYMENT: "No online payment was captured for this order, so there is nothing to refund automatically. Our team will help you another way.",
  TICKET_REFUND_FAILED: "The refund could not be processed right now. Your ticket stays open and our team will retry shortly.",
  TICKET_RATE_LIMITED: "You are raising tickets too quickly. Please wait a few minutes and try again.",
  TICKET_TOO_MANY_OPEN: "You already have several open tickets. Please wait for an update on those first.",
  TICKET_INVALID_INPUT: "Some ticket details look invalid. Please check the form and try again.",
  TICKET_FORBIDDEN: "You do not have permission to perform this ticket action.",
  TICKET_MESSAGE_EMPTY: "Your reply is empty. Please write a message first.",
  TICKET_ALREADY_RESOLVED: "This ticket is already resolved. Reopen it before resolving again.",
  TICKET_NOT_PENDING: "This ticket is already resolved.",
  TICKET_RESOLUTION_IN_PROGRESS: "Another staff member is resolving this ticket right now. Refresh in a minute.",
  TICKET_RESOLUTION_CLAIM_LOST: "The resolution lease on this ticket moved on (it was taken over after a stall). Refresh and retry.",
  TICKET_RESOLUTION_RETRY: "The ticket is busy under another write right now. Please retry in a moment.",
  // Notifications
  NOTIFY_BAD_TOKEN: "Push registration failed. Please reopen the app and allow notifications.",
  NOTIFY_SEND_FAILED: "Notification could not be delivered, but your request was saved.",
  // Generic fallbacks
  BAD_REQUEST: "Something in the request looks invalid. Please check and try again.",
  UNAUTHORIZED: "Please sign in again to continue.",
  FORBIDDEN: "You do not have permission to do that.",
  RATE_LIMITED: "Too many attempts. Please wait a bit and try again.",
  INTERNAL: "Something went wrong on our side. Please try again in a bit.",
};

/**
 * Coded service error: carries a stable user-safe code + HTTP status.
 * Services throw these; routes map code -> USER_SAFE_ERROR_COPY for clients
 * while the technical message stays in logs/snapshots only.
 */
export function serviceError(code: keyof typeof USER_SAFE_ERROR_COPY | string, technical: string, statusCode: number): Error & { code: string; statusCode: number } {
  const err = new Error(technical) as Error & { code: string; statusCode: number };
  err.code = code;
  err.statusCode = statusCode;
  return err;
}

/** Resolve any thrown error to its user-safe client string (H36). */
export function toUserSafeMessage(err: any): string {
  const code = err?.code;
  if (typeof code === "string" && USER_SAFE_ERROR_COPY[code]) {
    return USER_SAFE_ERROR_COPY[code];
  }
  return USER_SAFE_ERROR_COPY.INTERNAL;
}

/**
 * Dispatches P0 developer alerts to Slack and/or Discord webhooks with PII redaction.
 *
 * Returns a DELIVERY REPORT rather than swallowing everything: only a transport
 * that answered `res.ok` counts as acknowledged. Failure codes are sanitized to
 * a stable shape (`slack_http_503`, `slack_transport`) so they can be persisted
 * on a retry record — a webhook URL, request body, or provider text must never
 * leak into storage or logs.
 */
async function dispatchDeveloperAlert(
  snapshotId: string,
  snapshot: Omit<DevErrorSnapshot, "createdAt">
): Promise<AlertDeliveryReport> {
  const alertText =
    `🚨 *[BURGONOMICS P0 ALERT]*: ${snapshot.message}\n` +
    `• *Source*: \`${snapshot.source}\`\n` +
    `• *Severity*: \`${snapshot.severity}\`\n` +
    `• *Snapshot ID*: \`${snapshotId}\`\n` +
    (snapshot.orderId ? `• *Order ID*: \`${snapshot.orderId}\`\n` : "") +
    (snapshot.branchId ? `• *Branch ID*: \`${snapshot.branchId}\`\n` : "") +
    // customerId arrives pre-masked from captureErrorSnapshot; mask again
    // defensively in case this function is ever called directly.
    (snapshot.customerId ? `• *Customer*: \`${maskIdentifier(snapshot.customerId)}\`\n` : "");

  const report: AlertDeliveryReport = {
    channelsConfigured: 0,
    channelsAcknowledged: 0,
    failures: [],
  };

  /** Attempt one channel; only `res.ok` is an acknowledgement. */
  const send = async (
    channel: "slack" | "discord",
    url: string,
    body: Record<string, any>
  ): Promise<void> => {
    report.channelsConfigured += 1;
    try {
      const res: any = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        // P2: captureErrorSnapshot awaits this on inline request paths — a
        // hung Slack webhook must not hold the caller until platform timeout.
        signal: AbortSignal.timeout(10_000),
      });
      if (res && typeof res.ok === "boolean" && res.ok) {
        report.channelsAcknowledged += 1;
        return;
      }
      // A non-2xx (or a transport shim that never sets `ok`) is NOT delivery.
      const status =
        res && typeof res.status === "number" && Number.isFinite(res.status)
          ? Math.floor(res.status)
          : null;
      report.failures.push(`${channel}_http_${status === null ? "unknown" : status}`);
    } catch {
      // Never persist provider text or the URL: a stable, sanitized code only.
      report.failures.push(`${channel}_transport`);
    }
  };

  // Slack Webhook
  if (config.alerts.slackWebhookUrl) {
    await send("slack", config.alerts.slackWebhookUrl, { text: alertText });
  }

  // Discord Webhook
  if (config.alerts.discordWebhookUrl) {
    await send("discord", config.alerts.discordWebhookUrl, { content: alertText });
  }

  if (report.channelsConfigured === 0) {
    console.warn(
      "[Errors] No developer-alert channel configured (SLACK_DEV_WEBHOOK_URL / DISCORD_DEV_WEBHOOK_URL)"
    );
  } else if (report.channelsAcknowledged === 0) {
    console.warn("[Errors] No developer-alert transport acknowledged:", report.failures.join(","));
  }

  return report;
}
