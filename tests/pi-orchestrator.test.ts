import { describe, expect, it, vi } from "vitest";
import { parseControlMessage } from "../src/control/types.js";
import { PiWithChatGptOrchestrator } from "../extensions/pi-with-chatgpt/orchestrator.js";

describe("PiWithChatGptOrchestrator", () => {
  it("closes PLAN -> Pi execution -> REVIEW -> DONE through ManualTransport", async () => {
    const sentUserMessages: string[] = [];
    const notifications: string[] = [];
    let editorRound = 0;

    const pi = {
      exec: vi.fn(async (command: string, args: string[]) => {
        if (command === "git") {
          return { code: 0, stdout: " M src/a.ts\n?? tests/a.test.ts\n", stderr: "" };
        }
        if (args.includes("status")) {
          return {
            code: 0,
            stdout:
              JSON.stringify({
                ok: true,
                running: true,
                workspaceId: "ws1",
                workspaceName: "demo",
                port: 48765,
                publicUrl: "https://demo.example",
                tokenCount: 1,
              }) + "\n",
            stderr: "",
          };
        }
        if (args.includes("workspace")) {
          return {
            code: 0,
            stdout: JSON.stringify({ workspaceId: "ws1", name: "demo", root: "/workspace/demo" }) + "\n",
            stderr: "",
          };
        }
        if (args.includes("record")) {
          return { code: 0, stdout: "recorded\n", stderr: "" };
        }
        throw new Error(`Unexpected exec: ${command} ${args.join(" ")}`);
      }),
      registerCommand: vi.fn(),
      on: vi.fn(),
      sendUserMessage: vi.fn((content: string) => {
        sentUserMessages.push(content);
      }),
    };

    const ctx = {
      cwd: "/workspace/demo",
      hasUI: true,
      ui: {
        notify(message: string) {
          notifications.push(message);
        },
        async editor(_title: string, initialText?: string) {
          const outbound = parseControlMessage(initialText ?? "");
          editorRound += 1;
          if (editorRound === 1) {
            expect(outbound.state).toBe("INIT");
            return [
              "[P2C]",
              "STATE: PLAN",
              `TASK_ID: ${outbound.taskId}`,
              `ITERATION: ${outbound.iteration}`,
              "",
              "PLAN:",
              "1. Add validation",
              "2. Add tests",
            ].join("\n");
          }
          expect(outbound.state).toBe("EXECUTED");
          expect(outbound.body).not.toContain("src/a.ts");
          return [
            "[P2C]",
            "STATE: DONE",
            `TASK_ID: ${outbound.taskId}`,
            `ITERATION: ${outbound.iteration}`,
            "",
            "REVIEW:",
            "Validation and tests pass review.",
          ].join("\n");
        },
      },
    };

    const orchestrator = new PiWithChatGptOrchestrator(pi as any);
    await orchestrator.start("Add argument validation and tests", ctx as any);

    expect(orchestrator.workflow.snapshot?.state).toBe("EXECUTING");
    expect(sentUserMessages).toHaveLength(1);
    expect(sentUserMessages[0]).toContain("ChatGPT plan:");
    expect(sentUserMessages[0]).toContain("Add validation");

    await orchestrator.onAgentSettled(ctx as any);

    expect(orchestrator.workflow.snapshot).toMatchObject({ state: "DONE", iteration: 0 });
    expect(editorRound).toBe(2);
    expect(notifications.some((message) => message.includes("review passed"))).toBe(true);
    expect(pi.exec.mock.calls.some((call: any[]) => call[1]?.includes("record"))).toBe(true);
  });

  it("queues a FIX round when review returns PLAN", async () => {
    const sentUserMessages: string[] = [];
    let reviewCount = 0;
    const pi = {
      exec: vi.fn(async (command: string, args: string[]) => {
        if (command === "git") return { code: 0, stdout: " M src/a.ts\n", stderr: "" };
        if (args.includes("status")) {
          return {
            code: 0,
            stdout: JSON.stringify({ ok: true, running: true, publicUrl: "https://demo.example", tokenCount: 1 }) + "\n",
            stderr: "",
          };
        }
        if (args.includes("workspace")) {
          return { code: 0, stdout: JSON.stringify({ workspaceId: "ws1", name: "demo", root: "/workspace/demo" }) + "\n", stderr: "" };
        }
        if (args.includes("record")) return { code: 0, stdout: "ok\n", stderr: "" };
        throw new Error("unexpected exec");
      }),
      registerCommand: vi.fn(),
      on: vi.fn(),
      sendUserMessage: vi.fn((content: string) => sentUserMessages.push(content)),
    };
    const ctx = {
      cwd: "/workspace/demo",
      hasUI: true,
      ui: {
        notify: vi.fn(),
        async editor(_title: string, initialText?: string) {
          const outbound = parseControlMessage(initialText ?? "");
          if (outbound.state === "INIT") {
            return `[P2C]\nSTATE: PLAN\nTASK_ID: ${outbound.taskId}\nITERATION: 0\n\nPLAN:\nImplement the feature`;
          }
          reviewCount += 1;
          if (reviewCount === 1) {
            return `[P2C]\nSTATE: PLAN\nTASK_ID: ${outbound.taskId}\nITERATION: 0\n\nPLAN:\nFix the missing edge case`;
          }
          return `[P2C]\nSTATE: DONE\nTASK_ID: ${outbound.taskId}\nITERATION: 1\n\nREVIEW:\nDone`;
        },
      },
    };

    const orchestrator = new PiWithChatGptOrchestrator(pi as any);
    await orchestrator.start("Implement feature", ctx as any);
    await orchestrator.onAgentSettled(ctx as any);

    expect(orchestrator.workflow.snapshot).toMatchObject({ state: "FIXING", iteration: 1 });
    expect(sentUserMessages).toHaveLength(2);
    expect(sentUserMessages[1]).toContain("MODE: FIX");
    expect(sentUserMessages[1]).toContain("missing edge case");

    await orchestrator.onAgentSettled(ctx as any);
    expect(orchestrator.workflow.snapshot).toMatchObject({ state: "DONE", iteration: 1 });
  });
});
