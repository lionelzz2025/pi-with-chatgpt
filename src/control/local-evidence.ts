import fs from "node:fs/promises";
import path from "node:path";
import { Workspace } from "../workspace/manager.js";
import { gitDiff, gitStatus } from "../workspace/git.js";
import { latestExecutionRecord } from "../execution/records.js";
import type { ChatGptAttachment } from "./transport.js";

const MAX_PACKAGE_BYTES = 96 * 1024;
const MAX_FILE_BYTES = 16 * 1024;
const MAX_FILES = 6;
const SECRET = /(?:-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|c2c_(?:at|rt|ac|admin)_[A-Za-z0-9_-]+)\b|(?:password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*["']?[^\s"']{8,})/i;

function assertSafe(text: string, label: string): void {
  if (SECRET.test(text)) throw new Error(`Local evidence contains a possible credential in ${label}; no evidence was sent. Remove or exclude it before retrying.`);
}

function safePaths(workspace: Workspace, paths: string[]): string[] {
  return [...new Set(paths)].filter((candidate) => {
    if (!candidate || candidate.includes(" -> ")) return false;
    try {
      const { rel } = workspace.resolve(candidate);
      return rel !== "" && !workspace.ignoreRules.isHidden(rel);
    } catch {
      return false;
    }
  }).sort();
}

/** Create an in-memory, bounded attachment from workspace evidence, never a directory upload. */
export async function collectLocalEvidence(root: string, goal: string, phase: "plan" | "review", taskId?: string): Promise<ChatGptAttachment> {
  const workspace = new Workspace(root);
  const status = gitStatus(workspace.root);
  if (!status.isRepo) throw new Error("Local evidence requires a Git workspace; no evidence was sent.");
  if (status.conflicted.length) throw new Error("Unresolved merge conflicts prevent a complete evidence package; no evidence was sent.");
  const reportedPaths = [
    ...status.staged.map((item) => item.path),
    ...status.unstaged.map((item) => item.path),
    ...status.untracked,
  ];
  const changed = safePaths(workspace, reportedPaths);
  if (phase === "review" && [...status.staged, ...status.unstaged].some((item) => item.path.includes(" -> "))) {
    throw new Error("Renamed files require explicit evidence selection; no review evidence was sent.");
  }
  // Planning begins with project orientation. Review must inspect the actual changed paths.
  const candidates = phase === "plan"
    ? safePaths(workspace, [...changed, "README.md", "package.json", "AGENTS.md", "task_plan.md"])
    : changed;
  if (phase === "review" && changed.length !== new Set(reportedPaths).size) {
    throw new Error("Some changed paths are excluded by the sensitive-file policy; review evidence is incomplete.");
  }
  if (phase === "review" && status.untracked.length) {
    throw new Error("Untracked files are not represented in Git diff; stage them or narrow the review before sending.");
  }
  const words = goal.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? [];
  candidates.sort((a, b) => {
    const score = (name: string) => words.filter((word) => name.toLowerCase().includes(word)).length;
    return score(b) - score(a) || a.localeCompare(b);
  });
  if (candidates.length > MAX_FILES) throw new Error(`Local evidence has ${candidates.length} candidate files (limit ${MAX_FILES}); narrow the task before sending.`);

  const sections = [`# Local Pi evidence (${phase})`, `Workspace: ${workspace.name}`, `Goal: ${goal}`, `Git branch: ${status.branch ?? "unknown"}`];
  if (phase === "review") {
    if (!taskId) throw new Error("Review evidence requires a task id.");
    const record = latestExecutionRecord(workspace.id);
    if (!record || record.taskId !== taskId) throw new Error("No execution record for this task; refusing evidence-free review.");
    sections.push(`Execution: iteration ${record.iteration}; status ${record.exitStatus}; tests ${record.tests ?? "not recorded"}`);
    if (changed.length === 0) throw new Error("No changed files found for local review; refusing evidence-free review.");
    for (const mode of ["staged", "unstaged"] as const) {
      const diff = gitDiff(workspace, { mode, maxBytes: 32 * 1024 });
      if (!diff.isRepo || diff.hasMore) throw new Error(`The ${mode} diff exceeds the local evidence limit or could not be read; no evidence was sent.`);
      if (diff.diff) sections.push(`## ${mode} diff\n\n\`\`\`diff\n${diff.diff}\n\`\`\``);
    }
  }
  for (const candidate of candidates) {
    const { abs, rel } = workspace.resolve(candidate);
    // Check the source path too: resolve() canonicalizes symlinks for containment.
    const source = path.resolve(workspace.root, candidate);
    const sourceStat = await fs.lstat(source).catch(() => null);
    if (sourceStat?.isSymbolicLink()) throw new Error(`Refusing symlink evidence: ${rel}`);
    const stat = await fs.lstat(abs).catch(() => null);
    if (!stat?.isFile()) {
      if (!stat && !changed.includes(candidate)) continue; // optional orientation file absent
      if (phase === "review" && !stat && changed.includes(candidate)) continue; // deleted; included in diff
      throw new Error(`Cannot include non-file evidence: ${rel}`);
    }
    if (stat.size > MAX_FILE_BYTES) throw new Error(`${rel} exceeds the ${MAX_FILE_BYTES}-byte per-file limit; narrow the task before sending.`);
    const file = await workspace.readFile(rel, { maxBytes: MAX_FILE_BYTES, maxLines: 2000 });
    if (file.truncated) throw new Error(`${rel} was truncated; no evidence was sent.`);
    sections.push(`## File: ${rel}\n\n\`\`\`\n${file.content}\n\`\`\``);
  }
  if (phase === "review" && !sections.some((section) => section.includes(" diff\n"))) {
    throw new Error("Review changes have no readable staged or unstaged diff; no evidence was sent.");
  }
  const content = sections.join("\n\n");
  assertSafe(content, "package");
  if (Buffer.byteLength(content, "utf8") > MAX_PACKAGE_BYTES) throw new Error("Local evidence exceeds the 96 KiB package limit; narrow the task before sending.");
  return { name: `p2c-${phase}-evidence.md`, mimeType: "text/markdown", content: Buffer.from(content, "utf8") };
}
