# BURGONOMICS — Master Agent Instructions & Workspace Entrypoint

This workspace follows the **Interpretable Context Methodology (ICM)** (arXiv:2603.16021v2).

- **Global Agent Identity & Rules**: See [GEMINI.md](file:///c:/Users/DELL/Desktop/Burgonomics/GEMINI.md)
- **Task Router & Stage Index (Layer 1)**: See [CONTEXT.md](file:///c:/Users/DELL/Desktop/Burgonomics/CONTEXT.md)
- **Global Factory Configuration (Layer 3)**: See [_config/](file:///c:/Users/DELL/Desktop/Burgonomics/_config)
- **Domain Reference Specs (Layer 3)**: See [references/](file:///c:/Users/DELL/Desktop/Burgonomics/references)
- **Stages & Working Artifacts (Layer 2 & 4)**: See [stages/](file:///c:/Users/DELL/Desktop/Burgonomics/stages)

---

## 1. Directory Structure & Verified File Routing

> [!CAUTION]
> **Anti-Hallucination Rule**: Never guess relative paths or invoke `read` on unverified files.
> Always use `glob` or `grep` to confirm file presence before reading.

The project consists of three core codebases and supporting infrastructure:

```
Burgonomics/
├── burgonomics-foundation-core/   # Customer-facing delivery & ordering app (React Native / Web)
│   ├── src/                       # Components, screens, navigation, state hooks
│   └── package.json
├── burgonomics-partner/           # Restaurant partner / POS / franchise ops app (React Native / Web)
│   ├── src/                       # Live KOT stream, Porter/Borzo dispatch, ticketing
│   └── package.json
├── functions/                     # Firebase Cloud Functions v2 backend (Node.js / TypeScript)
│   ├── src/                       # Webhooks (Petpooja, Razorpay, Borzo/Shadowfax), triggers
│   └── package.json
├── shared/ & packages/            # Shared Zod validation schemas, types, and contracts
├── firestore.rules                # Single Firestore backend security rules (asia-south1)
├── firestore.indexes.json         # Composite indexes
└── playwright.config.ts           # End-to-end integration and UI sweep tests
```

---

## 2. Multi-Agent Model Specialization

OpenCode and Nexus run with a specialized multi-provider agent fleet:

* **Main Master Orchestrator** (`openai/gpt-6.1-sol`):
  Top-level task planning, architectural contracts, final security review.
* **Complex Backend & Mobile Coder** (`opencode/deepseek-v4.1-flash`):
  Modifying Cloud Functions, Firestore transactions, React Native state hooks.
* **Reviewer & Quality Critic** (`opencode/glm-5.3-flash`):
  Auditing Razorpay webhook signatures, Petpooja POS sync, idempotency, and regression checks.
* **Fast Subagent & Explorer** (`google/antigravity-gemini-3.8-flash`):
  Rapid repository indexing, dependency tracing, subagent test execution, and symbol resolution.
* **Large Context Workhorse** (`minimax/minimax-m3.1-flash`):
  1M-token whole-repo context ingestion, Playwright test suite sweeps, and handover documentation.

---

## 3. Primary Production Mission: Live Petpooja POS & Real-Time KOT Bridge

> [!IMPORTANT]
> **Priority Target**: Transform the Petpooja POS integration from a prototype stub into a bulletproof live production bridge.

1. **Order Push to POS (`orderPush.service.ts` / `petpooja.service.ts`)**:
   - Ensure orders placed in the customer app generate structured KOT payloads adhering to Petpooja API specs.
   - Idempotent order tracking: duplicate webhook triggers must not duplicate KOT generation.
   - Retry queue & dead-letter handling: if Petpooja API fails or responds with non-200, orders must transition to `pending_pos_retry` with exponential backoff rather than silently dropping.
2. **Item Stock & 86ing Sync (`item86ingSync.service.ts`)**:
   - Kitchen 86ing toggled in partner app or received from Petpooja webhooks must instantly update Firestore stock status (`inStock: false`) so customer app disables out-of-stock items in real time.
3. **Live KDS Stream (`burgonomics-partner`)**:
   - The Kitchen Display System (KDS) must stream live incoming orders via Firestore `onSnapshot` with acoustic alert fallback.

---

## 4. Strict Production Hardening: Purge All Mock-As-Live Paths

> [!WARNING]
> The app must function as real production software. Mocks are strictly prohibited in production bundles.

1. **Gate All Mocks Behind DEV**:
   - Any fixture data, mock stores (`MOCK_STORES`), simulated riders, or fake payment signatures must be wrapped strictly inside `if (import.meta.env.DEV) { ... }` or deleted if obsolete.
2. **Real Webhook Signatures & Auth**:
   - Enforce timing-safe HMAC validation on all Razorpay and Petpooja webhooks (`crypto.timingSafeEqual`).
   - All client writes to order states must be gated through server Cloud Functions; never trust client-asserted order totals.
3. **Fail-Closed on Missing Credentials**:
   - If a live API key (Petpooja, Razorpay, FCM) is missing or unconfigured, the service must throw a clear, fail-closed error instead of silently falling back to mock success.

---

## 5. Nexus Autonomous Self-Healing & Git Worktree Execution

Nexus operates autonomously with the following constraints:

1. **Isolated Worktrees**:
   - All feature fixes, refactors, and test repairs must run in `.swarm-worktrees` without creating unstaged collisions on `master`.
2. **Self-Healing Loop (Up to 400 Retries)**:
   - When a test fails during a task run, Nexus transfers error context to `deepseek-v4.1-flash` and `gemini-3.8-flash` to diagnose, edit, and re-run until green.
3. **Mandatory Verification Gate**:
   - Before committing any branch or merging a PR, run and verify:
     ```bash
     npx tsc --noEmit ; npx vitest run ; npm run build
     ```
   - Must be approved by Reviewer (`glm-5.3-flash`) before merge.
