import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import registerPiWithChatGPT from "../extensions/pi-with-chatgpt/index.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("Pi package manifest", () => {
  it("declares extension and skill resources", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")) as {
      keywords?: string[];
      pi?: { extensions?: string[]; skills?: string[] };
    };

    expect(pkg.keywords).toContain("pi-package");
    expect(pkg.pi?.extensions).toContain("./extensions/pi-with-chatgpt/index.ts");
    expect(pkg.pi?.skills).toContain("./skills");
  });
});

describe("Pi extension commands", () => {
  it("registers workflow/setup/status/stop commands and routes setup/status through the package CLI", async () => {
    const commands: Record<string, { handler(args: string, ctx: any): Promise<void> | void }> = {};
    const notifications: Array<{ message: string; level?: string }> = [];
    const exec = vi.fn(async (_command: string, args: string[]) => {
      if (args.includes("status")) {
        return {
          code: 0,
          stdout: JSON.stringify({ ok: true, running: true, workspaceName: "demo", port: 48765, publicUrl: null }) + "\n",
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

    registerPiWithChatGPT({
      exec,
      registerCommand(name: string, options: { handler(args: string, ctx: any): Promise<void> | void }) {
        commands[name] = options;
      },
      on: vi.fn(),
      sendUserMessage: vi.fn(),
    } as any);

    expect(Object.keys(commands).sort()).toEqual(["p2c", "p2c-setup", "p2c-status", "p2c-stop"]);

    const ctx = {
      cwd: "/workspace/demo",
      hasUI: true,
      ui: {
        notify(message: string, level?: string) {
          notifications.push({ message, level });
        },
        editor: vi.fn(),
      },
    };

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
});
