import { db } from "./firebase";
import { config } from "../config/env";
import * as admin from "firebase-admin";

export interface DevErrorSnapshot {
  id?: string;
  source: "payments" | "petpooja" | "porter" | "tickets" | "notifications" | "auth" | "system";
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

/**
 * Captures an error snapshot into Firestore dev_error_snapshots collection
 * and triggers developer alert channels (Slack/Discord) for P0/high severity errors.
 *
 * PII boundary: customerId and payment/porter/POS ids are masked before
 * persistence (DPDP Act 2023) — orderId/branchId stay raw so ops can still
 * find the order. Forbidden context keys are dropped, not stored.
 */
export async function captureErrorSnapshot(
  snapshot: Omit<DevErrorSnapshot, "createdAt">
): Promise<string> {
  const snapshotId = `err_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const scrubbedContext: Record<string, any> | undefined = snapshot.context
    ? Object.fromEntries(
        Object.entries(snapshot.context).filter(([k]) => !FORBIDDEN_CONTEXT_KEYS.test(k))
      )
    : undefined;
  // Caller-built messages often interpolate raw payment ids
  // (e.g. "Unmatched captured payment pay_...") — mask those too.
  const scrubbedMessage = snapshot.message.replace(
    /\b(pay_[A-Za-z0-9]+)\b/g,
    (_m, id) => maskIdentifier(id)
  );
  const fullSnapshot: DevErrorSnapshot = {
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

  try {
    if (db && typeof db.collection === "function") {
      await db.collection("dev_error_snapshots").doc(snapshotId).set(fullSnapshot);
    }
  } catch (err) {
    console.error("[Errors] Failed to write dev_error_snapshot to Firestore:", err);
  }

  // If high or P0, dispatch webhook notification with sanitized PII.
  // NOTE: alert on fullSnapshot (masked), never the raw caller snapshot.
  if (snapshot.severity === "high" || snapshot.severity === "p0_critical") {
    await dispatchDeveloperAlert(snapshotId, fullSnapshot);
  }

  return snapshotId;
}

/**
 * Dispatches P0 developer alerts to Slack and/or Discord webhooks with PII redaction.
 */
async function dispatchDeveloperAlert(
  snapshotId: string,
  snapshot: Omit<DevErrorSnapshot, "createdAt">
): Promise<void> {
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

  // Slack Webhook
  if (config.alerts.slackWebhookUrl) {
    try {
      await fetch(config.alerts.slackWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: alertText }),
      });
    } catch (err) {
      console.warn("[Errors] Failed to send Slack alert:", err);
    }
  }

  // Discord Webhook
  if (config.alerts.discordWebhookUrl) {
    try {
      await fetch(config.alerts.discordWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: alertText }),
      });
    } catch (err) {
      console.warn("[Errors] Failed to send Discord alert:", err);
    }
  }
}
