# Rejected WhatsApp draft — not the current message

**DO NOT SEND.** The user said this is not the current message to send on 28 October 2026. Retained only as a rejected historical account/signing draft; it is not an approved vendor message. No WhatsApp message was sent by the assistant. Current communication context is handed to OpenCode session `ses_e7f7d9238ffeeZTT1SvnTZhd2K` separately, without credential values.

## Rejected text — historical reference only

Hi, we are checking release readiness for *both Burgonomics apps on Android and iOS*. For now this is *read-only*: please don't create/change anything, accept agreements, upload builds or submit either app.

Apps to check:
• Customer/Delivery: `com.burgonomics`
• Partner: `com.burgonomics.partner`

*Google Play — please confirm separately for each app:*
1. Is developer/business identity verification complete? Is the account personal or organisation? If personal, was it created after 13 November 2023?
2. Does the app record already exist, and does its package ID match the ID above?
3. Is production access approved, restricted or pending? If testing is required, what requirement does the console show, when did the qualifying closed test start, and how many continuously opted-in testers are recorded? Don't share tester names/emails.
4. What is the highest version code already uploaded across all tracks, and the current track/release status? If none, say “no uploads”.
5. Is Play App Signing enabled? Who securely holds the *upload keystore* and its credentials, and is the signing setup usable? Please report status/custodian only. We must distinguish the upload certificate from the Play app-signing certificate; public SHA-256 fingerprints can be compared later in a controlled review.

*Apple — please confirm separately for each app:*
1. Is the Apple Developer membership active, what is its renewal/expiry date, and are there any outstanding agreements or verification blockers? Please report them only; don't accept/change anything yet.
2. Who is the Account Holder, and who has the necessary App Store Connect and Certificates/Identifiers/Profiles access? A role/name confirmation is enough; no login details.
3. Do the App Store Connect app records and registered Bundle IDs exist for the exact IDs above, and do they belong to the intended Burgonomics team? Report match/mismatch; don't rename/create records.
4. Are usable distribution signing and provisioning available for each app, including secure access to the matching private key or authorised cloud-managed signing? Give status, expiry and custodian only. Also confirm whether APNs/push setup exists for each Bundle ID.
5. What is the latest uploaded version/build and its TestFlight/App Store status for each app? If none, say “no uploads”.
6. Who can provide the approved Mac/Xcode build environment and an iPhone for testing? Please share the installed Xcode version and availability, not remote-access credentials.

Please reply with *Delivery Android / Partner Android / Delivery iOS / Partner iOS*, the person checking, the check date, and *confirmed / missing / unknown* for each item. Cropped screenshots are optional—hide personal details, emails, billing details and secrets.

*Do not send passwords, OTPs, recovery codes, API secrets, keystore files, private keys, .p12 files or provisioning profiles on WhatsApp.* Keep those in your controlled storage. We only need readiness/status confirmations now; secure access, fixes and submissions will need separate approval.

Thanks.

## Interpretation

- Ownership is already established; this requests readiness evidence, not a transfer of either account.
- A “yes” means owner-reported status until its scope, date and exact app record are recorded. It is not signing/build/store acceptance.
- A missing or mismatched app record is a finding, not permission to create one or change an identifier.
- Google currently applies the 12-testers/14-continuous-days gate to affected personal accounts created after 13 November 2023. Do not assume it applies to these accounts; use each app's console status.
- Neither a local key file nor an existing installed APK proves store signing custody or compatibility.

Sources retrieved 28 October 2026: [Play testing](https://support.google.com/googleplay/android-developer/answer/14151465?hl=en), [Play App Signing](https://support.google.com/googleplay/android-developer/answer/9842756?hl=en), [Apple roles](https://developer.apple.com/help/account/access/roles/), [Apple certificates](https://developer.apple.com/help/account/certificates/certificates-overview/).
