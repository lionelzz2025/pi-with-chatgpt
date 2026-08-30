---
name: pi-with-chatgpt
description: Coordinate software work with ChatGPT as planner/reviewer and Pi as the local execution agent. Use when the user wants planning or review through the Pi with ChatGPT bridge.
---

# Pi with ChatGPT

Use this skill to keep responsibilities explicit:

- **ChatGPT** owns planning, architecture discussion, and review.
- **Pi** owns local repository inspection, edits, commands, tests, and execution evidence.
- **The user** remains in control of setup, pairing, and plan approval.

## Commands

- `/p2c-status` — show bridge and workflow state.
- `/p2c-setup` — start the bridge and prepare ChatGPT pairing; use `/p2c-setup local` only for local development.
- `/p2c <goal>` — start the V0 workflow: ChatGPT PLAN → Pi EXECUTE → ChatGPT REVIEW.
- `/p2c-approve` — execute a plan that was captured but not approved yet.
- `/p2c-review` — run the next ChatGPT review round after Pi finishes an execution/fix iteration.
- `/p2c-stop` — cancel the active workflow without stopping the bridge.

## Manual transport V0

The first workflow version deliberately uses a manual control transport. Pi opens an editor containing a small `[P2C]` control message. Copy that control message to the paired ChatGPT conversation, let ChatGPT inspect the workspace through MCP, then replace the editor contents with ChatGPT's `[P2C]` reply and submit it.

Do **not** paste source code, diffs, or raw logs into ChatGPT. ChatGPT should fetch those through the read-only MCP tools.

During an active workflow, the extension blocks `write`, `edit`, and `bash` unless the state is `EXECUTING` or `FIXING`. This keeps planning and review phases read-only on the Pi side as well.

## Working rule

Do not claim that ChatGPT approved a plan or review unless a ChatGPT round actually occurred. Keep local Pi work and ChatGPT review distinct and report which side produced each result.

When practical, Pi should record execution evidence with `p2c record --agent pi` so ChatGPT can distinguish Pi execution from legacy Codex records.

## Safety

The old `p2c sandbox-allow` command is only for legacy Codex compatibility. Pi setup and doctor do not require it.
