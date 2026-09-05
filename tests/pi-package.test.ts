import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import registerPiWithChatGPT from "../extensions/index.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let harnessIndex = 0;

interface HarnessOptions {
  reviewReply?: "DONE" | "FIX";
  approvalMode?: "plan" | "auto";
  cwd?: string;
  initialEntries?: Array<{ type: string; customType: string; data: unknown }>;
}

function createHarness(options: HarnessOptions = {}) {
  const commands: Record<string, { handler(args: string, ctx: any): Promise<void> | void }> = {};
  const handlers: Record<string, Array<(event: any, ctx: any) => any>> = {};
  const notifications: Array<{ message: string; level?: string }> = [];
  const sentMessages: string[] = [];
  const sessionEntries = [...(options.initialEntries ?? [])];
  const reviewReply = options.reviewReply ?? "DONE";
  const approvalMode = options.approvalMode ?? "plan";
  const cwd = options.cwd ?? `/workspace/demo-${++harnessIndex}`;
  const exec = vi.fn(async (command: string, args: string[]) => {
    if (command === "git") {
      return {
        code: 0,
        stdout: "1 .M N... 100644 100644 100644 abc def src/a.ts\0? src/new.ts\0",
        stderr: "",
      };
    }
    if (args.includes("record")) {
      return { code: 0, stdout: "✓ 已记录执行摘要\n", stderr: "" };
    }
    if (args.includes("status")) {
      return {
        code: 0,
        stdout:
          JSON.stringify({
            ok: true,
            running: true,
            workspaceName: "demo",
            port: 48765,
            publicUrl: "https://demo.example.test",
          }) + "\n",
        stderr: "",
      };
    }
    if (args.includes("config") && args.includes("approval-mode")) {
      const modeIndex = args.indexOf("approval-mode") + 1;
      const requested = args[modeIndex] && !args[modeIndex].startsWith("--") ? args[modeIndex] : undefined;
      return {
        code: 0,
        stdout:
          JSON.stringify({
            ok: true,
            approvalMode: requested === "auto" || requested === "plan" ? requested : approvalMode,
            stored: requested ? true : approvalMode !== "plan",
          }) + "\n",
        stderr: "",
      };
    }
    return {
      code: 0,
      stdout:
        JSON.stringify({
          ok: true,
          workspaceName: "demo",
          connectorName: "Pi with ChatGPT · demo",
          mcpUrl: "http://127.0.0.1:48765/mcp",
          local: true,
          pairingCode: "ABC-123",
        }) + "\n",
      stderr: "",
    };
  });
  const editor = vi.fn(async (title: string, prefilled: string) => {
    const taskId = prefilled.match(/^TASK_ID:\s*(\S+)$/m)?.[1] ?? "unknown";
    const iteration = prefilled.match(/^ITERATION:\s*(\d+)$/m)?.[1] ?? "0";
    if (title.includes("planning")) {
      return `[P2C]\nSTATE: PLAN\nTASK_ID: ${taskId}\nITERATION: ${iteration}\n\nPLAN:\n1. Edit the implementation.\n2. Run tests.`;
    }
    if (reviewReply === "FIX") {
      return `[P2C]\nSTATE: FIX\nTASK_ID: ${taskId}\nITERATION: ${iteration}\n\nFIX:\nAddress the failing edge case and rerun tests.`;
    }
    return `[P2C]\nSTATE: DONE\nTASK_ID: ${taskId}\nITERATION: ${iteration}\n\nSUMMARY:\nImplementation and tests look good.`;
  });
  const confirm = vi.fn(async () => true);
  const ctx = {
    cwd,
    sessionManager: {
      getBranch() {
        return sessionEntries;
      },
    },
    ui: {
      notify(message: string, level?: string) {
        notifications.push({ message, level });
      },
      editor,
      confirm,
      setStatus: vi.fn(),
    },
  };

  registerPiWithChatGPT({
    exec,
    registerCommand(name: string, opts: { handler(args: string, ctx: any): Promise<void> | void }) {
      commands[name] = opts;
    },
    on(name: string, handler: (event: any, ctx: any) => any) {
      handlers[name] ??= [];
      handlers[name].push(handler);
    },
    async sendUserMessage(message: string) {
      sentMessages.push(message);
    },
    appendEntry(customType: string, data: unknown) {
      sessionEntries.push({ type: "custom", customType, data });
    },
  } as any);

  return { commands, handlers, notifications, sentMessages, sessionEntries, exec, editor, confirm, ctx };
}

describe("Pi package manifest", () => {
  it("declares extension and skill resources", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")) as {
      keywords?: string[];
      pi?: { extensions?: string[]; skills?: string[] };
    };

    expect(pkg.keywords).toContain("pi-package");
    expect(pkg.pi?.extensions).toContain("./extensions");
    expect(pkg.pi?.skills).toContain("./skills");
  });
});

describe("Pi extension commands", () => {
  it("registers workflow, status, setup, approval, review, and stop commands", () => {
    const { commands } = createHarness();
    expect(Object.keys(commands).sort()).toEqual([
      "p2c",
      "p2c-approve",
      "p2c-mode",
      "p2c-review",
      "p2c-setup",
      "p2c-status",
      "p2c-stop",
    ]);
  });

  it("routes bridge status/setup through the package-local CLI", async () => {
    const { commands, notifications, exec, ctx } = createHarness();

    await commands["p2c-status"].handler("", ctx);
    await commands["p2c-setup"].handler("local", ctx);

    expect(exec).toHaveBeenCalledTimes(2);
    const statusArgs = exec.mock.calls[0][1];
    expect(statusArgs[0]).toMatch(/bin[\\/]p2c\.js$/);
    expect(statusArgs).toEqual(expect.arrayContaining(["status", "--workspace", ctx.cwd, "--json"]));

    const setupArgs = exec.mock.calls[1][1];
    expect(setupArgs).toEqual(
      expect.arrayContaining(["setup", "--no-tunnel", "--workspace", ctx.cwd, "--json"])
    );
    expect(notifications.some((item) => item.message.includes("Pairing code: ABC-123"))).toBe(true);
  });

  it("gets and sets approval mode through the package-local CLI", async () => {
    const { commands, notifications, exec, ctx } = createHarness();

    await commands["p2c-mode"].handler("", ctx);
    await commands["p2c-mode"].handler("auto", ctx);

    const configCalls = exec.mock.calls.filter((call) => call[1].includes("approval-mode"));
    expect(configCalls).toHaveLength(2);
    expect(configCalls[0][1]).toEqual(
      expect.arrayContaining(["config", "approval-mode", "--workspace", ctx.cwd, "--json"])
    );
    expect(configCalls[1][1]).toEqual(
      expect.arrayContaining(["config", "approval-mode", "auto", "--workspace", ctx.cwd, "--json"])
    );
    expect(notifications.some((item) => item.message.includes("Plan approval mode: auto"))).toBe(true);
  });

  it("auto approval starts Pi execution without prompting", async () => {
    const { commands, sentMessages, confirm, ctx } = createHarness({ approvalMode: "auto" });

    await commands["p2c"].handler("Execute automatically after planning", ctx);

    expect(confirm).not.toHaveBeenCalled();
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toContain("Execute the approved ChatGPT instructions");
  });

  it("runs PLAN → EXECUTING → REVIEWING → DONE, records evidence, and gates review mutations", async () => {
    const { commands, handlers, sentMessages, editor, exec, sessionEntries, ctx } = createHarness();

    await commands["p2c"].handler("Implement manual workflow orchestration", ctx);
    expect(editor).toHaveBeenCalledTimes(1);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toContain("CHATGPT INSTRUCTIONS");
    expect(sentMessages[0]).toContain("Edit the implementation");
    expect(sentMessages[0]).toContain("records execution evidence automatically");

    const executingGate = await handlers.tool_call[0]({ toolName: "edit" }, ctx);
    expect(executingGate).toBeUndefined();

    await handlers.tool_result[0](
      { toolName: "bash", input: { command: "pnpm test" }, isError: false, content: [] },
      ctx
    );
    await handlers.agent_end[0]({}, ctx);

    const recordCall = exec.mock.calls.find((call) => call[1].includes("record"));
    expect(recordCall).toBeTruthy();
    expect(recordCall?.[1]).toEqual(
      expect.arrayContaining([
        "record",
        "--agent",
        "pi",
        "--changed-files",
        "2",
        "--tests",
        "passed (pnpm test)",
        "--exit-status",
        "ok",
      ])
    );
    expect(sessionEntries.some((entry) => (entry.data as any)?.state?.phase === "REVIEWING")).toBe(true);

    const reviewGate = await handlers.tool_call[0]({ toolName: "edit" }, ctx);
    expect(reviewGate).toMatchObject({ block: true });

    await commands["p2c-review"].handler("", ctx);
    expect(editor).toHaveBeenCalledTimes(2);
    expect(sentMessages).toHaveLength(1);

    const doneGate = await handlers.tool_call[0]({ toolName: "edit" }, ctx);
    expect(doneGate).toBeUndefined();
  });

  it("loops REVIEWING → FIXING → REVIEWING when ChatGPT asks for fixes", async () => {
    const { commands, handlers, sentMessages, ctx } = createHarness({ reviewReply: "FIX" });

    await commands["p2c"].handler("Implement a fix loop", ctx);
    await handlers.agent_end[0]({}, ctx);
    await commands["p2c-review"].handler("", ctx);

    expect(sentMessages).toHaveLength(2);
    expect(sentMessages[1]).toContain("iteration 1");
    expect(sentMessages[1]).toContain("Address the failing edge case");

    const fixingGate = await handlers.tool_call[0]({ toolName: "bash" }, ctx);
    expect(fixingGate).toBeUndefined();

    await handlers.agent_end[0]({}, ctx);
    const secondReviewGate = await handlers.tool_call[0]({ toolName: "write" }, ctx);
    expect(secondReviewGate).toMatchObject({ block: true });
  });

  it("restores an active workflow from Pi session entries after reload", async () => {
    const cwd = "/workspace/restored";
    const initialEntries = [
      {
        type: "custom",
        customType: "p2c-workflow-v1",
        data: {
          cwd,
          state: {
            taskId: "p2c_restore",
            workspaceName: "restored",
            goal: "Restore me",
            iteration: 1,
            phase: "REVIEWING",
            plan: "Implement it",
          },
        },
      },
    ];
    const { commands, handlers, notifications, ctx } = createHarness({ cwd, initialEntries });

    await handlers.session_start[0]({}, ctx);
    const gate = await handlers.tool_call[0]({ toolName: "edit" }, ctx);
    expect(gate).toMatchObject({ block: true });

    await commands["p2c-status"].handler("", ctx);
    expect(notifications.some((item) => item.message.includes("Restored Pi with ChatGPT workflow"))).toBe(true);
    expect(notifications.some((item) => item.message.includes("Workflow: REVIEWING · p2c_restore"))).toBe(true);
  });

  it("stops after the configured execution-iteration safety limit", async () => {
    const cwd = "/workspace/max-iterations";
    const initialEntries = [
      {
        type: "custom",
        customType: "p2c-workflow-v1",
        data: {
          cwd,
          state: {
            taskId: "p2c_max",
            workspaceName: "max",
            goal: "Do not loop forever",
            iteration: 2,
            phase: "REVIEWING",
            plan: "Initial plan",
          },
        },
      },
    ];
    const { commands, handlers, notifications, sentMessages, ctx } = createHarness({
      cwd,
      initialEntries,
      reviewReply: "FIX",
    });

    await handlers.session_start[0]({}, ctx);
    await commands["p2c-review"].handler("", ctx);

    expect(sentMessages).toHaveLength(0);
    expect(notifications.some((item) => item.message.includes("3-iteration safety limit"))).toBe(true);
  });
});
