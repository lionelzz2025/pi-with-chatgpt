# Pi with ChatGPT — Project Progress

> Updated: 2026-08-30  
> Repository: `lionelzz2025/pi-with-chatgpt`  
> Stable branch: `main`  
> Active branch: `feat/phase3-manual-transport`

This file is the short, continuously updated project log. Detailed roadmap and acceptance criteria are in [`task_plan.md`](task_plan.md). Architectural discoveries and lessons learned are in [`findings.md`](findings.md).

---

## Current status

**Overall:** Phase 0–2 are merged and validated. Phase 3 implementation is substantially complete on the active branch and is waiting for branch CI plus a real Pi + ChatGPT ManualTransport smoke test.

```text
Phase 0  Pi identity                ✅ merged
Phase 1  Remove Codex dependency    ✅ merged
Phase 2  Pi package skeleton        ✅ merged
Phase 3  ManualTransport workflow   🟡 implemented / validation pending
Phase 4  Execution gate             ⏳ next
Phase 5  Plan approval              ⏳
Phase 6  Playwright transport       ⏳
Phase 7  Product migration          ⏳ partial foundations only
```

Stable `main` head after Phase 2:

```text
2024c067453e1f49b52425e0b046c4c423ff704c
```

Before the documentation update, `feat/phase3-manual-transport` was 15 commits ahead of `main` with no divergence.

---

## Completed milestones

### Phase 0 — Pi product identity

Merged via PR #1.

Completed:

- package renamed to `pi-with-chatgpt`
- primary CLI changed to `p2c`
- `c2c` kept as compatibility alias
- product identity changed to `Pi with ChatGPT`
- new workspaces use `Pi with ChatGPT · <workspace>` connector names
- existing connector names are preserved
- GitHub Actions CI added
- pnpm pinned to a Node 20-compatible release

Validation:

```text
install ✅
test ✅
typecheck ✅
build ✅
```

### Phase 1 — Remove Codex hard dependency

Merged via PR #2 and PR #3.

Completed:

- `P2C_STATE_DIR` introduced
- `C2C_STATE_DIR` retained as compatibility fallback
- fresh installs use Pi state directory naming
- existing legacy state directories are reused instead of silently abandoned
- ExecutionRecord made agent-neutral with optional agent metadata
- `setup` no longer mutates Codex sandbox configuration
- `doctor` no longer treats Codex sandbox as a health gate
- `sandbox-allow` retained only as an explicit legacy compatibility command
- integration test verifies fake `CODEX_HOME` does not get a generated `config.toml`

Validation:

```text
install ✅
test ✅
typecheck ✅
build ✅
no-Codex setup/doctor ✅
```

### Phase 2 — Pi package skeleton

Merged via PR #4.

Completed:

- Pi package manifest added
- `pi-package` metadata added
- Pi Extension added
- Pi Skill added
- `/p2c-status` added
- `/p2c-setup` added
- Extension resolves the package-local `p2c` executable
- source-checkout and Git-installed package loader resolution fixed
- daemon fallback resolves `tsx` relative to this package instead of the user's cwd
- package manifest and command routing covered by tests

Validation:

```text
install ✅
test ✅
typecheck ✅
build ✅
```

---

## Phase 3 — ManualTransport workflow

Active branch:

```text
feat/phase3-manual-transport
```

### Implemented on branch

- `[P2C]` control protocol types
- parser / serializer
- legacy `[C2C]` parsing compatibility
- ManualTransport
- WorkflowStateMachine
- Pi Orchestrator
- `/p2c <goal>` command
- `/p2c-stop` command
- PREPARING / PLANNING / PLAN_READY / EXECUTING / REVIEWING / FIXING / DONE flow
- BLOCKED / ERROR terminal paths
- Pi execution initiated through follow-up user messages
- `agent_settled` used as execution-complete lifecycle signal
- execution collector
- agent=`pi` execution records
- automatic REVIEW request after Pi settles
- REVIEW=`PLAN` loops into FIXING
- REVIEW=`DONE` finishes workflow
- max-iteration blocking
- protocol tests
- state-machine tests
- orchestrator happy-path tests
- orchestrator fix-loop tests

### Validation still required

- [ ] create Phase 3 pull request
- [ ] run full branch CI
- [ ] fix any test/typecheck/build failures
- [ ] install the branch in a real Pi environment
- [ ] verify `/p2c-status`
- [ ] verify `/p2c-setup`
- [ ] perform one real ManualTransport PLAN → EXECUTE → REVIEW → DONE run
- [ ] merge Phase 3 into `main`

Important: Phase 3 has implementation and mocked integration coverage, but is **not considered complete until real Pi + ChatGPT smoke testing succeeds**.

---

## Next actions

1. Open PR for `feat/phase3-manual-transport`.
2. Run CI to green.
3. Perform real Pi package install and command smoke tests.
4. Run a real ChatGPT ManualTransport workflow.
5. Merge Phase 3.
6. Start Phase 4 `security-gate.ts`.

Phase 4 is the next major safety milestone because the state machine currently expresses permissions logically, but mutation tools are not yet force-blocked by a Pi `tool_call` hook.

---

## Definition of next milestone

Phase 3 is done only when all of the following are true:

```text
Pi package loads
  +
/p2c starts a task
  +
ChatGPT returns PLAN through ManualTransport
  +
Pi executes the plan
  +
agent_settled triggers execution collection
  +
ChatGPT reviews actual workspace evidence through MCP
  +
DONE ends the task
```

After that, Phase 4 will make the orchestration enforceable rather than prompt-conventional.
