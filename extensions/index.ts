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

interface CommandContext {
  cwd: string;
  signal?: AbortSignal;
  hasUI?: boolean;
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

interface ExtensionAPI {
  exec(
    command: string,
    args: string[],
    options?: { signal?: AbortSignal; timeout?: number }
  ): Promise<ExecResult>;
  registerCommand(
    name: string,
    options: {
      description?: string;
      handler(args: string, ctx: CommandContext): void | Promise<void>;
    }
  ): void;
  on(
    event: "tool_call" | "agent_end",
    handler: (event: ToolCallEvent | unknown, ctx: CommandContext) => void | Promise<void> | { block: true; reason: string }
  ): void;
  sendUserMessage?(message: string, options?: { deliverAs?: "steer" | "followUp" | "nextTurn" }): void | Promise<void>;
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

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const p2cBin = path.join(packageRoot, "bin", "p2c.js");
const workflowByWorkspace = new Map<string, WorkflowState>();
const MUTATING_TOOLS = new Set(["bash", "write", "edit"]);
const MUTATING_PHASES = new Set<WorkflowPhase>(["EXECUTING", "FIXING"]);
const TERMINAL_PHASES = new Set<WorkflowPhase>(["IDLE", "DONE", "ERROR"]);

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

async function dispatchPiExecution(pi: ExtensionAPI, ctx: CommandContext, state: WorkflowState, instructions: string): Promise<void> {
  if (!pi.sendUserMessage) {
    throw new Error("This Pi runtime does not expose sendUserMessage; cannot start the execution turn.");
  }
  const recordCommand = `p2c record --task ${state.taskId} --iteration ${state.iteration} --agent pi --changed-files <count-or-comma-list> --tests <summary> --exit-status <ok|failed|blocked>`;
  await pi.sendUserMessage(
    `You are the Pi execution layer for Pi with ChatGPT task ${state.taskId}, iteration ${state.iteration}.\n\nExecute the approved ChatGPT instructions below. You may inspect files, edit the workspace, run commands, and run tests as needed. Stay within the current workspace. Do not paste source code, diffs, or raw logs into ChatGPT; the reviewer will inspect them through MCP.\n\nBefore finishing, record an execution summary when practical with:\n${recordCommand}\n\nCHATGPT INSTRUCTIONS:\n${instructions}`
  );
  ctx.ui.notify(`Pi execution started for ${state.taskId}.`, "info");
}

async function approvePlan(pi: ExtensionAPI, ctx: CommandContext, state: WorkflowState): Promise<void> {
  if (!state.plan) throw new Error("The workflow has no ChatGPT plan to execute.");
  state.phase = "EXECUTING";
  setWorkflowStatus(ctx, state);
  await dispatchPiExecution(pi, ctx, state, state.plan);
}

export default function piWithChatGPT(pi: ExtensionAPI): void {
  pi.on("tool_call", (event, ctx) => {
    const toolEvent = event as ToolCallEvent;
    const state = activeWorkflow(ctx.cwd);
    if (!state || !MUTATING_TOOLS.has(toolEvent.toolName) || MUTATING_PHASES.has(state.phase)) return;
    return {
      block: true,
      reason: `Pi with ChatGPT workflow ${state.taskId} is in ${state.phase}. Local mutation is only allowed during EXECUTING or FIXING.`,
    };
  });

  pi.on("agent_end", (_event, ctx) => {
    const state = workflowByWorkspace.get(ctx.cwd);
    if (!state || (state.phase !== "EXECUTING" && state.phase !== "FIXING")) return;
    state.phase = "REVIEWING";
    setWorkflowStatus(ctx, state);
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
      try {
        const status = await runP2c<StatusResult>(pi, ctx, ["status"]);
        if (!status.running) {
          throw new Error("Bridge is not running. Run /p2c-setup first so ChatGPT can inspect the workspace through MCP.");
        }
        if (!status.publicUrl) {
          throw new Error("Bridge is running in local mode. Run /p2c-setup without `local` so ChatGPT can reach the MCP endpoint.");
        }
        const state: WorkflowState = {
          taskId: createTaskId(),
          workspaceName: status.workspaceName ?? path.basename(ctx.cwd),
          goal,
          iteration: 0,
          phase: "PLANNING",
        };
        workflowByWorkspace.set(ctx.cwd, state);
        setWorkflowStatus(ctx, state);
        const reply = await manualRound(ctx, "ChatGPT planning round", buildPlanRequest(state));
        parseControlReply(reply, state, ["PLAN"]);
        state.plan = extractSection(reply, "PLAN");
        state.phase = "PLAN_READY";
        setWorkflowStatus(ctx, state);

        const approved = ctx.ui.confirm
          ? await ctx.ui.confirm("Execute ChatGPT plan?", `Task ${state.taskId} is ready for Pi execution.`)
          : false;
        if (!approved) {
          ctx.ui.notify("Plan captured but not executed. Run /p2c-approve when ready, or /p2c-stop to cancel.", "warning");
          return;
        }
        await approvePlan(pi, ctx, state);
      } catch (error) {
        const state = workflowByWorkspace.get(ctx.cwd);
        if (state) {
          state.phase = "ERROR";
          state.error = (error as Error).message;
          setWorkflowStatus(ctx, state);
        }
        ctx.ui.notify(`p2c workflow failed: ${(error as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("p2c-approve", {
    description: "Approve the captured ChatGPT plan and start Pi execution",
    handler: async (_args, ctx) => {
      try {
        const state = requireWorkflow(ctx.cwd, "PLAN_READY");
        await approvePlan(pi, ctx, state);
      } catch (error) {
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
        if (reviewState === "DONE") {
          state.phase = "DONE";
          setWorkflowStatus(ctx, state);
          ctx.ui.notify(`Pi with ChatGPT task ${state.taskId} is DONE.`, "info");
          return;
        }
        state.iteration += 1;
        state.phase = "FIXING";
        setWorkflowStatus(ctx, state);
        await dispatchPiExecution(pi, ctx, state, extractSection(reply, "FIX"));
      } catch (error) {
        const state = workflowByWorkspace.get(ctx.cwd);
        if (state && state.phase === "REVIEWING") {
          state.error = (error as Error).message;
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
      setWorkflowStatus(ctx);
      ctx.ui.notify(state ? `Stopped workflow ${state.taskId}.` : "No active Pi with ChatGPT workflow.", "info");
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
