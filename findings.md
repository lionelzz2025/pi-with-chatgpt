# Pi with ChatGPT — Findings

Last updated: 2026-08-30

## Architecture findings

### Keep Bridge/MCP agent-neutral

The existing security-sensitive core is already mostly independent of Codex. OAuth 2.1 + PKCE, one-time pairing, workspace isolation, read-only MCP tools, tunnel handling, git/test/execution evidence and endpoint persistence should remain core infrastructure rather than being rewritten for Pi.

### Pi Extension should own orchestration

Pi's extension API provides the primitives the project needs: slash commands, lifecycle events, `tool_call` / `tool_result` interception, interactive UI, user-message injection and session state hooks. This is a better fit than encoding the workflow in a very large skill prompt.

### Pi session entries are the right V0 persistence boundary

`appendEntry()` plus `session_start` restoration gives the extension durable workflow checkpoints without adding a second orchestration database. The state follows Pi's own session history and can be restored on reload/resume. This also keeps persistence local to the execution session rather than coupling it to ChatGPT transport state.

### Manual transport is useful as a protocol test

A manual ChatGPT transport is intentionally not the final UX. It lets the project validate the control protocol and state transitions before adding browser automation. The control plane stays small: goal, task id, iteration, state, plan/fix/review outcome. Source code, diffs and logs remain in the read-only MCP data plane.

### Execution evidence should be summarized, not copied

The extension can observe Pi's bash tool results and record a safe summary at `agent_end`. The V0 collector stores a changed-entry count and the pass/fail state of the latest recognized test command instead of raw test output. This preserves useful review signals without creating another path for logs or secrets to leak into ChatGPT-visible records.

### Security needs two layers

The old Codex `writable_roots` mechanism is not a Pi security model. For Pi, the extension should enforce workflow-phase permissions (`write`/`edit`/`bash` only during execution/fix) and later add command/path policies. OS/container sandboxing can remain an optional stronger boundary.

## Compatibility findings

- New state should prefer Pi/P2C names while continuing to read legacy C2C state during migration.
- Existing ChatGPT connector names should not be silently renamed because that can break working pairings.
- `c2c` should remain a temporary CLI alias until the migration is stable.
- Execution records should remain backward-compatible but identify the execution agent.

### Approval policy belongs outside the workspace

`approvalMode` is a user/workspace execution preference, not project source. Persisting it under the existing P2C OS state directory avoids dirtying repositories or introducing a writable configuration path inside the workspace. The default remains `plan` so preference read failures degrade safely to explicit approval.

### Auto approval should only skip the human gate

`auto` changes one transition: `PLAN_READY → EXECUTING`. It does not weaken the phase mutation gate, bypass ChatGPT review, or change the iteration safety limit. Keeping those concerns separate makes later browser automation easier to reason about.

### Transport must stay behind a narrow exchange interface

The orchestrator only needs a small control-plane primitive: send one structured request and receive one structured reply. Moving manual editor behavior behind `ChatGptTransport.exchange()` confirms that browser automation does not need to own workflow state, approval policy, execution evidence, or review-loop logic. Those remain extension responsibilities.

## Current limitations

- Workflow persistence is scoped to Pi session entries; starting an unrelated fresh Pi session does not automatically import a previous workflow.
- Manual transport still requires an interactive Pi UI and user copy/paste between Pi and ChatGPT.
- Test detection is heuristic and intentionally coarse; unrecognized test runners produce `tests: null` rather than storing raw shell output.
- The execution collector records changed-file count rather than file names. ChatGPT can obtain the real status and diff through MCP.
- The three-iteration limit is currently a fixed V0 safety constant rather than configuration.
- Manual V0 validates structured ChatGPT replies but does not cryptographically bind them to a browser session; task-id checking only protects against accidental cross-task paste.

## Implementation lessons

- Keep the extension package self-contained: source/git installs must resolve helpers relative to the package, not the user's workspace.
- Do not add Pi runtime as a hard production dependency just to get types; extensions run inside Pi and can remain lightweight. Type dependency strategy can be revisited once package publishing/version compatibility is defined.
- Persist state at every meaningful phase transition. A single end-of-task snapshot is not enough for reload safety during `PLAN_READY` or `REVIEWING`.
- Automatic records should be best-effort: failure to write the evidence record should warn but should not prevent the workflow from reaching ChatGPT review, because the reviewer can still inspect git state directly through MCP.
- The control protocol should be tolerant enough for manual use but strict on `STATE` and task-id mismatches so workflow errors fail visibly instead of silently advancing the state machine.
