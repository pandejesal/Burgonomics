import { db, admin } from "../../core/firebase";
import { captureErrorSnapshot } from "../../core/errors";
import { withSchedulerLock } from "../../core/schedulerLock";
import { isProviderConfirmedCapture, settlementCaptureStamp, settlementMonthBounds } from "../settlements/settlementMath";
import { CAPTURE_REGENERATION, SETTLEMENT_STATEMENTS, generateSettlementStatement, withSettlementPublicationLock } from "../settlements/settlementService";
import { istMonthKey } from "./monthlyFee";
import { getRazorpayClient } from "./razorpayClient";

export const CAPTURE_ISSUES = "settlement_capture_issues";
export const CAPTURE_RESOLUTIONS = "settlement_capture_resolutions";
const ALERT_TTL_MS = 86_400_000;
const STALE_AFTER_MS = 7_200_000;
const OPERATION_LEASE_MS = 10 * 60_000;
const PAYMENT_FIELD = "payment.razorpayPaymentId";
const issueFor = (id: string) => db.collection(CAPTURE_ISSUES).doc(id);
const orderFor = (id: string) => db.collection("orders").doc(id);
type Actor = { uid: string; email?: string | null };
type Pending = { branchId: string; publicationKey: string; months: string[] };
type Result = { ok: true; regenerationPending?: boolean; monthKey?: string } | { ok: false; code: string; status?: number };
const refusal = (code: string, status?: number): Result => ({ ok: false, code, status });

function createdAtMsOf(order: FirebaseFirestore.DocumentData): number {
  const value = order.createdAt;
  const raw = typeof value?.toMillis === "function" ? value.toMillis()
    : typeof value === "number" ? value
    : typeof value === "string" ? Date.parse(value) : NaN;
  const parsed = Number.isFinite(raw) ? raw : typeof order.placedAt === "string" ? Date.parse(order.placedAt) : NaN;
  // Firestore Timestamp.toMillis() may carry sub-millisecond precision. Round
  // up so an integer operator-entered time cannot precede actual creation.
  const ms = Math.ceil(parsed);
  return Number.isSafeInteger(ms) && ms > 0 ? ms : NaN;
}

function paymentIdOf(order: FirebaseFirestore.DocumentData | undefined): string | null {
  const nested = order?.payment?.razorpayPaymentId;
  const legacy = order?.[PAYMENT_FIELD];
  if (nested && legacy && nested !== legacy) return null;
  const id = nested || legacy;
  return typeof id === "string" && /^pay_[A-Za-z0-9_-]+$/.test(id) ? id : null;
}

async function isBound(id: string, paymentId: string, tx?: FirebaseFirestore.Transaction): Promise<boolean> {
  const orders = db.collection("orders");
  const queries = [PAYMENT_FIELD, new admin.firestore.FieldPath(PAYMENT_FIELD)].map(path => orders.where(path, "==", paymentId).limit(2));
  const matches = await Promise.all(queries.map(q => tx ? tx.get(q) : q.get()));
  const ids = new Set(matches.flatMap(s => s.docs.map(d => d.id)));
  return ids.size === 1 && ids.has(id);
}

async function fetchPayment(id: string) {
  try { return await getRazorpayClient().payments.fetch(id); }
  catch (err) { console.warn("[Capture Recovery] provider read failed", err instanceof Error ? err.name : "unknown"); return null; }
}
const isCaptured = (provider: any, id: string) => provider?.id === id && provider.status === "captured" && provider.captured === true;
const providerCreatedMs = (provider: any) => typeof provider?.created_at === "number" && Number.isSafeInteger(provider.created_at * 1000) && provider.created_at > 0
  ? provider.created_at * 1000 : null;
const due = (previous: unknown, now: number) => typeof previous !== "number" || now - previous >= ALERT_TTL_MS;

export async function deliverCaptureRecoveryAlert(orderId: string, snapshotId: string): Promise<void> {
  try {
    await captureErrorSnapshot({ source: "payments", severity: "high", orderId, message: `Capture recovery needs review: ${snapshotId}` }, { snapshotId, requireAlertDelivery: true });
  } catch (err) {
    console.warn("[Capture Recovery] alert delivery failed:", err instanceof Error ? err.message : "Unknown error");
  }
}

/** Called only from the signed webhook's fresh-read transaction. */
export async function repairSettlementCaptureInTx(tx: FirebaseFirestore.Transaction, order: FirebaseFirestore.DocumentSnapshot, paymentId: string, atMs: number): Promise<string | null> {
  const data = order.data();
  if (!data || paymentIdOf(data) !== paymentId) return null;
  const ref = issueFor(order.id);
  const issue = (await tx.get(ref)).data();
  if (isProviderConfirmedCapture(data)) {
    if (issue?.status === "open") tx.update(ref, { status: "resolved", closedAtMs: Date.now(), closedBy: "provider_webhook" });
    return null;
  }
  const manual = data.settlementCaptureState === "confirmed_manual";
  const heldAtMs = data.settlementEffectiveAtMs;
  const webhookMonthKey = istMonthKey(atMs);
  const manualMonthKey = manual && Number.isSafeInteger(heldAtMs) && heldAtMs > 0 ? istMonthKey(heldAtMs) : null;
  if (manual && !manualMonthKey) return null;
  if (manualMonthKey && manualMonthKey !== webhookMonthKey) {
    const snapshotId = `capture-month-conflict-${order.id}-${paymentId}`;
    if (issue?.status === "resolved" && issue?.conflict?.snapshotId === snapshotId) return null;
    const first = issue?.conflict?.snapshotId !== snapshotId;
    const now = Date.now();
    if (!first && !due(issue?.lastAlertedAtMs, now)) return null;
    tx.set(ref, {
      orderId: order.id, paymentId, status: "conflict", firstConflictAtMs: first ? now : issue?.firstConflictAtMs ?? now,
      lastAlertedAtMs: now,
      ...(first ? { conflict: { snapshotId, paymentId, manualAtMs: heldAtMs, webhookAtMs: atMs, manualMonthKey, webhookMonthKey } } : {}),
    }, { merge: true });
    return snapshotId;
  }
  // An open conflict can only be closed by the admin reconciliation command.
  if (issue?.status === "conflict" || (manual && issue?.conflict && issue.status === "resolved")) return null;
  tx.set(order.ref, settlementCaptureStamp(atMs), { merge: true });
  if (issue?.status === "open") tx.update(ref, { status: "resolved", closedAtMs: Date.now(), closedBy: "provider_webhook" });
  return null;
}

export async function resolveCaptureManually(input: {
  orderId: string; paymentId: string; capturedAtMs: number; istMonthKey?: string; reason: string; caller: Actor;
}): Promise<Result> {
  const { orderId, paymentId, capturedAtMs, reason, caller } = input;
  const now = Date.now();
  if (!Number.isSafeInteger(capturedAtMs) || capturedAtMs <= 0 || capturedAtMs > now) return refusal("invalid_time");
  const monthKey = istMonthKey(capturedAtMs);
  if (input.istMonthKey !== undefined && input.istMonthKey !== monthKey) return refusal("invalid_month");
  const ref = orderFor(orderId);
  const issueRef = issueFor(orderId);
  const validate = (order: FirebaseFirestore.DocumentData | undefined): string | null => {
    if (order?.paymentChannel !== "razorpay") return "not_online";
    if (paymentIdOf(order) !== paymentId) return "payment_mismatch";
    if (isProviderConfirmedCapture(order) || order.settlementCaptureState === "confirmed_manual") return "already_resolved";
    const created = createdAtMsOf(order);
    return !Number.isFinite(created) || capturedAtMs < created ? "before_creation" : null;
  };
  const invalid = validate((await ref.get()).data());
  if (invalid) return refusal(invalid);
  if (!(await isBound(orderId, paymentId))) return refusal("ambiguous_payment");
  const provider = await fetchPayment(paymentId);
  if (!provider) return refusal("fetch_failed", 503);
  if (!isCaptured(provider, paymentId)) return refusal("not_captured");
  const authorizedAt = providerCreatedMs(provider);
  if (authorizedAt === null || capturedAtMs < authorizedAt) return refusal("before_authorisation");
  return db.runTransaction(async tx => {
    const fresh = (await tx.get(ref)).data();
    const check = validate(fresh);
    if (check) return refusal(check);
    if (!(await isBound(orderId, paymentId, tx))) return refusal("ambiguous_payment");
    const issue = (await tx.get(issueRef)).data();
    if (issue?.status === "conflict") return refusal("already_resolved");
    const version = (Number(fresh?.settlementResolutionVersion) || 0) + 1;
    const resolution = { uid: caller.uid, email: caller.email ?? null, atMs: now, reason, providerStatus: "captured", providerCreatedAtMs: authorizedAt, istMonthKey: monthKey };
    tx.update(ref, { settlementCaptureState: "confirmed_manual", settlementCaptureUnresolved: false, settlementEffectiveAtMs: capturedAtMs,
      settlementCreatedAtMs: createdAtMsOf(fresh!), settlementResolutionVersion: version, settlementResolution: resolution });
    tx.create(db.collection(CAPTURE_RESOLUTIONS).doc(`${orderId}_${version}`), { orderId, paymentId, capturedAtMs, ...resolution });
    tx.set(issueRef, { orderId, paymentId, status: "resolved", closedAtMs: now, closedBy: caller.uid }, { merge: true });
    return { ok: true, monthKey };
  });
}

const monthMarker = (branchId: string, month: string) => db.collection(CAPTURE_REGENERATION).doc(`${branchId}_${month}`);
const withOrderLock = <T>(id: string, fn: () => Promise<T>) => withSchedulerLock(`settlement-capture-${id}`, OPERATION_LEASE_MS, fn, "strict-operation");

/** Requires the order lock. The statement itself is the durable publication receipt. */
async function finishPending(orderId: string): Promise<boolean> {
  const issueRef = issueFor(orderId);
  const pending = (await issueRef.get()).data()?.pendingRegeneration as Pending | undefined;
  if (!pending) return false;
  let remaining = [...pending.months];
  for (const month of pending.months) {
    try {
      const lock = await withSettlementPublicationLock(pending.branchId, month, async () => {
        const prior = await db.collection(SETTLEMENT_STATEMENTS).where("generatedBy", "==", pending.publicationKey).limit(2).get();
        if (!prior.docs.some(d => d.data().branchId === pending.branchId && d.data().monthKey === month)) {
          await generateSettlementStatement({ branchId: pending.branchId, monthKey: month,
            caller: { uid: pending.publicationKey, role: "brand_owner" }, source: "on_demand" });
        }
        const marker = monthMarker(pending.branchId, month);
        await db.runTransaction(async tx => {
          const current = (await tx.get(issueRef)).data()?.pendingRegeneration as Pending | undefined;
          const active = (await tx.get(marker)).data();
          if (current?.publicationKey !== pending.publicationKey || !current.months.includes(month)) return;
          if (active?.pending?.[orderId] !== pending.publicationKey) throw new Error("Regeneration marker identity changed");
          const months = current.months.filter(m => m !== month);
          const jobs = { ...active.pending };
          delete jobs[orderId];
          if (Object.keys(jobs).length) tx.update(marker, { pending: jobs });
          else tx.delete(marker);
          tx.update(issueRef, { pendingRegeneration: months.length ? { ...current, months } : admin.firestore.FieldValue.delete(), regenerationPending: months.length > 0 });
        });
      });
      if (lock.ran) remaining = remaining.filter(m => m !== month);
    } catch (err) {
      console.warn("[Capture Recovery] regeneration remains pending", orderId, month, err instanceof Error ? err.message : "Unknown error");
    }
  }
  return remaining.length > 0;
}

export async function retryCaptureRegeneration(orderId: string): Promise<Result> {
  const lock = await withOrderLock(orderId, async () => ({ ok: true as const, regenerationPending: await finishPending(orderId) }));
  return lock.result ?? refusal("lock_busy", 409);
}

export async function reconcileCaptureMonth(input: { orderId: string; keepMonth: string; reason: string; caller: Actor }): Promise<Result> {
  const { orderId, keepMonth, reason, caller } = input;
  const issueRef = issueFor(orderId);
  // Validate before taking a lease so a third-month refusal does not write.
  const initial = (await issueRef.get()).data();
  const conflict = initial?.conflict;
  if (!conflict) return refusal("no_conflict");
  if (keepMonth !== conflict.manualMonthKey && keepMonth !== conflict.webhookMonthKey) return refusal("invalid_month");
  const lock = await withOrderLock(orderId, async (): Promise<Result> => {
    const issue = (await issueRef.get()).data();
    if (issue?.status === "resolved") return issue.keepMonth === keepMonth
      ? { ok: true, regenerationPending: await finishPending(orderId) } : refusal("already_resolved", 409);
    if (issue?.status !== "conflict" || issue.conflict?.snapshotId !== conflict.snapshotId) return refusal("no_conflict");
    const paymentId = conflict.paymentId;
    const ref = orderFor(orderId);
    if (typeof paymentId !== "string" || paymentIdOf((await ref.get()).data()) !== paymentId || !(await isBound(orderId, paymentId))) return refusal("ambiguous_payment");
    const provider = await fetchPayment(paymentId);
    if (!provider) return refusal("fetch_failed", 503);
    if (!isCaptured(provider, paymentId)) return refusal("not_captured");
    const now = Date.now();
    const committed = await db.runTransaction(async (tx): Promise<Result> => {
      const freshIssue = (await tx.get(issueRef)).data();
      const fresh = (await tx.get(ref)).data();
      if (freshIssue?.status !== "conflict" || freshIssue.conflict?.snapshotId !== conflict.snapshotId) return refusal("no_conflict");
      if (!fresh || fresh.paymentChannel !== "razorpay" || paymentIdOf(fresh) !== paymentId || !(await isBound(orderId, paymentId, tx))) return refusal("ambiguous_payment");
      const held = fresh.settlementEffectiveAtMs;
      const branchId = fresh.branchId;
      if (fresh.settlementCaptureState !== "confirmed_manual" || held !== conflict.manualAtMs || !Number.isSafeInteger(held) || istMonthKey(held) !== conflict.manualMonthKey || typeof branchId !== "string" || !branchId || branchId.includes("/")) return refusal("stale_conflict", 409);
      const move = keepMonth !== conflict.manualMonthKey;
      const chosenAt = move ? conflict.webhookAtMs : held;
      if (!Number.isSafeInteger(chosenAt) || chosenAt <= 0 || istMonthKey(chosenAt) !== keepMonth) return refusal("invalid_instant");
      const months = move ? [conflict.manualMonthKey, conflict.webhookMonthKey].filter(month => settlementMonthBounds(month).endMs <= now) : [];
      const publicationKey = `capture-reconciliation:${conflict.snapshotId}`;
      const markers = months.map(month => monthMarker(branchId, month));
      const activeMarkers = await Promise.all(markers.map(marker => tx.get(marker)));
      if (move) tx.update(ref, settlementCaptureStamp(chosenAt));
      for (const [i, marker] of markers.entries()) {
        tx.set(marker, { branchId, monthKey: months[i], pending: { ...activeMarkers[i].data()?.pending, [orderId]: publicationKey } });
      }
      tx.update(issueRef, { status: "resolved", closedAtMs: now, closedBy: caller.uid, keepMonth,
        ...(months.length ? { pendingRegeneration: { branchId, publicationKey, months }, regenerationPending: true } : {}) });
      tx.create(db.collection(CAPTURE_RESOLUTIONS).doc(conflict.snapshotId), { orderId, paymentId, branchId,
        keepMonth, chosenAtMs: chosenAt, manualMonthKey: conflict.manualMonthKey, webhookMonthKey: conflict.webhookMonthKey,
        uid: caller.uid, email: caller.email ?? null, reason, atMs: now, providerStatus: "captured", moved: move });
      return { ok: true };
    });
    return committed.ok ? { ok: true, regenerationPending: await finishPending(orderId) } : committed;
  });
  return lock.result ?? refusal("lock_busy", 409);
}

export async function listCaptureIssues() {
  const col = db.collection(CAPTURE_ISSUES);
  const pages = await Promise.all([col.where("status", "==", "open"), col.where("status", "==", "conflict"), col.where("regenerationPending", "==", true)].map(q => q.limit(200).get()));
  return pages.flatMap(s => s.docs.map(d => ({ id: d.id, ...d.data() })));
}

export async function runCaptureRecoverySweep(now = Date.now()): Promise<void> {
  const retries = await db.collection(CAPTURE_ISSUES).where("regenerationPending", "==", true).limit(50).get();
  for (const issue of retries.docs) await retryCaptureRegeneration(issue.id).catch(err => console.warn("[Capture Recovery] retry failed", issue.id, err));
  const query = db.collection("orders").where("paymentChannel", "==", "razorpay").where("settlementCaptureUnresolved", "==", true).orderBy("createdAt").limit(50);
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  do {
    const page = await (cursor ? query.startAfter(cursor) : query).get();
    for (const doc of page.docs) {
      try {
        const order = doc.data();
        const created = createdAtMsOf(order);
        const paymentId = paymentIdOf(order);
        if (!paymentId || !Number.isFinite(created) || created >= now - STALE_AFTER_MS || isProviderConfirmedCapture(order) || order.settlementCaptureState === "confirmed_manual") continue;
        const provider = await fetchPayment(paymentId);
        if (!provider || provider.id !== paymentId) continue;
        const issueRef = issueFor(doc.id);
        const alert = await db.runTransaction(async tx => {
          const fresh = (await tx.get(doc.ref)).data();
          const issue = (await tx.get(issueRef)).data();
          if (!fresh || fresh.paymentChannel !== "razorpay" || fresh.settlementCaptureUnresolved !== true || paymentIdOf(fresh) !== paymentId || isProviderConfirmedCapture(fresh) || fresh.settlementCaptureState === "confirmed_manual" || (issue && issue.status !== "open")) return false;
          const dispatch = due(issue?.lastAlertedAtMs, now);
          tx.set(issueRef, { orderId: doc.id, paymentId, providerStatus: String(provider.status ?? ""), providerCaptured: provider.captured === true,
            providerCreatedAtMs: providerCreatedMs(provider), firstSeenAtMs: issue?.firstSeenAtMs ?? now, lastSeenAtMs: now,
            createdMonthKey: istMonthKey(created), attempts: (Number(issue?.attempts) || 0) + 1, status: "open", ...(dispatch ? { lastAlertedAtMs: now } : {}) }, { merge: true });
          return dispatch;
        });
        if (alert) await deliverCaptureRecoveryAlert(doc.id, `capture-recovery-issue-${doc.id}`);
      } catch (err) { console.warn("[Capture Recovery] issue check failed", doc.id, err); }
    }
    cursor = page.docs.length === 50 ? page.docs[49] : undefined;
  } while (cursor);
}
