import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { collectLocalEvidence } from "../src/control/local-evidence.js";
import { appendExecutionRecord } from "../src/execution/records.js";
import { Workspace } from "../src/workspace/manager.js";

const dirs: string[] = [];
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.test", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.test" };
function git(root: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd: root, env: gitEnv, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "p2c-evidence-"));
  dirs.push(root);
  git(root, "init", "-b", "main");
  fs.writeFileSync(path.join(root, "README.md"), "Project orientation\n");
  fs.writeFileSync(path.join(root, "feature.ts"), "export const feature = 1;\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "init");
  return root;
}
function text(attachment: Awaited<ReturnType<typeof collectLocalEvidence>>) {
  return attachment.content.toString("utf8");
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    const result = spawnSync("python", ["-c", "import sys,send2trash;send2trash.send2trash(sys.argv[1])", dir]);
    if (result.status !== 0) throw new Error(`Could not move test fixture to recycle bin: ${dir}`);
  }
});

describe("local Pi evidence", () => {
  it("selects bounded workspace files and includes review diff and matching execution record", async () => {
    const root = fixture();
    fs.writeFileSync(path.join(root, "feature.ts"), "export const feature = 2;\n");
    const plan = await collectLocalEvidence(root, "Update feature", "plan");
    expect(plan.name).toBe("p2c-plan-evidence.md");
    expect(text(plan)).toContain("File: feature.ts");
    expect(text(plan)).toContain("Project orientation");
    const workspace = new Workspace(root);
    appendExecutionRecord(workspace.id, { taskId: "task-1", iteration: 1, changedFiles: 1, tests: "passed", exitStatus: "ok", timestamp: new Date().toISOString() });
    const review = await collectLocalEvidence(root, "Update feature", "review", "task-1");
    expect(text(review)).toContain("unstaged diff");
    expect(text(review)).toContain("+export const feature = 2;");
    expect(text(review)).toContain("tests passed");
  });

  it("refuses mismatched review records and empty changes", async () => {
    const root = fixture();
    await expect(collectLocalEvidence(root, "Check feature", "review", "wrong-task")).rejects.toThrow("No execution record");
    appendExecutionRecord(new Workspace(root).id, { taskId: "right-task", iteration: 1, changedFiles: 0, tests: "passed", exitStatus: "ok", timestamp: new Date().toISOString() });
    await expect(collectLocalEvidence(root, "Check feature", "review", "right-task")).rejects.toThrow("No changed files");
  });

  it("excludes sensitive filenames and refuses credentials in otherwise safe files or diff", async () => {
    const root = fixture();
    fs.writeFileSync(path.join(root, ".env"), "TOKEN=must-not-send\n");
    expect(text(await collectLocalEvidence(root, "Feature", "plan"))).not.toContain("must-not-send");
    fs.writeFileSync(path.join(root, "feature.ts"), "const apiKey = 'sk-abcdefghijklmnopqrstuvwxyz';\n");
    await expect(collectLocalEvidence(root, "Feature", "plan")).rejects.toThrow("possible credential");
  });

  it("rejects incomplete review evidence when changed paths are sensitive or untracked-only", async () => {
    const root = fixture();
    const taskId = "review-task";
    appendExecutionRecord(new Workspace(root).id, { taskId, iteration: 1, changedFiles: 1, tests: "passed", exitStatus: "ok", timestamp: new Date().toISOString() });
    fs.writeFileSync(path.join(root, "new.ts"), "export const added = true;\n");
    await expect(collectLocalEvidence(root, "Review new file", "review", taskId)).rejects.toThrow("Untracked files");
    git(root, "add", "new.ts");
    fs.writeFileSync(path.join(root, "feature.ts"), "export const feature = 2;\n");
    fs.writeFileSync(path.join(root, ".env"), "TOKEN=sensitive\n");
    await expect(collectLocalEvidence(root, "Review feature", "review", taskId)).rejects.toThrow("evidence is incomplete");
  });

  it("refuses oversized files and symlinks instead of silently truncating", async () => {
    const root = fixture();
    fs.writeFileSync(path.join(root, "feature.ts"), "x".repeat(17000));
    await expect(collectLocalEvidence(root, "Feature", "plan")).rejects.toThrow("per-file limit");
    fs.writeFileSync(path.join(root, "feature.ts"), "ok");
    const link = path.join(root, "linked.ts");
    try { fs.symlinkSync(path.join(root, "feature.ts"), link); }
    catch { return; } // Windows without symlink privilege
    await expect(collectLocalEvidence(root, "linked", "plan")).rejects.toThrow("symlink evidence");
  });
});
