# BURGONOMICS — Layer 0 Entrypoint

This workspace follows the **Interpretable Context Methodology (ICM)** (arXiv:2603.16021v2).

- **Global Agent Identity & Rules**: See [GEMINI.md](file:///c:/Users/DELL/Desktop/Burgonomics/GEMINI.md)
- **Task Router & Stage Index (Layer 1)**: See [CONTEXT.md](file:///c:/Users/DELL/Desktop/Burgonomics/CONTEXT.md)
- **Global Factory Configuration (Layer 3)**: See [_config/](file:///c:/Users/DELL/Desktop/Burgonomics/_config)
- **Domain Reference Specs (Layer 3)**: See [references/](file:///c:/Users/DELL/Desktop/Burgonomics/references)
- **Stages & Working Artifacts (Layer 2 & 4)**: See [stages/](file:///c:/Users/DELL/Desktop/Burgonomics/stages)

## InterHarness bus (Kilo worker contract)

Kilo Code also serves as the inline-IDE worker of a multi-agent harness
(Hermes orchestrates; OpenCode/Antigravity/Jules are siblings). Full
contract: [.kilocode/rules/interharness.md](file:///c:/Users/DELL/Desktop/Burgonomics/.kilocode/rules/interharness.md).
Short version: poll `C:\Users\DELL\Documents\Default Project\04-Prompt-Queues\Ecosystem\Kilo\`
for `*-to-kilo-*.md` tasks; reply to `.../InterHarness/kilo-to-<who>-YYYY-MM-DD.md`
+ vault mirror; log to vault `05-Session-Logs/`; no secrets in bus files.
Project methodology above wins on code conflicts; the bus contract wins on
handoff conflicts.
