# BURGONOMICS — Push Notifications & Audio Invariants (Layer 3 Constraint)

> **Reference Specification**: Firebase Cloud Messaging (FCM) topics, APNS / Android push tokens, and Partner POS looping audio alarms.

---

## 1. FCM Subscription Topics

| Topic | Target Audience | Trigger Event |
|---|---|---|
| `order_{orderId}` | Customer | Order status change (`accepted`, `preparing`, `ready`, `out_for_delivery`, `delivered`) |
| `branch_{branchId}` | Branch Staff & Manager | New incoming order, Porter courier updates, new support ticket |
| `brand` | Brand Owners | Daily executive sales summary, brand-wide escalation |
| `chat_{pairId}` | 1:1 DM Participants | New direct message between Branch Owner and Brand Owner |
| `upcoming_{branchId}` | Prospective Customers | Grand opening notifications for new franchise branches |

---

## 2. Partner POS Loud Audio Alarms
- When a new order arrives on `branch_{branchId}`, the Partner POS web & native app triggers a continuous looping high-urgency audio alarm (`new_order_chime.mp3`) until acknowledged by kitchen staff.
- Prevents missed orders during high-velocity lunch and dinner peak rushes.

---

## 3. In-App Notification Center
- Push notifications are mirrored into Firestore `users/{uid}/notifications/{id}`.
- Unread notification badges displayed in header profile avatar.
