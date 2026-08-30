export type WorkflowPhase =
  | "IDLE"
  | "PREPARING"
  | "PLANNING"
  | "PLAN_READY"
  | "EXECUTING"
  | "REVIEWING"
  | "FIXING"
  | "DONE"
  | "BLOCKED"
  | "ERROR";

export interface WorkflowState {
  workspaceId: string;
  taskId: string;
  iteration: number;
  state: WorkflowPhase;
  goal: string;
  plan?: string;
  lastReview?: string;
  maxIterations: number;
  error?: string;
}

const ALLOWED: Record<WorkflowPhase, WorkflowPhase[]> = {
  IDLE: ["PREPARING"],
  PREPARING: ["PLANNING", "ERROR"],
  PLANNING: ["PLAN_READY", "BLOCKED", "ERROR"],
  PLAN_READY: ["EXECUTING", "ERROR"],
  EXECUTING: ["REVIEWING", "ERROR"],
  REVIEWING: ["DONE", "FIXING", "BLOCKED", "ERROR"],
  FIXING: ["REVIEWING", "ERROR"],
  DONE: ["PREPARING"],
  BLOCKED: ["PREPARING"],
  ERROR: ["PREPARING"],
};

export class WorkflowStateMachine {
  private current: WorkflowState | null = null;

  get snapshot(): WorkflowState | null {
    return this.current ? { ...this.current } : null;
  }

  get active(): boolean {
    return Boolean(this.current && !["DONE", "BLOCKED", "ERROR"].includes(this.current.state));
  }

  begin(input: {
    workspaceId: string;
    taskId: string;
    goal: string;
    maxIterations?: number;
  }): WorkflowState {
    if (this.active) throw new Error(`Workflow ${this.current?.taskId} is already active`);
    const maxIterations = input.maxIterations ?? 3;
    if (!Number.isInteger(maxIterations) || maxIterations < 1) {
      throw new Error("maxIterations must be a positive integer");
    }
    this.current = {
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      iteration: 0,
      state: "PREPARING",
      goal: input.goal.trim(),
      maxIterations,
    };
    return this.snapshot!;
  }

  transition(next: WorkflowPhase, patch: Partial<Omit<WorkflowState, "state">> = {}): WorkflowState {
    if (!this.current) throw new Error("No workflow has been started");
    if (!ALLOWED[this.current.state].includes(next)) {
      throw new Error(`Invalid workflow transition ${this.current.state} -> ${next}`);
    }
    this.current = { ...this.current, ...patch, state: next };
    return this.snapshot!;
  }

  acceptPlan(plan: string): WorkflowState {
    if (!plan.trim()) throw new Error("ChatGPT PLAN is empty");
    return this.transition("PLAN_READY", { plan: plan.trim() });
  }

  startExecution(): WorkflowState {
    return this.transition("EXECUTING");
  }

  startReview(): WorkflowState {
    const state = this.requireCurrent();
    if (state.state !== "EXECUTING" && state.state !== "FIXING") {
      throw new Error(`Cannot review from ${state.state}`);
    }
    return this.transition("REVIEWING");
  }

  acceptReviewDone(review?: string): WorkflowState {
    return this.transition("DONE", { lastReview: review?.trim() || undefined });
  }

  acceptReviewPlan(plan: string): WorkflowState {
    const state = this.requireCurrent();
    if (state.state !== "REVIEWING") throw new Error(`Cannot accept review PLAN from ${state.state}`);
    if (!plan.trim()) throw new Error("ChatGPT review PLAN is empty");
    if (state.iteration + 1 >= state.maxIterations) {
      return this.transition("BLOCKED", {
        lastReview: plan.trim(),
        error: `Maximum execution iterations reached (${state.maxIterations})`,
      });
    }
    return this.transition("FIXING", {
      iteration: state.iteration + 1,
      plan: plan.trim(),
      lastReview: plan.trim(),
    });
  }

  block(reason: string): WorkflowState {
    return this.transition("BLOCKED", { error: reason.trim() || "Blocked" });
  }

  fail(error: unknown): WorkflowState {
    const message = error instanceof Error ? error.message : String(error);
    return this.transition("ERROR", { error: message });
  }

  private requireCurrent(): WorkflowState {
    if (!this.current) throw new Error("No workflow has been started");
    return this.current;
  }
}

export function createTaskId(now = Date.now(), random = Math.random()): string {
  const time = now.toString(36);
  const entropy = Math.floor(random * 0xffffff).toString(36).padStart(4, "0");
  return `p2c_${time}_${entropy}`;
}
