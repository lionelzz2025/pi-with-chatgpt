import type { ControlMessage } from "../../src/control/types.js";
import type { ExtensionAPI, ExtensionContext } from "./api.js";
import { collectExecutionEvidence } from "./execution-collector.js";
import { createManualTransport } from "./manual-transport.js";
import { runP2cJson, type StatusResult, type WorkspaceResult } from "./core.js";
import { createTaskId, WorkflowStateMachine, type WorkflowState } from "./state.js";

export class PiWithChatGptOrchestrator {
  readonly workflow = new WorkflowStateMachine();
  private handlingSettled = false;

  constructor(private readonly pi: ExtensionAPI) {}

  async start(goalInput: string, ctx: ExtensionContext): Promise<void> {
    const goal = goalInput.trim();
    if (!goal) {
      ctx.ui.notify("Usage: /p2c <goal>", "warning");
      return;
    }
    if (!ctx.hasUI) {
      ctx.ui.notify("/p2c ManualTransport currently requires Pi interactive UI.", "error");
      return;
    }
    if (this.workflow.active) {
      const active = this.workflow.snapshot;
      ctx.ui.notify(`P2C task ${active?.taskId ?? "unknown"} is already ${active?.state ?? "active"}.`, "warning");
      return;
    }

    try {
      const status = await runP2cJson<StatusResult>(this.pi, ctx.cwd, ["status"], { signal: ctx.signal });
      if (!status.running) {
        ctx.ui.notify("Pi with ChatGPT bridge is not running. Run /p2c-setup first.", "warning");
        return;
      }
      if (!status.publicUrl) {
        ctx.ui.notify("ChatGPT needs a public bridge for review. Run /p2c-setup without 'local'.", "warning");
        return;
      }
      if ((status.tokenCount ?? 0) < 1) {
        ctx.ui.notify("No paired ChatGPT connector is authorized yet. Finish /p2c-setup pairing first.", "warning");
        return;
      }

      const workspace = await runP2cJson<WorkspaceResult>(this.pi, ctx.cwd, ["workspace"], { signal: ctx.signal });
      const task = this.workflow.begin({
        workspaceId: workspace.workspaceId,
        taskId: createTaskId(),
        goal,
        maxIterations: 3,
      });
      this.workflow.transition("PLANNING");
      ctx.ui.notify(`Planning with ChatGPT · ${task.taskId}`, "info");

      const planReply = await this.exchange(ctx, {
        protocol: "P2C",
        state: "INIT",
        taskId: task.taskId,
        iteration: 0,
        body: buildInitBody(goal),
      }, ["PLAN", "BLOCKED"]);

      if (planReply.state === "BLOCKED") {
        this.workflow.block(planReply.body ?? "ChatGPT blocked the task");
        ctx.ui.notify(`ChatGPT blocked the task: ${planReply.body ?? "no reason provided"}`, "warning");
        return;
      }

      this.workflow.acceptPlan(planReply.body ?? "");
      this.workflow.startExecution();
      ctx.ui.notify("ChatGPT plan received. Pi is executing…", "info");
      this.queueExecution(this.workflow.snapshot!);
    } catch (error) {
      this.failWorkflow(error, ctx);
    }
  }

  async onAgentSettled(ctx: ExtensionContext): Promise<void> {
    const state = this.workflow.snapshot;
    if (!state || (state.state !== "EXECUTING" && state.state !== "FIXING")) return;
    if (this.handlingSettled) return;
    this.handlingSettled = true;

    try {
      const evidence = await collectExecutionEvidence(this.pi, ctx, {
        taskId: state.taskId,
        iteration: state.iteration,
      });
      this.workflow.startReview();
      ctx.ui.notify(`Reviewing with ChatGPT · iteration ${state.iteration}`, "info");

      const review = await this.exchange(ctx, {
        protocol: "P2C",
        state: "EXECUTED",
        taskId: state.taskId,
        iteration: state.iteration,
        body: buildExecutionBody(evidence.changedFiles, evidence.recordWritten),
      }, ["DONE", "PLAN", "BLOCKED"]);

      if (review.state === "DONE") {
        this.workflow.acceptReviewDone(review.body);
        ctx.ui.notify(`ChatGPT review passed · ${state.taskId}`, "info");
        return;
      }
      if (review.state === "BLOCKED") {
        this.workflow.block(review.body ?? "ChatGPT blocked the review");
        ctx.ui.notify(`Workflow blocked: ${review.body ?? "no reason provided"}`, "warning");
        return;
      }

      const next = this.workflow.acceptReviewPlan(review.body ?? "");
      if (next.state === "BLOCKED") {
        ctx.ui.notify(next.error ?? "Maximum P2C iterations reached.", "warning");
        return;
      }

      ctx.ui.notify(`ChatGPT requested fixes. Pi is fixing · iteration ${next.iteration}`, "info");
      this.queueExecution(next);
    } catch (error) {
      this.failWorkflow(error, ctx);
    } finally {
      this.handlingSettled = false;
    }
  }

  private async exchange(
    ctx: ExtensionContext,
    outbound: ControlMessage,
    expected: Array<"PLAN" | "DONE" | "BLOCKED">
  ) {
    const transport = createManualTransport(ctx);
    await transport.initialize();
    try {
      await transport.send(outbound);
      return await transport.waitForReply(outbound.taskId, expected);
    } finally {
      await transport.close();
    }
  }

  private queueExecution(state: WorkflowState): void {
    const prompt = buildPiExecutionPrompt(state);
    // Do not depend on the Promise forwarding behavior of individual Pi patch
    // versions. agent_settled is the authoritative completion signal.
    void Promise.resolve(this.pi.sendUserMessage(prompt, { deliverAs: "followUp" })).catch(() => undefined);
  }

  private failWorkflow(error: unknown, ctx: ExtensionContext): void {
    const message = error instanceof Error ? error.message : String(error);
    const state = this.workflow.snapshot;
    if (state && !["DONE", "BLOCKED", "ERROR"].includes(state.state)) {
      try {
        this.workflow.fail(error);
      } catch {
        // Preserve the original failure if a transition itself is invalid.
      }
    }
    ctx.ui.notify(`P2C workflow failed: ${message}`, "error");
  }
}

function buildInitBody(goal: string): string {
  return [
    goal,
    "",
    "CONTROL INSTRUCTIONS:",
    "Use the Pi with ChatGPT read-only connector to inspect the workspace as needed.",
    "Do not ask the user to paste source, diffs, or logs into chat.",
    "Return a small control reply with the same TASK_ID and ITERATION.",
    "Use STATE: PLAN with an actionable plan, or STATE: BLOCKED with a reason.",
  ].join("\n");
}

function buildExecutionBody(changedFiles: number, recordWritten: boolean): string {
  return [
    "Pi execution has settled.",
    `Changed-file entries reported by git status: ${changedFiles}.`,
    `Execution record written: ${recordWritten ? "yes" : "no"}.`,
    "Inspect git_status, git_diff, test_status, and execution_summary through MCP for the actual review evidence.",
    "Return STATE: DONE if the task is complete, STATE: PLAN with only the required fixes, or STATE: BLOCKED with a reason.",
  ].join("\n");
}

function buildPiExecutionPrompt(state: WorkflowState): string {
  return [
    "[P2C LOCAL EXECUTION]",
    `TASK_ID: ${state.taskId}`,
    `ITERATION: ${state.iteration}`,
    `MODE: ${state.state === "FIXING" ? "FIX" : "EXECUTE"}`,
    "",
    "ChatGPT plan:",
    state.plan ?? "",
    "",
    "Execute this plan in the current workspace. Inspect the repository yourself, make the required edits, and run relevant tests.",
    "Do not contact ChatGPT directly and do not wait for another plan. When your local work is complete, give a brief execution summary; the extension will request independent ChatGPT review after the agent settles.",
  ].join("\n");
}
