import * as admin from "firebase-admin";
import { db } from "../../core/firebase";
import { captureErrorSnapshot } from "../../core/errors";
import type { StaffCaller } from "../../core/middleware";
import {
  buildSettlementStatement,
  isBranchFeeApplicable,
  previousSettlementMonthKey,
  resolveSettlementFeePaise,
  settlementCsv,
  settlementMonthBounds,
  settlementStatementId,
  settlementEffectiveAtMsOf,
  summarizeSettlementOrders,
  SETTLEMENT_EFFECTIVE_AT_FIELD,
  type SettlementMonthBounds,
  type SettlementStatement,
  type SettlementSource,
  type SettlementPaymentRecord,
} from "./settlementMath";

/**
 * Franchise settlement service (owner decision 2026-11-20).
 *
 * One statement per branch per Asia/Kolkata calendar month:
 *
 *   net payable = online collected - online refunds - flat monthly fee
 *
 * Cash is reported for information; the branch already holds it. A regeneration
 * never rewrites history: it creates the next version. "Mark as paid" records a
 * reference + date and moves no money — this app has no payout rail.
 *
 * Reads are scoped here, in the service, because Firestore rules can only see a
 * document's own fields: a brand role reads every branch, a branch owner only
 * the statement's own branch, and everyone else is refused outright.
 */

export const SETTLEMENT_STATEMENTS = "branch_settlements";
export const SETTLEMENT_VERSIONS = "settlement_versions";
export const SETTLEMENT_AUDIT = "admin_audit_logs";
/** M6: one payment ledger per branch and month, independent of statement versions. */
export const SETTLEMENT_PAYMENTS = "settlement_payments";

/** Orders per page, and pages per statement, before the scan is declared partial. */
const SETTLEMENT_PAGE_SIZE = 500;
const SETTLEMENT_MAX_PAGES = 8;

/** Roles that may see every branch and change the paid state. */
const BRAND_ROLES = new Set(["brand_owner", "developer"]);
/** Roles that may read their own branch's statements (nothing more). */
const BRANCH_READ_ROLES = new Set(["branch_owner"]);

export class SettlementError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = "SettlementError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

interface CallerShape extends StaffCaller {
  branchIds?: string[];
}

function isBrand(caller: CallerShape | null | undefined): boolean {
  if (!caller) return false;
  if (caller.isBrandAdmin === true) return true;
  return !!caller.role && BRAND_ROLES.has(caller.role);
}

function assertBrand(caller: CallerShape | null | undefined, action: string): void {
  if (!caller || !caller.uid) {
    throw new SettlementError(
      "SETTLEMENT_UNAUTHENTICATED",
      `Forbidden: a signed-in brand owner is required to ${action}`,
      401
    );
  }
  if (!isBrand(caller)) {
    throw new SettlementError(
      "SETTLEMENT_FORBIDDEN",
      `Forbidden: only owner and brand roles may ${action}`,
      403
    );
  }
}

function assertReadable(caller: CallerShape | null | undefined): void {
  if (!caller || !caller.uid) {
    throw new SettlementError(
      "SETTLEMENT_UNAUTHENTICATED",
      "Forbidden: a signed-in user is required to read settlements",
      401
    );
  }
  if (isBrand(caller)) return;
  if (caller.role && BRANCH_READ_ROLES.has(caller.role)) return;
  throw new SettlementError(
    "SETTLEMENT_FORBIDDEN",
    "Forbidden: settlements are not readable for this role",
    403
  );
}

/** Branch ids the caller may read, or null for "every branch". */
function readableBranchScope(caller: CallerShape): string[] | null {
  if (isBrand(caller)) return null;
  const held = Array.isArray(caller.branchIds)
    ? caller.branchIds.filter((b): b is string => typeof b === "string" && !!b)
    : [];
  return held;
}

function millisOf(value: unknown, fallback: number): number {
  const candidate = value as { toMillis?: () => number; toDate?: () => Date };
  if (candidate && typeof candidate.toMillis === "function") {
    const ms = Number(candidate.toMillis());
    if (Number.isFinite(ms)) return ms;
  }
  if (candidate && typeof candidate.toDate === "function") {
    const ms = candidate.toDate().getTime();
    if (Number.isFinite(ms)) return ms;
  }
  const raw = Number(value);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/**
 * ONE query key: the server-normalised numeric `settlementEffectiveAtMs`.
 * Legacy rows are backfilled by the reviewed staging step; no guessed fallback
 * field is queried. Both bounds are numeric, and the composite index covers
 * (branchId, settlementEffectiveAtMs).
 */
const SETTLEMENT_TIME_FIELD = SETTLEMENT_EFFECTIVE_AT_FIELD;
const SETTLEMENT_ORDER_CAP = SETTLEMENT_PAGE_SIZE * SETTLEMENT_MAX_PAGES;

/**
 * Pages the single canonical field, de-duplicates by doc id, filters to the
 * month, and probes for the 4,001st UNIQUE ELIGIBLE row. Later-month orders are
 * excluded by the query itself and cannot consume the cap.
 */
async function readBranchMonthOrders(
  branchId: string,
  month: SettlementMonthBounds
): Promise<{ orders: any[]; truncated: boolean }> {
  const col = db.collection("orders");
  const start = month.startMs;
  const end = month.endMs;
  const byId = new Map<string, any>();
  let cursor: any = null;

  for (let page = 0; page < SETTLEMENT_MAX_PAGES; page += 1) {
    // +1 is the probe for an eligible row beyond the 4,000-row cap.
    let q: any = col
      .where("branchId", "==", branchId)
      .where(SETTLEMENT_TIME_FIELD, ">=", start)
      .where(SETTLEMENT_TIME_FIELD, "<", end)
      .orderBy(SETTLEMENT_TIME_FIELD, "asc")
      .limit(SETTLEMENT_PAGE_SIZE + 1);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    const docs = snap?.docs ?? [];
    for (const doc of docs) {
      if (!byId.has(doc.id)) {
        byId.set(doc.id, { id: doc.id, ...(typeof doc.data === "function" ? doc.data() : {}) });
      }
    }
    if (docs.length <= SETTLEMENT_PAGE_SIZE) break;
    cursor = docs[SETTLEMENT_PAGE_SIZE - 1];
  }

  const eligible = [...byId.values()].filter((order) => {
    const at = settlementEffectiveAtMsOf(order);
    return Number.isFinite(at) && at >= month.startMs && at < month.endMs;
  });
  return {
    orders: eligible.slice(0, SETTLEMENT_ORDER_CAP),
    truncated: eligible.length > SETTLEMENT_ORDER_CAP,
  };
}

/**
 * Unresolved captures carry NO numeric month key, so the canonical month query
 * cannot see them. Count them separately and inject the count into the statement:
 * the statement is never complete (and never payable) while one exists. We never
 * guess a month for these rows.
 */
async function readUnresolvedCaptureCount(branchId: string): Promise<number> {
  const snap: any = await db
    .collection("orders")
    .where("branchId", "==", branchId)
    .where("settlementCaptureUnresolved", "==", true)
    .limit(2000)
    .get();
  return (snap?.docs ?? []).length;
}

/** M6: the branch/month ledger, shared by every statement version. */
export interface PaymentLedger {
  settledNetPaise: number;
  payments: SettlementPaymentRecord[];
}

export async function readPaymentLedger(branchId: string, monthKey: string): Promise<PaymentLedger> {
  const ref = db.collection(SETTLEMENT_PAYMENTS).doc(`${branchId}_${monthKey}`);
  const snap: any = await ref.get();
  const data = snap && snap.exists ? (snap.data() as any) : null;
  return {
    settledNetPaise: Number(data?.settledNetPaise) || 0,
    payments: Array.isArray(data?.payments) ? (data.payments as SettlementPaymentRecord[]) : [],
  };
}

async function nextVersion(branchId: string, monthKey: string): Promise<number> {
  const id = `${branchId}_${monthKey}`;
  const ref = db.collection(SETTLEMENT_VERSIONS).doc(id);
  let version = 0;
  if (db && typeof (db as any).runTransaction === "function") {
    await (db as any).runTransaction(async (tx: any) => {
      const snap = await tx.get(ref);
      const data = (snap && snap.exists ? snap.data() : null) as any;
      version = Math.max(0, Number(data?.latestVersion) || 0) + 1;
      tx.set(
        ref,
        {
          branchId,
          monthKey,
          latestVersion: version,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    });
    return version;
  }
  throw new SettlementError(
    "SETTLEMENT_NO_TRANSACTION",
    "Settlements require a transactional datastore; no statement was written",
    503
  );
}

export interface GenerateSettlementInput {
  branchId: string;
  monthKey: string;
  caller: CallerShape | null | undefined;
  source: SettlementSource;
  now?: number;
  /** Scheduler batches set this; an owner request must not. */
  branchNameHint?: string;
  /**
   * Scheduler batches: a branch with no fee due and no trade in the month gets
   * no document at all (nothing to read, nothing to explain). An explicit
   * owner/brand request always gets its statement, even a zero one.
   */
  omitWhenEmpty?: boolean;
}

/**
 * Builds and stores ONE statement for a branch and month. Only brand roles may
 * call it. The month must already have closed (a live month would settle on
 * half-formed numbers). Returns null only in the `omitWhenEmpty` case.
 */
export async function generateSettlementStatement(
  input: GenerateSettlementInput
): Promise<SettlementStatement | null> {
  const { branchId, monthKey, caller, source } = input;
  const now = typeof input.now === "number" && Number.isFinite(input.now) ? input.now : Date.now();
  assertBrand(source === "scheduler" ? { uid: "scheduler", role: "brand_owner" } : caller, "generate statements");

  if (!branchId) {
    throw new SettlementError("SETTLEMENT_BRANCH_REQUIRED", "branchId is required", 400);
  }
  let month: SettlementMonthBounds;
  try {
    month = settlementMonthBounds(monthKey);
  } catch {
    throw new SettlementError(
      "SETTLEMENT_BAD_MONTH",
      `Cannot settle ${JSON.stringify(monthKey)}: expected a YYYY-MM calendar month`,
      400
    );
  }
  if (now < month.endMs) {
    throw new SettlementError(
      "SETTLEMENT_MONTH_OPEN",
      `${monthKey} has not closed yet — a running month cannot be settled`,
      409
    );
  }

  const branchRef = db.collection("branches").doc(branchId);
  const branchSnap = await branchRef.get();
  if (!branchSnap.exists) {
    throw new SettlementError(
      "SETTLEMENT_BRANCH_UNKNOWN",
      `Cannot settle branch ${branchId}: no such branch`,
      404
    );
  }
  const branchData = (branchSnap.data() || {}) as any;

  const { orders, truncated } = await readBranchMonthOrders(branchId, month);
  const summary = summarizeSettlementOrders(orders, { branchId, ...month }, { truncated });
  summary.captureUnresolved = await readUnresolvedCaptureCount(branchId);

  const fee = resolveSettlementFeePaise(branchData);
  const feeApplicable = isBranchFeeApplicable(
    {
      active: branchData?.active,
      status: branchData?.status,
      createdAtMs: millisOf(branchData?.createdAt, month.startMs - 1),
    },
    summary.onlineOrders > 0 || summary.cashOrders > 0,
    month
  );

  if (input.omitWhenEmpty && !feeApplicable.applicable && summary.onlineOrders === 0 && summary.cashOrders === 0) {
    return null;
  }

  // The ledger, version counter, statement and previous-version `current`
  // flags are all published in ONE transaction. A payment that lands between
  // the read and the write therefore cannot be silently overwritten.
  const ledgerRef = db.collection(SETTLEMENT_PAYMENTS).doc(`${branchId}_${monthKey}`);
  const versionsRef = db.collection(SETTLEMENT_VERSIONS).doc(`${branchId}_${monthKey}`);
  let statement: SettlementStatement | undefined;
  await (db as any).runTransaction(async (tx: any) => {
    const [ledgerSnap, versionsSnap]: any[] = await Promise.all([
      tx.get(ledgerRef),
      tx.get(versionsRef),
    ]);
    const ledgerData = ledgerSnap && ledgerSnap.exists ? (ledgerSnap.data() as any) : null;
    const version =
      Math.max(0, Number(versionsSnap?.exists ? (versionsSnap.data() as any)?.latestVersion : 0) || 0) + 1;
    statement = buildSettlementStatement({
      branchId,
      branchName: String(branchData?.name || "").trim() || input.branchNameHint || branchId,
      monthKey,
      month,
      version,
      summary,
      fee,
      feeApplicable,
      generatedAtMs: now,
      generatedBy: String(caller?.email || caller?.uid || input.source),
      source,
      monthClosed: true,
      now,
      priorSettledNetPaise: Number(ledgerData?.settledNetPaise) || 0,
      priorPaymentRecords: Array.isArray(ledgerData?.payments) ? ledgerData.payments : [],
    });
    // ALL reads first: Firestore rejects any tx.get() after a tx.set().
    // The cycle-9 500 was exactly this error when a month had prior versions.
    const priorToRetire: any[] = [];
    for (let prior = 1; prior < version; prior += 1) {
      const priorRef = db.collection(SETTLEMENT_STATEMENTS).doc(settlementStatementId(branchId, monthKey, prior));
      const priorSnap: any = await tx.get(priorRef);
      if (priorSnap && priorSnap.exists && (priorSnap.data() as any)?.current !== false) {
        priorToRetire.push(priorRef);
      }
    }
    tx.set(versionsRef, {
      branchId,
      monthKey,
      latestVersion: version,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    tx.set(db.collection(SETTLEMENT_STATEMENTS).doc(statement.id), statement);
    // Retire earlier versions deterministically by known document IDs.
    for (const priorRef of priorToRetire) {
      tx.set(priorRef, { current: false }, { merge: true });
    }
  });

  if (fee.invalid) {
    await captureErrorSnapshot({
      source: "system",
      severity: "medium",
      message: `Settlement ${statement!.id}: configured fee for ${branchId} was unusable; default applied`,
      branchId,
    }).catch(() => undefined);
  }
  await writeSettlementAudit(caller, "settlement_generated", statement!.id, {
    branchId,
    monthKey,
    version: statement!.version,
    netPayablePaise: statement!.netPayablePaise,
    outstandingPaise: statement!.outstandingPaise,
    source,
  });
  return statement!;
}

async function writeSettlementAudit(
  caller: CallerShape | null | undefined,
  action: string,
  statementId: string,
  metadata: Record<string, unknown>
): Promise<void> {
  try {
    await db.collection(SETTLEMENT_AUDIT).add({
      actorUid: caller?.uid ?? null,
      actorEmail: caller?.email ?? null,
      action,
      targetType: "settlement",
      targetId: statementId,
      metadata,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err: any) {
    // The statement is already stored; a logging failure must not undo it.
    console.warn("[Settlements] audit write failed:", err?.message || err);
  }
}

function asStatement(data: any): SettlementStatement | null {
  if (!data || typeof data !== "object") return null;
  if (!data.id || !data.branchId || !data.monthKey) return null;
  return data as SettlementStatement;
}

export interface ListSettlementsInput {
  caller: CallerShape | null | undefined;
  monthKey: string;
  branchId?: string;
  allVersions?: boolean;
}

/**
 * Statements for a month, newest version per branch unless `allVersions`.
 * A branch owner sees only their own branches; a brand role sees every branch.
 */
export async function listSettlements(
  input: ListSettlementsInput
): Promise<SettlementStatement[]> {
  assertReadable(input.caller);
  const caller = input.caller!;
  try {
    settlementMonthBounds(input.monthKey);
  } catch {
    throw new SettlementError(
      "SETTLEMENT_BAD_MONTH",
      `Cannot list ${JSON.stringify(input.monthKey)}: expected a YYYY-MM calendar month`,
      400
    );
  }

  const scope = readableBranchScope(caller);
  if (scope !== null && scope.length === 0) {
    throw new SettlementError(
      "SETTLEMENT_FORBIDDEN",
      "Forbidden: this account holds no branch, so there is nothing to settle",
      403
    );
  }
  if (scope !== null && input.branchId && !scope.includes(input.branchId)) {
    throw new SettlementError(
      "SETTLEMENT_FORBIDDEN",
      "Forbidden: that branch is outside your assigned branches",
      403
    );
  }

  const snap = await db
    .collection(SETTLEMENT_STATEMENTS)
    .where("monthKey", "==", input.monthKey)
    .limit(2000)
    .get();

  const statements: SettlementStatement[] = [];
  for (const doc of snap?.docs ?? []) {
    const statement = asStatement(typeof doc.data === "function" ? doc.data() : null);
    if (!statement) continue;
    if (scope !== null && !scope.includes(statement.branchId)) continue;
    if (input.branchId && statement.branchId !== input.branchId) continue;
    statements.push(statement);
  }

  const byBranch = new Map<string, SettlementStatement[]>();
  for (const statement of statements) {
    const list = byBranch.get(statement.branchId) || [];
    list.push(statement);
    byBranch.set(statement.branchId, list);
  }

  const selected: SettlementStatement[] = [];
  for (const [, list] of byBranch) {
    list.sort((a, b) => Number(b.version) - Number(a.version));
    if (input.allVersions) selected.push(...list);
    else if (list.length > 0) selected.push(list[0]);
  }

  return selected.sort(
    (a, b) => a.branchName.localeCompare(b.branchName) || Number(b.version) - Number(a.version)
  );
}

export interface MarkSettlementPaidInput {
  statementId: string;
  reference: string;
  paidOn: string;
  note?: string;
  /**
   * N1 (staging 2026-11-21): an already-paid statement refuses a second payment
   * unless the caller states that this IS an additional payment (a split payout
   * or a top-up). Two UTRs on one statement is a real accounting event, so it is
   * allowed — but only when asked for, never by a double tap.
   */
  additionalPayment?: boolean;
  /**
   * M6: the signed net this payment settles. Defaults to the statement's net
   * payable, which is what "mark as paid" has always meant. Override only for a
   * true part-payment so a regeneration exposes exactly the unpaid delta.
   */
  settledNetPaise?: number;
  caller: CallerShape | null | undefined;
  now?: number;
}

/** `YYYY-MM-DD` in Asia/Kolkata → epoch ms at 00:00 IST, or NaN. */
export function istDateToMs(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || "").trim());
  if (!match) return NaN;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return NaN;
  const ms = Date.UTC(year, month - 1, day) - 5.5 * 60 * 60 * 1000;
  // Reject a date that rolls (31 Feb → 3 Mar).
  const check = new Date(ms + 5.5 * 60 * 60 * 1000);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day) {
    return NaN;
  }
  return ms;
}

/**
 * Records that the brand paid the branch. Reference and date are required; the
 * entry is appended to the statement's payment history. This moves NO money and
 * never alters an amount.
 */
export async function markSettlementPaid(
  input: MarkSettlementPaidInput
): Promise<{ statement: SettlementStatement; reused: boolean }> {
  assertBrand(input.caller, "record a settlement payment");
  const caller = input.caller!;
  const now = typeof input.now === "number" && Number.isFinite(input.now) ? input.now : Date.now();

  const reference = String(input.reference || "").trim();
  if (!reference) {
    throw new SettlementError(
      "SETTLEMENT_INVALID_REFERENCE",
      "A payment reference (bank UTR / cheque / cash voucher number) is required",
      400
    );
  }
  if (reference.length > 120) {
    throw new SettlementError(
      "SETTLEMENT_INVALID_REFERENCE",
      "Payment reference is too long (max 120 characters)",
      400
    );
  }
  const paidAtMs = istDateToMs(input.paidOn);
  if (!Number.isFinite(paidAtMs)) {
    throw new SettlementError(
      "SETTLEMENT_INVALID_PAID_ON",
      `paidOn must be a real YYYY-MM-DD date, got ${JSON.stringify(input.paidOn)}`,
      400
    );
  }
  if (paidAtMs > now) {
    throw new SettlementError(
      "SETTLEMENT_INVALID_PAID_ON",
      "paidOn cannot be in the future",
      400
    );
  }

  const ref = db.collection(SETTLEMENT_STATEMENTS).doc(String(input.statementId || ""));
  const update = async (): Promise<{ statement: SettlementStatement; reused: boolean }> =>
    (db as any).runTransaction(async (tx: any) => {
      const snap = await tx.get(ref);
      if (!snap.exists) {
        throw new SettlementError(
          "SETTLEMENT_NOT_FOUND",
          `No settlement statement ${input.statementId}`,
          404
        );
      }
      const current = asStatement(snap.data());
      if (!current) {
        throw new SettlementError(
          "SETTLEMENT_CORRUPT",
          `Settlement ${input.statementId} is not a readable statement; refusing to mark it paid`,
          409
        );
      }
      // M6 cutover: a statement written before the payment ledger existed has
      // no verified balance. It is VOID — never payable, no data step needed.
      if (current.ledgerSchema !== 1 || typeof current.outstandingPaise !== "number") {
        throw new SettlementError(
          "SETTLEMENT_VOID",
          `Settlement ${input.statementId} predates the payment ledger and is void; regenerate the month before recording a payment`,
          409
        );
      }
      // M6: an incomplete statement is never actionable. A truncated order
      // scan means the totals are a floor; marking it paid would over-pay on
      // numbers we know are wrong.
      if (current.ordersTruncated === true || current.complete === false) {
        throw new SettlementError(
          "SETTLEMENT_INCOMPLETE",
          `Settlement ${input.statementId} has an incomplete order scan; regenerate after raising the scan cap before marking it paid`,
          409
        );
      }
      // M6: verify this is still the current version. A stale paid version
      // hides a regenerated delta behind an old "paid" badge.
      const versionsSnap: any = await tx.get(
        db.collection(SETTLEMENT_VERSIONS).doc(`${current.branchId}_${current.monthKey}`)
      );
      const latestVersion = Number(versionsSnap?.exists ? (versionsSnap.data() as any)?.latestVersion : 0) || 0;
      if (latestVersion > Number(current.version || 0)) {
        throw new SettlementError(
          "SETTLEMENT_STALE_VERSION",
          `Settlement ${input.statementId} is no longer the current version (latest v${latestVersion}); mark the current statement paid instead`,
          409
        );
      }

      // M6: read the ledger INSIDE this transaction, then compute the signed
      // delta against the fresh value. A payment interleaved with regeneration
      // can never add the same net twice.
      const ledgerRef = db
        .collection(SETTLEMENT_PAYMENTS)
        .doc(`${current.branchId}_${current.monthKey}`);
      const ledgerSnap: any = await tx.get(ledgerRef);
      const ledgerData = ledgerSnap && ledgerSnap.exists ? (ledgerSnap.data() as any) : null;
      const ledgerNet = Number(ledgerData?.settledNetPaise) || 0;
      const ledgerPayments: SettlementPaymentRecord[] = Array.isArray(ledgerData?.payments)
        ? ledgerData.payments
        : [];
      const payments = Array.isArray(current.payments) ? [...current.payments] : [];
      const already = payments.find(
        (p) => p.reference === reference && Number(p.paidAtMs) === paidAtMs
      );
      if (already) {
        return { statement: current, reused: true };
      }
      // Delta is recomputed against the FRESH ledger read inside this tx.
      const settledNetPaise = (Number(current.netPayablePaise) || 0) - ledgerNet;
      if (settledNetPaise === 0) {
        throw new SettlementError(
          "SETTLEMENT_ZERO_DELTA",
          `Settlement ${input.statementId} has no outstanding delta; nothing to record`,
          409
        );
      }
      const isAdditionalPayment = payments.length > 0;
      const record: SettlementPaymentRecord = {
        paidAtMs,
        reference,
        recordedBy: String(caller.uid),
        recordedByEmail: caller.email ? String(caller.email) : null,
        note: input.note ? String(input.note).trim().slice(0, 500) : null,
        settledNetPaise,
      };
      tx.set(
        ledgerRef,
        {
          branchId: current.branchId,
          monthKey: current.monthKey,
          // Explicit new total (not increment): retry-safe after a fresh read.
          settledNetPaise: ledgerNet + settledNetPaise,
          payments: [...ledgerPayments, record],
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      // The FIRST payment is the one that settles the statement; any further row
      // is additional history. Overwriting `paymentReference`/`paidAtMs` on a top
      // up would silently restate when the statement was settled.
      const settledAtMs = isAdditionalPayment ? current.paidAtMs : paidAtMs;
      const settledReference = isAdditionalPayment ? current.paymentReference : reference;
      const paid = {
        ...current,
        paidStatus: "paid" as const,
        paidAtMs: settledAtMs,
        paymentReference: settledReference,
        payments: [...payments, record],
        outstandingPaise: 0,
      };
      tx.set(
        ref,
        {
          paidStatus: "paid",
          paidAtMs: settledAtMs,
          paymentReference: settledReference,
          // The transaction already read the current list, so writing the full
          // array is the same read-modify-write Firestore's arrayUnion would do,
          // and it keeps the stored history in one canonical order.
          payments: paid.payments,
          outstandingPaise: 0,
          paidUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      return { statement: paid, reused: false };
    });

  const result = await update();
  if (!result.reused) {
    await writeSettlementAudit(caller, "settlement_marked_paid", input.statementId, {
      branchId: result.statement.branchId,
      monthKey: result.statement.monthKey,
      reference,
      paidAtMs,
    });
  }
  return result;
}

export interface ExportSettlementsInput {
  caller: CallerShape | null | undefined;
  monthKey: string;
  branchId?: string;
}

/** CSV of the month's latest statements, scoped exactly like the list view. */
export async function exportSettlementsCsv(
  input: ExportSettlementsInput
): Promise<{ filename: string; csv: string; count: number }> {
  const statements = await listSettlements({
    caller: input.caller,
    monthKey: input.monthKey,
    branchId: input.branchId,
    allVersions: false,
  });
  if (statements.length === 0) {
    throw new SettlementError(
      "SETTLEMENT_NONE",
      `No settlement statements exist for ${input.monthKey} in your scope`,
      404
    );
  }
  return {
    filename: `settlements-${input.monthKey}.csv`,
    csv: settlementCsv(statements),
    count: statements.length,
  };
}

export interface SchedulerInput {
  /** Defaults to now; the tests pass a fixed instant. */
  now?: number;
  caller?: CallerShape | null;
  /** Only these branches (tests / a targeted re-run). */
  branchIds?: string[];
}

/**
 * The 1st-of-month job: settle the previous Asia/Kolkata month for every active
 * branch. Idempotent — a branch that already has a statement for the month is
 * skipped, so a scheduler retry (or a second run in the same minute) never
 * spawns a version.
 */
export async function runMonthlySettlementScheduler(
  input: SchedulerInput = {}
): Promise<{
  monthKey: string;
  generated: SettlementStatement[];
  skipped: string[];
  failed: Array<{ branchId: string; error: string }>;
}> {
  const now = typeof input.now === "number" && Number.isFinite(input.now) ? input.now : Date.now();
  const monthKey = previousSettlementMonthKey(
    istMonthKeyLocal(now)
  );
  if (!monthKey) {
    throw new SettlementError("SETTLEMENT_BAD_MONTH", "Cannot resolve the previous month", 500);
  }

  const branchesSnap = await db.collection("branches").limit(500).get();
  const wanted = input.branchIds && input.branchIds.length > 0 ? new Set(input.branchIds) : null;

  const existing = await db
    .collection(SETTLEMENT_STATEMENTS)
    .where("monthKey", "==", monthKey)
    .limit(2000)
    .get();
  const already = new Set<string>();
  for (const doc of existing?.docs ?? []) {
    const data = (typeof doc.data === "function" ? doc.data() : null) as any;
    if (data?.branchId) already.add(String(data.branchId));
  }

  const generated: SettlementStatement[] = [];
  const skipped: string[] = [];
  const failed: Array<{ branchId: string; error: string }> = [];

  for (const doc of branchesSnap?.docs ?? []) {
    const branchId = doc.id;
    if (wanted && !wanted.has(branchId)) continue;
    if (already.has(branchId)) {
      skipped.push(branchId);
      continue;
    }
    const branchData = (typeof doc.data === "function" ? doc.data() : {}) as any;
    try {
      const statement = await generateSettlementStatement({
        branchId,
        monthKey,
        caller: input.caller ?? { uid: "settlement-scheduler", role: "brand_owner" },
        source: "scheduler",
        now,
        branchNameHint: branchData?.name,
        omitWhenEmpty: true,
      });
      if (!statement) {
        // Dormant branch, no fee, no trade: nothing is owed, so nothing is filed.
        skipped.push(branchId);
        continue;
      }
      generated.push(statement);
    } catch (err: any) {
      if (err instanceof SettlementError && err.code === "SETTLEMENT_MONTH_OPEN") throw err;
      failed.push({ branchId, error: String(err?.message || err) });
      await captureErrorSnapshot({
        source: "system",
        severity: "high",
        message: `Settlement generation failed for ${branchId} ${monthKey}: ${String(
          err?.message || err
        )}`,
        branchId,
      }).catch(() => undefined);
    }
  }

  return { monthKey, generated, skipped, failed };
}

/** `YYYY-MM` for Asia/Kolkata, from a fixed UTC+05:30 offset (no DST). */
function istMonthKeyLocal(ms: number): string {
  const shifted = new Date(ms + 5.5 * 60 * 60 * 1000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}
