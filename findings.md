# Pi with ChatGPT — Findings

Last updated: 2026-10-10

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

### Fail closed means abnormal states, not every paused state

`planner/review` pauses (`PLANNING`, `PLAN_READY`, `REVIEWING`) already blocked mutation. The hardening adds the abnormal cases: `ERROR`/`BLOCKED` workflows and unrecognized persisted phases now keep mutation frozen until `/p2c-stop` (or a fresh `/p2c` task) releases them, while `DONE` releases immediately. This keeps "the workflow failed" from silently becoming "Pi is unsupervised again".

### The write-target policy should reuse the read policy

Pi-side write protection checks three things for `write`/`edit` during `EXECUTING`/`FIXING`: the target stays inside the workspace, outside `.git/`, and outside the sensitive-file patterns that already govern MCP reads (`.env.example` stays allowed). Sharing one rule set means "what ChatGPT cannot read" and "what Pi should not silently rewrite" cannot drift apart. Unrecognized write/edit input shapes fail closed with an actionable reason; this is accepted over silently unguarding edits because a Pi runtime with different tool-input keys should be discovered loudly, not bypass the gate.

### Dangerous commands are about irreversibility, not scariness

The confirmation list is deliberately small: recursive deletes, `git push`, `git reset --hard`, `git clean -f`, discard-changes checkout/restore, branch deletion, `sudo`, piping downloads into a shell, power/disk commands, and package publishing. Ordinary loop commands (`pnpm test`, `git commit`, `git checkout -b`) stay frictionless. Confirmation goes through `ctx.ui.confirm`; a runtime without a confirmation UI, or a declined prompt, blocks the command (fail closed) with `/p2c-stop` as the release hatch.

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
- Gate target checks cover `write`/`edit` only; `bash` commands are not path-analyzed, so a shell command can still write wherever the OS allows. OS/container sandboxing remains the strong boundary for that.
- The write-target policy has no per-task escape hatch yet; a task that legitimately needs to edit `.env` during execution is blocked until the workflow is stopped and the change is made manually (or the policy is adjusted).
- Dangerous-command confirmation depends on an interactive `ctx.ui.confirm`; runtimes without it block the confirmation-list commands outright rather than allowing them unsupervised.

## Phase 6 Playwright foundation

- Playwright is optional; `PlaywrightTransport` dynamically imports it on initialization so the main CLI/core does not require browser automation at runtime.
- Browser context uses a persistent app-owned profile at `<stateDir>/browser-profile`, separate from the user's default browser profile. `openSession(workspaceId)` reuses a previously persisted conversation URL or opens ChatGPT home; `saveSession` stores the active URL.
- `src/control/session-store.ts` persists workspace-scoped session URLs using secure state-file writes and rejects invalid workspace IDs, non-HTTPS URLs, and hosts other than `chatgpt.com` / `chat.openai.com`.
- `exchange()` intentionally remains disabled and throws an explicit not-implemented error. No verified ChatGPT composer/reply selectors, login detection, protocol parser, or retry logic exist yet; automation must not be claimed complete until implemented and exercised in a real browser.
- Tests use injected `launchPersistentContext` to verify behavior without launching a browser; no end-to-end ChatGPT login test has been performed.

## Implementation lessons

- Keep the extension package self-contained: source/git installs must resolve helpers relative to the package, not the user's workspace.
- Do not add Pi runtime as a hard production dependency just to get types; extensions run inside Pi and can remain lightweight. Type dependency strategy can be revisited once package publishing/version compatibility is defined.
- Persist state at every meaningful phase transition. A single end-of-task snapshot is not enough for reload safety during `PLAN_READY` or `REVIEWING`.
- Automatic records should be best-effort: failure to write the evidence record should warn but should not prevent the workflow from reaching ChatGPT review, because the reviewer can still inspect git state directly through MCP.
- The control protocol should be tolerant enough for manual use but strict on `STATE` and task-id mismatches so workflow errors fail visibly instead of silently advancing the state machine.
- When a resolution function accepts an injected platform for testability, path construction must follow that platform's rules (`path.win32` vs `path.posix`) instead of the host's `path.join`; otherwise the tests pass on the author's platform and fail everywhere else (this broke `resolveStateDir` on Windows).
- The MCP Streamable HTTP integration suite can transiently fail with `fetch failed` while the full suite runs in parallel; a single describe-level retry was added there. If it recurs with retry exhausted, look at port/timing contention between suites that spawn local bridges.
- Gate detection bugs are easiest to catch with a table of realistic commands; combined short flags (`-fd`) and long options (`--recursive`) both initially slipped through naive character-class regexes.
