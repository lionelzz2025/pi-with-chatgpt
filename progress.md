# Pi with ChatGPT — Progress

Last updated: 2026-10-10

## Phase 6B local evidence feature branch (2026-10-10)

- Created `feat/local-evidence-browser` from main. Implementing local Pi-selected evidence as an in-memory markdown attachment for browser transport only; no tunnel/public URL.
- Added `src/control/local-evidence.ts`: bounded file selection with Workspace/IgnoreRules, Git diff, execution record, secret check, size/count bounds and fail-closed incomplete review. Added browser document-input upload before message send and Extension local PLAN/REVIEW attachment wiring.
- New `/p2c` task finds a same-named ChatGPT project, creates one if absent, then opens a fresh chat in that project; later review requires the saved chat, rather than choosing another tab. Duplicate project names fail closed.
- Real browser smoke: reused an existing project, created a synthetic test project, uploaded a synthetic markdown attachment, received `P2C_PROJECT_ATTACHMENT_OK`, and reopened its saved project chat. No workspace evidence was sent in this probe. The synthetic test project remains in ChatGPT and may be removed manually if undesired.
- Final serial full suite passed 189/189 (18 files), and typecheck/build/diff check passed. Earlier parallel runs occasionally hit resource/timeouts; do not count them as clean passes. Full real `/p2c` PLAN → Pi execution → REVIEW → DONE/FIX has not been validated.
- Errors resolved: absent optional `AGENTS.md` blocked evidence fixture; ChatGPT virtualized/hydrated project sidebar caused a false absent-project lookup; an earlier validation command timed out under process load. Each has a targeted fix or an isolated rerun.

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

## Completed in the transport-abstraction checkpoint

- Define a small `ChatGptTransport.exchange()` interface for control-plane request/reply rounds.
- Move manual editor copy/paste behavior into `ManualTransport`.
- Route both PLAN and REVIEW rounds through the transport interface without changing the workflow protocol.
- Add direct transport regression coverage for reply normalization and missing/unchanged manual input.
- Keep transport state separate from the orchestration state machine so Playwright can be added as another implementation.

## Completed in the execution-gate-hardening checkpoint

- Move gate policy into `src/control/security-gate.ts` (phases, mutation tools, target checks, dangerous-command list) with direct unit coverage.
- Fail closed on abnormal states: `ERROR` and `BLOCKED` workflows and unrecognized persisted phases keep `write`/`edit`/`bash` blocked until `/p2c-stop` (or a new `/p2c` task) releases the freeze. `DONE` releases the gate.
- Enforce a write-target policy during `EXECUTING`/`FIXING`: targets must stay inside the workspace, outside `.git/`, and outside the sensitive-file policy (`.env.example` remains allowed). Unrecognized write/edit input shapes fail closed.
- Require interactive confirmation for dangerous bash commands (recursive deletes, `git push`, `git reset --hard`, `git clean -f`, discarding uncommitted changes, branch deletion, `sudo`, piping downloads into a shell, power/disk commands, package publishing). No confirmation UI or a declined prompt blocks the command.
- Fix `resolveStateDir` to build injected-platform paths with that platform's separator rules (Windows test failures), and add a single retry to the MCP integration suite for transient fetch failures under full parallel load.

## Phase 6 Playwright foundation checkpoint (2026-05-28)

- Added Playwright as an optional dependency and dynamically loads it only when `PlaywrightTransport.initialize()` is used; regular CLI/core use remains independent of browser automation.
- Added `src/control/transports/playwright.ts`: launches a persistent app-owned browser profile under `<stateDir>/browser-profile`, opens/saves workspace conversation sessions, and closes the context. Message exchange deliberately throws a clear not-implemented error; no brittle ChatGPT UI selectors are enabled.
- Added `src/control/session-store.ts`: stores a per-workspace conversation URL in secure state storage; validates workspace IDs and HTTPS ChatGPT hosts.
- Added tests for profile behavior, URL reuse, initialization, disabled exchange, secure session URL persistence, and rejection of invalid host/ID.
- Verification: typecheck/build passed; focused tests (2 files, 6 tests) passed. Full `pnpm test` had 16/17 files and 161/162 tests pass; one MCP integration case errored with `fetch failed` / `ECONNRESET`, then retry encountered a fixture collision (`git mv .npmrc src/public.txt failed: fatal: destination exists`). The exact case passed alone with one worker.
- At this checkpoint, browser login/session verification, composer send/reply parsing, retry/reconnect, Developer Mode/connector setup, pairing automation, and connector lifecycle automation remained incomplete.
- Existing uncommitted Phase 4.5 changes were preserved. Untracked `.pi/`, `.qoder/`, `.zvec-grep/` directories were not included.

## Phase 6 Playwright exchange checkpoint (2026-05-28)

- Implemented `PlaywrightTransport.exchange()`: verifies a ChatGPT-origin page and signed-in composer, fills/submits the outbound control message, waits up to configurable `timeoutMs` (default 120 seconds) for a new nonempty assistant message and enabled send button, then returns assistant text for existing orchestrator parsing.
- Added manual-recovery messages for signed-out/composer missing/timeout/empty response; stores the current trusted ChatGPT URL against the workspace selected by `openSession()`.
- Added mocked tests for send-and-capture, sign-in refusal before sending, and bounded timeout. `pnpm typecheck`, `pnpm build`, targeted suite (8 tests), and the full suite except one MCP integration test passed.
- Full suite result: 16/17 files and 163/164 tests passed. Remaining failure was unrelated test flakiness/contention: `fetch failed` / `ECONNRESET`, followed by fixture collision `git mv .npmrc src/public.txt failed: fatal: destination exists, source=.npmrc, destination=src/public.txt` in `tests/mcp-integration.test.ts`.
- Initial browser acceptance attempt (user selected a dedicated application profile; explicitly declined downloading bundled Chromium): launching installed Chrome/Edge via Playwright persistent context ended early (`Target crashed` / closed context), including a follow-up with GPU-disable flags. No binaries downloaded.
- Skill-guided follow-up: `browser-start.js` reported Chrome already running on `:9222`; `browser-nav.js https://chatgpt.com` and `browser-eval.js` succeeded. Initial DOM showed Login/Sign up; user then signed in to that same Chrome. Follow-up DOM now shows authenticated home UI and recent chat history, with composer `[role=textbox][contenteditable=true][aria-label="询问 ChatGPT"]`; `#prompt-textarea` and assistant messages are absent on home. This establishes a real authenticated CDP browser session and reveals that current PlaywrightTransport's composer selector is stale. No message was sent because transport currently doesn't connect to existing Chrome, and send/completion selectors have not been verified.
- PlaywrightTransport still launches its own Chromium persistent context, unlike browser-tools which connects to existing Chrome; likely startup-integration mismatch. Real exchange remains unverified pending safe implementation/verification of CDP attach and observed UI selectors.
- Re-ran Playwright/session focused tests (2 files, 8 tests), `pnpm typecheck`, `pnpm build`, and `git diff --check`: all passed.
- Re-ran Playwright/session focused tests (2 files, 8 tests), `pnpm typecheck`, `pnpm build`, and `git diff --check`: all passed.
- Not yet verified: authenticated ChatGPT browser UI exchange (selectors may change), retry/reconnect, Developer Mode/connector/pairing automation and lifecycle management. Phase 6 remains incomplete.

## Phase 6 CDP attach checkpoint (2026-05-28)

- Added opt-in `cdpEndpoint`/`connectOverCDP` support to `PlaywrightTransport`; it reuses the attached browser's existing context and page, without creating a browser profile or context when one exists. Default behavior remains isolated persistent-profile launch.
- Added composer selector fallback `#prompt-textarea, [role="textbox"][contenteditable="true"]`, matching the authenticated Chrome DOM observed via browser-tools.
- Added mocked CDP attach/lifecycle test and verified the existing attached context is not closed by transport cleanup; the CDP Browser connection is closed (detaches Playwright client) on `close()`.
- Verification: `pnpm exec vitest run tests/playwright-transport.test.ts` passed (6 tests); `pnpm typecheck`, `pnpm build`, and `git diff --check` passed.
- Read-only browser-tools inspection of an authenticated conversation found the active composer is `<div contenteditable="true" role="textbox" class="ProseMirror" aria-label="询问 ChatGPT">`; footer in idle state displayed `开始语音` (not a send button). No `[data-message-author-role]`, `[data-testid*=conversation-turn]`, or `[data-message-id]` nodes appeared in the loaded conversation, so current assistant-response selector is not validated. No message was typed or sent.
- CDP cleanup intentionally avoids `Browser.close()` because it may close the user's Chrome; attached browser disconnection is deferred to process teardown. Mock verifies attached context remains open and browser `close()` is not called.
- No live message sent. Real send/completion selectors remain unverified; CDP mode is opt-in and not wired to CLI config yet.

## Phase 6 validation checkpoint (2026-05-28)

- Added loopback-only validation for explicitly supplied CDP endpoints; non-local endpoints are refused before connection. Attaching remains opt-in at the transport API, not integrated into the Pi Extension.
- Hardened ChatGPT URL checks with parsed HTTPS hostname equality; session opening prefers trusted tabs over unrelated CDP tabs and navigates to a saved conversation if needed.
- Expanded mocked transport coverage to 10 tests (including CDP, multi-tab, saved URL, signed-out, and timeout cases). Focused transport/session tests: 13 passed; full suite: 17 files / 168 tests passed; `pnpm typecheck`, `pnpm build`, and `git diff --check` passed.
- Live browser inspection was unavailable at this checkpoint: the existing localhost:9222 endpoint returned `HTTP Not Found` for `/json/version`. No browser message was sent, so assistant selector and completion detection remain unverified against the real UI.
- Remaining Phase 6: explicit Extension configuration and lifecycle integration, real authenticated exchange/protocol acceptance, retry/reconnect, connector setup/pairing and URL lifecycle automation.

## Phase 6 live browser acceptance checkpoint (2026-10-10)

- Rechecked localhost:9222: its `/json/version` returns 404, so it was not usable as CDP. Started a separate Chrome with an isolated existing browser-tools profile on loopback port 9333; `/json/version` returned 200 and authenticated ChatGPT was available. The app-owned Playwright persistent-context path still cannot complete a page load here: default bundled Chromium revision is absent, while installed Chrome/Edge launches failed with GPU/network process crashes.
- First live probe could not find the composer: two matching contenteditables existed, and `.first()` selected a hidden 0×0 copy. Switched to `:visible`. Second probe sent successfully and ChatGPT showed a reply, but timed out because the old `[data-message-author-role="assistant"]` selector matched zero nodes in the current UI.
- Inspected the real reply markup: `[data-markdown-text-style="assistant-message"]` contained the assistant text. Added it as a reply selector fallback. A fresh live probe returned exactly `P2C_BROWSER_ACCEPTANCE_2_OK` from `PlaywrightTransport.exchange()`.
- After the successful exchange, the CLI process stayed alive because CDP connection was not closed. `close()` now calls Playwright's attached `Browser.close()` to disconnect the client; verified the script exits and Chrome remains available (`/json/version` HTTP 200). This check did not send another message.
- Focused tests: 13/13 passed; full suite: 17 files / 169 tests passed; typecheck, build, and diff check passed. Real protocol parsing through the Extension was still unverified at this checkpoint because Extension continues using ManualTransport. (Superseded later the same day; see the real protocol round-trip checkpoint.)

## Upstream update review plan (2026-10-10)

- Compared the locally available upstream snapshot `535a07d` against common ancestor `6395334`; reviewed changed-file scopes for candidate commits. This is a planning pass only: no upstream code was merged or cherry-picked.
- Added `task_plan.md` §22 with P0 search/privacy and auth/pairing, P1 Windows/tunnel and MCP contract, optional P2 read-only media, explicit non-adoption of Codex-specific flows, per-batch tests, compatibility and security gates. Recheck upstream `main` before any implementation.

## Phase 6 real protocol round-trip checkpoint (2026-10-10)

- Sent the real `buildPlanRequest` message shape (INIT) through `PlaywrightTransport.exchange()` against the authenticated Chrome on loopback CDP `127.0.0.1:9333`. ChatGPT returned a well-formed `STATE: PLAN` control reply; a second exchange with the real `buildReviewRequest` shape returned `STATE: DONE` plus a `SUMMARY:` section. Both were captured verbatim from the live UI.
- Ran those real replies through the actual extension command path (`/p2c` → plan, `agent_end` → review, `/p2c-review` → outcome) using the real `parseControlReply` / `extractSection` code, with only `TASK_ID`/`ITERATION` rewritten to the current task. Result: plan section extracted intact, phases went PLANNING → EXECUTING → REVIEWING → DONE. No parser change was needed for real ChatGPT formatting.
- Confirmed task binding works against real input: the first harness run used the reply's own task id and the parser correctly rejected it with `ChatGPT reply belongs to <id>, not current task <id>`, which is the designed behavior.
- Harness verification scripts and captured replies were temporary and have been recycled; no new test was added because the real reply shape is identical to the existing synthetic fixtures, so a fixture test would not add coverage.
- Still not verified: end-to-end `/p2c` through the browser transport instead of `ManualTransport`; retry/reconnect; connector setup/pairing and URL lifecycle automation.
- Plan/implementation mismatch found and resolved by decision (B): `parseControlReply` accepts only `PLAN|FIX|DONE`, so ChatGPT cannot return `BLOCKED`; `BLOCKED` is a Pi-side terminal phase only (iteration limit / workflow error), and a ChatGPT `BLOCKED` reply fails safely as a format error with mutations frozen. The Phase 6 checklist and §18 test list were corrected to match the implementation instead of adding a ChatGPT-side stop state. No behavior was changed.

## Phase 6 browser transport wiring checkpoint (2026-10-10)

- Browser transport is now reachable from the extension but still explicitly opt-in: `p2c config transport browser --cdp http://127.0.0.1:9222` stores `{ transport: "browser", cdpEndpoint }` in the workspace preference file; default stays `manual`. Non-loopback endpoints and `browser` without an endpoint are rejected with actionable errors. `src/control/transports/playwright.ts` exports `isLoopbackCdpEndpoint` so the CLI and the transport enforce one rule.
- `p2c config transport` also returns the current mode and endpoint; `p2c status --json` now includes `workspaceId`, which the extension stores in the workflow state and passes to `PlaywrightTransport.openSession()` so the plan and review rounds reuse one persisted conversation.
- `extensions/index.ts` gained `exchangeControl()`: manual mode keeps the existing `ManualTransport` path, browser mode creates a `PlaywrightTransport`, initializes, opens the workspace session, exchanges, and always disconnects in `finally` (detaching the CDP client without closing Chrome). A browser failure is reported with the exact remedy (`p2c config transport manual`) and never falls back to copy/paste, because the message may already have been sent.
- Verified live: real CLI config write via a temporary state dir; `p2c status --json` returned `workspaceId 8e8bb3e46c81` from a running local bridge; two real browser exchanges (INIT→`STATE: PLAN`, REVIEW→`STATE: DONE`) both reopened the same saved conversation URL and persisted `state/sessions/8e8bb3e46c81.json`. Bridge stopped and the temporary workspace/state were recycled afterwards.
- Verification: 17 files / 173 tests passed (4 new: browser transport used, browser failure reported without fallback, manual mode does not attach, CLI transport config persist/validate); typecheck, build, and `git diff --check` passed. Not yet verified: an actual `/p2c` run inside Pi with browser transport enabled (the extension path is covered by mocks only).

## Phase 6 real Pi browser-command checkpoint (2026-10-10)

- Ran actual `pi --mode json -p '/p2c ...'` with this Extension loaded, a local-only bridge on port 48765 and browser transport explicitly configured for `http://127.0.0.1:9333` (no tunnel/public URL). Git Bash requires `MSYS_NO_PATHCONV=1` for a leading `/p2c` prompt; otherwise it rewrites the slash into `C:/Program Files/Git/p2c` and Pi treats it as ordinary text.
- `extensions/index.ts` now permits local-only **browser** transport with an explicit warning that ChatGPT cannot read MCP workspace data. Manual mode still requires a public URL. Local-only INIT tells ChatGPT to plan only from the goal and not claim file inspection. This is a reduced-capability protocol smoke test, not evidence-based implementation/review.
- Two real `/p2c` attempts sent INIT and ChatGPT visibly returned matching PLAN replies, but the extension timed out. Its completion condition required the assistant DOM-node count to grow; ChatGPT virtualized an older turn, leaving the count at five. `PlaywrightTransport.exchange()` now compares the prior last-reply text as well as count and polls at 250 ms. The third real `/p2c` reached `PLAN_READY`, extracting the live PLAN; approval remained `plan`, so no Pi execution or file mutation followed. The transient failed runs used ephemeral Pi sessions. The successful JSON event log recorded `PLANNING → PLAN_READY` for `p2c_mv28n9xv_ewiw2v`.
- Focused tests 34/34 passed; typecheck/build/diff check passed. Full parallel run: 175/176 passed, with the known unrelated MCP integration `ECONNRESET` → retry fixture collision. Its standalone single-worker rerun passed 15/15. This does **not** claim a clean full parallel suite. Tests now cover local browser/manual distinction and virtualized reply detection.
- Cleanup: stopped the temporary local bridge and restored transport mode to `manual` (the stored CDP endpoint remains inert). Chrome was not closed. No tunnel or public URL was used.
- Scope still open: real `/p2c` PLAN → Pi execution → ChatGPT REVIEW → DONE/FIX loop, retry/reconnect, and connector setup/pairing/lifecycle. Local-only ChatGPT cannot inspect workspace via MCP, so production review requires an alternative context path or a reachable connector.

## Next

1. Decide how a no-public-URL workflow supplies trustworthy workspace evidence to ChatGPT for review; do not treat a goal-only PLAN smoke test as full automation.
2. Independently review §22 P0 upstream candidates against current code/tests, recording adopt/skip decisions before implementing any batch.
3. Implement retry/reconnect after browser protocol acceptance; improve execution evidence and Pi integration coverage.
