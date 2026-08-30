# Pi with ChatGPT — Findings & Lessons Learned

> Updated: 2026-08-30  
> Purpose: record architectural findings, compatibility constraints, implementation lessons, and decisions discovered while converting `codex-with-chatgpt` into `pi-with-chatgpt`.

This document is intentionally different from [`task_plan.md`](task_plan.md) and [`progress.md`](progress.md):

- `task_plan.md` = what we plan to build and how it will be accepted.
- `progress.md` = what has been completed and what is currently in flight.
- `findings.md` = what we learned while doing the work and what future changes must respect.

---

## 1. The reusable core was much less Codex-specific than the original UX suggested

The strongest initial impression was that the project was a Codex-specific integration. After separating UX from infrastructure, most of the important system is actually agent-neutral.

The following areas can remain largely unchanged:

```text
Bridge
MCP
OAuth 2.1 + PKCE
Pairing
Workspace containment
Sensitive-file filtering
Git status / diff reads
Quick Tunnel
Named Tunnel
Execution records
```

The main Codex coupling was concentrated in:

```text
old Skill behavior
Codex in-app browser assumptions
Codex sandbox writable_roots
CLI/product wording
agent-driven state-machine instructions
```

**Decision:** do not rewrite the secure data plane. Replace the Codex adapter/UX layer with a Pi Extension and transport abstraction.

---

## 2. The Pi Extension must own orchestration; the Skill must not

The original Codex workflow depended heavily on a large Skill prompt instructing the agent to maintain protocol state correctly.

That approach is fragile for Pi because:

- state is implicit in model behavior
- permission boundaries are advisory rather than enforced
- recovery after interrupted turns is difficult
- lifecycle transitions are hard to test deterministically

Pi provides Extension lifecycle hooks and commands, so the state machine can live in TypeScript instead.

**Decision:**

```text
Skill = when and why to use Pi with ChatGPT
Extension = state, transitions, execution lifecycle, security gates
```

Do not re-grow the Pi Skill into a hidden orchestrator.

---

## 3. `agent_settled` is the right execution-completion boundary

A key orchestration question was: when should ChatGPT REVIEW begin?

Waiting for a specific assistant text response is unreliable because the model can phrase completion in arbitrary ways. The Pi lifecycle exposes `agent_settled`, which represents the local agent turn actually becoming settled.

**Decision:** use `agent_settled` as the authoritative boundary:

```text
PLAN received
  ↓
send Pi execution follow-up
  ↓
Pi works
  ↓
agent_settled
  ↓
collect execution evidence
  ↓
request ChatGPT REVIEW
```

Do not use natural-language phrases such as “done” or “finished” as execution lifecycle signals.

---

## 4. Do not depend on `sendUserMessage()` return-value semantics

Pi versions may vary in how message forwarding APIs expose Promise/return behavior. The orchestration does not need that return value if lifecycle events are authoritative.

**Decision:** use `sendUserMessage(..., { deliverAs: "followUp" })` to enqueue execution instructions, but use `agent_settled` to determine completion.

This keeps the workflow robust against minor API behavior changes.

---

## 5. Control plane and data plane must stay separated

The original project has a strong security property: ChatGPT does not receive an uploaded repository or pasted bulk source data. It reads what it needs through authenticated read-only MCP tools.

During the Pi rewrite it would be easy to accidentally send execution logs, diffs, or source snippets in `[P2C]` messages because ManualTransport is text-based.

That would weaken the architecture.

**Decision:** `[P2C]` messages carry only small control metadata, such as:

```text
STATE
TASK_ID
ITERATION
GOAL
execution status metadata
```

Do not put complete:

```text
source files
git diffs
command logs
test logs
credentials
```

into the control channel. ChatGPT should inspect actual evidence through MCP.

---

## 6. ManualTransport is an architectural validation tool, not the final UX

ManualTransport deliberately requires a human to relay messages between Pi and ChatGPT.

Its purpose is to validate independently that these pieces work before browser automation is introduced:

```text
P2C protocol
state machine
Pi execution lifecycle
execution records
ChatGPT independent review
fix loop
iteration limit
```

If Playwright were introduced first, browser selectors, login state, connector setup, and orchestration bugs would become mixed together.

**Decision:** keep browser automation outside the orchestrator. ManualTransport and PlaywrightTransport should satisfy the same logical control interface.

---

## 7. Existing connector identity is persistent user state and must not be casually renamed

A product rename from `Codex with ChatGPT` to `Pi with ChatGPT` sounds cosmetic, but connector names are part of existing paired workspace state.

Automatically renaming or recreating connectors could:

- invalidate a working setup
- create duplicate connectors
- trigger unnecessary OAuth/pairing flows
- confuse users with old and new entries

**Decision:**

- new workspace → `Pi with ChatGPT · <workspace>`
- existing endpoint with stored connector name → preserve it
- old endpoint without a connectorName → preserve legacy naming behavior
- migrate only through explicit re-pair/migration flows

Product rename alone must not delete a ChatGPT connector.

---

## 8. State-directory migration must favor continuity over cosmetic cleanliness

Changing the app name also changes the natural state directory name. Simply switching paths would make existing installations appear unconfigured.

Important persisted state includes things such as:

```text
workspace endpoints
OAuth/token information
tunnel information
sessions
execution records
logs/runtime metadata
```

**Decision:** resolution order currently favors continuity:

```text
P2C_STATE_DIR
  ↓
C2C_STATE_DIR
  ↓
existing legacy codex-with-chatgpt state
  ↓
new pi-with-chatgpt state
```

No automatic destructive move/copy was added in the early phases. A dedicated state migration command can be introduced later.

---

## 9. Codex sandbox configuration was an integration convenience, not a core security boundary

The original CLI automatically manipulated:

```text
~/.codex/config.toml
[sandbox_workspace_write].writable_roots
```

That behavior caused the core CLI to require Codex concepts even on a Pi-only system.

The bridge itself does not need Codex sandbox configuration to provide its read-only MCP security model.

**Decision:**

- `p2c setup` must not modify Codex configuration
- `p2c doctor` must not fail because Codex config is missing
- `sandbox-allow` remains only as an explicit legacy compatibility command

A regression integration test verifies that a fake `CODEX_HOME` remains untouched during normal setup/doctor usage.

---

## 10. Removing the Codex sandbox dependency creates a new Pi-side responsibility

Removing the Codex-specific sandbox does not mean mutation security is solved.

The intended model says:

```text
PLANNING / REVIEWING => no write/edit/bash
EXECUTING / FIXING    => mutation allowed
```

Phase 3 currently represents these permissions in workflow state, but does not yet force them at the tool boundary.

**Decision:** Phase 4 is a required safety milestone, not optional polish.

The Pi Extension must install a `tool_call` gate and fail closed when state is ambiguous or non-executing.

---

## 11. Node 20 support requires pinning a compatible pnpm version

The first CI attempt uncovered an environmental issue before tests even ran: Corepack selected a pnpm release requiring a newer Node runtime and failed on Node 20 (`node:sqlite` / minimum Node mismatch).

This was useful because the project claims Node >=20 support.

**Decision:** pin pnpm to a Node 20-compatible 10.x version rather than silently raising the project's minimum Node version.

General lesson: package-manager version is part of runtime compatibility and should be tested in CI.

---

## 12. Git-installed Pi packages cannot assume the user's cwd contains project devDependencies

The original source-mode launcher used:

```text
--import tsx/esm
```

This can work in a repository checkout where dependency resolution happens from the repo, but a Pi package installed under Pi's Git package directory can be executed while `cwd` is an unrelated user workspace.

Then `tsx` resolution can fail if it is resolved relative to the wrong location.

**Decision:** resolve the loader relative to the `pi-with-chatgpt` package itself in both:

```text
bin/p2c.js
daemon source fallback
```

General lesson: extension/package code must treat `ctx.cwd` as the target workspace, not as the package installation directory.

---

## 13. Pi package installation and workspace execution are two different roots

There are always at least two important filesystem roots:

```text
package root    = where pi-with-chatgpt is installed
workspace root  = the user's current project (`ctx.cwd`)
```

Mixing them causes bugs in executable lookup, dependency resolution, state storage, and file access.

**Decision:**

- package resources / `p2c` binary → resolve from Extension file location
- target workspace operations → use `ctx.cwd`
- credentials/state → OS state directory
- never put browser profile or long-lived secrets inside workspace

---

## 14. CI should validate the support contract, not just compilation

Adding CI immediately paid off by finding the pnpm/Node mismatch.

The useful baseline is:

```text
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build
```

But tests should also encode migration promises, for example:

- old connector names remain valid
- no Codex config is required
- state-dir priority is deterministic
- Pi manifest routes to package resources
- orchestrator state transitions are deterministic

**Decision:** every migration behavior that protects an existing user should have a regression test where practical.

---

## 15. “Implemented” and “validated” must remain separate statuses

Phase 3 currently has substantial implementation and mocked integration tests, but it has not yet completed branch CI and a real Pi + ChatGPT ManualTransport smoke test.

Calling it complete before that would hide integration risk.

**Decision:** project status uses explicit distinctions:

```text
implemented
CI validated
real-environment smoke tested
merged
```

A phase is complete only when its acceptance criteria are met, not merely when files exist.

---

## 16. Existing bridge/OAuth/MCP code should be changed only when Pi requirements actually demand it

Early migration plans deliberately avoid rewriting:

```text
OAuth
MCP server
workspace path containment
Quick Tunnel
Named Tunnel
```

These are already security-sensitive and independently useful.

**Decision:** prefer adapters around stable core code. Do not use the Pi migration as an excuse for broad infrastructure refactoring.

---

## 17. Execution records are the bridge between Pi execution and ChatGPT review

ChatGPT must independently inspect the workspace rather than trust a natural-language “tests passed” claim from Pi.

Execution records provide compact structured evidence such as:

```text
task ID
iteration
agent kind/model
changed files/count
test summary
exit status
timestamp
```

ChatGPT can then correlate that metadata with `git_diff`, `test_status`, and other read-only MCP tools.

**Decision:** keep execution records agent-neutral and preserve existing MCP interfaces (`execution_summary`, `test_status`).

---

## 18. Backward compatibility is easier when aliases are retained during migration

Immediately deleting `c2c`, `[C2C]`, old state variables, or connector names would make the fork cleaner but significantly increase migration failures.

**Decision:** use staged compatibility:

```text
p2c primary / c2c alias
[P2C] primary / [C2C] accepted
P2C_STATE_DIR primary / C2C_STATE_DIR fallback
new connector names / old connector identity preserved
```

Deprecation can happen after Pi-native behavior is stable and migration tooling exists.

---

## 19. Security gate should fail closed

For Phase 4, ambiguous state must not imply permission to mutate.

Target rule:

```text
allow mutation only if state === EXECUTING || state === FIXING
otherwise deny
```

This is safer than maintaining a list of “read-only states,” because future states would otherwise accidentally become writable.

Protected paths and dangerous command detection should be additional controls, not replacements for the state gate.

---

## 20. Plan approval belongs after the execution gate

Adding `approvalMode=plan` before mutation enforcement would produce a misleading UX: the UI could say “waiting for approval” while the agent still technically has write/bash capability.

**Decision:** implementation order matters:

```text
Manual state machine
  ↓
Execution Gate
  ↓
Plan Approval
  ↓
Browser automation
```

The gate makes approval meaningful.

---

## 21. Playwright automation should use an isolated profile

When browser automation is introduced, it should not take over the user's normal Chrome/Edge/Safari profile.

Reasons:

- minimizes accidental access to unrelated browsing sessions
- makes automation state reproducible
- keeps ChatGPT login/session scope explicit
- prevents browser data from entering the workspace

**Decision:** browser profile belongs under the OS application state area and is never committed or stored inside project workspaces.

---

## 22. Named Tunnel and Quick Tunnel require different connector-repair behavior

Quick Tunnel URLs can change after restart. Named Tunnel hostnames are intended to stay stable.

Therefore connector repair logic must not blindly delete/recreate on every restart.

**Decision:**

```text
Quick Tunnel address changed
  → connector update/recreate may be necessary

Named Tunnel same hostname
  → do not perform meaningless connector rebuild
```

This distinction should remain explicit when PlaywrightTransport automates connector management.

---

## 23. The project should avoid automatic self-updating execution

The old Codex Skill included an aggressive auto-update pattern (`git pull` + install/build behavior).

For an agent extension that controls local execution permissions, silently changing its own code is undesirable.

**Decision:**

- user explicitly triggers updates
- prefer pinned tag/commit installs for stable releases
- upgrade after release validation
- do not automatically pull/install/build the project as part of routine task execution

---

## 24. Current highest-risk area

The highest remaining architectural risk is not MCP/OAuth. It is the Pi execution boundary.

Until Phase 4 lands, state transitions describe when mutation should happen but do not cryptographically or mechanically prevent an agent tool call outside EXECUTING/FIXING.

**Priority:** implement and test the `tool_call` execution gate immediately after Phase 3 acceptance.

---

## 25. Current milestone interpretation

The first major milestone is:

> Core runs with no Codex dependency, Pi can load the package, and ManualTransport can complete a real PLAN → EXECUTE → REVIEW → DONE loop.

The second major milestone is:

> Pi mutation permissions are mechanically enforced by Extension state.

Only after those are stable should the project optimize browser automation and polished end-user UX.

---

## Findings to verify later

These are not treated as settled until later phases test them in real environments:

- [ ] exact Pi version compatibility range for Extension APIs
- [ ] Windows behavior of Pi Git-installed package loader paths
- [ ] macOS/Linux browser-profile handling for PlaywrightTransport
- [ ] ChatGPT UI selector stability for connector creation and conversation reuse
- [ ] recovery behavior after Pi process interruption mid-EXECUTING
- [ ] recovery behavior after ChatGPT response timeout mid-REVIEWING
- [ ] best durable persistence model for in-flight workflow state
- [ ] correct UX for plan revise/reject without leaking mutation permission
- [ ] state migration behavior when both legacy and Pi state directories contain data

Add new discoveries here as implementation proceeds; avoid burying important compatibility or security lessons only in PR discussions.
