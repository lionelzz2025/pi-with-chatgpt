# Pi with ChatGPT migration status

This repository is being migrated from `codex-with-chatgpt` to **Pi with ChatGPT**.

## Current phase

Phases 0–4 are complete on `main`: Pi product identity, Codex hard-dependency removal, installable Pi package skeleton, ManualTransport orchestration V0, and the hardened execution gate (fail-closed abnormal states, write-target policy, dangerous-command confirmation). The current milestone is **Phase 5 — Plan Approval baseline**.

- New package name: `pi-with-chatgpt`
- New primary CLI: `p2c`
- Compatibility CLI: `c2c` remains available as an alias
- New workspaces use connector names like `Pi with ChatGPT · <workspace>`
- Existing workspaces keep their recorded connector name; legacy endpoints without a stored name remain `Codex with ChatGPT`
- Service/state compatibility remains intentionally unchanged; the P2C naming migration for config/ignore files and docs is Phase 7

The legacy Codex Skill and Codex-specific setup flow are still present alongside the Pi Extension and Pi Skill. See [`task_plan.md`](../task_plan.md) for the staged migration plan and [`progress.md`](../progress.md) for the current checkpoint.
