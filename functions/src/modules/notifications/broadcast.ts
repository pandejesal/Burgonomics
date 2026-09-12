import { z } from "zod";
import { db } from "../../core/firebase";
import * as admin from "firebase-admin";
import { sendMulticastFcm } from "./fcmClient";
import { truncatePushText } from "./templates";
import { writeAuditLog } from "../audit/auditLog";

export const BroadcastSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(120),
  body: z.string().trim().min(1, "Body is required").max(1000),
  data: z.record(z.string(), z.string()).optional().default({}),
});

export type BroadcastInput = z.infer<typeof BroadcastSchema>;

/** One wave caps here — larger token bases page across waves (queued). */
export const BROADCAST_WAVE_LIMIT = 2000;

export interface BroadcastResult {
  success: boolean;
  broadcastId: string;
  targeted: number;
  successCount: number;
  failureCount: number;
  prunedCount: number;
}

type Caller = { uid?: string; email?: string | null } | null | undefined;

/**
 * Readiness-8: customer broadcast endpoint (queued since Loop 22). The
 * partner push page recorded local drafts with fabricated reach because no
 * send channel existed. This lists registered device tokens (bounded wave),
 * multicasts through the chunked/pruning sender, records a broadcasts doc
 * (UI history source) plus a security-registry row, and returns MEASURED
 * counts — never estimates. Brand-only callers; audience is all registered
 * devices (staff included until audience segmentation lands — the response
 * says so via targeted vs customers math staying out of it).
 */
export async function broadcastToDevices(
  rawInput: unknown,
  caller: Caller
): Promise<BroadcastResult> {
  const input = BroadcastSchema.parse(rawInput);

  let tokens: string[] = [];
  if (db && typeof db.collection === "function") {
    const snap = await db
      .collection("device_tokens")
      .limit(BROADCAST_WAVE_LIMIT)
      .get();
    snap.forEach((d: any) => {
      // The token FIELD is authoritative (it is the FCM credential); the doc
      // id is only its key. Preferring the id would address a phantom token
      // if the two ever diverged.
      const field = (d?.data() as any)?.token;
      const id = typeof d?.id === "string" ? d.id : "";
      const token = typeof field === "string" && field ? field : id;
      if (token) tokens.push(token);
    });
  }
  tokens = [...new Set(tokens)];

  const title = input.title.trim();
  const body = truncatePushText
    ? truncatePushText(input.body.trim())
    : input.body.trim();

  let successCount = 0;
  let failureCount = 0;
  let prunedCount = 0;
  if (tokens.length > 0) {
    const result = await sendMulticastFcm(tokens, {
      notification: { title, body },
      data: { type: "broadcast", ...(input.data || {}) },
    });
    successCount = result.successCount;
    failureCount = result.failureCount;
    prunedCount = (result.prunedTokens || []).length;
  }

  const broadcastRef =
    db && typeof db.collection === "function"
      ? db.collection("broadcasts").doc()
      : null;
  const broadcastId =
    (broadcastRef as any)?.id || `bc_${Date.now().toString(36)}`;
  if (broadcastRef) {
    await broadcastRef.set({
      title,
      body,
      data: input.data || {},
      targeted: tokens.length,
      successCount,
      failureCount,
      prunedCount,
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
    metadata: { title, targeted: tokens.length, successCount, failureCount },
  });

  return {
    success: true,
    broadcastId,
    targeted: tokens.length,
    successCount,
    failureCount,
    prunedCount,
  };
}
