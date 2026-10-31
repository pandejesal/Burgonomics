# 08 — Dependency-ordered schedule and date decision

**Original targets are unchanged:** 3 November 2026 tested RCs/submission readiness; 8 November 2026 public launch. Neither is a promise. Observation date is 28 October, so the seven-calendar-day window is **28 October–3 November inclusive**, not seven full engineering days after approval. It includes Saturday 31 October and Sunday 1 November. No weekend staffing or working worker-model capacity has been confirmed.

## Honest forecast

At current evidence/capacity, **a four-release, fully tested 3 November RC is not a credible commitment**. App changes are not approved; designs/baselines/account state are unresolved; no fresh package/emulator/native/provider gates ran. Initial planning workers all failed; a later fresh review returned three bounded reports while Phoenix Grove was quota-blocked and NVIDIA returned `Invalid request`. Those reviews are not implementation or staffed engineering capacity. Existing code may shorten repairs after it is tested, but that saving is not evidence today. 8 November also requires actual store approval, not merely a successful build.

There is a conditional hard Play blocker: for each restricted new personal-account app whose qualifying closed test starts 28 October, 14 continuous days ends approximately **11 November at the actual qualifying timestamp**, before production-access application/review (official guidance: usually seven days or less, sometimes longer) and subsequent app publication review. An internal build or 12 testers active for a few days does not satisfy this. Account type/history may remove that blocker, but has not been verified.

## Capacity and effort assumptions

Estimates are human-equivalent hands-on hours, not model token time or elapsed guarantees. They include scoped implementation/test authoring/review fixes; Q1 is integrated execution/retest. External account/vendor/team/store waits are additional. Initial estimates should be replaced after A0 and first red/green baselines, not interpreted as fixed-price promises.

| Stream / packages | Hours | Required people/constraints |
|---|---|---|
| Baseline + design + edit-source A0/A1/A2 | 20–34 | Release lead + designer, fast team feedback |
| Delivery D1–D4 | 52–84 | Delivery engineer; extra engineer useful for bounded Menu work; shared Home/Cart files serialised |
| Partner P1–P3 | 30–48 | Partner engineer, backend state contract first |
| Backend/security B1–B6 | 74–126 | Backend + security/integration capacity; rules/money/POS/index/auth dependencies and shared files constrain parallelism |
| Release R1–R4 | 30–48 | Native/QA engineer plus account/legal owner; Mac/device/signing access |
| Integrated QA Q1 | 24–40 | QA + engineers; each platform/build independently |
| Supervised pilot O1 | 6–10 **per initial pilot scope** | Outlet operator + finance/provider/QA; additional outlets require additional slots |
| **Launch-critical subtotal** | **236–390** | Does not include every branch, vendor delay, store review or extra design rounds |
| Deferred/noncritical Reelo C1 | 4–8 | Integration owner, vendor waiting excluded |

Five people × seven days × seven productive hours is only **245 theoretical hours**, before context switching, approvals or waiting. The low estimate consumes essentially all of it; the dependency path and lost first-day approval time make it worse. Actual available hours have not been committed. Five model names are not five engineers; later successful read-only reviews do not establish implementation throughput or restore the two failed routes. Do not schedule a 24-hour unattended self-healing loop as capacity or bypass approvals with repeated retries.

## Dependencies

```text
A approval → A0 per-repo baseline + A1 labelled comps → B design / C implementation approval
                               └→ A2 source-contract reconciliation as decisions settle

B1 rules authority → B2 pricing/payment/refunds → B3 POS/reconciliation/alerts → P2 / D4
                  └→ B4 webhook/stock/category contract → D3 / P3
                  └→ B5 invite/revoke → authorised Partner/native paths
B2 + approved courier contract → B6 dispatch → P3
D1 theme → D3 early category-resolution contract → D2 Home
D1 theme + B4 contract → D3 continuous Menu (does not wait for D2)
D1 + B2/B3 contracts + D2 shared-file handover → D4 Cart
P1 theme → P2 / P3

Owner-led read-only account check begins in phase A
R1 deterministic build/test plumbing → R2 signed native builds + R3 final metadata
Relevant code review + local/emulator/browser gates → sandbox → native Q1 → scoped O1
Q1 + O1 + R1/R2/R3 + store eligibility → F submission approval → R4 → actual store decision
C1 Reelo investigation is off the launch critical path
```

B1 owns its initial read-only mutation inventory with B2/P3 owner input; it does not wait for those downstream implementations. D3 hands the category-resolution interface to D2 early; D2 shortcut acceptance depends on it, not the whole D3 query rollout. Each handover still requires the exact approved baseline and gate C before source implementation.

Security tests/design-independent contract work may run in parallel **only after C authorises their exact baseline/scope**. Local tests run daily on owned code, not all deferred to day six. Production deployment, sandbox financial/POS operations, push/SMS and real pilot actions remain separately authorised even when an upstream development task is approved.

## Seven-day target recovery schedule, not a finish promise

If any predecessor is incomplete, keep its successor blocked and update the ledger. Dates do not override dependencies.

| Day (IST) | Planned focus, if authorised | Required exit / stop rule |
|---|---|---|
| **1 · Wed 28 Oct** | Review this packet; gate A; A0 inventory/ownership; A1 comps begin; owner-led read-only account/signing/Play eligibility check; vendor tax/auth/ID questions; restore permitted routes | No source edits before C. Name human owners and design response window. Record all four account/release lanes as known/unknown, not assumed eligible |
| **2 · Thu 29 Oct** | Complete screenshot review B; agree per-repo bases/C; A2 overlays; R1 infrastructure; B1-owned mutation inventory then rules tests; D1/P1 only after design approval **and gate C** | **18:00 go/no-go reforecast:** full B requires the complete agreed A1 state set, not a nod to the initial v0. A bounded per-screen/package approval must be explicit and cannot waive relevant shared-backend gates. Missing B/C/baseline/capacity/finance/SDK/signing route means stop promising 3 Nov RC; do not silently change dates |
| **3 · Fri 30 Oct** | B1/B2 financial boundaries, B4 auth/category/stock; D2/P1; R1 package/toolchain/runner repair; R2 secure signing preparation | Real package/emulator execution with counts/source hashes for completed scope. No sandbox/live calls to compensate for failing offline gates |
| **4 · Sat 31 Oct** | Conditional staffed work: D3/D4 after contracts, B3 POS/reconciliation/2m/5m, B5/B6, P2/P3; signed-build pipeline work | Review money/rules/POS changes before integration. If capacity/contracts unresolved, backlog remains explicit; do not replace contracts with mocks |
| **5 · Sun 1 Nov** | Conditional staffed integration; approved sandbox only after offline exits; independent review; R2 candidate Android/iOS builds; R3 metadata/secure reviewers; Q1 may begin per lane only when its prerequisites pass | A candidate requires an exact complete input manifest and signed artifact. Reserve a rolling Q1/rebuild window across Days 5–7 and beyond if needed. No candidate while a P0 remains; no fallback to Oct17 artifacts |
| **6 · Mon 2 Nov** | Rolling Q1 styled-browser + Android/iOS native acceptance and failure paths on ready lanes; fix/rebuild/rerun; O1 only with exact approval and prior exits | Q1's 24–40 hands-on hours are not compressed into this one day. Record actual QA/device capacity. Failed gates invalidate affected evidence; missing fresh signed/native/operator proof keeps that lane not-ready |
| **7 · Tue 3 Nov** | Q1/retest continues where needed; per-ready-release evidence/eligibility audit, finance/operator sign-off, R3 metadata, gate F decision | **RC/submission readiness checkpoint:** unfinished Q1 or another missing gate means no-go for that lane, with work extending past 3 Nov. Ready lanes may seek submission approval; do not upload without F |

## 4–8 November target window

- R4 only for releases approved at F: track processing/review/rejections separately; operate no production acceptance test without its exact scope.
- Reserve correction/resubmission capacity and the time to build/retest new artifacts. Do not assume five calendar days guarantees either store approves.
- Before 8 November go/no-go, verify actual public availability, compatible accepted backend, supported outlets/modes/tenders and staffed reconciliation/on-call. An approved binary with an unsafe order lane must not start taking orders.
- If a ready app/platform proceeds independently, document the other three states honestly. One accepted outlet does not enable all outlets. Any proposed scope reduction beyond approved hide-empty content must return to Burgonomics for approval.

## Revised decision offered, not silently applied

**Recommended:** keep 3 November as the original hard evidence checkpoint and 8 November as the conditional marketing target, but authorise phase A first. At 29 October's checkpoint choose either:

1. **Evidence supports a narrow, genuinely ready independent release:** retain the original target for that lane, with all gates intact and other lanes explicitly blocked. No arbitrary abandonment of required functions or platforms.
2. **More likely from today's baseline:** approve a provisional **10 November RC/submission-readiness target and 22 November public-launch target**, contingent on design/C by 29 October, named 5–6-person equivalent capacity, contracts/signing/devices, passing safety gates and actual store eligibility/review. These dates are proposals, not bookings or guarantees. A newly required Play test would still finish no earlier than about 11 November, so “10 November readiness” would mean engineering/metadata readiness, **not Play production eligibility**; its publication remains later and conditional.
3. **External blockers remain:** use relative milestones (approved baseline → implementation/review → exact-source gates → signed native → operator → store eligibility/review). Agree a new date only after the blocking evidence exists. Do not invent a public launch date merely to populate a calendar.

Known invalid shortcuts: counting skipped rules tests; treating ACK as KOT printing; auto-refunding at 2/5 minutes; restoring mock-as-live data, lower signing standards, fake staff/reviewer access, or testing only browser viewports instead of iOS/Android. Optional animation polish is the first candidate for an explicit deferral; the approved brief flip behaviour and all other requirements are not silently dropped.
