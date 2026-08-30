# BURGONOMICS — Agent Protocols & Quality Governance (Layer 3 Constraint)

> **Factory Configuration**: Interpretable Context Methodology (ICM) workflows, stage transition rules, and the Edit-Source principle.

---

## 1. Selective Loading Protocol
Antigravity must never load the entire documentation base into context upfront. Always:
1. Start at **Layer 1: [CONTEXT.md](file:///c:/Users/DELL/Desktop/Burgonomics/CONTEXT.md)**.
2. Identify the active stage and load only that stage's **Layer 2 Stage Contract** (`stages/XX/CONTEXT.md`).
3. Load only the specific **Layer 3 References** declared in the stage contract's `Inputs` table.

---

## 2. Mandatory Verification Gates
Before completing any task, ticket, or stage, execute:

```bash
npx tsc --noEmit && npx vitest run && npm run build
```

Zero compiler errors and zero test failures are required before code is committed.

---

## 3. The Edit-Source Principle
When human review catches an error, ambiguity, or bug in generated code:
1. Trace the issue back to its source rule in Layer 3 (`_config/` or `references/`) or Layer 2 (`stages/XX/CONTEXT.md`).
2. Update the source rule immediately so that the same mistake can never recur.
