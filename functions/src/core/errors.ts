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
 * Captures an error snapshot into Firestore dev_error_snapshots collection
 * and triggers developer alert channels (Slack/Discord) for P0/high severity errors.
 */
export async function captureErrorSnapshot(
  snapshot: Omit<DevErrorSnapshot, "createdAt">
): Promise<string> {
  const snapshotId = `err_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const fullSnapshot: DevErrorSnapshot = {
    ...snapshot,
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

  // If high or P0, dispatch webhook notification with sanitized PII
  if (snapshot.severity === "high" || snapshot.severity === "p0_critical") {
    await dispatchDeveloperAlert(snapshotId, snapshot);
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
