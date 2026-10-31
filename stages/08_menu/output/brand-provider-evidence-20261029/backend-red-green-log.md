# Backend RED → GREEN log — pricing precision

Engine hash BEFORE the fix:
`79663E6727F9CA4D3897A286D3728C538750FF465A861E7AD845207C8F05807E`
(`functions/src/modules/payments/pricing.engine.ts`, verified at the start of the RED run).

## RED — production regression tests against the unmodified engine

File: `functions/tests/pricing.email-rounding.test.ts` (calls the real
`calculateOrderPricing` against a mocked Firestore catalog/branch/coupon).
Command: `npx --no-install vitest run tests/pricing.email-rounding.test.ts`
Result: **exit 1 — 6 failed / 3 passed (9 total)**.

Observed failures (old whole-INR total vs split legs):

| Case | Old grandTotal | Split legs | Failing assertion |
|---|---|---|---|
| catalog 350, GST 17.50 | 368 | 367.50 | `grandTotal === 367.50`; conservation; marker absent |
| 350 − coupon 20, GST 16.50 | 347 | 346.50 | `grandTotal === 346.50`; marker absent |
| catalog 350.33, GST 17.52 | 368 | 367.85 | `grandTotal === 367.85`; conservation; marker absent |
| new-marked order (367.50) | recomputed 368 | — | reprice `matches` false |
| marked drift case | expected 36800 | — | expectedPaise was 36800, not 36750 |
| unknown marker `paise-v999` | no error | — | reprice proceeded instead of failing closed |

Passing on old code (kept as guards): integral 400 → 420 control, legacy unmarked 368 still
matches, and unmarked 367.50 does not match the legacy law.

The full RED log was preserved during the session at `%TEMP%\pricing-red.log` (machine-local
scratch, not committed).

## GREEN — after the frozen patch

Engine hash AFTER the fix:
`6C2CA3CEA9C311F3B9632D4AF71BD6ABA45A0FDE9ED3403E2D3583F6749B7F39`.
Command: `npx --no-install vitest run tests/pricing.email-rounding.test.ts tests/pricing.engine.test.ts`
Result: **exit 0 — 20 passed / 20**.

Assertions now proven:
- 350 → GST 17.50, grand 367.50, split legs 36750, `pricingVersion === "paise-v1"`;
- coupon 20 → GST 16.50, grand 346.50, legs 34650;
- 350.33 → GST 17.52, grand 367.85, legs 36785;
- 400 → 420 (integral control, both laws agree);
- marked order compares in exact paise (36750);
- unmarked legacy 368 still matches under the recomputed old law (36800);
- unmarked 367.50 does not match (no silent upgrade);
- marked drift refused;
- unknown marker → `422 UNKNOWN_PRICING_VERSION`.

## Downstream suites adjusted for the corrected law

- `tests/pricing.parity.test.ts`: whole-INR pins at lines 126/175/218 replaced by
  `Math.round(grandTotal*100) === brandRoyaltyPaise + branchTransferPaise`
  (+ composition check); all other invariants retained. Golden basket 1012 → 1011.8.
- `tests/e2e.flow.test.ts`: 497 + 24.85 + 55 → 576.85; legs 57685; marker asserted.
- No test was skipped or weakened to reach GREEN. The only skipped tests remain the pre-existing
  `WIRE_BORZO*` probes.

## Full-suite GREEN (serialized)

Command: `npx --no-install vitest run --maxWorkers=1`
Exit 0 — **1116 passed / 2 skipped**, **85 files passed + 1 skipped**, 84.36 s.
Typecheck `tsc --noEmit` exit 0; build `npm run build` exit 0.

## Note on the earlier full-suite attempt

Before the parent restored disk space, one full-suite run aborted with
`ENOENT … \Temp\<id>\ssr\…` and produced spurious failures. That run is explicitly
**excluded** from evidence; it measured the disk, not the code.
