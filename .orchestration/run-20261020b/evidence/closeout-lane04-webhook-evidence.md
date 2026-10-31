DISPATCH-BOUNDARY CLOSEOUT — FINAL FREEZE + RED/GREEN (run 2026-1020b, lane 04 closeout)
Negative controls (re-run after the applied DS delta; FINAL test file):
  RED vs pristine committed 086b60d source : 14 failed / 11 passed (25)
  RED vs frozen v1 packet bytes 442e70d5..e883cc: 9 failed / 16 passed (25)
    - v1 RED fails = 3 needs_review decision pins + 2 sticky containment pins
      + 3 stale-map/order-binding pins + 1 hint-path numeric normalization pin;
      F2 rewind pins + F7 read-side pins PASS on v1 (the packet fixed those).
    - committed RED additionally fails those F2/F7-resolution pins.
    - Groups stay separable; no production source is mutated to fake RED.
      RED artifacts: Temp/opencode/lane04-red1-wt (v1) and lane04-red2-wt (committed).
GREEN on final bytes: focused 25/25; neighbours 53/53 (hardening+router DR10 both
  re-run); full checks happen in the isolated exact-bundle gate.
FINAL CANDIDATE HASHES (round 2 refreeze: DS findings 1,3,4,5,6,7,8,9,10 applied):
  functions/src/modules/dispatch/dispatch.webhooks.ts sha256 0D10309936D9CEE8B7F3C72AE7951D878DC723A1999EBCF271888B41C4A60AE7 blob 51db3573702f07bc2c1aeb97e2268f8c87d6978a size 56169
  functions/tests/dispatch.webhook-boundary.fresh.test.ts sha256 611097CE74C5BB2AD865A853916DE043FCFA1785760EF88799CAA9E3587C9742 blob 09f239eb077409c415d5884129e723d0ce86bd17 size 41080
  references/delivery_routing.md sha256 E17C00E20827C8CC533B3E35FF8592F81F489A4D4814E999DFC94962D90524AE blob 122f1e7764a3b4adc60ca92eda3a6ead97df24e6 size 30030
  (round-2 RED re-runs on the FINAL tests: vs committed 086b60d 16 failed/11 passed/27;
   vs frozen v1 packet 12 failed/15 passed/27; groups stay separable)
  (round-2 DS focused run on final bytes: 80/80 across fresh test + 2 committed suites)
ISOLATED EXACT-BUNDLE GATE (Temp/opencode/lane04-gate-webhook):
  base = current root HEAD 4b6e4f620fe26c589ecf7c31bc85905df4aaab6f; detached worktree,
  node_modules junction; ONLY the 3 owned paths copied over (status showed exactly
  2 modified + 1 untracked, hash-verified MATCH for all three vs main tree):
  npm run typecheck exit 0
  npm test -- --maxWorkers=2 exit 0: 77 files passed | 1 skipped (78); 939 passed | 2 skipped (941); dur 71.73s
  npm run build exit 0
SERVING PROOFS (local session API, api/session/%sid%/message, password-held server only, opaque counts):
  DS reviewer ses_e9edb8e2fffeUTqdlpvixpbn5H: 47 assistant rows, all deepseek-v4.1-flash-free, 0 zero-output
  GLM verifier ses_e9ec321cdffeA7C2uhogmtyUVA: 13 assistant rows, all glm-5.3-flash-free, 0 zero-output
CORRECTION DISCLOSED: an earlier reviewer call reusing a mixed session (ses_e9eea71d0ffeJfBUL8fOP0Zx5v) served glm-5.3-flash-free on all 25 rows — it was NOT a DS review. Its round-1(bytes 47C7E2A3)/delta content was nonetheless discarded for provenance anyway; the accepted chain uses the FRESH DS session ses_e9edb8e2fffeUTqdlpvixpbn5H (round-1 APPROVE on 04B5F3EA set + round-2 reconfirm APPROVE on final 0D103099 set, byte-proven delta reversal) plus the separate GLM verification above.
Round-1 refreeze hashes (superseded, kept for provenance):
  functions/src/modules/dispatch/dispatch.webhooks.ts sha256 04B5F3EA8D8E01990255B30096D46DD8DC1940357075471F51585388A92C8855 blob 1cbec6c1443e0b69539f0faf068fd4c4e52efe8e size 54720
  functions/tests/dispatch.webhook-boundary.fresh.test.ts sha256 055DEB3E80F609E90302D41BDB365EAC42A9F16406899443245AE3EC54D16B64 blob 11d75f6aa35e209811abd3e38c87fa373a48b4dd size 37657
  references/delivery_routing.md sha256 90922E548E0E2575F8512F273CE44D844D0B65DD4557CEFE0A09E56C3664D69E blob 0fabf6d4009879e8c22394b4d40d82407aa1933a size 29715
Pre-delta DS review: ses_e9eea71d0ffeJfBUL8fOP0Zx5v VERDICT APPROVE (must-fix empty;
  non-blocking findings: hint-path normalization, containment scope note, commit-boundary note).
