import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "./api.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const p2cBin = path.join(packageRoot, "bin", "p2c.js");

export interface WorkspaceResult {
  workspaceId: string;
  name: string;
  root: string;
}

export interface StatusResult {
  ok: boolean;
  running: boolean;
  workspaceId?: string;
  workspaceName?: string;
  port?: number;
  publicUrl?: string | null;
  tokenCount?: number;
}

export interface SetupResult {
  ok: boolean;
  error?: string;
  workspaceName?: string;
  connectorName?: string;
  mcpUrl?: string;
  local?: boolean;
  pairingCode?: string;
  pairingExpiresAt?: number;
}

export async function runP2cJson<T>(
  pi: ExtensionAPI,
  cwd: string,
  args: string[],
  options: { signal?: AbortSignal; timeout?: number } = {}
): Promise<T> {
  const result = await pi.exec(
    process.execPath,
    [p2cBin, ...args, "--workspace", cwd, "--json"],
    { cwd, signal: options.signal, timeout: options.timeout ?? 30_000 }
  );
  if (result.code !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `p2c exited with code ${result.code}`;
    throw new Error(message);
  }
  return parseLastJson<T>(result.stdout);
}

export async function runP2cRaw(
  pi: ExtensionAPI,
  cwd: string,
  args: string[],
  options: { signal?: AbortSignal; timeout?: number } = {}
): Promise<string> {
  const result = await pi.exec(process.execPath, [p2cBin, ...args, "--workspace", cwd], {
    cwd,
    signal: options.signal,
    timeout: options.timeout ?? 30_000,
  });
  if (result.code !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `p2c exited with code ${result.code}`;
    throw new Error(message);
  }
  return result.stdout;
}

function parseLastJson<T>(stdout: string): T {
  const line = stdout.trim().split("\n").filter(Boolean).at(-1);
  if (!line) throw new Error("p2c returned no JSON output");
  return JSON.parse(line) as T;
}
