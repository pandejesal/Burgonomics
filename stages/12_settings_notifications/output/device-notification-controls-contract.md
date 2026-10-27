# Device Notification Controls — Contract (FINAL_DRAFT_NEEDS_INDEPENDENT_REVIEW_REV4)

- **Status**: FINAL_DRAFT_NEEDS_INDEPENDENT_REVIEW_REV4. Docs only — no code/tests/config/rules/CI/children/commits/pushes/`.env`/FCM/device. Nothing implemented or run.
- **Supersedes**: REV3 (216 lines). Main plan/summary and other owners' files untouched.
- **Preserved**: DEC-02/05/06/08/16/17/18/19; rejections of shared-install toggles, deliver-unknown-type, automatic security bypass. Delivery stays Firebase standard OS background, generic previews, no data-only native.
- **Design-only**: `installationId` and `device_prefs` still have zero matches in `functions/src`.
- **REV4 scope**: B2 retry token source, B3a inbox persistence for every account send, B3b real tap routes, plus five non-blocking corrections. B1 and F4–F6 are closed and unchanged.

---

## 1. Citation hygiene (tree-specific)
| Claim | Worktree `polish-core-20261025` (target) | Root `burgonomics-foundation-core` (dirty main) |
|---|---|---|
| Logout unlink | awaited 3 s: `authStore.ts:109-136`,`:342` | fire-and-forget `:264` (306 lines) |
| Service worker | sanitized, 131 lines `:18-26`,`:39-46` | 52-line copy, unsanitized |
| Web push init | `pushNotifications.ts:240`,`:244`,`:290` | same |

- Rules drift: `device_tokens` deny `:857-860` (`polish-backend-20261025`) vs `:844-847` (`polish-plan-20261025`); parity is a precondition of N-09.
- RBAC fact: `GLOBAL_TICKET_ROLES = {brand_owner, developer, support}` (`tickets.service.ts:36-40`, `:54`).
- Raw ticket senders: `notificationDispatcher.ts:77`,`:108`,`:148`; `ticketReminder.scheduler.ts:88`,`:105` (plan-wt; backend-wt `:107`,`:124`).
- Others verified: `mobileBootstrap.ts:19`; `tickets.service.ts:826-829`; `index.ts:1171-1217`,`:1196-1204`,`:1209-1213`; `fcm.service.ts:62-69`; `broadcast.ts:48-63`; `notificationsStore.ts:10`; `NotificationRow.tsx:10-14`; `screens.ts:24`; `support.tsx:51-58`,`:169-172`; `TicketListAccordion.tsx:15`.

---

## 2. F1 — one gate for every send primitive
NEW `functions/src/modules/notifications/sendGate.ts`; **only `sendGate.ts` and `fcmClient.ts` internals** may call `messaging.send` / `sendEachForMulticast` (lint-enforced).

```
resolveSend({ purpose, payloadType, recipientUid?, topic?, token?, actor? }) -> ApprovedSend
```

- `purpose` is required on `sendMulticastFcm`, `sendFcmMessage`, `dispatchFCM`; the router supplies it from server state, never from the body.
- Purposes: `CustomerPurpose = orderUpdates|supportReplies|offers|announcements`; `StaffPurpose = operational`; **`SystemPurpose = system`**.
- Customer purpose without `recipientUid` ⇒ throw `SendGateError`, **zero messaging calls**, quarantine + audit + error snapshot.
- Every token in a customer send must resolve to that uid (`fcmClient.ts:78-95`).
- `system` (badge_clear) requires `recipientUid`, is ownership-checked, never preference-gated or quarantined, writes no inbox row, and **sends badge 0 only — it never increments** (`fcm.service.ts:62-69`).
- Staff purpose only from trusted server context or a route-resolved staff actor (§3); body `data.type` never classifies.
- Broadcast is the sole bulk exception (`offers`/`announcements`, `audience:"all_devices"`, §9).

| Caller | Today | `purpose` | `recipientUid` |
|---|---|---|---|
| `triggers.ts:40`,`:266`,`:308`; `petpooja.scheduler.ts:506`; `dispatch.webhooks.ts`; `porter.service.ts` | `sendFcmMessage`/`dispatchFCM` topic | `operational` | — |
| `notificationDispatcher.ts:77`,`:108`,`:148`; `ticketReminder.scheduler.ts:88`,`:105` | **raw `messaging.send`** | `operational` (lint forces rewrite) | — |
| `triggers.ts:92`,`:197` | multicast, no purpose | `orderUpdates` | `customerId` |
| `webhookHandler.ts:890`,`:1115` | `pushToCustomer` | `orderUpdates` | order owner |
| `tickets.service.ts:823` | `pushToCustomer` | `supportReplies` | `customerId` |
| `fcm.service.ts:62-69` badge_clear | multicast, no purpose | `system` | `recipientUid` |
| `index.ts:1216` token | `dispatchFCM` | `operational` after §3 | token owner |
| `broadcast.ts:73` | multicast, no purpose | `announcements`\|`offers` | `audience:"all_devices"` |

---

## 3. F2 — `/notifications/dispatch` authorization (closed, B1)
1. Resolve `device_tokens/{token}` → `ownerUid` + role; unknown/ambiguous owner ⇒ generic `403`.
2. `brand_owner`/`developer`: any **staff** token; **customer** token only with `purpose ∈ {orderUpdates, supportReplies}` plus a `notification_admin_sends` audit row.
3. **`support` is brand-global for staff-token sends** (`tickets.service.ts:36-40`, `:54`): empty `branchIds` still reaches any staff token; customer tokens ⇒ `403`. Dispatch scope only, not a Phase-3 policy change.
4. `branch_owner`/`branch_staff`: recipient staff **and** in `caller.branchIds`; missing/empty/mismatch ⇒ `403`; customer tokens ⇒ `403`.
5. Topic path keeps `:1196-1204`, purpose `operational` only.

Audit row: actor uid, purpose, target class, token prefix — never the full token or customer copy.

---

## 4. F3 — logout unlink: retry that actually has a token (B2)
- Target tree already awaits a 3 s race (`authStore.ts:109-136`,`:342`); root still fire-and-forgets (`:264`). No regression.
- Helper returns `"ok" | "timeout" | "failed"` (today `void`), because `unlinkUserFromDeviceToken` logs `!res.ok` and returns `ok(null)` (`notificationsService.ts:192-205`, `:226`); the service must return failure on non-2xx/exception.
- **Retry token source**: on failure write
  `pendingUnlink = { uid, tokenHash, attempts, at, reason }` plus a **retry-only copy of the token in the existing secure-storage adapter** (`shared/services/secureStorage.ts`, the same adapter described at `authStore.ts:64-68`). The operational cache is cleared immediately; the secure copy is readable **only** by the retry routine — registration never reads it.
- Retry triggers, both bounded:
  1. next boot with the **same uid**, before any register call: read the secure copy → unlink → clear it;
  2. native SDK `registration` event (the point where a token actually exists): compare `hash(sdkToken)`; match ⇒ unlink then associate; mismatch ⇒ **drop the entry** (rotation) and associate the new token.
- **Drop rules**: after 3 attempts, 7 days, a hash mismatch, or a different-uid sign-in. Dropping logs `pendingUnlinkDropped`, clears the secure copy, and never loops. The entry is only ever replayed when the current uid equals `entry.uid`; no unlink is sent under another uid's JWT.
- Acceptance: HTTP **401** at logout → entry written with secure token → same-uid boot issues the unlink and clears it; SDK rotation → entry dropped, no loop, no cross-UID send.

---

## 5. F4 — legacy token rows (closed, unchanged)
| Token doc | Canonical `device_prefs` | Result | Counter |
|---|---|---|---|
| has `installationId` | exists | record prefs | — |
| has `installationId` | absent | category defaults | `legacyUnresolved` |
| lacks `installationId` | n/a | category defaults | `legacyUnresolved` |

`registerToken` stamps `installationId` only on owner `claimed`/`refreshed`; no mass backfill, withhold, or bypass; pending is client state only.

---

## 6. F5 — legacy decision per uid (closed, unchanged)
`burg.notifPrefs.v1.<uid>.legacyDecision = "pending"|"claimed"|"declined"`; `burg.settings` never written, legacy blob never mutated; A's decline cannot bind B; claim preserves a stored `false`.

---

## 7. F6 — CAS, replay, multi-tab (closed, unchanged)
`version` only order; `expectedVersion: 0` creates at `v1` in the same transaction; ring stores `{mutationId, prefsHash, version, prefs}`; replay returns `{replicated, version, prefs, currentVersion, currentPrefs}` with `stale:true` when older; different hash ⇒ `409 idempotency_conflict`; `BroadcastChannel` + `storage` fallback.

---

## 8. Data model (protocol `prefsSchema: 1`)
`users/{uid}/device_prefs/{installationId}`: `notificationPrefs`, `version`, `prefsUpdatedAt`, `provenance`, `lastToken`, `platform`, `recentMutations[8]`.
`device_tokens/{token}`: adds `installationId` only — no prefs snapshot.
- Rules: nested `match /device_prefs/{installationId} { allow read, write: if false; }` inside `match /users/{userId}`, plus an explicit deny for `notification_quarantine/{id}`. No recursive wildcard exists; blocks are defence-in-depth. No existing `users`/`orders` match is loosened.
- No index: doc-id access only; query-by-token forbidden.

---

## 9. Defaults and suppression (preserved)
| Category | Absent | Explicit `false` | Explicit `true` |
|---|---|---|---|
| `offers` | true | preserved | preserved |
| `orderUpdates` | true | preserved | preserved |
| `announcements` | **false** | preserved | preserved |
| `supportReplies` | **true** (DEC-08) | **always preserved** | preserved |

- Suppression only for customer-purpose sends; staff topics read zero prefs; `system` exempt.
- Document reads: `2k` per recipient; broadcast wave ≤2000 ⇒ ≤4000. Document reads are the unit, not RPCs.
- Metrics: `suppressedCount`, `suppressedAll`, `quarantinedCount`, `legacyUnresolved`; broadcast adds `targeted`, `eligible`, `customerEligible`, `staffDevices`, `providerAccepted`, `providerFailed`, `prunedCount`. No "delivered" without ACK.
- `all_devices` enumerates every `device_tokens` row, staff included (`broadcast.ts:48-63`). Absent record ⇒ defaults, so **staff devices do receive `offers` (default true)** but not `announcements` (default false). Topic alarms unaffected.

---

## 10. Support publishers (P1)
NEW `functions/src/modules/tickets/supportNotifications.ts`: reply, escalation, plus the existing resolution send.
- New senders, not current capability (`addTicketMessage` has no push).
- Staff author from `caller.role` (`tickets.service.ts:389-390`); self-reply ⇒ no push.
- Stable `messageId`/`transitionId`; attempt record `notification_dispatch/{purpose}:{stableId}`; dispatch after commit, never inside `runTransaction`.
- Push failure never fails the persisted message and never retries it; ambiguous delivery is `unknown`.
- Resolution copy drops `ticketNumber` (`tickets.service.ts:826-829`).

---

## 11. Payload, inbox persistence, routing (B3a + B3b)
- Account payload: `data = {purpose, category, recipientUid, ref}` only — no order/ticket id, no `deeplink`, no name, snippet, or address.
- **`ref` is the inbox document id, created for every account send, independent of FCM outcome.** Order: generate `ref = crypto.randomUUID()` → write `users/{uid}/notifications/{ref}` with `{id, title, message, purpose, targetId, type, read:false, createdAt}` → send FCM carrying `data.ref`.
- `targetId` is supplied by the sender, not guessed: support publishers pass the ticket id, order/payment sends pass the order id. `writeCustomerInboxDoc` (`fcmClient.ts:216-244`) is extended to map `data.ticketId`/`data.orderId` → `targetId` and `data.purpose` → `purpose`, and keeps `type` as a compatibility alias (`:234-235`).
- Failure/suppression/quarantine paths **update the same `ref`** (idempotent on `ref`) — never a second dangling row. Zero-delivery fallback remains an additional path, no longer the only writer.
- Any payload whose `recipientUid` ≠ current uid is dropped before inbox, toast, or navigation.
- **Foreground resolution**: after auth, read `users/{uid}/notifications/{ref}`; `purpose === "supportReplies"` ⇒ `/support?ticketId=<targetId>`; `"orderUpdates"` ⇒ `/orders/<targetId>/track`; missing/denied ⇒ `/profile/notifications`.
- **Background tap**: the SW opens the real route `"/profile/notifications?ref=<encoded>"` (`screens.ts:24`); the app resolves after sign-in. `resolveNotificationTarget` (`:39-46`) stops reading `deeplink`/`ticketId`/`orderId` and never falls back to `/`.
- **Support route must parse it**: add `ticketId` to `support.tsx` `validateSearch` (`:51-58`) and pass `initialOpenId={search.ticketId}` at `:169-172`; `TicketListAccordion` already accepts `initialOpenId` (`TicketListAccordion.tsx:15`).
- Public offers/announcements keep public copy; category enforced. Security copy generic, allowlist empty. Native OS fallback is generic because the server sends generic copy.
- SW duplicate display remains audit-first; edit only if the audit proves double rendering or a privacy leak.

---

## 12. Client fixes folded in
- Categories: extend to `"offer"|"order"|"general"|"support"` (`notificationsStore.ts:10`); map `supportReplies→support`, `orderUpdates→order`, `offers→offer`, `announcements→general`; `LifeBuoy` icon (`NotificationRow.tsx:10-14`).
- Web permission: split "listener attached" from "permission decided" (`pushNotifications.ts:240`,`:244`,`:290`); boot with `default` → toggle ON ⇒ prompt.
- Logout/SDK coherence: token deleted or rotated; operational cache cleared.

---

## 13. Ownership IDs (proposals; not written by me)
| ID | Files |
|---|---|
| N-01 | `functions/src/modules/notifications/{sendGate.ts,registry.ts,devicePrefs.ts}` (NEW) |
| N-02 | `functions/src/core/deviceTokenRegister.ts` |
| N-03 | `functions/src/core/validation.ts` (notification schemas only) |
| N-04 | `functions/src/index.ts` (§3 dispatch + §4 register/prefs routes) |
| N-05 | `functions/src/modules/notifications/{fcmClient.ts,fcm.service.ts}` (inbox persistence, `ref`, `purpose`) |
| N-06 | `functions/src/modules/notifications/{templates,broadcast,triggers}.ts` |
| N-07 | `functions/src/modules/tickets/{supportNotifications.ts (NEW),tickets.service.ts,notificationDispatcher.ts,ticketReminder.scheduler.ts}` |
| N-08 | `functions/src/modules/payments/webhookHandler.ts` |
| N-09 | `firestore.rules` (two deny blocks, after parity check) |
| C-01 | `src/features/settings/{state/settingsStore.ts,models/index.ts,repositories/SettingsRepository.ts}` (+ BroadcastChannel) |
| C-02 | `src/features/notifications/{services/notificationsService.ts,state/notificationsStore.ts,components/NotificationRow.tsx}`, `src/features/auth/state/authStore.ts`, `src/boot.tsx` |
| C-03 | `src/shared/platform/pushNotifications.ts` (`ref` routing, permission prompt) |
| C-04 | `src/routes/profile.settings.tsx` (+ migration prompt) |
| C-05 | `src/routes/{support.tsx,profile.notifications.tsx}` (`ticketId` search + `initialOpenId`, `ref` resolution) |
| C-06 | `public/firebase-messaging-sw.js` — only after the audit proves a defect |

**Reserved**: orders/checkout/`FulfillmentCard`/receipt/search, partner app, CI/config, root dirty Petpooja files.

---

## 14. Acceptance cases
1. 401 / 403 foreign / 403 unknown (identical body) / 200 own; `.strict()` 400 on `uid`/`category`.
2. A→B same install: isolated prefs, no A dirty replay under B.
3. Rotation/multiple tokens: canonical read at send; no stale snapshot honoured.
4. Delayed save/timer/refresh: late A response discarded; 409 keeps desired, shows conflict.
5. Multi-tab: BroadcastChannel reconciliation, stale `baseVersion` merge, no false synced.
6. Replay `m1(v1)→m2(v2)→replay m1` ⇒ `stale:true`; first write `expectedVersion:0` creates, `1` on empty ⇒ 409.
7. Gate: customer purpose without uid ⇒ 0 sends + quarantine; badge_clear still clears with a category off and never increments.
8. Dispatch auth: `support(branchIds:[])` → staff token 200; `branch_owner[b1]` → staff in `b2` 403; support → customer 403.
9. Legacy: token without `installationId` or absent prefs doc ⇒ documented defaults + `legacyUnresolved`; A declines → B still prompted; stored `false` preserved.
10. **Logout retry**: stub HTTP 401 ⇒ `pendingUnlink` + secure retry token + operational cache cleared; same-uid boot issues a real unlink (server observes it) and clears the entry; SDK rotation between sessions ⇒ entry dropped, no loop, no cross-UID send.
11. Unknown purpose / `data.type:"NEW_KOT"` on a customer token ⇒ 0 sends, quarantined.
12. Support reply once; self-reply none; push failure does not fail the message; retry no duplicate.
13. **Payload + inbox + routing**: payload has no `orderId`/`ticketId`/`deeplink`; mismatch ⇒ no toast/inbox/nav; **successful send (`successCount>0`) still has an inbox doc with `targetId`**, and tap resolves `/support?ticketId=…`; `validateSearch` accepts `ticketId` and the accordion opens it; background `ref` ⇒ `/profile/notifications?ref=…` renders and resolves, never `/`.
14. All-suppressed critical: no throw, inbox persists; read budget asserted; topic sends zero prefs reads.
15. Emulator (Firestore/Auth only): canonical survives token deletion; deny rules hold for every role.

**Commands (proposed, not run)**: `cd functions && npx tsc --noEmit && npx vitest run tests/notifications.*.test.ts tests/tickets.support*.test.ts`; `cd burgonomics-foundation-core && npx tsc --noEmit && npx vitest run src/features/settings src/features/notifications src/shared/platform src/routes`; `firebase emulators:exec --only firestore,auth "npx vitest run tests/prefs.emulator.test.ts"`.

---

## 15. Limits
- No live FCM, device, Safari, or provider proof; acceptance is emulator/unit only.
- `stage_summary.md` pass lines are not evidence for this contract.
- FCM acceptance ≠ delivery; ambiguous sends report `unknown`.
- OS/SW tray entries may persist after logout; generic copy limits exposure, not existence.

**No new product question.** Remaining work is independent review plus implementation.

---

## 16. Readback
`C:\Users\DELL\Desktop\Burgonomics\.swarm-worktrees\polish-plan-20261025\stages\12_settings_notifications\output\device-notification-controls-contract.md` — FINAL_DRAFT_NEEDS_INDEPENDENT_REVIEW_REV4. Docs only; no code, tests, or commits.
