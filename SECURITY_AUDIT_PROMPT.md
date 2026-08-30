# BURGONOMICS — Comprehensive Security Audit Master Prompt

> **Master Application Security Review Framework (70 Checks across 4 Parts)**  
> **Target Scope**: 
> 1. 📱 **Customer Delivery App**: `burgonomics-foundation-core/` (Web, PWA, Android/iOS Capacitor)
> 2. 🏪 **Partner / Franchise POS App**: `burgonomics-partner/` (KOT, Porter dispatch, staff management, tickets)
> 3. ⚡ **Cloud Functions v2 & Integrations**: `functions/` (Razorpay Route, Petpooja POS, Porter API, FCM)
> 4. 🛡️ **Data Layer & Security Rules**: `firestore.rules`, `firestore.indexes.json`, Cloud Storage

---

## HOW TO USE THIS

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│    01 AUDIT     │ ──> │     02 FIX      │ ──> │    03 VERIFY    │ ──> │    04 RE-RUN    │
│  Run the prompt │     │  FAIL + UNKNOWN │     │ Test deployed   │     │ After major     │
│                 │     │                 │     │      path       │     │     changes     │
└─────────────────┘     └─────────────────┘     └─────────────────┘     └─────────────────┘
```

- **01 AUDIT**: Copy and paste the prompt in the [COPY / PASTE AUDIT PROMPT](#copy--paste-audit-prompt) section below into your AI coding assistant (Antigravity / Gemini / Claude) or provide it to a human security auditor.
- **02 FIX**: Address every item marked **FAIL** or **UNKNOWN**. Implement the provided minimal safe code fix starting with P0/P1 items (Auth, Payments, Data isolation, Secrets).
- **03 VERIFY**: Execute the verification command for each remediated item and ensure workspace integrity gates pass:
  ```bash
  npx tsc --noEmit && npx vitest run && npm run build
  ```
- **04 RE-RUN**: Re-execute this audit whenever new dependencies are added, payment/auth logic changes, new Cloud Functions are deployed, or before any major production release.

---

## TARGET ARCHITECTURE & REPOSITORY MAP

Before running the audit, review the target components and file paths:

| Subsystem | Root Path | Primary Tech Stack | Critical Security Surfaces |
|---|---|---|---|
| **Customer App** | `burgonomics-foundation-core/` | React 19, Vite, TanStack Router, Tailwind CSS, Capacitor | Guest auth, cart calculation, Razorpay checkout modal, address PII, localStorage tokens |
| **Partner POS App** | `burgonomics-partner/` | React 19, Vite, Zustand, Tailwind CSS, Lucide | RBAC roles (`superadmin`, `branch_manager`, `cashier`, `kitchen`), live KOT stream, manual Porter trigger, combo builder, staff credentialing |
| **Cloud Functions** | `functions/src/` | Node.js 20, TypeScript, Firebase Functions v2 | Razorpay Route royalty split, webhook HMAC verification, Petpooja POS sync & 86ing, Porter delivery dispatch, Ticket auto-escalator |
| **Database & Storage** | `firestore.rules`, Cloud Storage | Google Cloud Firestore (asia-south1) | Default-deny rules, multi-tenant branch data isolation, user document permissions, rate-limiting counters |

---

## COPY / PASTE AUDIT PROMPT

Copy and paste the block below into your AI agent or security review session:

```markdown
Act as a Principal Application Security Reviewer and Cloud Security Architect for Burgonomics. 
Audit both client applications (`burgonomics-foundation-core/` and `burgonomics-partner/`), the Cloud Functions backend (`functions/`), and the data rules (`firestore.rules`) against checks 01–70 in this specification.

### AUDIT INSTRUCTIONS:
1. For every check (01 to 70), evaluate the workspace and assign one of the following statuses:
   - [PASS]: Verified safe with concrete source code or configuration evidence.
   - [FAIL]: Concrete security vulnerability, flawed configuration, or anti-pattern identified.
   - [UNKNOWN]: Cannot be verified from repository files alone (requires runtime inspection, cloud console review, or secret validation).
   - [NOT APPLICABLE]: Not relevant to this stack (explicit rationale required).

2. CITATION REQUIREMENT:
   - Never mark PASS without citing the exact file path and line number(s) supporting the result.
   - For every FAIL or UNKNOWN, you must provide an Actionable Remediation Card.

3. REMEDIATION CARD STRUCTURE (for all FAIL and UNKNOWN findings):
   - Check ID & Name: (e.g., "05 Missing server-side authorization")
   - Target Scope: `burgonomics-foundation-core` | `burgonomics-partner` | `functions` | `firestore.rules`
   - Severity: [P0 - Critical] | [P1 - High] | [P2 - Medium] | [P3 - Low]
   - File & Line Reference: `path/to/file.ts:L123-L145`
   - Failure Mode: A single, realistic sentence describing the attack vector or failure scenario.
   - Minimal Safe Fix: The exact, drop-in replacement code snippet or configuration setting to resolve the issue.
   - Verification Step: The exact command, unit test, or inspection step to confirm the fix.

4. AUDIT PRIORITIES:
   - Prioritize anything touching:
     a) Authentication & RBAC custom claims (`superadmin`, `franchise_owner`, `branch_manager`, `kitchen_staff`, `driver`).
     b) Payment transactions & Razorpay Route split calculations (prevent client-side tampering).
     c) Third-party integrations: Razorpay webhooks, Petpooja POS bridge (86ing), and Porter logistics dispatch.
     d) Cross-user & multi-branch tenant data isolation in `firestore.rules`.
     e) Exposed secrets in client builds, git history, or Capacitor native assets (`android/`, `ios/`).

5. CONSTRAINT:
   - Do NOT modify production data or live infrastructure during the audit.
```

---

## 70-CHECK SECURITY AUDIT SPECIFICATION

### PART 1: SECRETS, AUTHENTICATION & INPUT
*Stop the obvious shortcuts and trust boundaries AI-generated apps tend to ship with.*

#### 01 Exposed database credentials
- **Guideline**: Keep database usernames, passwords, and connection strings server-side; rotate anything that was exposed.
- **Burgonomics Targets**: `functions/src/config/`, `firestore.rules`, `.env`, `.env.local`, `firebase.json`. Ensure Firebase Admin SDK initialization uses default Google Application Credentials in production and never commits service account JSON files.

#### 02 Public .env files
- **Guideline**: Keep environment files out of Git, public builds, and static hosting; use platform secret storage in production.
- **Burgonomics Targets**: Check `.gitignore` in workspace root, `burgonomics-foundation-core/`, `burgonomics-partner/`, and `functions/`. Verify no `.env`, `.env.production`, or `.env.local` files containing production secrets are committed.

#### 03 Hardcoded API keys or secrets
- **Guideline**: Move private keys to server-side environment variables or a secret manager and rotate leaked values.
- **Burgonomics Targets**: Search for hardcoded Razorpay Key Secrets, Porter API Keys, Petpooja App Keys, or Firebase Service Account Private Keys in `src/` and `functions/`. (Note: Firebase Web `apiKey` and Razorpay `key_id` are public client identifiers, but secret keys must never appear in frontend code).

#### 04 Weak or missing authentication
- **Guideline**: Use a proven auth system and require authentication on every route that should be private.
- **Burgonomics Targets**:
  - `burgonomics-foundation-core`: Protected routes (`/account`, `/orders`, `/checkout`) vs public routes (`/menu`, `/`). Ensure guest sessions cannot access other users' profile data.
  - `burgonomics-partner`: All partner routes (`/dashboard`, `/kot`, `/branches`, `/staff`, `/tickets`, `/analytics`) must strictly require authenticated staff sessions.

#### 05 Missing server-side authorization
- **Guideline**: Check what the signed-in user is allowed to do on the server before every sensitive action.
- **Burgonomics Targets**: `functions/src/modules/` endpoints and Cloud Functions callable functions. Ensure functions check `context.auth.token` or decode ID tokens to verify required roles rather than trusting request parameters.

#### 06 Cross-user data access
- **Guideline**: Scope reads and writes to the authenticated user or tenant so changing an ID cannot expose someone else’s data.
- **Burgonomics Targets**: `firestore.rules` paths `users/{userId}`, `orders/{orderId}`, `cart/{userId}`. Verify that a user cannot query, read, or write documents belonging to another `userId`.

#### 07 Open database permissions
- **Guideline**: Default-deny database access and grant the application only the reads and writes it genuinely needs.
- **Burgonomics Targets**: `firestore.rules`. Ensure `match /{document=**} { allow read, write: if false; }` is the root fallback and every individual collection has explicit granular rules.

#### 08 Misconfigured Firebase / Supabase / S3
- **Guideline**: Review database and storage rules, then test them while signed out and as the wrong user.
- **Burgonomics Targets**: `firestore.rules` and Cloud Storage security rules. Verify that menu items (`menu_items/{itemId}`) and branch public profiles (`branches/{branchId}`) are read-only for public, and only editable by verified `admin` / `branch_manager`.

#### 09 Unprotected admin routes
- **Guideline**: Enforce admin permissions on the server; a hidden button or secret URL is not an access control.
- **Burgonomics Targets**:
  - `burgonomics-partner/src/routes/` and navigation guards.
  - Backend Cloud Functions (`functions/src/modules/auth/`, `functions/src/modules/tickets/`).
  - Verify that UI route protection is backed by Firebase Custom Claims (`admin === true` or `role === 'superadmin'`) on the server.

#### 10 Production debug tools exposed
- **Guideline**: Disable or strongly protect debug consoles, test routes, profilers, and internal developer tools.
- **Burgonomics Targets**: Look for mock data injectors, bypass login buttons, test harness endpoints, or `console.log` overrides left in production bundles in `burgonomics-foundation-core/src/` and `burgonomics-partner/src/`.

#### 11 Build logs leaking secrets
- **Guideline**: Mask credentials in CI/CD and make sure scripts never print tokens, keys, or connection strings.
- **Burgonomics Targets**: Inspect `.github/workflows/`, Netlify build configs (`netlify.toml`), and npm scripts (`package.json`) to ensure build commands do not echo env variables or tokens.

#### 12 Verbose production errors
- **Guideline**: Return generic errors to users and keep stack traces, queries, paths, and internal details in private logs.
- **Burgonomics Targets**: `functions/src/core/errors/` and API response handlers. Ensure client responses return sanitized error codes (`UNAUTHENTICATED`, `PERMISSION_DENIED`, `INTERNAL_ERROR`) without leaking internal file paths or stack traces.

#### 13 Secrets in Git history
- **Guideline**: Treat a committed secret as exposed even after deletion; rotate it and remove it from history where appropriate.
- **Burgonomics Targets**: Check `.git` commits and history for accidental commits of `.env`, `serviceAccountKey.json`, `keystore.jks`, or `.p8` Apple Auth keys.

#### 14 Secrets shipped in frontend JavaScript
- **Guideline**: Anything sent to the browser is readable by users; private service credentials must stay server-side.
- **Burgonomics Targets**: Inspect Vite `import.meta.env` and bundled JS files in `dist/`. Ensure only variables prefixed with `VITE_PUBLIC_` or `VITE_FIREBASE_` are exposed, and no secret keys (e.g. `RAZORPAY_SECRET_KEY`, `PORTER_API_KEY`) are bundled into client code.

#### 15 Client-side-only security checks
- **Guideline**: Repeat validation, authorization, and entitlement checks on the trusted server, not only in the UI.
- **Burgonomics Targets**: Order pricing, discount coupon redemption, and loyalty coin deductions. The final payable amount and coin burn must be calculated in Firebase Cloud Functions, never trusted from client payload.

#### 16 Missing input validation
- **Guideline**: Validate type, length, format, allowed values, and size for every piece of untrusted input on the server.
- **Burgonomics Targets**: Use Zod schemas across all Cloud Functions endpoints (`functions/src/modules/`) and Firestore document create/update functions.

#### 17 SQL injection
- **Guideline**: Use parameterized queries or safe ORM bindings instead of concatenating user input into SQL.
- **Burgonomics Targets**: While Burgonomics uses Firestore (NoSQL), check any external SQL/BigQuery reporting connectors or raw analytics exports for unsafe string interpolation.

#### 18 NoSQL injection
- **Guideline**: Validate object shapes and operators and use safe query APIs so user-controlled objects cannot change query logic.
- **Burgonomics Targets**: Firestore queries in `functions/` and client stores. Ensure user input strings are strictly validated and not passed as arbitrary query filter objects (`where(field, op, val)`).

---

### PART 2: WEB, SESSIONS, APIs & PAYMENTS
*Protect the places users, browsers, files, and money touch your backend.*

#### 19 Cross-site scripting (XSS)
- **Guideline**: Escape untrusted output, sanitize any allowed HTML, and use a Content Security Policy where appropriate.
- **Burgonomics Targets**: Review `dangerouslySetInnerHTML`, rich text renderers in customer order notes, ticket chat messages (`stages/07_tickets`), and partner notification displays.

#### 20 Cross-site request forgery (CSRF)
- **Guideline**: Use appropriate SameSite cookies and framework CSRF protections for browser-authenticated state changes.
- **Burgonomics Targets**: Any Cloud Functions HTTP endpoints handling cookies or form posts. Ensure Firebase Auth Bearer tokens or `SameSite=Strict` cookie policies are enforced.

#### 21 Insecure file uploads
- **Guideline**: Restrict file type and size, generate safe filenames, store files safely, and scan risky uploads when appropriate.
- **Burgonomics Targets**: Cloud Storage uploads in `burgonomics-partner` (menu item food images, franchise document uploads, ticket attachment images). Enforce mime-type checks (`image/webp`, `image/jpeg`), size caps (<=5MB), and random UUID filenames.

#### 22 Path traversal
- **Guideline**: Never trust a user-supplied path or filename; resolve access against an approved base directory.
- **Burgonomics Targets**: Cloud Storage path builders and any dynamic asset loaders in Cloud Functions. Ensure file paths cannot contain `../` or arbitrary bucket paths.

#### 23 Server-side request forgery (SSRF)
- **Guideline**: Allowlist external destinations where possible and block requests to private or internal network ranges.
- **Burgonomics Targets**: Cloud Functions dispatching outgoing HTTP calls (`functions/src/modules/porter/`, `functions/src/modules/petpooja/`, `functions/src/modules/payments/`). Ensure outbound URLs are strictly constructed from hardcoded base URLs and validated partner endpoints.

#### 24 Broken password-reset flows
- **Guideline**: Use short-lived, single-use reset tokens and avoid leaking whether a particular account exists.
- **Burgonomics Targets**: Firebase Auth password reset and OTP verification flows. Ensure rate limits on OTP resends and generic error responses for non-existent accounts.

#### 25 Weak session management
- **Guideline**: Use strong session tokens, sensible expiry, rotation, and server-side invalidation on logout or security changes.
- **Burgonomics Targets**: Firebase Auth token refresh mechanisms. When a staff member is revoked or password changed in `burgonomics-partner`, revoke refresh tokens via `admin.auth().revokeRefreshTokens(uid)`.

#### 26 Weak or incorrectly validated JWTs
- **Guideline**: Use strong signing keys and verify signature, issuer, audience, expiry, and allowed algorithms.
- **Burgonomics Targets**: Cloud Functions verifying Firebase ID Tokens (`admin.auth().verifyIdToken(token, true)`). Ensure token revocation checks (`checkRevoked=true`) are enabled for high-risk operations (e.g. branch payouts, staff deletion).

#### 27 Overly permissive CORS
- **Guideline**: Allow only the origins, methods, headers, and credential combinations your application actually needs.
- **Burgonomics Targets**: Express/CORS configuration in `functions/src/index.ts`. Ensure `cors({ origin: [...] })` is restricted to authorized Burgonomics domains (e.g., `https://burgonomics.com`, `https://partner.burgonomics.com`, Capacitor `capacitor://localhost`) and not wildcard `*` with credentials.

#### 28 Missing rate limits
- **Guideline**: Rate-limit login, signup, password reset, APIs, and AI routes using sensible per-user and per-IP ceilings.
- **Burgonomics Targets**: Cloud Functions for OTP requests (`sendOtp`), checkout creation (`createRazorpayOrder`), and ticket creation (`createTicket`). Implement Firestore/Redis rate counters.

#### 29 Unprotected staging or test environments
- **Guideline**: Authenticate non-production systems and keep production secrets, data, and admin tools out of them.
- **Burgonomics Targets**: Staging Firebase projects vs production Firebase projects (`asia-south1`). Ensure staging does not connect to live Razorpay Route merchant accounts or live Porter production API keys.

#### 30 Default credentials left unchanged
- **Guideline**: Replace vendor defaults before deployment and remove unused default accounts or tokens.
- **Burgonomics Targets**: Default admin seed scripts, test users, or demo partner accounts. Ensure all test seed scripts (`scripts/seed.ts`) are excluded from production and require initial password rotation.

#### 31 Webhook signatures not verified
- **Guideline**: Verify the provider’s webhook signature before trusting or processing the event.
- **Burgonomics Targets**:
  - `functions/src/modules/payments/razorpay.webhook.ts`: Verify `X-Razorpay-Signature` using `crypto.createHmac('sha256', secret).update(rawBody).digest('hex')`.
  - `functions/src/modules/petpooja/`: Verify Petpooja webhook authentication tokens/signatures.

#### 32 Frontend-only payment checks
- **Guideline**: Determine subscription and entitlement state on the server rather than trusting browser state.
- **Burgonomics Targets**: Order fulfillment and status transitions (`orders/{orderId}`). Orders must ONLY transition to `PAID` / `CONFIRMED` via verified server-side Razorpay webhook or server-side verification function, never directly written as `PAID` from the client app.

#### 33 IDOR / BOLA (Insecure Direct Object Reference / Broken Object Level Authorization)
- **Guideline**: Authorize the specific object being requested every time; possession of its ID must never be enough.
- **Burgonomics Targets**:
  - `orders/{orderId}`: Ensure only the customer who placed the order or staff from the assigned `branchId` can read the order details.
  - `tickets/{ticketId}`: Ensure customers can only read tickets where `customerId == request.auth.uid`.

#### 34 APIs trusting user-controlled roles or IDs
- **Guideline**: Derive identity and permissions from trusted server-side auth context rather than request fields.
- **Burgonomics Targets**: Never trust `{ userId, role: 'admin', branchId }` passed in the JSON request body. Always extract `uid` and custom claims from `request.auth` / `context.auth`.

#### 35 Sensitive data in logs
- **Guideline**: Redact passwords, tokens, payment data, and unnecessary PII, then restrict log access and retention.
- **Burgonomics Targets**: Cloud Functions logging (`functions/src/core/logger.ts`). Ensure customer phone numbers, full addresses, card details, and auth tokens are masked before writing to Google Cloud Logging.

#### 36 Sensitive source maps or build artifacts
- **Guideline**: Inspect production output and exclude source maps or artifacts that reveal secrets or unintended internal files.
- **Burgonomics Targets**: `vite.config.ts` in both `burgonomics-foundation-core` and `burgonomics-partner`. Ensure `build.sourcemap: false` (or `hidden` for Sentry error tracking) in production builds.

---

### PART 3: DEPENDENCIES, AI, DATA & INFRA
*Cover the supply chain, AI permissions, observability, and production data layer.*

#### 37 Vulnerable or abandoned dependencies
- **Guideline**: Scan dependencies, patch known vulnerabilities quickly, and replace libraries that are no longer maintained.
- **Burgonomics Targets**: Run `npm audit` / `bun audit` across root, `burgonomics-foundation-core`, `burgonomics-partner`, and `functions`. Ensure zero High or Critical CVEs.

#### 38 Malicious or compromised packages
- **Guideline**: Minimise dependencies, verify package identity and maintainers, and review suspicious install scripts.
- **Burgonomics Targets**: Review `package.json` across workspaces. Ensure packages are from trusted registries with verified scopes (`@capacitor/*`, `@tanstack/*`, `firebase-admin`, etc.).

#### 39 Prompt injection
- **Guideline**: Separate trusted instructions from untrusted content and enforce permissions outside the model itself.
- **Burgonomics Targets**: Any AI chatbot, automated review responder, or customer support summarizer. Ensure user-supplied food reviews or ticket messages are encapsulated as untrusted user inputs with strict system prompt boundaries.

#### 40 AI tools bypassing user permissions
- **Guideline**: Authorize every tool call with the real user and tenant context before the model can access data or take action.
- **Burgonomics Targets**: If AI agents/tools are used for customer service or order queries, ensure tool execution validates the caller's Firebase Auth `uid` and `branchId` before executing DB lookups.

#### 41 Excess database privileges
- **Guideline**: Give the application a least-privilege database role and isolate operations that genuinely need elevated access.
- **Burgonomics Targets**: Client apps must only use Firebase Client SDK subject to `firestore.rules`. Firebase Admin SDK (which bypasses rules) must ONLY be executed within Cloud Functions backend.

#### 42 Missing audit logs
- **Guideline**: Record actor, action, target, time, and outcome for sensitive changes so important activity can be reconstructed.
- **Burgonomics Targets**: `audit_logs` collection. Record all critical partner actions: staff creation/deletion, menu price updates, manual 86ing, manual Porter order dispatch, and ticket resolution.

#### 43 No security monitoring or alerts
- **Guideline**: Alert on auth abuse, privilege changes, unusual traffic, webhook failures, critical exceptions, and spend spikes.
- **Burgonomics Targets**: Google Cloud Monitoring and Firebase Alerts for Cloud Function error spikes, Razorpay webhook failure rate, and Firebase budget threshold alerts.

#### 44 No tested backup / restore plan
- **Guideline**: Automate protected backups and prove that you can restore them before you rely on them.
- **Burgonomics Targets**: Google Cloud Firestore scheduled automated export to a dedicated Cloud Storage backup bucket in `asia-south1` with lifecycle retention rules.

#### 45 Public internal dashboards
- **Guideline**: Put admin, database, queue, and monitoring dashboards behind strong authentication and network controls.
- **Burgonomics Targets**: `burgonomics-partner` deployment URL. Must not expose unauthenticated health dashboards, internal metrics, or dev consoles.

#### 46 Missing security headers
- **Guideline**: Configure browser protections such as CSP and anti-sniffing headers where relevant, then test the deployed response.
- **Burgonomics Targets**: `firebase.json` / `netlify.toml` headers:
  - `Content-Security-Policy`
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `Strict-Transport-Security: max-age=31536000; includeSubDomains`
  - `Referrer-Policy: strict-origin-when-cross-origin`

#### 47 Unsafe cookie settings
- **Guideline**: Set HttpOnly, Secure, and an appropriate SameSite policy on sensitive cookies based on how they are used.
- **Burgonomics Targets**: Any session or CSRF cookies set by Cloud Functions must have `HttpOnly; Secure; SameSite=Lax` (or `Strict`).

#### 48 Sensitive data unprotected in transit / at rest
- **Guideline**: Use HTTPS/TLS, provider encryption, and sensible key management for data that needs protection.
- **Burgonomics Targets**: Strict HTTPS enforcement on custom domains (`burgonomics.com`). Firestore and Cloud Storage default AES-256 encryption at rest.

#### 49 Poor tenant isolation (Multi-Branch Isolation)
- **Guideline**: Include tenant scope in authorization and data access at every layer of a multi-user or multi-organisation app.
- **Burgonomics Targets**:
  - `burgonomics-partner`: A `branch_manager` or `kitchen_staff` assigned to `branch_123` must NEVER receive live KOT updates, orders, or sales data for `branch_456`.
  - Validate this in `firestore.rules` on `orders` and `branches` collections: `resource.data.branchId == request.auth.token.branchId || request.auth.token.role == 'superadmin'`.

#### 50 Over-trusting AI-generated code
- **Guideline**: Review diffs, run scanners and tests, and manually inspect auth, payment, data, and permission logic before shipping.
- **Burgonomics Targets**: Continuous verification gate: Run `npx tsc --noEmit && npx vitest run && npm run build` on every PR. Manually inspect financial calculations (Razorpay Route royalty split formulas).

#### 51 Mass assignment / over-posting
- **Guideline**: Allowlist fields a user is allowed to update so they cannot submit hidden fields such as role, balance, or ownership.
- **Burgonomics Targets**:
  - `firestore.rules` write restrictions: Ensure users cannot update their own `grillCoins`, `isSuperAdmin`, or `role` fields during a profile update: `!request.resource.data.diff(resource.data).affectedKeys().hasAny(['role', 'grillCoins', 'isSuperAdmin'])`.
  - Cloud Functions Zod schemas stripping unexpected fields.

#### 52 Command / OS injection
- **Guideline**: Avoid shell execution where possible; otherwise use safe APIs and strictly validated arguments rather than concatenated commands.
- **Burgonomics Targets**: Cloud Functions and backend scripts. Avoid `child_process.exec()`. If executing external CLI tools (e.g. image processing), use `child_process.execFile` or native WASM libraries with strict argument arrays.

#### 53 Unsafe deserialization
- **Guideline**: Use safe formats, strict schemas, and integrity checks; do not deserialize attacker-controlled objects with unsafe mechanisms.
- **Burgonomics Targets**: JSON parsing in webhook endpoints (`functions/src/modules/`). Ensure `JSON.parse` is validated via Zod schemas and does not expose `__proto__` prototype pollution vulnerabilities.

#### 54 Misconfigured OAuth / OIDC / social login
- **Guideline**: Restrict redirect URIs and correctly validate state or nonce, issuer, audience, and token integrity.
- **Burgonomics Targets**: Firebase Authentication Google/Phone Auth settings. Ensure authorized domains in Firebase Console are restricted only to official production and staging URLs (prevent redirect URI hijack).

---

### PART 4: LOGIC, CI/CD & ADVANCED RISKS
*Finish with privileged accounts, edge cases, build pipelines, and agent-specific failure modes.*

#### 55 No MFA on privileged accounts
- **Guideline**: Enable MFA on GitHub, cloud, database, payments, email, and application-admin accounts.
- **Burgonomics Targets**: Enforce MFA on Google Cloud / Firebase Console, GitHub organization, Razorpay Merchant Dashboard, Petpooja Partner Portal, and Porter Business Dashboard.

#### 56 Account enumeration
- **Guideline**: Avoid login, signup, or reset responses that unnecessarily reveal which email addresses or phone numbers have accounts.
- **Burgonomics Targets**: Customer and Partner login forms. Ensure authentication failure responses use uniform messaging (e.g., "Invalid credentials or account does not exist") to prevent user scraping.

#### 57 Business-logic abuse
- **Guideline**: Enforce prices, credits, trials, limits, and valid state transitions on the server, including unusual sequences and values.
- **Burgonomics Targets**:
  - **Cart Total Verification**: Verify that item unit prices, addon prices (extra cheese, patty upgrades), taxes, and delivery fees match the server-side menu database.
  - **Coupon Abuse**: Enforce coupon max usage counts and minimum order value on the server.
  - **Grill Coins Loyalty**: Enforce max loyalty coin redemption cap (e.g., max 20% of order value) on the server.

#### 58 Race conditions
- **Guideline**: Use transactions, locking, uniqueness constraints, or idempotency so simultaneous requests cannot create duplicate outcomes.
- **Burgonomics Targets**:
  - Use `db.runTransaction()` for burning Grill Coins loyalty balance to prevent double-spending.
  - Use transactions for stock/inventory countdown when limited-edition items are ordered.

#### 59 Webhook replay / duplicate processing
- **Guideline**: Track processed event IDs and make webhook handlers safe to retry without performing the action twice.
- **Burgonomics Targets**: `functions/src/modules/payments/razorpay.webhook.ts`. Store processed `event.id` in a `processed_webhooks/{eventId}` Firestore document with a transaction to ensure idempotency.

#### 60 Overpowered CI/CD credentials
- **Guideline**: Scope pipeline tokens, protect deployment environments, and prefer short-lived credentials for production access.
- **Burgonomics Targets**: GitHub Actions CI/CD workflows. Use Workload Identity Federation (WIF) for Google Cloud / Firebase deployment instead of long-lived service account key JSON secrets.

#### 61 Untrusted build actions or scripts
- **Guideline**: Review third-party CI actions and build scripts because they can read secrets or modify the software you ship.
- **Burgonomics Targets**: `.github/workflows/`. Audit all third-party GitHub Actions (e.g. `actions/checkout@v4`, `actions/setup-node@v4`) and ensure they are from verified official creators.

#### 62 Unpinned build dependencies
- **Guideline**: Lock dependency versions and pin sensitive CI actions so upstream changes cannot silently alter a production build.
- **Burgonomics Targets**: Ensure `package-lock.json` / `bun.lock` is committed and strictly used via `npm ci` in CI/CD pipelines to prevent unexpected dependency resolution changes.

#### 63 Security checks fail open
- **Guideline**: Default to deny when auth, payment, or permission dependencies fail instead of accidentally granting access.
- **Burgonomics Targets**: If Razorpay API status check fails or times out, or if Petpooja POS bridge is unreachable, the order state must default to `PENDING_VERIFICATION` or `FAILED`, never `PAID` or `CONFIRMED`.

#### 64 Missing resource limits
- **Guideline**: Set timeouts, quotas, upload limits, and usage ceilings so a user cannot exhaust compute, storage, APIs, or AI spend.
- **Burgonomics Targets**:
  - Cloud Functions: Configure `timeoutSeconds: 60`, `maxInstances: 20`, and `memory: '256MiB'` (or `512MiB`) to prevent runaway scaling costs.
  - Storage: Enforce max upload file size in client and storage rules.

#### 65 AI sensitive-information disclosure
- **Guideline**: Minimise what reaches the model and filter retrieval and output according to the user’s actual permissions.
- **Burgonomics Targets**: If AI RAG or search is integrated for partner analytics or ticketing, filter context strictly by `branchId` and `role` before passing data into LLM prompts.

#### 66 Unsafe use of AI output
- **Guideline**: Treat model output as untrusted before using it as HTML, SQL, code, URLs, filenames, or shell commands.
- **Burgonomics Targets**: If AI generates automated customer support ticket responses or marketing notifications, sanitize and escape text before rendering in web views or push notification payloads.

#### 67 AI agents have excessive agency
- **Guideline**: Give agents the smallest tool scopes possible and require confirmation for consequential actions such as spending or deletion.
- **Burgonomics Targets**: AI tools must never be granted autonomous tools to trigger bank transfers, issue unrestricted refunds, or delete branch databases without human supervisor confirmation.

#### 68 Sensitive browser storage
- **Guideline**: Avoid putting long-lived secrets or unnecessary PII in localStorage, IndexedDB, or caches; prefer safer session patterns.
- **Burgonomics Targets**:
  - `burgonomics-foundation-core`: Only store non-sensitive preferences (e.g., selected branch, active fulfillment mode `delivery|takeaway|dine_in`, cached cart item IDs). Do NOT store credit card numbers or raw passwords in `localStorage`.
  - `burgonomics-partner`: Rely on Firebase SDK's built-in IndexedDB auth token persistence with auto-refresh.

#### 69 Open redirects
- **Guideline**: Allow only trusted redirect destinations or validated relative paths so your domain cannot be abused for phishing redirects.
- **Burgonomics Targets**: Post-login redirect handlers and payment return URLs (`/order-success?orderId=...`). Ensure redirects only route to validated internal relative paths (`/account`, `/orders`) and reject absolute external URLs (`http://evil.com`).

#### 70 Unsecured GraphQL / WebSocket / Realtime Endpoints
- **Guideline**: Authenticate connections, authorize every operation, and cap query or message abuse just like a normal API.
- **Burgonomics Targets**:
  - Firestore Realtime Listeners (`onSnapshot`): Live KOT stream (`burgonomics-partner`), live order tracking (`burgonomics-foundation-core`), and ticket chat streams (`stages/07_tickets`).
  - Ensure every `onSnapshot` listener attaches to a query strictly guarded by `firestore.rules` matching the user's authenticated `uid` or staff `branchId`.

---

## OUTPUT REPORTING TEMPLATE (MANDATORY FOR AUDITOR)

When executing this audit, generate the report using the following structure:

### 1. High-Level Compliance Scorecard
```markdown
| Part | Category | Total Checks | PASS | FAIL | UNKNOWN | N/A | Compliance % |
|---|---|---|---|---|---|---|---|
| Part 1 | Secrets, Authentication & Input (01–18) | 18 | _ | _ | _ | _ | _% |
| Part 2 | Web, Sessions, APIs & Payments (19–36) | 18 | _ | _ | _ | _ | _% |
| Part 3 | Dependencies, AI, Data & Infra (37–54) | 18 | _ | _ | _ | _ | _% |
| Part 4 | Logic, CI/CD & Advanced Risks (55–70) | 16 | _ | _ | _ | _ | _% |
| **TOTAL** | **All Security Domains** | **70** | **_** | **_** | **_** | **_** | **_%** |
```

### 2. Actionable Remediation Cards (For every FAIL & UNKNOWN)
```markdown
### [FAIL] Check 31: Webhook signatures not verified
- **Target Scope**: `functions/src/modules/payments/razorpay.webhook.ts`
- **Severity**: P0 - Critical
- **File & Line**: `functions/src/modules/payments/razorpay.webhook.ts:L42-L65`
- **Failure Mode**: An attacker could forge HTTP POST requests to the webhook URL and transition arbitrary orders to `PAID` without transferring funds.
- **Minimal Safe Fix**:
```typescript
import * as crypto from 'crypto';

export const verifyRazorpayWebhook = (rawBody: Buffer, signature: string, secret: string): boolean => {
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(signature));
};
```
- **Verification Step**: Run `npx vitest run functions/tests/webhook.test.ts` with a mock forged signature to verify HTTP 400 rejection.
```

---

## OFFICIAL SECURITY REFERENCES

- ↗ [OWASP Application Security Verification Standard (ASVS)](https://owasp.org/www-project-application-security-verification-standard/)
- ↗ [OWASP OAuth 2.0 Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/OAuth2_Cheat_Sheet.html)
- ↗ [OWASP Software Component Verification Standard](https://owasp.org/www-project-software-component-verification-standard/)
- ↗ [OWASP API Security Top 10](https://owasp.org/www-project-api-security/)
- ↗ [OWASP CI/CD Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/CI_CD_Security_Cheat_Sheet.html)
- ↗ [CISA Secure by Design Guidelines](https://www.cisa.gov/securebydesign)
- ↗ [NIST Secure Software Development Framework (SSDF)](https://csrc.nist.gov/pubs/sp/800/218/final)
- ↗ [GitHub Actions Security Hardening](https://docs.github.com/en/actions/security-for-github-actions)
- ↗ [Burgonomics Backend Upgrade Specification](file:///c:/Users/DELL/Desktop/Burgonomics/references/backend_upgrade_spec.md)
- ↗ [Burgonomics Firestore Schema & RBAC](file:///c:/Users/DELL/Desktop/Burgonomics/references/firestore_schema.md)
