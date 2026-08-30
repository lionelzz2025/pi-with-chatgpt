# Pi with ChatGPT — Progress

Last updated: 2026-08-30

## Overall

The repository has moved from a Codex-specific fork to an installable Pi package skeleton while preserving the existing secure Bridge/MCP/OAuth/Pairing/Tunnel core.

Current milestone: **Phase 2 — Pi orchestration loop (Manual Transport V0)**.

## Completed

- Phase 0 product identity
  - package/product renamed to Pi with ChatGPT
  - `p2c` CLI added with temporary `c2c` compatibility
  - connector naming migration preserves existing bindings
  - baseline GitHub Actions CI added
- Phase 1 compatibility and de-Codex work
  - `P2C_STATE_DIR` / new state directory support with legacy C2C fallback
  - execution records made agent-neutral with `agent.kind` / `agent.model`
  - setup/doctor no longer require Codex sandbox configuration
  - `sandbox-allow` retained only as explicit legacy compatibility
- Pi package skeleton
  - package declares Pi extensions and skills
  - `/p2c-status` and `/p2c-setup` commands work through the package-local CLI
  - compact Pi skill added
  - source/git install loader resolves package-local `tsx`

## In progress in this change

- Add `/p2c <goal>` workflow entrypoint.
- Add in-memory workflow states for `PLANNING`, `PLAN_READY`, `EXECUTING`, `REVIEWING`, `FIXING`, `DONE` and error/idle handling.
- Add Manual Transport V0 using Pi's interactive editor for structured `[P2C]` control messages.
- Add plan approval flow with `/p2c-approve`.
- Add review/fix loop with `/p2c-review`.
- Add `/p2c-stop`.
- Gate Pi `write` / `edit` / `bash` outside `EXECUTING` and `FIXING`.
- Add regression tests for the happy path and review→fix loop.

## Next

1. Persist workflow state across Pi reload/restart using Pi session entries and/or the P2C state directory.
2. Add an execution collector so changed files/tests/exit status are recorded automatically rather than relying on Pi to call `p2c record`.
3. Add approval mode configuration (`plan` vs `auto`).
4. Add protected-path and dangerous-command policy on top of the phase gate.
5. Implement automated ChatGPT transport (Playwright or another browser control layer) behind the same control protocol.
6. Finish P2C naming migration for config/ignore files and remaining docs while keeping backwards compatibility.
