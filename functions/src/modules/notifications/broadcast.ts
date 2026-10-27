import { z } from "zod";
import { db } from "../../core/firebase";
import * as admin from "firebase-admin";
import { sendMulticastFcm } from "./fcmClient";
import { truncatePushText } from "./templates";
import { writeAuditLog } from "../audit/auditLog";
import {
  BROADCAST_PURPOSES,
  CustomerPurpose,
  DISPATCH_STAFF_ROLES,
  isCustomerPurpose,
} from "./registry";
import {
  categoryEnabled,
  loadPrefsForDevices,
  prefsForDevice,
} from "./devicePrefs";
import { TRUSTED_SERVER_ACTOR } from "./sendGate";

export const BroadcastSchema = z
  .object({
    title: z.string().trim().min(1, "Title is required").max(120),
    body: z.string().trim().min(1, "Body is required").max(1000),
    data: z.record(z.string(), z.string()).optional().default({}),
    /**
     * Server-validated operator intent. Absent falls back to `announcements`
     * (the opt-in category, default false) and is recorded as
     * `purposeDefaulted: true`; an omitted field can never silently classify a
     * broadcast as promotional `offers` and bypass the announcements opt-in.
     */
    purpose: z.enum(["offers", "announcements"]).optional(),
  })
  .strict();

export type BroadcastInput = z.infer<typeof BroadcastSchema>;

/** One wave caps here — larger token bases page across waves (queued). */
export const BROADCAST_WAVE_LIMIT = 2000;

export interface BroadcastResult {
  success: boolean;
  broadcastId: string;
  purpose: CustomerPurpose;
  /** True when the caller omitted `purpose` and the server fell back. */
  purposeDefaulted: boolean;
  targeted: number;
  eligible: number;
  customerEligible: number;
  staffDevices: number;
  successCount: number;
  failureCount: number;
  prunedCount: number;
  providerAccepted: number;
  providerFailed: number;
  suppressedCount: number;
  suppressedAll: boolean;
  legacyUnresolved: number;
}

type Caller = { uid?: string; email?: string | null } | null | undefined;

interface BroadcastDevice {
  token: string;
  uid?: string;
  installationId?: string;
  staff: boolean;
}

/**
 * Readiness-8: customer broadcast endpoint. This lists registered device
 * tokens (bounded wave), applies the canonical `device_prefs` category at send
 * time (staff included, because `all_devices` is the sole bulk exception),
 * multicasts through the chunked/pruning sender, records a broadcasts doc
 * (UI history source) plus a security-registry row, and returns MEASURED
 * counts — never estimates and never a "delivered" claim.
 */
export async function broadcastToDevices(
  rawInput: unknown,
  caller: Caller
): Promise<BroadcastResult> {
  const input = BroadcastSchema.parse(rawInput);
  // No default may classify a send as marketing: omission means the opt-in
  // `announcements` category, and the defaulted flag is recorded for audit.
  const purposeDefaulted = input.purpose === undefined;
  const purpose = (input.purpose ?? "announcements") as CustomerPurpose;
  if (!isCustomerPurpose(purpose) || !BROADCAST_PURPOSES.has(purpose)) {
    throw new Error("broadcast purpose must be offers or announcements");
  }

  const devices: BroadcastDevice[] = [];
  if (db && typeof db.collection === "function") {
    const snap = await db
      .collection("device_tokens")
      .limit(BROADCAST_WAVE_LIMIT)
      .get();
    snap.forEach((d: any) => {
      const data = (d?.data() as any) || {};
      // The token FIELD is authoritative (it is the FCM credential); the doc
      // id is only its key. Preferring the id would address a phantom token
      // if the two ever diverged.
      const field = data.token;
      const id = typeof d?.id === "string" ? d.id : "";
      const token = typeof field === "string" && field ? field : id;
      if (!token) return;
      const role = typeof data.role === "string" ? data.role : undefined;
      devices.push({
        token,
        uid: typeof data.userId === "string" && data.userId ? data.userId : undefined,
        installationId:
          typeof data.installationId === "string" && data.installationId
            ? data.installationId
            : undefined,
        staff: data.isStaff === true || (!!role && DISPATCH_STAFF_ROLES.has(role)),
      });
    });
  }

  // De-dupe on the credential, keeping the first metadata row.
  const seen = new Set<string>();
  const uniqueDevices = devices.filter((device) => {
    if (seen.has(device.token)) return false;
    seen.add(device.token);
    return true;
  });

  const { byKey } = await loadPrefsForDevices(
    uniqueDevices.map((device) => ({ uid: device.uid, installationId: device.installationId }))
  );

  const eligible: string[] = [];
  let suppressedCount = 0;
  let legacyUnresolved = 0;
  let customerEligible = 0;
  let staffDevices = 0;

  for (const device of uniqueDevices) {
    if (device.staff) staffDevices += 1;
    const resolved = prefsForDevice(
      { uid: device.uid, installationId: device.installationId },
      byKey
    );
    if (!resolved.canonical) legacyUnresolved += 1;
    if (categoryEnabled(resolved.prefs, purpose)) {
      eligible.push(device.token);
      if (!device.staff) customerEligible += 1;
    } else {
      suppressedCount += 1;
    }
  }

  const title = input.title.trim();
  const body = truncatePushText
    ? truncatePushText(input.body.trim())
    : input.body.trim();

  let successCount = 0;
  let failureCount = 0;
  let providerFailed = 0;
  let prunedCount = 0;
  if (eligible.length > 0) {
    const result = await sendMulticastFcm(
      eligible,
      {
        notification: { title, body },
        data: { type: "broadcast", ...(input.data || {}) },
      },
      undefined,
      {
        purpose,
        audience: "all_devices",
        actor: TRUSTED_SERVER_ACTOR,
        critical: true,
      }
    );
    successCount = result.successCount;
    failureCount = result.failureCount;
    providerFailed = result.providerFailed ?? 0;
    prunedCount = (result.prunedTokens || []).length;
  }

  const broadcastRef =
    db && typeof db.collection === "function"
      ? db.collection("broadcasts").doc()
      : null;
  const broadcastId =
    (broadcastRef as any)?.id || `bc_${Date.now().toString(36)}`;
  const metrics = {
    purpose,
    purposeDefaulted,
    targeted: uniqueDevices.length,
    eligible: eligible.length,
    customerEligible,
    staffDevices,
    providerAccepted: successCount,
    providerFailed,
    prunedCount,
    suppressedCount,
    suppressedAll: uniqueDevices.length > 0 && eligible.length === 0,
    legacyUnresolved,
  };
  if (broadcastRef) {
    await broadcastRef.set({
      title,
      body,
      data: input.data || {},
      ...metrics,
      // Legacy UI aliases: the same provider-acknowledgement numbers.
      successCount,
      failureCount,
      targeted: uniqueDevices.length,
      sentByUid: caller?.uid || null,
      sentByEmail: (caller as any)?.email || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  await writeAuditLog({
    actorUid: caller?.uid ?? null,
    actorEmail: (caller as any)?.email ?? null,
    action: "broadcast_sent",
    targetType: "broadcast",
    targetId: broadcastId,
    metadata: metrics,
  });

  return {
    success: true,
    broadcastId,
    ...metrics,
    successCount,
    failureCount,
  };
}
