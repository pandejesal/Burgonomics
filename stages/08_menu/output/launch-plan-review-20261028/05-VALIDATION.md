# Artifact verification — not an application acceptance gate

This review validates **planning documents and preserved input/artifact identity only**. The generated [validation record](validation.json) contains actual command/result/time/counts, final document hashes and errors. A nonzero exit blocks a clean artifact-completion claim; a zero exit does not establish design, ownership, security, native/provider or store readiness.

## Reproducible local command

From `C:\Users\DELL\Desktop\Burgonomics`, run the owned artifact checker without bytecode generation:

```powershell
python -B stages/08_menu/output/launch-plan-review-20261028/validate-review.py
```

The checker refuses to overwrite its existing result. Any later modified packet requires a new explicitly named result file. It does not install packages, execute app code, start an emulator/browser/server, contact a provider/store or read environment/private signing material.

Separate scoped whitespace gate:

```powershell
git --no-optional-locks diff --check -- stages/08_menu/CONTEXT.md stages/08_menu/output/stage_summary.md
```

Git does not automatically check untracked planning Markdown; the Python pass checks those files directly. Existing LF→CRLF advisories are not permission to rewrite line endings globally.

The first checker attempt stopped on Windows' default CP1252 decoding of a UTF-8 Markdown file before a result file was written. The helper was corrected to use explicit UTF-8 for all text inputs, then rerun; no source change or application test was involved. The final result is recorded separately, not presented as an uninterrupted first-attempt pass.

## Checked scope

- UTF-8/final newline/trailing whitespace/fences, every local Markdown link and table shape across the detailed plan, Phase A, review packet and two Stage 08 routing/summary files.
- All 118 selected planning-source hashes plus ten public native input hashes and four newly identified Delivery input hashes. These are partial manifests, not complete release inputs.
- Current mockup asset/source/image fingerprints and the six earlier cropped/redacted observation-image hashes. Rechecking identity does not repeat app rendering, device acceptance or animation tests.
- Required corrected dependency/ownership/approval/provenance statements, explicit rejected-draft handling, four-release scope, final plan/document SHA-256 fingerprints and the review's five-route outcomes.
- All three HEADs and staging state versus the fresh observation; tracked-dirty counts; status-path comparison against the saved Phase A census outside exactly owned artifact directories. This is **not every unmanifested byte** and cannot establish authorship or permission.
- The new checker parses its own syntax; no application typecheck, unit suite, build, lint, emulator, signed archive or provider test runs.

## Independent review versus final parent edits

The final correction-only GLM report verified four document hashes and confirmed the original five document findings resolved. It then supplied two LOW diagram/shared-file handover follow-ups. The parent applied those changes in Delivery/schedule only. Their final hashes legitimately differ from the rechecked hashes; backend/acceptance should remain exactly at the independently rechecked revision. The validator records that distinction instead of attaching an old verdict to changed bytes.

No additional GLM/worker retry is needed to call these final edits parent-verified. This is not a final independent code/security approval, and failed Phoenix/NVIDIA audits remain failures. Original source/native/provider/store/financial gates remain unexecuted or blocked as recorded in the acceptance matrix.

## Final boundary

The original requirements handoff was not edited. Existing source/dirty overlays/worktrees were not reset, stashed, merged, overwritten, adopted, committed, pushed, unlocked or pruned. No new font/SDK/dependency install, app/rules/environment/native change, private signing-key inspection, store submission or financial/provider operation occurred in this review pass. The limited hierarchy-only device revisit cannot guarantee absence of SDK background telemetry; it is not end-to-end/native acceptance.

Next human evidence remains team review of exact proposed screenshots, named custodians and base/overlay decisions, owner-led account/signing status and finance/vendor policy. The plan and this artifact checker cannot supply those approvals or guarantee the original 3/8 November targets.
