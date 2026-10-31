# QA and gate record — brand content, providers, phone status

## Environment

- Phone `RZCX51TXRKB` was **disconnected by the owner**. Mobile MCP discovery
  returned no local device, simulator or emulator.
- No cloud device was allocated: that costs money and needs explicit approval.
- Browser QA therefore ran against the local dev server with an isolated Chromium
  context, as in the previous Delivery pass.

## Brand content

- Awards and upcoming stores are owner-supplied data; see `awards-content.md` and
  `upcoming-stores.md`.
- Extracted assets are in `public/images/brand/` with per-file SHA-256 in
  `source-manifest.json`; the extraction script is `collect-brand-evidence.py`.
- Empty sections still render nothing; a section only appears when it has at least
  one approved entry.

## Backend / payment

- Backend unit/build gates are recorded in `backend-gate-log.md`.
- Independent review findings are in `backend-review-repairs.md` once the bounded
  repair completes.
- Merchant-side prerequisites (outlet tax rows, vendor sandbox confirmation of
  `final_price` encoding, callback authenticity, add-on semantics) remain external
  and are not implied by passing unit tests.

## Not done

No live order, payment/refund, POS relay, rider booking, deployment, store
submission, commit or push. No claim of vendor acceptance, store approval or
release signing.
