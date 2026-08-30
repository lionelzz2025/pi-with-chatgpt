import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import registerPiWithChatGPT from "../extensions/index.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function createHarness(options?: { reviewReply?: "DONE" | "FIX" }) {
  const commands: Record<string, { handler(args: string, ctx: any): Promise<void> | void }> = {};
  const handlers: Record<string, Array<(event: any, ctx: any) => any>> = {};
  const notifications: Array<{ message: string; level?: string }> = [];
  const sentMessages: string[] = [];
  const reviewReply = options?.reviewReply ?? "DONE";
  const exec = vi.fn(async (_command: string, args: string[]) => {
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
    if (title.includes("planning")) {
      return `[P2C]\nSTATE: PLAN\nTASK_ID: ${taskId}\nITERATION: 0\n\nPLAN:\n1. Edit the implementation.\n2. Run tests.`;
    }
    if (reviewReply === "FIX") {
      return `[P2C]\nSTATE: FIX\nTASK_ID: ${taskId}\nITERATION: 0\n\nFIX:\nAddress the failing edge case and rerun tests.`;
    }
    return `[P2C]\nSTATE: DONE\nTASK_ID: ${taskId}\nITERATION: 0\n\nSUMMARY:\nImplementation and tests look good.`;
  });
  const confirm = vi.fn(async () => true);
  const ctx = {
    cwd: "/workspace/demo",
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
  } as any);

  return { commands, handlers, notifications, sentMessages, exec, editor, confirm, ctx };
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
    expect(statusArgs).toEqual(expect.arrayContaining(["status", "--workspace", "/workspace/demo", "--json"]));

    const setupArgs = exec.mock.calls[1][1];
    expect(setupArgs).toEqual(
      expect.arrayContaining(["setup", "--no-tunnel", "--workspace", "/workspace/demo", "--json"])
    );
    expect(notifications.some((item) => item.message.includes("Pairing code: ABC-123"))).toBe(true);
  });

  it("runs PLAN → EXECUTING → REVIEWING → DONE and gates local mutations during review", async () => {
    const { commands, handlers, sentMessages, editor, ctx } = createHarness();

    await commands["p2c"].handler("Implement manual workflow orchestration", ctx);
    expect(editor).toHaveBeenCalledTimes(1);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toContain("CHATGPT INSTRUCTIONS");
    expect(sentMessages[0]).toContain("Edit the implementation");

    const executingGate = await handlers.tool_call[0]({ toolName: "edit" }, ctx);
    expect(executingGate).toBeUndefined();

    await handlers.agent_end[0]({}, ctx);
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
});
