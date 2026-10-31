Packet closed on the root repo.

**QUEUE_TASK: release-infra-closeout**

**Commit** `2b3824d` (local only, never pushed), 7 root paths, base `81e20d1`:
`scripts/validate-mobile-hosting.cjs` (blob d74374f0fd), `…test.cjs` (47ae4db022), `.github/workflows/functions-ci.yml` (26884f3ed8), `.gitignore`, `firebase.json`, `R15-…md` (1907409506), `R18-…md` (885c0a42aa). All 7 committed blobs reproduce the frozen SHA256 after CRLF→LF normalisation (`.gitignore`, `firebase.json` only).

**Defects reproduced then fixed**
1. `readBundleId()` returned null on >1 `PRODUCT_BUNDLE_IDENTIFIER`, downgrading the AASA check from FAIL to SKIP for any project with a `.debug`/extension target. Now returns all ids, requires coverage of the primary app bundle — an AASA authorising only an extension id now FAILs.
2. An unmodellable ignore glob was a WARN plus early `return`, which also skipped the `.well-known` existence check. Now `ignore-unsupported` FAILs, evaluation continues, and overlap is SKIP (never PASS) when unknown.
3. `functions-ci.yml` node 20 → 22 (matches `functions/package.json` engines); R18 stale counts corrected.

**Evidence** — RED: pre-fix copy fails 4 new tests. GREEN: 22/22 in the main tree and 22/22 in an isolated worktree at `81e20d1` + only the 7 files; `node --check` exit 0. Preflight: PASS 25 / FAIL 2 / exit 1, both FAILs the literal `TEAMID` placeholder. In the worktree the only FAILs are `publish-dir-exists` (gitignored `dist/` absent) — stated, not hidden.

**Review** `ses_e99113369ffeEptLt5B6rgg2tX`, session record `opencode/glm-5.3-flash-free`, parent = this session: APPROVE, then APPROVE again on the two applied deltas. Limit: this host persists no per-message model metadata, so that is session-record evidence, not message-level proof.

**firebase.json hunk** (permitted): hosting `ignore` for both sites, `**/.*` → explicit list, plus JSON Content-Type/Cache-Control headers for both `.well-known` files. No functions/firestore/rewrites change.

**Remaining limits** — iOS is BLOCKED (Mac + Xcode + real Apple Team ID); `functions-ci.yml` was inspected, not executed; the two 20261017 AABs were left untracked because their commit/toolchain provenance cannot be stated; no device, store, deploy or push.

SUPERVISOR_STATE: COMPLETE