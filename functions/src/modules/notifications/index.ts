/**
 * Notifications module barrel (Batch 1 S1 — H11).
 *
 * Re-exports the FCM dispatch entry point and the Firestore trigger
 * handlers consumed by `src/index.ts`.
 */
export { dispatchFCM } from "./fcm.service";
export { filterSubscribableTopics, MAX_TOPICS_PER_CALL } from "./topics";
export type { TopicCaller } from "./topics";
export {
  onOrderCreatedNotificationTrigger,
  onOrderStatusChangedNotificationTrigger,
  onTicketCreatedUrgentTrigger,
  onTicketEscalatedNotificationTrigger,
} from "./triggers";
