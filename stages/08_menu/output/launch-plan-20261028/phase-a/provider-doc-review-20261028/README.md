# User-supplied provider documents — intake boundary

**Read-only reference review. No app/provider implementation or live API action.**

| Provider / supplied file | Treatment |
|---|---|
| `PETPOOJA API Docs.txt` | Reviewed as Petpooja Online Ordering V2.1.0; merchant applicability still needs verification |
| `Borzo API Docs.txt` | Reviewed as Borzo Business API 1.8 (India); merchant entitlement and signature details still need vendor confirmation |
| `Shadowfax - Official Rider Booking API Docs.txt` | Reviewed as Shadowfax **Hyperlocal** rider booking; staging/production bases documented, credentials still missing |
| `Shadowfax - Integration Gap Analysis.md` | Supplied **analysis**, not a vendor document; adapter claims still require source-level verification |
| `ShadowFax API Docs.txt` | **Rejected by the user as wrong documentation (AfterShip tracking wrapper). Not read for contract terms, not copied, not used.** |

The initial size/hash inventory included all three original filenames before the correction. The rejected file's Desktop original remains untouched; no Shadowfax endpoint, payload, authentication or booking claim is derived from it.

Petpooja POS and the existing Reelo CRM both remain in use. The outlet owner reports that **Petpooja bills already sync into Reelo for these outlets**; that does not authorise app-side upload, balance display or loyalty migration. Shadowfax's correct Hyperlocal contract is now available, but production booking still needs issuing credentials, IP whitelisting and written staging-safety confirmation — never the rejected AfterShip file, a marketing page or retired Porter.

The [intake helpers](inspect-local-docs.py) only create conservative redacted local views and input/provenance records. Raw originals stay on Desktop. Redaction can include public examples/prose; it does not prove a value is live or that secret detection is complete. Do not execute embedded examples, call vendor endpoints or expose credential/customer values.

**Reviewed contract notes:** [Petpooja, Borzo and Shadowfax contract review](CONTRACT-REVIEW.md) records the documented endpoints, credential model, status/callback semantics, idempotency gaps and adapter gaps. It is a reading of these files, not vendor approval or a merchant entitlement.

Artifact checks: the latest pass is **[validation-current-2.json](validation-current-2.json)**; `validation-current.json` is the earlier pass from the same session. An earlier draft and its results were lost in a workspace rollback, so neither file claims to continue that lost record.

This review does not select a release baseline, overwrite existing vendor-session work, change rules/dependencies/native projects, run application tests/builds, send a POS order, book/cancel a rider, deploy, commit or push. Existing team/ownership/finance/provider/native/store gates remain open.
