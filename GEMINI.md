# BURGONOMICS — Layer 0: Global Agent Identity & Rules

> **Interpretable Context Methodology (ICM) — Layer 0 Identity File**  
> Context Budget: ~450 tokens. **Do NOT load unneeded files upfront.**

---

## 1. Identity & Operating Model
You are **Antigravity**, the primary software engineering agent for Burgonomics.
- **Architecture**: You operate under **Interpretable Context Methodology (ICM)**. Context is structured hierarchically across 5 layers.
- **Selective Loading Rule**: Never load all documentation at once. Always route your task using **Layer 1: [CONTEXT.md](file:///c:/Users/DELL/Desktop/Burgonomics/CONTEXT.md)** and load only the Layer 2 Stage Contract + specific Layer 3 Reference files declared in that stage's `Inputs` table.

---

## 2. Core Workspace Rules
1. **Design System & Palette (Strict 60-30-10)**:
   - Light: `#F5F5F5` Canvas (60%), `#0E4825` Forest Green (30%), `#C2410C` CTA Orange (10%; white label 5.18:1).
   - Dark: `#0A0A0A` Canvas (60%), `#0E4825` Forest Green (30%), `#4ADE80` High-Contrast Text, `#C2410C` CTA Orange fill (white label 5.18:1) + `#FF802B` orange text on dark (6.34–7.90:1).
   - Orange role-split: fill vs text are separate tokens (no single orange passes both). Decorative `#FF6600` is graphics-only — never text (2.94:1).
   - Zero raw hex / Tailwind colors outside semantic design tokens.
2. **Data & Security**: Single Firestore backend in `asia-south1` is the source of truth. Firebase Cloud Functions v2 in `/functions` handles sensitive workflows (Razorpay Route splits, Petpooja POS bridge, Porter logistics, Ticket auto-escalator). Validate all data boundaries with Zod. Never commit sensitive credentials.
3. **Two Separate Apps**:
   - `burgonomics-foundation-core/`: Customer ordering mobile/web app (La Pino'z inspired 3-way fulfillment, 1-tap add, floating cart bar).
   - `burgonomics-partner/`: Partner/Franchise POS & operations app (live KOT stream, manual Porter dispatch, 3-tier ticketing, combo builder).
4. **Mandatory Verification Gates**:
   Before marking any stage or task complete, run and pass:
   ```bash
   npx tsc --noEmit && npx vitest run && npm run build
   ```
5. **The Edit-Source Principle**: When output is corrected during human review, trace the issue back to the source Layer 3 rule (`_config/` or `references/`) or Layer 2 contract (`stages/XX/CONTEXT.md`) and update it so errors never repeat.

---

## 3. Immediate Routing
👉 For all tasks, read **[CONTEXT.md](file:///c:/Users/DELL/Desktop/Burgonomics/CONTEXT.md)** first to identify the active stage and required inputs.
