# Owner-led read-only account/signing checks

Status: **awaiting owner evidence; communication request unresolved**. The user rejected the generic account/signing WhatsApp text as not the current message to send. [Rejected draft, do not send](OWNER-WHATSAPP.md). Do not interpret its existence as an approved request already sent to owners. No console was opened/authenticated and no private signing credential was inspected. No external owner/vendor message was sent by this task; cross-session context sharing is separately requested.

## Evidence register

| Check | Delivery Android | Partner Android | Delivery iOS | Partner iOS |
|---|---|---|---|---|
| Intended source identifier | `com.burgonomics` | `com.burgonomics.partner` | `com.burgonomics` | `com.burgonomics.partner` |
| Verification / membership / agreements | Awaiting owner | Awaiting owner | Awaiting owner | Awaiting owner |
| Exact app record / identifier / team match | Awaiting owner | Awaiting owner | Awaiting owner | Awaiting owner |
| Production eligibility / review restrictions | Awaiting owner | Awaiting owner | Awaiting owner | Awaiting owner |
| Highest uploaded version/build; track/status | Awaiting owner | Awaiting owner | Awaiting owner | Awaiting owner |
| Signing method, custody, usability and expiry | Awaiting owner | Awaiting owner | Awaiting owner | Awaiting owner |
| Public certificate comparison | Not performed | Not performed | Not performed | Not performed |
| Push registration/custody where applicable | Awaiting owner | Awaiting owner | Awaiting owner | Awaiting owner |
| Mac/Xcode and native test access | Not applicable to Android build host | Not applicable to Android build host | Awaiting owner | Awaiting owner |
| Person / role / verification timestamp | Not supplied | Not supplied | Not supplied | Not supplied |

Source identifiers above are intended local identities from [the release plan](../06-RELEASE-INFRASTRUCTURE.md), **not verified store records**. Do not create or rename an app to make this table true. A future read-only source recheck still cannot establish a store-side match.

## Owner procedure

1. The owner signs in directly to Play Console, Apple Developer and App Store Connect on their own device. Do not share login or MFA with the assistant.
2. Read the status of the exact two app records and account. Record date, app/platform, checker and only the requested status fields. If permissions prevent a check, record “not accessible”, not “missing”.
3. Inspect existing signing status with its custodian. Do not export, copy, hash or upload private signing material. Public certificate fingerprints may be compared in a later controlled review; an owner saying the key exists is not an executed signature verification.
4. Report blocked agreements, verification, testing, certificates, profiles or identifier mismatches. **Do not accept, renew, create, revoke, rotate, invite, upload or submit** under this read-only scope.
5. Send the status text or optionally redacted screenshots through the agreed channel. Exclude account emails, tester identities, billing details, credentials, private keys and profiles. Raw console captures are not required in this Git packet.

## Date implications, not promises

Original targets remain **3 November RC / 8 November public launch**. If a relevant app must start a 14-day qualifying Play closed test on 28 October, the qualifying timestamp cannot be before approximately 11 November; production-access and app review follow. This is conditional policy arithmetic, not a finding about Burgonomics' account.

An active Apple membership does not establish signed-archive readiness, available iOS testing, App Store review approval or publication. No account-specific go/no-go is possible until responses arrive.

## Verified policy references

Read-only Scrapling requests returned HTTP 200 on 28 October 2026:

- [Play personal-account testing](https://support.google.com/googleplay/android-developer/answer/14151465?hl=en): affected personal accounts created after 13 November 2023 need at least 12 continuously opted-in testers for the preceding 14 days before applying for production access.
- [Play App Signing](https://support.google.com/googleplay/android-developer/answer/9842756?hl=en): upload-key custody and Play app-signing identity are distinct; keep private upload material secure.
- [Apple roles](https://developer.apple.com/help/account/access/roles/): the Account Holder is responsible for membership renewal and accepting updated programme agreements.
- [Apple certificates](https://developer.apple.com/help/account/certificates/certificates-overview/): expired/revoked distribution certificates cannot sign new uploads; distribution-certificate creation requires Account Holder/Admin permissions. This task does not create a certificate.

These references establish general rules, not the state of any Burgonomics account. Recheck requirements when later release action is authorised.
