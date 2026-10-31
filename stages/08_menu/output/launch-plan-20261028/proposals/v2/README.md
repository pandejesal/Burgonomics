# Phase A — proposed v2-r1 review packet

**PROPOSED — NOT IMPLEMENTED. Internal review only. No design-team approval is recorded.**

The missing-state expansion contains **38 states in both themes: 76 state images + 13 representative layout/type/spacing studies, with 10 review boards**. These are static, synthetic scenarios, not current app screens, operational evidence or approved store creative.

## Start here

- [Team-review index: every board and full-resolution image](REVIEW-r1.md)
- [Single internal-review ZIP](burgonomics-proposed-v2-r1.zip) — generated only after the artifact checks succeed; contains the current images, index, disconnected preview and six local assets, not repository/account metadata
- [Coverage and exact feedback checklist](COVERAGE.md)
- [Design extension and boundaries](DESIGN.md)
- [Asset provenance](brand-spec.md)
- [Verification scope and recovery record](VALIDATION.md)
- [Machine-readable artifact result](validation-r1.json)

Useful boards: [discovery](screenshots-r1/board-discovery.png), [Cart](screenshots-r1/board-cart.png), [notes/keyboard space](screenshots-r1/board-notes.png), [customer confirmation](screenshots-r1/board-confirmation.png), [Partner access](screenshots-r1/board-access.png), [feed/KDS](screenshots-r1/board-feed.png), [orders/POS](screenshots-r1/board-orders-pos.png), [stock/dispatch](screenshots-r1/board-stock-dispatch.png), [appearance](screenshots-r1/board-appearance.png), [layout studies](screenshots-r1/board-layout-studies.png).

## What changed after the first render

v2-r0's artifact checks passed, but visual review found two misleading scope labels and selected navigation that could be offscreen at enlarged type. v2-r1 corrects the unmapped Home scenario to show an example selected outlet, the stock scope guard to show **All Outlets — view only**, and the static navigation position so its selected destination is visible. No destinations are reordered or removed. This is composition, not proof of actual app navigation.

v2-r0 and its manifest/index remain superseded evidence. The current source files describe r1; r0 source hashes are historical and are not relabelled as current. The earlier v0-r1 in `../v1/` remains entirely separate and unchanged.

## Restart recovery

The server interrupted r1 after **45 PNGs** and before a final manifest. Those files were retained byte-for-byte. Recovery compared each existing image's pixels with the current local composition, collected fresh artifact metrics, created the **44 remaining PNGs**, and then produced the boards/index/manifest. It did not restart r0, replace existing PNGs or assume missing original metrics had survived. Details are in [the append-only recovery record](resume-record-r1-1.json) and [r1 image manifest](image-manifest-r1.json).

## Review boundary

Reply with **`v2-r1 / full image ID / element / accept, change or hold / requested change and reason`**. Record the exact approved IDs, approver and date separately. Nothing has been sent externally.

The Wraps photo, prices and fares remain honest placeholders. Awards/openings hide without approved content. The note uses the current **240 UTF-16-unit client ceiling**, not an invented vendor allowance. Payment, POS transport, restaurant acceptance, backend stock save, customer propagation and courier certainty remain separate facts. No blind resend, automatic refund or simulated rider is proposed.

The keyboard image is a **labelled reserved-space illustration**, not an actual keyboard. CSS 200% type/text-spacing studies are not browser zoom, Dynamic Type, screen-reader, native safe-area or WCAG-conformance proof. The disconnected preview contains no working login, persistence, payment, stock, POS, audio/push or dispatch action.

Baseline custodians/dirty overlays, design-team approval, owner-led account/signing status, finance/vendor decisions and implementation/native/provider/store gates remain unresolved. Original **3 November RC / 8 November public targets are unchanged**, not guaranteed. No app/rules/native/dependency changes, app tests/builds, deployments, submissions, commits or pushes are performed by this packet.
