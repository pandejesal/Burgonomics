# v2 artifact checks — not application acceptance

Current image revision: **v2-r1**. [Image manifest](image-manifest-r1.json) records 38 light/dark state pairs, 13 layout/type/spacing samples and 10 boards. Its render checks passed within the scope below. The separate [final artifact record](validation-r1.json) records actual source-preservation, document, syntax and ZIP checks; do not infer its outcome from this explanatory document.

## Executed rendering and recovery

1. The owned preparation helper reused six hash-verified local assets, rechecked 118 selected source entries plus 14 public inputs, and recorded three repository HEAD/status boundaries. [Input snapshot](input-snapshot.json) is partial identity evidence, not baseline selection or an ownership decision.
2. `render-mockups.py --revision r0` produced a complete initial render; its scoped checks passed. Visual inspection then found scope-label and selected-navigation improvements. r0 remains superseded, not deleted.
3. `render-mockups.py --revision r1` was cancelled by the server restart after 45 PNGs. No final manifest or per-image metrics had been persisted. A scoped process check found no remaining renderer before recovery.
4. `render-mockups.py --revision r1 --resume` retained all 45 existing PNGs after exact pixel comparisons against current compositions, captured the other 44, and generated 10 boards and the final index/manifest. [Recovery input hashes](resume-record-r1-1.json) distinguish existing bytes from fresh observations. No existing PNG was overwritten. This is not an uninterrupted first-attempt run.

The renderer used a fresh ephemeral Chromium context per sheet, no authenticated profile, blocked service workers, and a loopback server exposing only named proposal assets. Page requests were confined to whitelisted local GETs; no blocked external/non-GET attempts, page errors or HTTP errors were observed in the successful run. This does not prove absence of every browser background request.

Recorded observations: image identity/disclaimers and Inter loading; page overflow/text clipping; 44 px static button geometry; selected strip item visibility; missing-photo placeholder overlap; one read-only kitchen field/counter where expected; no guest/no-history reorder rail; no order/outlet record nodes in denial compositions; three appearance choices; token contrast pairs. These are **isolated layout/token observations**, not app accessibility or behaviour acceptance.

## Final checker

From the repository root:

```powershell
python -B stages/08_menu/output/launch-plan-20261028/proposals/v2/validate-packet.py --revision r1
```

The checker writes a new result and refuses to overwrite it. To record a later recheck of unchanged inputs, use a new `--output` JSON filename. It does not render again, install anything, execute app tests, start a browser/emulator or contact an account/provider/store. Existing ZIP/manifest outputs may only be reused if their content exactly matches; they are not replaced.

Checked scope:

- Final image/source/index/asset/recovery fingerprints, image dimensions, complete catalog pairs and sample counts; retained r0 image/index identity.
- Every file in the two protected input trees: v1 and the completed planning-review packet. Earlier validation records remain historical; none is rewritten to attach its verdict to later documents.
- 118 selected source hashes, 14 additional public input hashes, four unchanged input-plan documents, three HEAD/staging/dirty-status boundaries. **Not every unmanifested source byte**, complete release provenance or authorship.
- Local Markdown links/tables/UTF-8/newlines/whitespace/fences for this v2 directory and the Phase A routing README; Python AST syntax and both proposal JavaScript syntax checks; scoped `git diff --check`.
- A whitelist-only team ZIP: current images/index, disconnected HTML/JS/CSS and six assets including the font licence. No input snapshot, repository status, private material, old render or application source is shipped. Archive CRC, names and every packaged file hash are checked.

## Self-review, not independent approval

The parent visually inspected r0 discovery, Cart, notes, access, KDS/feed and stock/dispatch boards plus full customer confirmation, POS escalation and enlarged Partner settings samples. That inspection drove the r1 scope/navigation changes. r1 is inspected separately before delivery; the final result records the bounded image IDs. No additional model, design-team, staff/operator, security or native review is invented.

No TypeScript application compilation, Vitest application suite, build, rules/emulator, keyboard/device, sandbox/provider, notification, financial, signing or store gate ran. Static field counters do not test Unicode limit handling, persistence or exact KOT transport. The packet cannot clear these gates or guarantee the original launch targets. Implementation remains unauthorised.
