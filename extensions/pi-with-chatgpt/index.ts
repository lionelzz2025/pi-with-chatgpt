import type { ExtensionAPI } from "./api.js";
import { runP2cJson, runP2cRaw, type SetupResult, type StatusResult } from "./core.js";
import { PiWithChatGptOrchestrator } from "./orchestrator.js";

export default function piWithChatGPT(pi: ExtensionAPI): void {
  const orchestrator = new PiWithChatGptOrchestrator(pi);

  pi.registerCommand("p2c", {
    description: "Ask ChatGPT to plan, let Pi execute, then return to ChatGPT for independent review",
    handler: async (args, ctx) => orchestrator.start(args, ctx),
  });

  pi.registerCommand("p2c-status", {
    description: "Show Pi with ChatGPT bridge and workflow status for this project",
    handler: async (_args, ctx) => {
      try {
        const status = await runP2cJson<StatusResult>(pi, ctx.cwd, ["status"], { signal: ctx.signal });
        const workflow = orchestrator.workflow.snapshot;
        if (!status.running) {
          ctx.ui.notify(
            `Pi with ChatGPT bridge is not running.${workflow ? ` Workflow: ${workflow.state}.` : ""} Run /p2c-setup.`,
            "warning"
          );
          return;
        }
        const remote = status.publicUrl ? ` · ${status.publicUrl}/mcp` : " · local mode";
        const workflowText = workflow ? ` · workflow ${workflow.state} (${workflow.taskId})` : "";
        ctx.ui.notify(
          `Pi with ChatGPT: ${status.workspaceName ?? "workspace"} · port ${status.port ?? "?"}${remote}${workflowText}`,
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
        const setup = await runP2cJson<SetupResult>(
          pi,
          ctx.cwd,
          ["setup", ...(localOnly ? ["--no-tunnel"] : [])],
          { signal: ctx.signal, timeout: 120_000 }
        );
        if (!setup.ok) throw new Error(setup.error ?? "setup failed");
        ctx.ui.notify(`Connection: ${setup.mcpUrl ?? "unknown"}`, "info");
        if (setup.pairingCode) ctx.ui.notify(`Pairing code: ${setup.pairingCode}`, "info");
        ctx.ui.notify(
          setup.local
            ? "Local setup is ready. Use /p2c-setup without 'local' before a ChatGPT review workflow."
            : `Connector ready: ${setup.connectorName ?? "Pi with ChatGPT"}`,
          "info"
        );
      } catch (error) {
        ctx.ui.notify(`p2c setup failed: ${(error as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("p2c-stop", {
    description: "Stop the Pi with ChatGPT bridge for this project",
    handler: async (_args, ctx) => {
      try {
        await runP2cRaw(pi, ctx.cwd, ["stop"], { signal: ctx.signal });
        ctx.ui.notify("Pi with ChatGPT bridge stopped.", "info");
      } catch (error) {
        ctx.ui.notify(`p2c stop failed: ${(error as Error).message}`, "error");
      }
    },
  });

  pi.on("agent_settled", async (_event, ctx) => {
    await orchestrator.onAgentSettled(ctx);
  });
}
