import type { ExtensionAPI, ExtensionContext } from "./api.js";
import { runP2cRaw } from "./core.js";

export interface ExecutionEvidence {
  changedFiles: number;
  gitAvailable: boolean;
  recordWritten: boolean;
}

export async function collectExecutionEvidence(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  input: { taskId: string; iteration: number }
): Promise<ExecutionEvidence> {
  let changedFiles = 0;
  let gitAvailable = false;

  const status = await pi.exec("git", ["status", "--porcelain"], {
    cwd: ctx.cwd,
    signal: ctx.signal,
    timeout: 10_000,
  });
  if (status.code === 0) {
    gitAvailable = true;
    changedFiles = status.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
  }

  let recordWritten = false;
  try {
    await runP2cRaw(
      pi,
      ctx.cwd,
      [
        "record",
        "--task",
        input.taskId,
        "--iteration",
        String(input.iteration),
        "--agent",
        "pi",
        "--changed-files",
        String(changedFiles),
        "--exit-status",
        "settled",
        "--notes",
        "Pi agent settled; inspect git_diff, test_status, and execution_summary through MCP for review evidence.",
      ],
      { signal: ctx.signal }
    );
    recordWritten = true;
  } catch {
    // The review can still proceed through git_status/git_diff/test_status even
    // if writing the convenience execution record fails.
  }

  return { changedFiles, gitAvailable, recordWritten };
}
