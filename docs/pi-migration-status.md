# Pi with ChatGPT migration status

This repository is being migrated from `codex-with-chatgpt` to **Pi with ChatGPT**.

## Current phase

Phase 0 establishes the Pi product identity without changing the bridge, OAuth, pairing, workspace security, or tunnel architecture.

- New package name: `pi-with-chatgpt`
- New primary CLI: `p2c`
- Compatibility CLI: `c2c` remains available as an alias
- New workspaces use connector names like `Pi with ChatGPT · <workspace>`
- Existing workspaces keep their recorded connector name; legacy endpoints without a stored name remain `Codex with ChatGPT`
- Service/state compatibility remains intentionally unchanged in this phase

The legacy Codex Skill and Codex-specific setup flow are still present while the Pi Extension and Pi Skill are implemented in later phases. See [`task_plan.md`](../task_plan.md) for the staged migration plan.
