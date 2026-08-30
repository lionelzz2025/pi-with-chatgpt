import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const PRODUCT_STATE_DIR = "pi-with-chatgpt";
const LEGACY_STATE_DIR = "codex-with-chatgpt";

export interface StateDirResolutionOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  existsSync?: (candidate: string) => boolean;
}

function defaultStateDir(name: string, opts: {
  env: NodeJS.ProcessEnv;
  home: string;
  platform: NodeJS.Platform;
}): string {
  const { env, home, platform } = opts;
  switch (platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", name);
    case "win32":
      return path.join(env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), name);
    default: {
      const base = env.XDG_STATE_HOME ?? path.join(home, ".local", "state");
      return path.join(base, name);
    }
  }
}

/**
 * Resolve persistent state without breaking existing C2C installations.
 *
 * Priority:
 * 1. P2C_STATE_DIR (new explicit override)
 * 2. C2C_STATE_DIR (legacy explicit override)
 * 3. Existing Pi state directory
 * 4. Existing legacy Codex state directory
 * 5. New Pi state directory
 *
 * Existing legacy installations therefore keep using their current state until
 * an explicit migration is introduced, while fresh installations start in the
 * Pi-named directory.
 */
export function resolveStateDir(options: StateDirResolutionOptions = {}): string {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const existsSync = options.existsSync ?? fs.existsSync;

  const p2cOverride = env.P2C_STATE_DIR?.trim();
  if (p2cOverride) return path.resolve(p2cOverride);

  const c2cOverride = env.C2C_STATE_DIR?.trim();
  if (c2cOverride) return path.resolve(c2cOverride);

  const current = defaultStateDir(PRODUCT_STATE_DIR, { env, home, platform });
  const legacy = defaultStateDir(LEGACY_STATE_DIR, { env, home, platform });
  if (existsSync(current)) return current;
  if (existsSync(legacy)) return legacy;
  return current;
}

export function getStateDir(): string {
  return resolveStateDir();
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function stateSubdir(name: string): string {
  return ensureDir(path.join(getStateDir(), name));
}

/** Write a JSON file with owner-only permissions. */
export function writeSecureJson(file: string, data: unknown): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best effort on platforms without chmod semantics
  }
}

export function readJsonIfExists<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export const DEFAULT_PORT = 48765;
export const DEFAULT_HOST = "127.0.0.1";
