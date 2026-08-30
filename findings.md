# Pi with ChatGPT — Findings

Last updated: 2026-08-30

## Architecture findings

### Keep Bridge/MCP agent-neutral

The existing security-sensitive core is already mostly independent of Codex. OAuth 2.1 + PKCE, one-time pairing, workspace isolation, read-only MCP tools, tunnel handling, git/test/execution evidence and endpoint persistence should remain core infrastructure rather than being rewritten for Pi.

### Pi Extension should own orchestration

Pi's extension API provides the primitives the project needs: slash commands, lifecycle events, `tool_call` interception, interactive UI, user-message injection and session state hooks. This is a better fit than encoding the workflow in a very large skill prompt.

### Manual transport is useful as a protocol test

A manual ChatGPT transport is intentionally not the final UX. It lets the project validate the control protocol and state transitions before adding browser automation. The control plane stays small: goal, task id, iteration, state, plan/fix/review outcome. Source code, diffs and logs remain in the read-only MCP data plane.

### Security needs two layers

The old Codex `writable_roots` mechanism is not a Pi security model. For Pi, the extension should enforce workflow-phase permissions (`write`/`edit`/`bash` only during execution/fix) and later add command/path policies. OS/container sandboxing can remain an optional stronger boundary.

## Compatibility findings

- New state should prefer Pi/P2C names while continuing to read legacy C2C state during migration.
- Existing ChatGPT connector names should not be silently renamed because that can break working pairings.
- `c2c` should remain a temporary CLI alias until the migration is stable.
- Execution records should remain backward-compatible but identify the execution agent.

## Current limitations

- Workflow state is initially in-memory; Pi reload/restart recovery is still pending.
- Manual transport requires an interactive Pi UI and user copy/paste between Pi and ChatGPT.
- Automatic execution evidence collection is not implemented yet; the execution prompt asks Pi to call `p2c record` when practical.
- Manual V0 validates structured ChatGPT replies but does not cryptographically bind them to a browser session; task-id checking only protects against accidental cross-task paste.

## Implementation lessons

- Keep the extension package self-contained: source/git installs must resolve helpers relative to the package, not the user's workspace.
- Do not add Pi runtime as a hard production dependency just to get types; extensions run inside Pi and can remain lightweight. Type dependency strategy can be revisited once package publishing/version compatibility is defined.
- The control protocol should be tolerant enough for manual use but strict on `STATE` and task-id mismatches so workflow errors fail visibly instead of silently advancing the state machine.
