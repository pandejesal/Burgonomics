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

## 4. Recipient ownership at send time

- `users/{uid}.fcmTokens` is an index, not delivery authority. Logout cleanup can
  be best-effort or skip after a concurrent token rebind, leaving stale memberships.
- Recipient-bound multicast reads `device_tokens/{token}.userId` before each
  transport chunk (at most 500 tokens) and sends only matching owned tokens.
  Missing, ownerless, foreign or unreadable destinations are withheld, not reported
  as delivered and not pruned from another user's profile. Withheld noncritical
  customer messages can still use the recipient's in-app inbox fallback.
- Explicitly empty recipient IDs fail closed. Omitting a recipient retains the
  trusted server's generic multicast API; private customer sends must supply a UID.
- The ledger read and external FCM send are not atomic. This closes stale-list
  delivery after a completed rebind, not every possible account-switch timing
  window; client token lifecycle and real-device acceptance remain separate gates.
- Regression tests of this boundary must exercise the production send path with a
  mocked transport, not count the NODE_ENV=test/VITEST simulation as delivery proof.
