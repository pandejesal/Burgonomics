# Workspace, evidence and continuation constraints

Snapshot date: 2026-10-28. Paths and fingerprints are observations, not immutable promises. Re-check before planning or editing.

## Repository boundaries

Workspace: `C:\Users\DELL\Desktop\Burgonomics` on Windows, PowerShell 5.1. The two apps are independent nested Git repositories, not ordinary tracked folders in the root repository.

| Repository | HEAD observed | State |
|---|---|---|
| Root (includes `functions`, `shared`, `packages`, stages) | `31e82c3c415757064e3b33010ade4d2b0d8ebd6f` | `ui-sweep`, ahead 138; extensive existing modified/untracked work |
| Customer | `7affdf698576110a64e008a492f2d8380abe2d58` | `ui-sweep`; dirty source, styles, rules tests and native workflows |
| Partner | `7374d3e183f7272b91c19749fc192eaddee9e3ae` | `ui-sweep`; dirty rules, KDS/menu/navigation/styles/native files/tests |

Parent ran `git status --short` and `git rev-parse HEAD` in the relevant repositories. An older root commit does not contain all current files. Do not reset, stash, commit or copy entire unrelated dirty patches to “clean up”. Future feature/test changes must follow the required isolated `.swarm-worktrees` workflow, but worktree creation does not transfer uncommitted source automatically. Resolve baseline/ownership explicitly and preserve user work.

Known overlapping customer files include `src/styles.css`, route-transition code, iOS/Android workflows and `tests/rules/firestore.rules.test.ts`. Partner overlaps include `src/index.css`, layout, KDS/menu hooks/pages, rules and iOS project. Root overlaps include `firestore.rules`, payment/POS/dispatch/auth source and many tests. Re-read exact current contents before editing.

## Directly recorded SHA-256 fingerprints

Paths below are workspace-relative. Hashes are from `Get-FileHash -Algorithm SHA256`, not commit-tree hashes.

| File | SHA-256 |
|---|---|
| `firestore.rules` | `113FA5EA407F2792DC40E5DB2E4302FC3B2ECD0C21E6A203C64C3AE58BBADCFC` |
| `burgonomics-foundation-core/firestore.rules` | `BF491F4CC46C8D1E1A9678A20456755155D56F7A6BD9E7CCEF3E2EDAAB600282` |
| `burgonomics-partner/firestore.rules` | `113FA5EA407F2792DC40E5DB2E4302FC3B2ECD0C21E6A203C64C3AE58BBADCFC` |
| `functions/src/modules/payments/razorpay.service.ts` | `EC486F8EB93218674F3B5A4FD8336410E81FADDB774E964043C167F245D0328A` |
| `functions/src/modules/petpooja/orderPush.ts` | `E5EB93EE293F613ACA6A49F87C72507C0DF5D972AA6A9161376F173767D97F1F` |
| `burgonomics-foundation-core/src/features/home/components/BannerCarousel.tsx` | `EF5057FCEB12D1A964BD47A5B563A2E0F0E3B805A89A29B7FE12B31DE2493D25` |
| `burgonomics-foundation-core/src/routes/home.tsx` | `8914390492C3F61F062A1C0444BFA29925F8564867D8191BE08C3F26685BA9FA` |
| `burgonomics-foundation-core/src/routes/cart.tsx` | `FE6F4672A9C3F0E39A0C01EAC961DC10B135EDDFBBBF6D97F2D8CD02A441BF0C` |
| `opencode.jsonc` after approved REA setup | `978942C44C8F4D9D034D56FCEA88DC5EFF5B0DEF22211A47F144587CE37A2DA5` |

## Tool readiness observed

- **Firebase MCP:** environment metadata showed active project `burgonomics-7faa8`, billing enabled and authenticated access. No production collections were queried. Native iOS app registration, database edition and deployed configuration were not verified. A connected billing-enabled project is not a sandbox.
- **Vera MCP:** root overview returned 571 files / 7,388 chunks and a warning of 6,823 additions / 1 modification unindexed. Both app-specific queries reported no index. Results do not cover all app source. Use Vera first where indexed, then scoped exact search; verify paths with app-scoped globs. Do not automatically index downloaded third-party repositories.
- **Context7:** used to retrieve current Capacitor documentation; use it again for the actual SDK/library/CLI implementation question. Do not send secrets, PII or proprietary source in documentation queries.
- **Code Review MCP:** catalog discovered, but no user-owned implementation diff reviewed. Later scope it to the exact approved repository/diff. Returned instructions are suggestions, not permission for edits, commits, PRs or comments. Root dirty changes are not all owned by this task.
- **Mobile MCP:** initially saw physical Android `RZCX51TXRKB`, Samsung `SM-S921B`, Android 16. At the last Mobile check it returned no devices. No app was launched or screen inspected in this task.
- **REA MCP:** project-local registration connected with 230 tools. Config command is `node C:/Users/DELL/Desktop/Burgonomics/rea/scripts/rea.mjs mcp`; environment sets `REA_ADB_PATH` to `C:/Users/DELL/AppData/Local/Android/Sdk/platform-tools/adb.exe` (path existence verified).
- Parent's post-configuration REA `list_adb_devices` call succeeded with **empty devices**; evidence ID `ev_a35a40b9ae83b3809ee8c2d8afdd889096386ffbf8de5875b63f817870990670`. No target was opened, no screen captured and no competitor compared. Discover the device again before passing a serial to further calls.
- REA worker reported local version 6.8.0 with host Node 24.18.0 below the package's declared supported floor. Handshake/ADB listing worked, but the support-window warning remains. No Node upgrade or reverse-engineering engine installation was approved/performed.
- GitHub MCP still needed visible OAuth in the worker's check. No CI/account data was fetched. Do not treat local workflow YAML as a successful remote run.

REA/mobile permissions are for UI/UX inspection. Use screen element hierarchies before screenshots; avoid personal data and real transactions. Do not decompile competitors, extract private tokens/APIs, or allocate a paid cloud device merely because REA has those capabilities.

## Approved config change and backups

Only project `opencode.jsonc` was changed for tool setup; it was already untracked and had unrelated user changes that were preserved. Global settings and other servers were not altered.

- Before registration: `C:\Users\DELL\AppData\Local\Temp\opencode\opencode.project.before-rea-mcp-20261028-053047.jsonc`.
- Before ADB environment addition: `C:\Users\DELL\AppData\Local\Temp\opencode\opencode.project.before-rea-adbpath-20261028-055839.jsonc`.
- Worker validated JSONC with zero parse errors and deep equality of the eight unrelated project MCP entries. Parent independently read the final registration and exercised REA device discovery.
- No service restart, global PATH change, SDK installation or app change was performed. Do not restore an old whole-config backup over newer user changes without examining the difference.

## Requested delegation models

### Current explicit roster — clarified by user after handoff review

All five IDs below were re-queried and returned active catalog entries. This is not a live authentication, quota or execution test:

- `opencode/deepseek-v4.1-flash-free` — OpenCode Free DeepSeek V4.1 Flash.
- `opencode-go/deepseek-v4.1-flash` — OpenCode Go DeepSeek V4.1 Flash.
- `phoenix-grove/deepseek-v4.1-flash-1017` — Phoenix Grove API DeepSeek V4.1 Flash 1017.
- `opencode/glm-5.3-flash-free` — OpenCode GLM 5.3 Flash Free.
- `nvidia/minimaxai/minimax-m3.1-flash` — NVIDIA NIM MiniMax M3.1 Flash.

Use explicit per-task model selection. All three DeepSeek routes are intentional; do not collapse them into an unspecified “DeepSeek” default. The fresh-session prompt includes suggested assignment types, not permission to implement code. Re-check availability/auth/budget, use scoped verified-path contracts and safe isolation, and report unavailable routes. Do not infer permission for arbitrary extra models from “etc.” or silently add paid substitutes. Workers must not create additional subagents beyond allowed depth.

### Historical executions — not the current preferred roster

- `opencode/deepseek-v4.1-flash` — initial worker failed: insufficient account funds. Do not keep retrying that failure.
- `opencode/deepseek-v4.1-flash-free` — completed UI/tooling discovery and approved REA setup.
- `phoenix-grove/deepseek-v4.1-flash-1017` — completed POS/Reelo reconnaissance.
- `opencode-go/glm-5.3-flash` — completed security reconnaissance, corrections and the first Markdown review. This is a different route from the newly requested GLM Free.

No worker was launched on OpenCode Go DeepSeek, GLM Free or NVIDIA NIM MiniMax merely to validate this roster update. Do not claim those routes were execution-tested.

## Source-document conflicts to resolve, not copy blindly

- `_config/design_system.md` and `references/ui_ux_spec.md` still describe grey light canvas, 3-column circular categories, decorative headings and Home reorder. The approved launch changes are in this packet and the Stage 08 overlay; current styles/tests must be reconciled during approved implementation, not silently rewritten now.
- Stage 01 lists customer app ID `com.burgonomics.app`; the release worker found native config `com.burgonomics`. Verify actual native/Firebase/store registrations before any identifier change.
- Stage 05/08 contain old `functions/src/petpooja/...` paths; current inspected POS code is under `functions/src/modules/petpooja/`.
- Stage 05/UI spec describe pickup PINs, while `references/order_flow.md:45-51` says no Takeaway PIN and identifies the 4-digit secret as delivery handover OTP. Do not restore an obsolete pickup requirement while polishing UI.
- `references/petpooja_pos.md` has an older envelope, identifier/credential storage and retry description that differs from recent `orderPush.ts` vendor-sample comments. Obtain current approved vendor evidence. Never place credentials in client-readable documents just because an old example does.
- Backend spec still contains historical mock fallback and auto-refund language. Production fail-closed rules and the approved staff/reconciliation policy remain mandatory; do not revive mock-as-live or automatic refunds from that wording.
- Older architecture/stage docs emphasise Porter, while newer order/backend references mark it retired/opt-in and describe Borzo/Shadowfax/manual restaurant delivery. Verify actual contracts/configuration; do not re-enable a provider as a UI change.
- Stage 10 specifies an upcoming-branch lifecycle/Notify Me flow. That does not prove the customer Home has a data source. This launch deliberately uses approved developer-maintained content and adds no new signup/CMS.
- Historical stage summaries show PASS/Completed without this task's source/artifact identity. They remain historical, not current release evidence.

## Discovery corrections retained

The first security worker mistook nested-repository glob misses for missing rules mirrors/runner and misread an order denylist as an allowlist. Both were corrected and the parent verified file existence and the actual rule/consumer logic. Do not resurrect either erroneous claim. Numeric security scores from a limited read-only review are not release clearance.

No app tests/builds, emulator/provider/device acceptance or store submissions were run in this handoff task. The only functional tool check after setup was REA device discovery; it found no device. Public Reelo research is worker-reported external evidence, not an approved integration contract.
