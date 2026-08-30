import { describe, expect, it } from "vitest";
import { WorkflowStateMachine, createTaskId } from "../extensions/pi-with-chatgpt/state.js";

describe("WorkflowStateMachine", () => {
  it("runs PLAN -> EXECUTE -> REVIEW -> DONE", () => {
    const machine = new WorkflowStateMachine();
    machine.begin({ workspaceId: "ws", taskId: "task", goal: "goal", maxIterations: 3 });
    machine.transition("PLANNING");
    machine.acceptPlan("implement validation");
    machine.startExecution();
    machine.startReview();
    machine.acceptReviewDone("review passed");

    expect(machine.snapshot).toMatchObject({ state: "DONE", iteration: 0, lastReview: "review passed" });
    expect(machine.active).toBe(false);
  });

  it("loops REVIEW PLAN through FIXING and enforces maxIterations", () => {
    const machine = new WorkflowStateMachine();
    machine.begin({ workspaceId: "ws", taskId: "task", goal: "goal", maxIterations: 2 });
    machine.transition("PLANNING");
    machine.acceptPlan("first plan");
    machine.startExecution();
    machine.startReview();

    const fixing = machine.acceptReviewPlan("fix edge case");
    expect(fixing).toMatchObject({ state: "FIXING", iteration: 1, plan: "fix edge case" });

    machine.startReview();
    const blocked = machine.acceptReviewPlan("another fix");
    expect(blocked.state).toBe("BLOCKED");
    expect(blocked.error).toContain("Maximum execution iterations reached (2)");
  });

  it("rejects invalid transitions", () => {
    const machine = new WorkflowStateMachine();
    machine.begin({ workspaceId: "ws", taskId: "task", goal: "goal" });
    expect(() => machine.startExecution()).toThrow("PREPARING -> EXECUTING");
  });

  it("creates compact task ids", () => {
    expect(createTaskId(1_700_000_000_000, 0.5)).toMatch(/^p2c_[a-z0-9]+_[a-z0-9]+$/);
  });
});
