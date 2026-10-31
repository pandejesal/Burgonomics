# Proposed v0-r1 screenshots — review before expanding

**PROPOSED — NOT IMPLEMENTED.** These are isolated, static design comps, not either app, new native builds, store screenshots or functional acceptance. Existing images were approved for internal mockup use only. All ticket/history data is synthetic; amounts and missing food imagery remain explicit placeholders.

## Start with the two boards

- [Delivery overview](screenshots-r1/delivery-overview.png): light/dark Home, continuous Menu, empty Cart, one expanded cooking note.
- [Partner overview](screenshots-r1/partner-overview.png): dark tablet KDS and light invitation-only sign-in.

## Full-resolution screen IDs

| ID | Image | Scope |
|---|---|---|
| D01 | [Home light, 390](screenshots-r1/D01.png) | Four square shortcuts; Wraps photo pending; optional awards/openings hidden |
| D02 | [Home dark, 390](screenshots-r1/D02.png) | Same hierarchy on black canvas |
| D03 | [Continuous menu, 390](screenshots-r1/D03.png) | Representative sections, natural boundary and section-local loading example |
| D04 | [Empty Cart, 390](screenshots-r1/D04.png) | Synthetic returning-user reorder layout, not real history |
| D05 | [Populated Cart, 390](screenshots-r1/D05.png) | One cooking note; no per-item or duplicate checkout editor; no fabricated bill |
| P01 | [Partner KDS, 768](screenshots-r1/P01.png) | Example stale/muted feed; payment and POS confirmation separate |
| P02 | [Partner sign-in, 390](screenshots-r1/P02.png) | Invitation-only access, no live login/role selector |
| D01-320 | [Home, 320](screenshots-r1/D01-320.png) | Narrow layout sample |
| D01-768 | [Home, 768](screenshots-r1/D01-768.png) | Content-width-limited tablet sample |
| D05-320-200 | [Cart, 320 / 200% type](screenshots-r1/D05-320-200.png) | Reflow sample, not actual device font settings or keyboard |
| P01-320 | [KDS, 320](screenshots-r1/P01-320.png) | One-column queue keeps urgent examples visible |

[Design direction and remaining states](DESIGN.md), [asset provenance](brand-spec.md), [asset manifest](asset-manifest.json), [current render/image manifest](image-manifest-r1.json).

Use **v0-r1** for review. The first render's narrow Wraps placeholder was partly covered by its caption; manual inspection caught what the horizontal-clipping check did not. Its original `screenshots/` and `image-manifest.json` are retained as superseded evidence, not approved/review deliverables. The corrected r1 reserves caption space and adds an overlap check; source hashes bind the r1 images to the exact HTML/CSS/JS/render helper and asset manifest.

`preview.html` renders the same static comps when served locally. Direct file viewing may block local fonts under browser policy. Screenshot delivery does not require starting a server. The render helper starts a temporary loopback-only server, blocks nonlocal page requests, uses a fresh browser context and closes the server/browser on completion. No production config, app source or signed-in profile is loaded.

## v0 review request

Please forward the two boards or individual IDs to Burgonomics' design team. Ask for **layout/type/colour feedback on this v0**, especially Home density, the stationary category caption and Partner queue hierarchy. The wrap photograph and live category mappings need owner-approved assets/data; they were not guessed.

Do not approve this as a complete A1 set or an app implementation request. The full both-theme/error/guest/stock/dispatch/settings/pending-customer state set remains in [DESIGN.md](DESIGN.md). Stop here for feedback before generating that larger set. Baseline owner handover and owner-reported account readiness remain independent open gates.
