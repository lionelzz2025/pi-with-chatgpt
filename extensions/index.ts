import path from "node:path";
import { fileURLToPath } from "node:url";

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  killed?: boolean;
}

type WorkflowPhase =
  | "IDLE"
  | "PLANNING"
  | "PLAN_READY"
  | "EXECUTING"
  | "REVIEWING"
  | "FIXING"
  | "DONE"
  | "BLOCKED"
  | "ERROR";

type ControlReplyState = "PLAN" | "FIX" | "DONE";
type ApprovalMode = "plan" | "auto";

interface WorkflowState {
  taskId: string;
  workspaceName: string;
  goal: string;
  iteration: number;
  phase: WorkflowPhase;
  plan?: string;
  lastReview?: string;
  error?: string;
}

interface SessionEntry {
  type?: string;
  customType?: string;
  data?: unknown;
}

interface CommandContext {
  cwd: string;
  signal?: AbortSignal;
  hasUI?: boolean;
  sessionManager?: {
    getBranch?(): SessionEntry[];
    getEntries?(): SessionEntry[];
  };
  ui: {
    notify(message: string, level?: "info" | "warning" | "error"): void;
    confirm?(title: string, message: string): Promise<boolean>;
    editor?(title: string, prefilled?: string): Promise<string | undefined>;
    setStatus?(id: string, text: string | undefined): void;
  };
}

interface ToolCallEvent {
  toolName: string;
  input?: unknown;
}

interface ToolResultEvent {
  toolName: string;
  input?: Record<string, unknown>;
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
}

interface ExtensionAPI {
  exec(
    command: string,
    args: string[],
    options?: { signal?: AbortSignal; timeout?: number; cwd?: string }
  ): Promise<ExecResult>;
  registerCommand(
    name: string,
    options: {
      description?: string;
      handler(args: string, ctx: CommandContext): void | Promise<void>;
    }
  ): void;
  on(
    event: "session_start" | "tool_call" | "tool_result" | "agent_end",
    handler: (
      event: ToolCallEvent | ToolResultEvent | unknown,
      ctx: CommandContext
    ) => void | Promise<void> | { block: true; reason: string }
  ): void;
  sendUserMessage?(message: string, options?: { deliverAs?: "steer" | "followUp" | "nextTurn" }): void | Promise<void>;
  appendEntry?(customType: string, data?: unknown): void;
}

interface StatusResult {
  ok: boolean;
  running: boolean;
  workspaceName?: string;
  port?: number;
  publicUrl?: string | null;
  tokenCount?: number;
}

interface SetupResult {
  ok: boolean;
  error?: string;
  workspaceName?: string;
  connectorName?: string;
  mcpUrl?: string;
  local?: boolean;
  pairingCode?: string;
  pairingExpiresAt?: number;
}

interface ApprovalModeResult {
  ok: boolean;
  approvalMode: ApprovalMode;
  stored: boolean;
}

interface ExecutionObservation {
  lastTest?: {
    label: string;
    ok: boolean;
  };
  bashErrors: number;
}

interface PersistedWorkflowData {
  cwd: string;
  state: WorkflowState | null;
}

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const p2cBin = path.join(packageRoot, "bin", "p2c.js");
const workflowByWorkspace = new Map<string, WorkflowState>();
const executionByWorkspace = new Map<string, ExecutionObservation>();
const MUTATING_TOOLS = new Set(["bash", "write", "edit"]);
const MUTATING_PHASES = new Set<WorkflowPhase>(["EXECUTING", "FIXING"]);
const TERMINAL_PHASES = new Set<WorkflowPhase>(["IDLE", "DONE", "BLOCKED", "ERROR"]);
const WORKFLOW_ENTRY_TYPE = "p2c-workflow-v1";
const MAX_EXECUTION_ITERATIONS = 3;

function parseLastJson<T>(stdout: string): T {
  const line = stdout.trim().split("\n").filter(Boolean).at(-1);
  if (!line) throw new Error("p2c returned no JSON output");
  return JSON.parse(line) as T;
}

async function runP2c<T>(
  pi: ExtensionAPI,
  ctx: CommandContext,
  args: string[],
  timeout = 30_000
): Promise<T> {
  const result = await pi.exec(
    process.execPath,
    [p2cBin, ...args, "--workspace", ctx.cwd, "--json"],
    { signal: ctx.signal, timeout }
  );
  if (result.code !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `p2c exited with code ${result.code}`;
    throw new Error(message);
  }
  return parseLastJson<T>(result.stdout);
}

function createTaskId(): string {
  return `p2c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function workflowLabel(state: WorkflowState): string {
  return `${state.phase} · ${state.taskId} · iteration ${state.iteration}`;
}

function setWorkflowStatus(ctx: CommandContext, state?: WorkflowState): void {
  ctx.ui.setStatus?.("p2c-workflow", state && !TERMINAL_PHASES.has(state.phase) ? `P2C ${state.phase}` : undefined);
}

function persistWorkflow(pi: ExtensionAPI, ctx: CommandContext, state: WorkflowState | null): void {
  pi.appendEntry?.(WORKFLOW_ENTRY_TYPE, {
    cwd: ctx.cwd,
    state: state ? { ...state } : null,
  } satisfies PersistedWorkflowData);
}

function saveWorkflow(pi: ExtensionAPI, ctx: CommandContext, state: WorkflowState): void {
  workflowByWorkspace.set(ctx.cwd, state);
  setWorkflowStatus(ctx, state);
  persistWorkflow(pi, ctx, state);
}

function setPhase(pi: ExtensionAPI, ctx: CommandContext, state: WorkflowState, phase: WorkflowPhase): void {
  state.phase = phase;
  saveWorkflow(pi, ctx, state);
}

function restoreWorkflow(ctx: CommandContext): WorkflowState | null {
  const entries = ctx.sessionManager?.getBranch?.() ?? ctx.sessionManager?.getEntries?.() ?? [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== WORKFLOW_ENTRY_TYPE) continue;
    const data = entry.data as PersistedWorkflowData | undefined;
    if (!data || data.cwd !== ctx.cwd) continue;
    if (!data.state) {
      workflowByWorkspace.delete(ctx.cwd);
      setWorkflowStatus(ctx);
      return null;
    }
    const restored = { ...data.state };
    workflowByWorkspace.set(ctx.cwd, restored);
    setWorkflowStatus(ctx, restored);
    return restored;
  }
  workflowByWorkspace.delete(ctx.cwd);
  setWorkflowStatus(ctx);
  return null;
}

function activeWorkflow(cwd: string): WorkflowState | undefined {
  const state = workflowByWorkspace.get(cwd);
  if (!state || TERMINAL_PHASES.has(state.phase)) return undefined;
  return state;
}

function requireWorkflow(cwd: string, phase?: WorkflowPhase): WorkflowState {
  const state = workflowByWorkspace.get(cwd);
  if (!state) throw new Error("No Pi with ChatGPT workflow is active. Start one with /p2c <goal>.");
  if (phase && state.phase !== phase) {
    throw new Error(`Workflow is ${state.phase}, expected ${phase}.`);
  }
  return state;
}

function buildPlanRequest(state: WorkflowState): string {
  return `[P2C]\nSTATE: INIT\nTASK_ID: ${state.taskId}\nITERATION: ${state.iteration}\nWORKSPACE: ${state.workspaceName}\n\nGOAL:\n${state.goal}\n\nINSTRUCTIONS:\nUse the connected Pi with ChatGPT MCP tools to inspect the workspace and produce an implementation plan. Do not ask the user to paste source code, diffs, or logs into chat. Return a compact control response in this shape:\n\n[P2C]\nSTATE: PLAN\nTASK_ID: ${state.taskId}\nITERATION: ${state.iteration}\n\nPLAN:\n<steps for Pi to execute>`;
}

function buildReviewRequest(state: WorkflowState): string {
  return `[P2C]\nSTATE: REVIEW\nTASK_ID: ${state.taskId}\nITERATION: ${state.iteration}\nWORKSPACE: ${state.workspaceName}\n\nINSTRUCTIONS:\nReview Pi's current execution using only the connected MCP workspace tools (git_status, git_diff, test_status, execution_summary, read/search tools as needed). Do not ask the user to paste source code, diffs, or logs. Return exactly one outcome:\n\n[P2C]\nSTATE: DONE\nTASK_ID: ${state.taskId}\nITERATION: ${state.iteration}\n\nSUMMARY:\n<why the task is complete>\n\nOR\n\n[P2C]\nSTATE: FIX\nTASK_ID: ${state.taskId}\nITERATION: ${state.iteration}\n\nFIX:\n<specific fixes for Pi>`;
}

function parseControlReply(raw: string, state: WorkflowState, allowed: ControlReplyState[]): ControlReplyState {
  const stateMatch = raw.match(/^STATE:\s*(PLAN|FIX|DONE)\s*$/im);
  if (!stateMatch) {
    throw new Error("ChatGPT reply is missing a supported `STATE: PLAN|FIX|DONE` control line.");
  }
  const replyState = stateMatch[1].toUpperCase() as ControlReplyState;
  if (!allowed.includes(replyState)) {
    throw new Error(`ChatGPT returned STATE: ${replyState}; expected ${allowed.join(" or ")}.`);
  }
  const taskMatch = raw.match(/^TASK_ID:\s*(\S+)\s*$/im);
  if (taskMatch && taskMatch[1] !== state.taskId) {
    throw new Error(`ChatGPT reply belongs to ${taskMatch[1]}, not current task ${state.taskId}.`);
  }
  return replyState;
}

function extractSection(raw: string, heading: "PLAN" | "FIX"): string {
  const match = new RegExp(`^${heading}:\\s*$`, "im").exec(raw);
  if (!match || match.index === undefined) return raw.trim();
  const text = raw.slice(match.index + match[0].length).trim();
  return text || raw.trim();
}

function testCommandLabel(command: string): string | null {
  if (/\bpnpm\s+(?:run\s+)?test\b/i.test(command)) return "pnpm test";
  if (/\bnpm\s+(?:run\s+)?test\b/i.test(command)) return "npm test";
  if (/\byarn\s+(?:run\s+)?test\b/i.test(command)) return "yarn test";
  if (/\bbun\s+test\b/i.test(command)) return "bun test";
  if (/\b(?:npx\s+|pnpm\s+(?:exec\s+)?)?vitest\b/i.test(command)) return "vitest";
  if (/\b(?:npx\s+|pnpm\s+(?:exec\s+)?)?jest\b/i.test(command)) return "jest";
  if (/\b(?:python(?:3)?\s+-m\s+)?pytest\b/i.test(command)) return "pytest";
  if (/\bcargo\s+test\b/i.test(command)) return "cargo test";
  if (/\bgo\s+test\b/i.test(command)) return "go test";
  if (/\bdotnet\s+test\b/i.test(command)) return "dotnet test";
  if (/\bmvn(?:w)?\b[^\n;&|]*\btest\b/i.test(command)) return "maven test";
  if (/\bgradle(?:w)?\b[^\n;&|]*\btest\b/i.test(command)) return "gradle test";
  if (/\bswift\s+test\b/i.test(command)) return "swift test";
  if (/\brspec\b/i.test(command)) return "rspec";
  if (/\bphpunit\b/i.test(command)) return "phpunit";
  return null;
}

function observeBashResult(cwd: string, event: ToolResultEvent): void {
  if (event.toolName !== "bash") return;
  const observation = executionByWorkspace.get(cwd) ?? { bashErrors: 0 };
  const command = typeof event.input?.command === "string" ? event.input.command : "";
  const label = testCommandLabel(command);
  if (event.isError) observation.bashErrors += 1;
  if (label) {
    observation.lastTest = { label, ok: !event.isError };
  }
  executionByWorkspace.set(cwd, observation);
}

function changedEntryCount(stdout: string): number {
  const tokens = stdout.split("\0");
  let count = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    count += 1;
    if (token.startsWith("2 ")) index += 1;
  }
  return count;
}

async function collectChangedFileCount(pi: ExtensionAPI, ctx: CommandContext): Promise<number | null> {
  const result = await pi.exec("git", ["status", "--porcelain=v2", "-z", "--", "."], {
    cwd: ctx.cwd,
    signal: ctx.signal,
    timeout: 10_000,
  });
  return result.code === 0 ? changedEntryCount(result.stdout) : null;
}

async function recordExecution(pi: ExtensionAPI, ctx: CommandContext, state: WorkflowState): Promise<void> {
  const observation = executionByWorkspace.get(ctx.cwd) ?? { bashErrors: 0 };
  const changedFiles = await collectChangedFileCount(pi, ctx);
  const tests = observation.lastTest
    ? `${observation.lastTest.ok ? "passed" : "failed"} (${observation.lastTest.label})`
    : null;
  const exitStatus = observation.lastTest?.ok === false ? "failed" : "ok";
  const notes = [
    "Automatic Pi execution record.",
    changedFiles === null ? "git status unavailable." : null,
    observation.bashErrors > 0 ? `${observation.bashErrors} bash tool error(s) observed.` : null,
  ]
    .filter(Boolean)
    .join(" ");
  const args = [
    p2cBin,
    "record",
    "--task",
    state.taskId,
    "--iteration",
    String(state.iteration),
    "--agent",
    "pi",
    "--changed-files",
    String(changedFiles ?? 0),
    "--exit-status",
    exitStatus,
    "--notes",
    notes,
    "--workspace",
    ctx.cwd,
  ];
  if (tests) args.splice(args.length - 2, 0, "--tests", tests);
  const result = await pi.exec(process.execPath, args, { signal: ctx.signal, timeout: 30_000 });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `p2c record exited with code ${result.code}`);
  }
}

async function manualRound(ctx: CommandContext, title: string, outbound: string): Promise<string> {
  if (!ctx.ui.editor) {
    throw new Error("Manual ChatGPT transport requires Pi's interactive editor UI.");
  }
  const reply = await ctx.ui.editor(
    `${title} — copy this request to ChatGPT, then replace it with ChatGPT's reply and submit`,
    outbound
  );
  const normalized = reply?.trim() ?? "";
  if (!normalized || normalized === outbound.trim()) {
    throw new Error("No ChatGPT reply was captured. Paste ChatGPT's control response into the editor before submitting.");
  }
  return normalized;
}

async function resolveApprovalMode(pi: ExtensionAPI, ctx: CommandContext): Promise<ApprovalMode> {
  try {
    const result = await runP2c<ApprovalModeResult>(pi, ctx, ["config", "approval-mode"]);
    return result.approvalMode === "auto" ? "auto" : "plan";
  } catch (error) {
    ctx.ui.notify(
      `Could not read approval mode; using safe default 'plan': ${(error as Error).message}`,
      "warning"
    );
    return "plan";
  }
}

async function dispatchPiExecution(
  pi: ExtensionAPI,
  ctx: CommandContext,
  state: WorkflowState,
  instructions: string
): Promise<void> {
  if (!pi.sendUserMessage) {
    throw new Error("This Pi runtime does not expose sendUserMessage; cannot start the execution turn.");
  }
  executionByWorkspace.set(ctx.cwd, { bashErrors: 0 });
  await pi.sendUserMessage(
    `You are the Pi execution layer for Pi with ChatGPT task ${state.taskId}, iteration ${state.iteration}.\n\nExecute the approved ChatGPT instructions below. You may inspect files, edit the workspace, run commands, and run tests as needed. Stay within the current workspace. Do not paste source code, diffs, or raw logs into ChatGPT; the reviewer will inspect them through MCP. The extension records execution evidence automatically when the turn ends.\n\nCHATGPT INSTRUCTIONS:\n${instructions}`
  );
  ctx.ui.notify(`Pi execution started for ${state.taskId}.`, "info");
}

async function approvePlan(pi: ExtensionAPI, ctx: CommandContext, state: WorkflowState): Promise<void> {
  if (!state.plan) throw new Error("The workflow has no ChatGPT plan to execute.");
  delete state.error;
  setPhase(pi, ctx, state, "EXECUTING");
  await dispatchPiExecution(pi, ctx, state, state.plan);
}

function markWorkflowError(pi: ExtensionAPI, ctx: CommandContext, state: WorkflowState, error: unknown): void {
  state.error = (error as Error).message;
  setPhase(pi, ctx, state, "ERROR");
}

export default function piWithChatGPT(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    const restored = restoreWorkflow(ctx);
    if (restored && !TERMINAL_PHASES.has(restored.phase)) {
      ctx.ui.notify(`Restored Pi with ChatGPT workflow: ${workflowLabel(restored)}.`, "info");
    }
  });

  pi.on("tool_call", (event, ctx) => {
    const toolEvent = event as ToolCallEvent;
    const state = activeWorkflow(ctx.cwd);
    if (!state || !MUTATING_TOOLS.has(toolEvent.toolName) || MUTATING_PHASES.has(state.phase)) return;
    return {
      block: true,
      reason: `Pi with ChatGPT workflow ${state.taskId} is in ${state.phase}. Local mutation is only allowed during EXECUTING or FIXING.`,
    };
  });

  pi.on("tool_result", (event, ctx) => {
    const state = workflowByWorkspace.get(ctx.cwd);
    if (!state || (state.phase !== "EXECUTING" && state.phase !== "FIXING")) return;
    observeBashResult(ctx.cwd, event as ToolResultEvent);
  });

  pi.on("agent_end", async (_event, ctx) => {
    const state = workflowByWorkspace.get(ctx.cwd);
    if (!state || (state.phase !== "EXECUTING" && state.phase !== "FIXING")) return;
    try {
      await recordExecution(pi, ctx, state);
    } catch (error) {
      ctx.ui.notify(`Could not write automatic execution record: ${(error as Error).message}`, "warning");
    }
    delete state.error;
    setPhase(pi, ctx, state, "REVIEWING");
    ctx.ui.notify(`Pi execution finished. Run /p2c-review so ChatGPT can review iteration ${state.iteration}.`, "info");
  });

  pi.registerCommand("p2c", {
    description: "Start a ChatGPT-plan → Pi-execute → ChatGPT-review workflow",
    handler: async (args, ctx) => {
      const goal = args.trim();
      if (!goal) {
        ctx.ui.notify("Usage: /p2c <goal>", "warning");
        return;
      }
      const existing = activeWorkflow(ctx.cwd);
      if (existing) {
        ctx.ui.notify(`A workflow is already active: ${workflowLabel(existing)}. Use /p2c-stop first.`, "warning");
        return;
      }
      let state: WorkflowState | undefined;
      try {
        const status = await runP2c<StatusResult>(pi, ctx, ["status"]);
        if (!status.running) {
          throw new Error("Bridge is not running. Run /p2c-setup first so ChatGPT can inspect the workspace through MCP.");
        }
        if (!status.publicUrl) {
          throw new Error("Bridge is running in local mode. Run /p2c-setup without `local` so ChatGPT can reach the MCP endpoint.");
        }
        state = {
          taskId: createTaskId(),
          workspaceName: status.workspaceName ?? path.basename(ctx.cwd),
          goal,
          iteration: 0,
          phase: "PLANNING",
        };
        saveWorkflow(pi, ctx, state);
        const reply = await manualRound(ctx, "ChatGPT planning round", buildPlanRequest(state));
        parseControlReply(reply, state, ["PLAN"]);
        state.plan = extractSection(reply, "PLAN");
        delete state.error;
        setPhase(pi, ctx, state, "PLAN_READY");

        const approvalMode = await resolveApprovalMode(pi, ctx);
        if (approvalMode === "auto") {
          ctx.ui.notify("Approval mode is auto; starting Pi execution.", "info");
          await approvePlan(pi, ctx, state);
          return;
        }

        const approved = ctx.ui.confirm
          ? await ctx.ui.confirm("Execute ChatGPT plan?", `Task ${state.taskId} is ready for Pi execution.`)
          : false;
        if (!approved) {
          ctx.ui.notify("Plan captured but not executed. Run /p2c-approve when ready, or /p2c-stop to cancel.", "warning");
          return;
        }
        await approvePlan(pi, ctx, state);
      } catch (error) {
        if (state) markWorkflowError(pi, ctx, state, error);
        ctx.ui.notify(`p2c workflow failed: ${(error as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("p2c-approve", {
    description: "Approve the captured ChatGPT plan and start Pi execution",
    handler: async (_args, ctx) => {
      let state: WorkflowState | undefined;
      try {
        state = requireWorkflow(ctx.cwd, "PLAN_READY");
        await approvePlan(pi, ctx, state);
      } catch (error) {
        if (state) markWorkflowError(pi, ctx, state, error);
        ctx.ui.notify(`p2c approve failed: ${(error as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("p2c-review", {
    description: "Send the completed Pi iteration to ChatGPT for MCP-based review",
    handler: async (_args, ctx) => {
      try {
        const state = requireWorkflow(ctx.cwd, "REVIEWING");
        const reply = await manualRound(ctx, "ChatGPT review round", buildReviewRequest(state));
        const reviewState = parseControlReply(reply, state, ["FIX", "DONE"]);
        state.lastReview = reply;
        delete state.error;
        if (reviewState === "DONE") {
          setPhase(pi, ctx, state, "DONE");
          ctx.ui.notify(`Pi with ChatGPT task ${state.taskId} is DONE.`, "info");
          return;
        }
        if (state.iteration + 1 >= MAX_EXECUTION_ITERATIONS) {
          state.error = `Reached the maximum of ${MAX_EXECUTION_ITERATIONS} execution iterations.`;
          setPhase(pi, ctx, state, "BLOCKED");
          ctx.ui.notify(
            `ChatGPT requested another fix, but task ${state.taskId} reached the ${MAX_EXECUTION_ITERATIONS}-iteration safety limit. Start a new task or stop this workflow.`,
            "warning"
          );
          return;
        }
        state.iteration += 1;
        setPhase(pi, ctx, state, "FIXING");
        await dispatchPiExecution(pi, ctx, state, extractSection(reply, "FIX"));
      } catch (error) {
        const state = workflowByWorkspace.get(ctx.cwd);
        if (state && state.phase === "REVIEWING") {
          state.error = (error as Error).message;
          saveWorkflow(pi, ctx, state);
        }
        ctx.ui.notify(`p2c review failed: ${(error as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("p2c-stop", {
    description: "Stop the active Pi with ChatGPT workflow (does not stop the bridge)",
    handler: async (_args, ctx) => {
      const state = workflowByWorkspace.get(ctx.cwd);
      workflowByWorkspace.delete(ctx.cwd);
      executionByWorkspace.delete(ctx.cwd);
      setWorkflowStatus(ctx);
      persistWorkflow(pi, ctx, null);
      ctx.ui.notify(state ? `Stopped workflow ${state.taskId}.` : "No active Pi with ChatGPT workflow.", "info");
    },
  });

  pi.registerCommand("p2c-mode", {
    description: "Get or set plan approval mode: plan or auto",
    handler: async (args, ctx) => {
      const mode = args.trim().toLowerCase();
      if (mode && mode !== "plan" && mode !== "auto") {
        ctx.ui.notify("Usage: /p2c-mode [plan|auto]", "warning");
        return;
      }
      try {
        const result = await runP2c<ApprovalModeResult>(
          pi,
          ctx,
          ["config", "approval-mode", ...(mode ? [mode] : [])]
        );
        ctx.ui.notify(
          `Plan approval mode: ${result.approvalMode}${result.stored ? "" : " (default)"}.`,
          "info"
        );
      } catch (error) {
        ctx.ui.notify(`p2c mode failed: ${(error as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("p2c-status", {
    description: "Show Pi with ChatGPT bridge and workflow status for this project",
    handler: async (_args, ctx) => {
      try {
        const status = await runP2c<StatusResult>(pi, ctx, ["status"]);
        const workflow = workflowByWorkspace.get(ctx.cwd);
        if (!status.running) {
          ctx.ui.notify("Pi with ChatGPT bridge is not running. Run /p2c-setup.", "warning");
        } else {
          const remote = status.publicUrl ? ` · ${status.publicUrl}/mcp` : " · local mode";
          ctx.ui.notify(
            `Pi with ChatGPT: ${status.workspaceName ?? "workspace"} · port ${status.port ?? "?"}${remote}`,
            "info"
          );
        }
        if (workflow) {
          ctx.ui.notify(`Workflow: ${workflowLabel(workflow)}${workflow.error ? ` · ${workflow.error}` : ""}`, "info");
        } else {
          ctx.ui.notify("Workflow: IDLE", "info");
        }
      } catch (error) {
        ctx.ui.notify(`p2c status failed: ${(error as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("p2c-setup", {
    description: "Start the bridge and create a ChatGPT pairing code; pass 'local' to skip the tunnel",
    handler: async (args, ctx) => {
      const localOnly = /(^|\s)(local|--local)(\s|$)/i.test(args.trim());
      try {
        ctx.ui.notify("Starting Pi with ChatGPT…", "info");
        const setup = await runP2c<SetupResult>(
          pi,
          ctx,
          ["setup", ...(localOnly ? ["--no-tunnel"] : [])],
          120_000
        );
        if (!setup.ok) throw new Error(setup.error ?? "setup failed");
        ctx.ui.notify(`Connection: ${setup.mcpUrl ?? "unknown"}`, "info");
        if (setup.pairingCode) {
          ctx.ui.notify(`Pairing code: ${setup.pairingCode}`, "info");
        }
        ctx.ui.notify(
          setup.local
            ? "Local setup is ready. Use /p2c-setup without 'local' when you want a ChatGPT-accessible tunnel."
            : `Connector ready: ${setup.connectorName ?? "Pi with ChatGPT"}`,
          "info"
        );
      } catch (error) {
        ctx.ui.notify(`p2c setup failed: ${(error as Error).message}`, "error");
      }
    },
  });
}
