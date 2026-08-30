# BURGONOMICS — Layer 1: Workspace Task Router

> **Interpretable Context Methodology (ICM) — Layer 1 Task Router**  
> Read this file to determine which Stage Contract to execute and which Layer 3 references apply.  
> **Master Directives**:
> - 📱 **UI/UX Standard**: [ui_ux_spec.md](file:///c:/Users/DELL/Desktop/Burgonomics/references/ui_ux_spec.md) (La Pino'z-inspired 3-way fulfillment, 60-30-10 palette, 1-tap quick-add).
> - ⚡ **Backend Standard**: [backend_upgrade_spec.md](file:///c:/Users/DELL/Desktop/Burgonomics/references/backend_upgrade_spec.md) (Firebase Cloud Functions v2, Razorpay Route, Petpooja POS bridge, Porter logistics, 3-tier ticketing escalator).

---

## 1. Stage Routing Matrix

Identify your current goal and open the designated Stage Contract:

| # | Stage Directory | Focus Area | Stage Contract | Key Layer 3 References & Authoritative Specs |
|---|---|---|---|---|
| **01** | `stages/01_project_setup/` | Tooling, monorepo configs, functions package, Capacitor | [01 CONTEXT.md](file:///c:/Users/DELL/Desktop/Burgonomics/stages/01_project_setup/CONTEXT.md) | `_config/architecture_overview.md`, `_config/deployment_strategy.md` |
| **02** | `stages/02_firebase_firestore/` | Collections, security rules, indexes, client SDK | [02 CONTEXT.md](file:///c:/Users/DELL/Desktop/Burgonomics/stages/02_firebase_firestore/CONTEXT.md) | `references/firestore_schema.md`, `references/rbac.md` |
| **03** | `stages/03_auth_roles/` | Phone/Email Auth, RBAC custom claims, guest policy | [03 CONTEXT.md](file:///c:/Users/DELL/Desktop/Burgonomics/stages/03_auth_roles/CONTEXT.md) | `references/rbac.md`, `_config/coding_standards.md` |
| **04** | `stages/04_dashboard/` | Executive stats, branch performance, live KOT cards | [04 CONTEXT.md](file:///c:/Users/DELL/Desktop/Burgonomics/stages/04_dashboard/CONTEXT.md) | `_config/design_system.md`, `references/push_notifications.md` |
| **05** | `stages/05_orders/` | Order creation, 3-way fulfillment, Petpooja KOT, Porter | [05 CONTEXT.md](file:///c:/Users/DELL/Desktop/Burgonomics/stages/05_orders/CONTEXT.md) | `references/order_flow.md`, `references/petpooja_pos.md`, `references/delivery_porter.md` |
| **06** | `stages/06_customers/` | Customer CRM, Global Grill Coins loyalty, order history | [06 CONTEXT.md](file:///c:/Users/DELL/Desktop/Burgonomics/stages/06_customers/CONTEXT.md) | `references/firestore_schema.md` |
| **07** | `stages/07_tickets/` | Unified ticketing, 3-tier escalator, 60m reminder cron | [07 CONTEXT.md](file:///c:/Users/DELL/Desktop/Burgonomics/stages/07_tickets/CONTEXT.md) | `references/ticketing.md`, `references/rbac.md` |
| **08** | `stages/08_menu/` | Menu categories, pre-made items/combos, Petpooja sync | [08 CONTEXT.md](file:///c:/Users/DELL/Desktop/Burgonomics/stages/08_menu/CONTEXT.md) | `references/petpooja_pos.md`, `_config/design_system.md` |
| **09** | `stages/09_analytics/` | Sales reports, peak hours, Route royalty split ledger | [09 CONTEXT.md](file:///c:/Users/DELL/Desktop/Burgonomics/stages/09_analytics/CONTEXT.md) | `_config/design_system.md`, `references/firestore_schema.md` |
| **10** | `stages/10_branches/` | Dynamic branches, Route linked accounts, franchise leads | [10 CONTEXT.md](file:///c:/Users/DELL/Desktop/Burgonomics/stages/10_branches/CONTEXT.md) | `references/scaling_architecture.md`, `references/push_notifications.md` |
| **11** | `stages/11_users/` | Staff management, custom claims assignment, audit logs | [11 CONTEXT.md](file:///c:/Users/DELL/Desktop/Burgonomics/stages/11_users/CONTEXT.md) | `references/rbac.md`, `_config/coding_standards.md` |
| **12** | `stages/12_settings_notifications/` | FCM push notifications, 1:1 DMs (chats/{pairId}) | [12 CONTEXT.md](file:///c:/Users/DELL/Desktop/Burgonomics/stages/12_settings_notifications/CONTEXT.md) | `references/push_notifications.md`, `references/firestore_schema.md` |

---

## 2. Layer 3 Index (Factory Configuration & Domain Specs)

### Global Factory Rules (`_config/`)
- [project_context.md](file:///c:/Users/DELL/Desktop/Burgonomics/_config/project_context.md) — Product background, 100% Pure Veg proposition, core stack.
- [design_system.md](file:///c:/Users/DELL/Desktop/Burgonomics/_config/design_system.md) — Strict 60-30-10 palette tokens, typography, radii, and QSR components.
- [coding_standards.md](file:///c:/Users/DELL/Desktop/Burgonomics/_config/coding_standards.md) — TypeScript strictness, Zod validation boundaries, WCAG 2.2 AA.
- [architecture_overview.md](file:///c:/Users/DELL/Desktop/Burgonomics/_config/architecture_overview.md) — Two-app topology, Firebase backend, and service gateways.
- [agent_protocols.md](file:///c:/Users/DELL/Desktop/Burgonomics/_config/agent_protocols.md) — Selective loading and the Edit-Source principle.
- [deployment_strategy.md](file:///c:/Users/DELL/Desktop/Burgonomics/_config/deployment_strategy.md) — Capacitor mobile builds and Firebase deployment.

### Domain Reference Specifications (`references/`)
- [backend_upgrade_spec.md](file:///c:/Users/DELL/Desktop/Burgonomics/references/backend_upgrade_spec.md) — Master backend specification & execution roadmap.
- [ui_ux_spec.md](file:///c:/Users/DELL/Desktop/Burgonomics/references/ui_ux_spec.md) — Master production UI/UX specification & La Pino'z screens.
- [firestore_schema.md](file:///c:/Users/DELL/Desktop/Burgonomics/references/firestore_schema.md) — Complete collection data model and TypeScript interfaces.
- [order_flow.md](file:///c:/Users/DELL/Desktop/Burgonomics/references/order_flow.md) — Delivery, Takeaway, and Dine-In lifecycle states.
- [petpooja_pos.md](file:///c:/Users/DELL/Desktop/Burgonomics/references/petpooja_pos.md) — Petpooja POS bridge, hourly sync, and instant 86ing.
- [delivery_porter.md](file:///c:/Users/DELL/Desktop/Burgonomics/references/delivery_porter.md) — Porter delivery integration and Partner manual dispatch.
- [ticketing.md](file:///c:/Users/DELL/Desktop/Burgonomics/references/ticketing.md) — 3-tier support ticket escalator and 60-min reminder.
- [push_notifications.md](file:///c:/Users/DELL/Desktop/Burgonomics/references/push_notifications.md) — FCM subscription topics and loud audio alarms.
- [rbac.md](file:///c:/Users/DELL/Desktop/Burgonomics/references/rbac.md) — Role hierarchy, custom claims, and security rule helpers.
- [scaling_architecture.md](file:///c:/Users/DELL/Desktop/Burgonomics/references/scaling_architecture.md) — Multi-branch scaling and franchise lead pipeline.
- [image_storage.md](file:///c:/Users/DELL/Desktop/Burgonomics/references/image_storage.md) — Cloud Storage WebP paths and food photography standards.
- [demo_presentation_script.md](file:///c:/Users/DELL/Desktop/Burgonomics/references/demo_presentation_script.md) — Executive presentation & slide-by-slide demo walkthrough.
- [changelog.md](file:///c:/Users/DELL/Desktop/Burgonomics/references/changelog.md) — Version history, SemVer releases, and sprint logs.
- [known_issues.md](file:///c:/Users/DELL/Desktop/Burgonomics/references/known_issues.md) — Resolved defects, active roadmap, and operational status.
