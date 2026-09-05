# Pi with ChatGPT — Progress

Last updated: 2026-08-30

## Overall

The repository has moved from a Codex-specific fork to an installable Pi package while preserving the existing secure Bridge/MCP/OAuth/Pairing/Tunnel core.

Current milestone: **Phase 5 — Plan Approval baseline**, with ManualTransport V0 and the baseline Phase 4 execution gate already implemented.

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
- Phase 2 Pi package skeleton
  - package declares Pi extensions and skills
  - `/p2c-status` and `/p2c-setup` commands work through the package-local CLI
  - compact Pi skill added
  - source/git install loader resolves package-local `tsx`
- Phase 3 ManualTransport V0 baseline
  - `/p2c <goal>` creates a structured `[P2C]` planning round
  - plan approval via `/p2c-approve`
  - Pi execution via `sendUserMessage`
  - ChatGPT review via `/p2c-review`
  - `DONE` and iterative `FIX` outcomes
  - task-id validation on pasted ChatGPT control replies
  - public MCP endpoint required before starting a workflow
- Phase 4 execution gate baseline
  - `write`, `edit`, and `bash` are blocked outside `EXECUTING` / `FIXING` while a workflow is active
  - review rounds are read-only on the Pi side

## Completed in the current checkpoint

- Persist workflow snapshots with Pi `appendEntry()` and restore them on `session_start`.
- Preserve pending `PLAN_READY`, `EXECUTING`, `REVIEWING`, and `FIXING` state across reload/resume of the same Pi session.
- Automatically observe bash test commands during Pi execution.
- Automatically write an execution record on `agent_end` with:
  - changed git entry count
  - safe recognized-test summary
  - Pi agent identity
  - execution status and coarse error notes
- Remove the need for Pi to manually run `p2c record` in the normal workflow.
- Add a three-execution-iteration safety limit to prevent an endless `FIX` loop.
- Add regression tests for session restore, evidence collection, mutation gating, happy path, fix loop, and iteration limit.

## Completed in the approval-mode checkpoint

- Add workspace-scoped `approvalMode` with a fail-safe default of `plan`.
- Persist the preference under the P2C OS state directory instead of writing config into the source workspace.
- Add `p2c config approval-mode [plan|auto]`.
- Add Pi command `/p2c-mode [plan|auto]`.
- In `auto` mode, move from `PLAN_READY` directly into Pi execution without a confirmation prompt.
- Keep `/p2c-approve` and interactive confirmation behavior for `plan` mode.
- Add CLI and mocked Pi extension regression coverage for persisted and automatic approval behavior.

## Next

1. Strengthen the execution gate with protected paths, dangerous-command confirmation, and explicit fail-closed behavior for abnormal states.
2. Improve execution evidence beyond heuristic test-command detection, without storing raw logs or secrets.
3. Introduce a transport interface and implement automated ChatGPT transport (Playwright or another browser control layer) behind the same control protocol.
4. Finish P2C naming migration for config/ignore files and remaining docs while keeping backwards compatibility.
5. Add real Pi integration/e2e coverage in addition to the mocked extension tests.
6. Extend plan approval with explicit reject/revise UX if needed after automated transport lands.
