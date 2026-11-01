/**
 * Notifications module barrel (Batch 1 S1 — H11).
 *
 * Re-exports the FCM dispatch entry points, the send gate, preference readers
 * and the Firestore trigger handlers consumed by `src/index.ts` and by the
 * sibling support/payment senders (N-07/N-08).
 */
export { dispatchFCM, markNotificationsRead } from "./fcm.service";
export type { FCMDispatchParams } from "./fcm.service";
export {
  pushToCustomer,
  sendFcmMessage,
  sendMulticastFcm,
  writeCustomerInboxDoc,
} from "./fcmClient";
export type {
  CustomerPushOptions,
  FcmSendOptions,
  MulticastSendOptions,
  SendMulticastResult,
} from "./fcmClient";
export {
  SendGateError,
  TRUSTED_SERVER_ACTOR,
  assertSystemBadgeZero,
  auditAdminDispatch,
  quarantineSendFailure,
  resolveDispatchTarget,
  resolveSend,
} from "./sendGate";
export type {
  ApprovedSend,
  QuarantineInput,
  SendActor,
  SendGateReason,
  SendRequest,
} from "./sendGate";
export {
  ADMIN_CUSTOMER_DISPATCH_PURPOSES,
  BROADCAST_PURPOSES,
  CATEGORY_BY_CUSTOMER_PURPOSE,
  CUSTOMER_PURPOSES,
  DISPATCH_STAFF_ROLES,
  GLOBAL_DISPATCH_ROLES,
  NOTIFICATION_PURPOSES,
  PREF_CATEGORY_BY_PURPOSE,
  SYSTEM_PURPOSE,
  STAFF_PURPOSE,
  authorizeDispatch,
  classifyPurpose,
  isCustomerPurpose,
  isNotificationPurpose,
  notificationPurposeSchema,
} from "./registry";
export type {
  CustomerPurpose,
  DispatchCaller,
  DispatchAuthorization,
  NotificationKind,
  NotificationPurpose,
  StaffPurpose,
  SystemPurpose,
} from "./registry";
export {
  DEFAULT_NOTIFICATION_PREFS,
  MAX_DEVICE_PREFS_PER_USER,
  DevicePrefsVersionConflict,
  filterTokensByPrefs,
  getDevicePreferences,
  isPurposeEnabled,
  loadCanonicalPrefs,
  normalizeNotificationPrefs,
  updateDevicePreferences,
} from "./devicePrefs";
export type {
  CanonicalPrefsSnapshot,
  DevicePrefsConflictCode,
  DevicePrefsReadResult,
  DevicePrefsUpdateResult,
  NotificationPrefs,
  SuppressionResult,
} from "./devicePrefs";
export {
  onOrderCreatedNotificationTrigger,
  onOrderStatusChangedNotificationTrigger,
  onTicketCreatedUrgentTrigger,
  onTicketEscalatedNotificationTrigger,
} from "./triggers";
