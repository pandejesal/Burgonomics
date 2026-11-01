import * as admin from "firebase-admin";
import { db } from "../../core/firebase";
import {
  CustomerPurpose,
  NotificationPurpose,
  PREF_CATEGORY_BY_PURPOSE,
  PrefCategory,
  classifyPurpose,
  isCustomerPurpose,
} from "./registry";

/**
 * Canonical notification preferences (contract §8, §9).
 *
 * Source of truth: `users/{uid}/device_prefs/{installationId}` with
 * `notificationPrefs`. `device_tokens/{token}` only carries `installationId`;
 * there is deliberately no prefs snapshot on the token, so a rotation can
 * never honour stale state.
 *
 * Read budget: one recipient is at most `MAX_DEVICE_PREFS_PER_USER` docs; a
 * broadcast wave (≤2000 token docs) adds at most one direct-doc read per token
 * that has an installationId. Topic sends read zero preference documents.
 */

export const DEVICE_PREFS_SCHEMA_VERSION = 1;
export const MAX_DEVICE_PREFS_PER_USER = 2000;
const PREF_READ_CHUNK = 500;

export interface NotificationPrefs {
  offers: boolean;
  orderUpdates: boolean;
  announcements: boolean;
  supportReplies: boolean;
}

/** Category defaults (§9). `announcements` is opt-in; the rest are opt-out. */
export const DEFAULT_NOTIFICATION_PREFS: Readonly<NotificationPrefs> = Object.freeze({
  offers: true,
  orderUpdates: true,
  announcements: false,
  supportReplies: true,
});

const PREF_KEYS: ReadonlyArray<PrefCategory> = [
  "offers",
  "orderUpdates",
  "announcements",
  "supportReplies",
];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Normalizes a stored prefs blob. An absent key inherits the documented
 * default; an explicit boolean is always preserved (a stored `false` is a
 * decision, never coerced back to the default).
 */
export function normalizeNotificationPrefs(raw: unknown): NotificationPrefs {
  const source = asRecord(raw);
  const prefs = { ...DEFAULT_NOTIFICATION_PREFS };
  for (const key of PREF_KEYS) {
    const value = source[key];
    if (typeof value === "boolean") prefs[key] = value;
  }
  return prefs;
}

export function isPurposeEnabled(prefs: NotificationPrefs, purpose: NotificationPurpose): boolean {
  if (!isCustomerPurpose(purpose)) return true; // staff/system are never preference-gated
  return prefs[PREF_CATEGORY_BY_PURPOSE[purpose]];
}

export interface CanonicalPrefsSnapshot {
  /** installationId -> normalized prefs. */
  byInstallation: Map<string, NotificationPrefs>;
  docsRead: number;
  truncated: boolean;
  readFailed: boolean;
}

const EMPTY_SNAPSHOT = (): CanonicalPrefsSnapshot => ({
  byInstallation: new Map(),
  docsRead: 0,
  truncated: false,
  readFailed: false,
});

/**
 * Reads the recipient's canonical records in one bounded query. A read failure
 * is reported (never hidden): callers fall back to category defaults and count
 * the tokens as `legacyUnresolved`, the same honest bucket as a legacy token.
 */
export async function loadCanonicalPrefs(uid: string): Promise<CanonicalPrefsSnapshot> {
  const snapshot = EMPTY_SNAPSHOT();
  if (!uid || !db || typeof db.collection !== "function") return snapshot;
  try {
    const snap = await db
      .collection("users")
      .doc(uid)
      .collection("device_prefs")
      .limit(MAX_DEVICE_PREFS_PER_USER)
      .get();
    const docs: any[] = Array.isArray((snap as any)?.docs) ? (snap as any).docs : [];
    for (const doc of docs) {
      if (!doc || typeof doc.id !== "string" || !doc.id) continue;
      snapshot.byInstallation.set(doc.id, normalizeNotificationPrefs(doc.data?.()?.notificationPrefs));
    }
    snapshot.docsRead = docs.length;
    snapshot.truncated = docs.length >= MAX_DEVICE_PREFS_PER_USER;
    return snapshot;
  } catch {
    snapshot.readFailed = true;
    return snapshot;
  }
}

export interface PrefDevice {
  token: string;
  installationId?: string | null;
}

export interface SuppressionResult {
  eligible: string[];
  suppressed: string[];
  suppressedAll: boolean;
  /** Token documents with no installationId / no canonical record (defaults applied). */
  legacyUnresolved: number;
  docsRead: number;
  readFailed: boolean;
}

/**
 * Applies canonical prefs to a set of recipient tokens.
 *
 * Only customer purposes are suppressed. A token with no installationId, no
 * matching record, or whose read failed uses the category defaults and is
 * counted in `legacyUnresolved` — it is never withheld for being legacy.
 */
export function filterTokensByPrefs(
  purpose: NotificationPurpose,
  devices: ReadonlyArray<PrefDevice>,
  snapshot: CanonicalPrefsSnapshot
): SuppressionResult {
  const kind = classifyPurpose(purpose);
  const eligible: string[] = [];
  const suppressed: string[] = [];
  let legacyUnresolved = 0;

  if (kind !== "customer") {
    for (const device of devices) eligible.push(device.token);
    return {
      eligible,
      suppressed,
      suppressedAll: false,
      legacyUnresolved: 0,
      docsRead: 0,
      readFailed: false,
    };
  }

  const category = PREF_CATEGORY_BY_PURPOSE[purpose as CustomerPurpose];
  for (const device of devices) {
    const installationId = typeof device.installationId === "string" ? device.installationId : "";
    if (!installationId) {
      legacyUnresolved += 1;
      if (DEFAULT_NOTIFICATION_PREFS[category]) eligible.push(device.token);
      else suppressed.push(device.token);
      continue;
    }
    const canonical = snapshot.byInstallation.get(installationId);
    if (!canonical) {
      // A read failure is counted per token, so metrics distinguish "no record"
      // from "Firestore could not answer" while behaviour stays defaults-only.
      legacyUnresolved += 1;
      if (DEFAULT_NOTIFICATION_PREFS[category]) eligible.push(device.token);
      else suppressed.push(device.token);
      continue;
    }
    if (canonical[category]) eligible.push(device.token);
    else suppressed.push(device.token);
  }

  return {
    eligible,
    suppressed,
    suppressedAll: devices.length > 0 && eligible.length === 0,
    legacyUnresolved,
    docsRead: snapshot.docsRead,
    readFailed: snapshot.readFailed,
  };
}

/**
 * Batch variant for the broadcast wave. Uses direct document reads (doc-id
 * access only; no query-by-token) so a ≤2000-device wave costs at most one
 * extra read per device that has an installationId.
 */
export async function loadPrefsForDevices(
  devices: ReadonlyArray<{ uid?: string | null; installationId?: string | null }>
): Promise<{ byKey: Map<string, NotificationPrefs>; docsRead: number }> {
  const byKey = new Map<string, NotificationPrefs>();
  const keys: Array<{ key: string; ref: any }> = [];
  if (!db || typeof db.collection !== "function") return { byKey, docsRead: 0 };

  for (const device of devices) {
    const uid = typeof device.uid === "string" ? device.uid : "";
    const installationId =
      typeof device.installationId === "string" ? device.installationId : "";
    if (!uid || !installationId) continue;
    const key = `${uid}/${installationId}`;
    if (byKey.has(key)) continue;
    keys.push({
      key,
      ref: db.collection("users").doc(uid).collection("device_prefs").doc(installationId),
    });
  }

  let docsRead = 0;
  for (let i = 0; i < keys.length; i += PREF_READ_CHUNK) {
    const chunk = keys.slice(i, i + PREF_READ_CHUNK);
    try {
      const snaps = await db.getAll(...chunk.map((entry) => entry.ref));
      snaps.forEach((snap: any, index: number) => {
        docsRead += 1;
        if (!snap?.exists) return;
        byKey.set(chunk[index].key, normalizeNotificationPrefs(snap.data?.()?.notificationPrefs));
      });
    } catch {
      // The chunk stays unresolved; callers fall back to defaults and count it.
    }
  }
  return { byKey, docsRead };
}

/** Broadcast helper: resolves a device's prefs from the batch map. */
export function prefsForDevice(
  device: { uid?: string | null; installationId?: string | null },
  byKey: Map<string, NotificationPrefs>
): { prefs: NotificationPrefs; canonical: boolean } {
  const uid = typeof device.uid === "string" ? device.uid : "";
  const installationId =
    typeof device.installationId === "string" ? device.installationId : "";
  const found = uid && installationId ? byKey.get(`${uid}/${installationId}`) : undefined;
  return { prefs: found ?? { ...DEFAULT_NOTIFICATION_PREFS }, canonical: !!found };
}

/** True when a customer purpose is enabled by a (possibly defaulted) pref set. */
export function categoryEnabled(prefs: NotificationPrefs, purpose: CustomerPurpose): boolean {
  return prefs[PREF_CATEGORY_BY_PURPOSE[purpose]];
}

export interface DevicePrefsUpdateInput {
  uid: string;
  installationId: string;
  notificationPrefs: Partial<NotificationPrefs>;
  expectedVersion: number;
  mutationId?: string;
}

export interface DevicePrefsUpdateResult {
  replicated: boolean;
  version: number;
  prefs: NotificationPrefs;
  currentVersion: number;
  currentPrefs: NotificationPrefs;
  stale: boolean;
}

export type DevicePrefsConflictCode = "PREF_VERSION_CONFLICT" | "idempotency_conflict";

export class DevicePrefsVersionConflict extends Error {
  readonly code: DevicePrefsConflictCode;
  readonly statusCode = 409;
  /** Server state at conflict time — the client conflict card rebases on this. */
  readonly currentVersion: number;
  readonly currentPrefs: NotificationPrefs;

  constructor(params: {
    code?: DevicePrefsConflictCode;
    message?: string;
    currentVersion?: number;
    currentPrefs?: NotificationPrefs;
  } = {}) {
    const code = params.code ?? "PREF_VERSION_CONFLICT";
    super(params.message ?? code);
    this.name = "DevicePrefsVersionConflict";
    this.code = code;
    this.currentVersion =
      typeof params.currentVersion === "number" && params.currentVersion >= 0
        ? params.currentVersion
        : 0;
    this.currentPrefs = params.currentPrefs ?? { ...DEFAULT_NOTIFICATION_PREFS };
  }
}

interface RecentMutation {
  mutationId: string;
  version: number;
  prefsHash: string;
  prefs: NotificationPrefs;
}

const MAX_RECENT_MUTATIONS = 8;

/**
 * Replay hash over SUPPLIED keys only (contract §7 idempotency). A
 * defaults-normalized hash collapsed distinct patches (`{}` vs
 * `{announcements:false}`), so replaying the same mutationId with a changed
 * patch was answered "replicated" and silently dropped the change.
 */
function patchHash(patch: Record<string, unknown>): string {
  return PREF_KEYS.filter((key) => typeof patch[key] === "boolean")
    .map((key) => `${key}:${patch[key] ? 1 : 0}`)
    .join("|");
}

/** Canonical read (GET /notifications/preferences). Doc-id access only. */
export interface DevicePrefsReadResult {
  installationId: string;
  notificationPrefs: NotificationPrefs;
  version: number;
  exists: boolean;
}

export async function getDevicePreferences(input: {
  uid: string;
  installationId: string;
}): Promise<DevicePrefsReadResult> {
  const { uid, installationId } = input;
  if (typeof uid !== "string" || !uid) {
    throw new Error("getDevicePreferences: authenticated uid is required");
  }
  if (typeof installationId !== "string" || !installationId) {
    throw new Error("getDevicePreferences: installationId is required");
  }
  const snap = await db
    .collection("users")
    .doc(uid)
    .collection("device_prefs")
    .doc(installationId)
    .get();
  if (!snap.exists) {
    // Not a 404: an absent record is the documented default state at version 0.
    return {
      installationId,
      notificationPrefs: { ...DEFAULT_NOTIFICATION_PREFS },
      version: 0,
      exists: false,
    };
  }
  const data = (snap.data() ?? {}) as Record<string, unknown>;
  const version =
    typeof data.version === "number" && data.version >= 0 ? data.version : 0;
  return {
    installationId,
    notificationPrefs: normalizeNotificationPrefs(data.notificationPrefs),
    version,
    exists: true,
  };
}

/**
 * CAS write for one installation (contract §7). Version is the only ordering:
 * - `expectedVersion: 0` on an absent doc creates at v1; on an existing doc 409.
 * - a matching `expectedVersion` writes version + 1.
 * - a replayed `mutationId` returns the recorded result without writing.
 *
 * The merge keeps a stored `false` (a partial patch cannot silently re-enable
 * a category); absent keys inherit defaults on first write.
 */
export async function updateDevicePreferences(
  input: DevicePrefsUpdateInput
): Promise<DevicePrefsUpdateResult> {
  const uid = input.uid;
  const installationId = input.installationId;
  if (typeof uid !== "string" || !uid) {
    throw new Error("updateDevicePreferences: authenticated uid is required");
  }
  if (typeof installationId !== "string" || !installationId) {
    throw new Error("updateDevicePreferences: installationId is required");
  }

  return db.runTransaction(async (tx: FirebaseFirestore.Transaction) => {
    const ref = db
      .collection("users")
      .doc(uid)
      .collection("device_prefs")
      .doc(installationId);
    const snap = await tx.get(ref);
    const currentData = snap.exists ? (snap.data() ?? {}) : {};
    const currentPrefs = normalizeNotificationPrefs(currentData.notificationPrefs);
    const currentVersion =
      typeof currentData.version === "number" && currentData.version >= 0
        ? currentData.version
        : 0;

    const recent: RecentMutation[] = Array.isArray(currentData.recentMutations)
      ? (currentData.recentMutations as RecentMutation[])
      : [];

    if (input.mutationId) {
      const replay = recent.find((entry) => entry?.mutationId === input.mutationId);
      if (replay) {
        const sameHash =
          replay.prefsHash === patchHash(input.notificationPrefs as Record<string, unknown>);
        if (!sameHash) {
          throw new DevicePrefsVersionConflict({
            code: "idempotency_conflict",
            message: "idempotency_conflict",
            currentVersion,
            currentPrefs,
          });
        }
        return {
          replicated: true,
          version: replay.version,
          prefs: normalizeNotificationPrefs(replay.prefs),
          currentVersion,
          currentPrefs,
          stale: replay.version < currentVersion,
        };
      }
    }

    if (input.expectedVersion !== currentVersion) {
      throw new DevicePrefsVersionConflict({ currentVersion, currentPrefs });
    }

    const nextVersion = currentVersion + 1;
    // A partial patch keeps existing explicit booleans; only provided keys move.
    const merged: NotificationPrefs = { ...currentPrefs };
    for (const key of PREF_KEYS) {
      const value = (input.notificationPrefs as Record<string, unknown>)[key];
      if (typeof value === "boolean") merged[key] = value;
    }

    const mutation: RecentMutation = {
      mutationId: input.mutationId || `m_${Date.now()}_${nextVersion}`,
      version: nextVersion,
      prefsHash: patchHash(input.notificationPrefs as Record<string, unknown>),
      prefs: merged,
    };
    const nextRecent = [...recent, mutation].slice(-MAX_RECENT_MUTATIONS);

    tx.set(
      ref,
      {
        notificationPrefs: merged,
        version: nextVersion,
        prefsUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
        provenance: "server_route",
        prefsSchema: DEVICE_PREFS_SCHEMA_VERSION,
        recentMutations: nextRecent,
      },
      { merge: true }
    );

    return {
      replicated: false,
      version: nextVersion,
      prefs: merged,
      currentVersion: nextVersion,
      currentPrefs: merged,
      stale: false,
    };
  });
}

/** Exported for tests/readers that need the canonical category vocabulary. */
export const PREFERENCE_CATEGORIES = PREF_KEYS;
