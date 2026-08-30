import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, makeTmpDir } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(projectRoot, "bin", "p2c.js");
const cleanupDirs: string[] = [];

function runCli(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: projectRoot,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
}

function parseLastJson(stdout: string): Record<string, any> {
  const line = stdout.trim().split("\n").filter(Boolean).at(-1);
  if (!line) throw new Error("CLI returned no JSON output");
  return JSON.parse(line) as Record<string, any>;
}

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) cleanup(dir);
});

describe("p2c without Codex", () => {
  it("runs setup and doctor without creating a Codex config", () => {
    const root = makeTmpDir("p2c-cli");
    cleanupDirs.push(root);
    const workspace = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const codexHome = path.join(root, "codex-home");
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "package.json"), '{"name":"p2c-test"}\n');

    const env = {
      ...process.env,
      P2C_STATE_DIR: stateDir,
      C2C_STATE_DIR: "",
      CODEX_HOME: codexHome,
    };

    try {
      const setup = runCli(["setup", "--no-tunnel", "--json", "--workspace", workspace], env);
      expect(setup.status, setup.stderr || setup.stdout).toBe(0);
      const setupJson = parseLastJson(setup.stdout);
      expect(setupJson.ok).toBe(true);
      expect(setupJson.sandbox).toMatchObject({ ok: true, required: false, legacy: true });
      expect(fs.existsSync(path.join(codexHome, "config.toml"))).toBe(false);

      const doctor = runCli(["doctor", "--no-fix", "--json", "--workspace", workspace], env);
      expect(doctor.status, doctor.stderr || doctor.stdout).toBe(0);
      const doctorJson = parseLastJson(doctor.stdout);
      expect(doctorJson.report.sandbox.ok).toBe(true);
      expect(doctorJson.report.sandbox.detail).toContain("无需 Codex");
      expect(fs.existsSync(path.join(codexHome, "config.toml"))).toBe(false);
    } finally {
      runCli(["stop", "--workspace", workspace], env);
    }
  });
});
