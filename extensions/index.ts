import path from "node:path";
import { fileURLToPath } from "node:url";

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  killed?: boolean;
}

interface CommandContext {
  cwd: string;
  signal?: AbortSignal;
  ui: {
    notify(message: string, level?: "info" | "warning" | "error"): void;
  };
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
}

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const p2cBin = path.join(packageRoot, "bin", "p2c.js");

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

export default function piWithChatGPT(pi: ExtensionAPI): void {
  pi.registerCommand("p2c-status", {
    description: "Show Pi with ChatGPT bridge status for this project",
    handler: async (_args, ctx) => {
      try {
        const status = await runP2c<StatusResult>(pi, ctx, ["status"]);
        if (!status.running) {
          ctx.ui.notify("Pi with ChatGPT bridge is not running. Run /p2c-setup.", "warning");
          return;
        }
        const remote = status.publicUrl ? ` · ${status.publicUrl}/mcp` : " · local mode";
        ctx.ui.notify(
          `Pi with ChatGPT: ${status.workspaceName ?? "workspace"} · port ${status.port ?? "?"}${remote}`,
          "info"
        );
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
