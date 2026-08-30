---
name: pi-with-chatgpt
description: Coordinate software work with ChatGPT as planner/reviewer and Pi as the local execution agent. Use when the user wants planning or review through the Pi with ChatGPT bridge.
---

# Pi with ChatGPT

Use this skill to keep responsibilities explicit:

- **ChatGPT** owns planning, architecture discussion, and review.
- **Pi** owns local repository inspection, edits, commands, tests, and execution evidence.
- **The user** remains in control of setup, pairing, and any destructive or sensitive action.

## First checks

Run `/p2c-status` to see whether the workspace bridge is available.

If it is not running, run `/p2c-setup`. Use `/p2c-setup local` only for local development where ChatGPT does not need to reach the bridge over the public connector.

## Working rule

Do not claim that ChatGPT approved a plan or review unless a ChatGPT round actually occurred. Until the transport workflow is active, treat local Pi work and ChatGPT review as distinct steps and report which side produced each result.

When recording local execution evidence, use the `p2c record` command with `--agent pi` when practical so ChatGPT can distinguish Pi execution from legacy Codex records.

## Safety

The old `p2c sandbox-allow` command is only for legacy Codex compatibility. Pi setup and doctor do not require it.
