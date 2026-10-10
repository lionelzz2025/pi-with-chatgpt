import path from "node:path";
import { IgnoreRules } from "../workspace/ignore.js";

export const WORKFLOW_PHASES = [
  "IDLE",
  "PLANNING",
  "PLAN_READY",
  "EXECUTING",
  "REVIEWING",
  "FIXING",
  "DONE",
  "BLOCKED",
  "ERROR",
] as const;

export type WorkflowPhase = (typeof WORKFLOW_PHASES)[number];

export const MUTATING_TOOLS = new Set(["bash", "write", "edit"]);

/** Phases in which the workflow deliberately unlocks local mutation. */
export const MUTATION_PHASES = new Set<WorkflowPhase>(["EXECUTING", "FIXING"]);

/** Phases where the workflow no longer constrains local mutation (finished successfully or absent). */
export const UNGUARDED_PHASES = new Set<WorkflowPhase>(["IDLE", "DONE"]);

/** Prefix Pi uses for tools contributed by MCP servers: `mcp__<server>__<tool>`. */
export const MCP_TOOL_PREFIX = "mcp__";

/**
 * Read-only MCP resource tools Pi exposes as core tools. They are not `mcp__`-prefixed
 * because Pi owns them, but they belong to the MCP family and never mutate the workspace.
 */
export const MCP_RESOURCE_TOOLS = new Set([
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
]);

/**
 * Hints about what a tool does, mirroring MCP tool annotations. They come from the tool's
 * author and are not verified, so only an explicit `readOnlyHint === true` is trusted here.
 */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** True for MCP server tools, named `mcp__<server>__<tool>`. */
export function isMcpTool(toolName: string): boolean {
  return toolName.startsWith(MCP_TOOL_PREFIX);
}

/** True for Pi's read-only MCP resource tools. */
export function isMcpResourceTool(toolName: string): boolean {
  return MCP_RESOURCE_TOOLS.has(toolName);
}

/** True for any tool the MCP policy governs (MCP server tools and MCP resource tools). */
export function isMcpFamilyTool(toolName: string): boolean {
  return isMcpTool(toolName) || isMcpResourceTool(toolName);
}

/**
 * Decide whether an MCP tool may run in any workflow phase.
 *
 * MCP defaults are fail-closed: when `readOnlyHint` is absent or false the tool is treated
 * as a mutation, so it stays gated like `write`/`edit`/`bash`.
 */
export function mcpToolIsReadOnly(toolName: string, annotations?: ToolAnnotations | null): boolean {
  if (isMcpResourceTool(toolName)) return true;
  return annotations?.readOnlyHint === true;
}

/** Short human-readable class of an MCP tool, used in gate messages. */
export function mcpToolLabel(toolName: string, annotations?: ToolAnnotations | null): string {
  if (isMcpResourceTool(toolName)) return "read-only MCP resource tool";
  if (mcpToolIsReadOnly(toolName, annotations)) return "read-only MCP tool";
  if (annotations?.destructiveHint) return "destructive MCP tool";
  return "mutating MCP tool";
}

export function isKnownPhase(value: unknown): value is WorkflowPhase {
  return typeof value === "string" && (WORKFLOW_PHASES as readonly string[]).includes(value);
}

const PATH_KEYS = [
  "path",
  "file_path",
  "filePath",
  "filepath",
  "filename",
  "fileName",
  "file",
  "target_file",
  "targetFile",
] as const;

/**
 * Extract the mutation target of a write/edit tool call.
 * Returns null when no recognizable path key is present, which callers must
 * treat as a fail-closed condition rather than "no target".
 */
export function extractMutationPath(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  for (const key of PATH_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/** Returns a human-readable violation, or null when the target may be mutated. */
export function checkWriteTarget(cwd: string, target: string, rules: IgnoreRules): string | null {
  const resolved = path.resolve(cwd, target);
  const rel = path.relative(cwd, resolved);
  if (path.isAbsolute(rel) || rel === ".." || rel.startsWith(`..${path.sep}`)) {
    return `target '${target}' is outside the workspace root`;
  }
  const relPosix = rel.split(path.sep).join("/");
  if (relPosix === ".git" || relPosix.startsWith(".git/")) {
    return `target '${target}' is inside .git/`;
  }
  if (relPosix && rules.isSensitive(relPosix)) {
    return `target '${target}' matches the sensitive-file policy`;
  }
  return null;
}

function commandSegments(command: string): string[] {
  return command
    .split(/&&|\|\||[;&|\n]/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/** True when a single-dash flag token (e.g. -rf, -fd) contains the letter. */
function shortFlagPresent(segment: string, letter: string): boolean {
  return segment
    .split(/\s+/)
    .some((token) => /^-[a-zA-Z]+$/.test(token) && token.slice(1).toLowerCase().includes(letter));
}

const DANGEROUS_RULES: Array<{
  label: string;
  test(command: string, segments: string[]): boolean;
}> = [
  {
    label: "recursive delete",
    test: (_command, segments) =>
      segments.some((segment) => {
        if (/(^|[\s($`])rm(\s|$)/.test(segment)) {
          return shortFlagPresent(segment, "r") || /(^|\s)--recursive(\s|$)/.test(segment);
        }
        if (/^(rd|rmdir)\b/i.test(segment)) {
          return /(^|\s)\/s(\s|$)/i.test(segment);
        }
        if (/^del\b/i.test(segment)) {
          return /(^|\s)\/s(\s|$)/i.test(segment) && /(^|\s)\/[qf](\s|$)/i.test(segment);
        }
        return false;
      }),
  },
  {
    label: "Windows recursive delete",
    test: (_command, segments) =>
      segments.some((segment) => /^Remove-Item\b/i.test(segment) && /-Recurse\b/i.test(segment)),
  },
  {
    label: "privilege escalation",
    test: (_command, segments) => segments.some((segment) => /^(sudo|doas)\b/.test(segment)),
  },
  {
    label: "git push",
    test: (_command, segments) => segments.some((segment) => /^git\s+push\b/.test(segment)),
  },
  {
    label: "git reset --hard",
    test: (_command, segments) => segments.some((segment) => /^git\s+reset\b/.test(segment) && /--hard\b/.test(segment)),
  },
  {
    label: "git clean -f",
    test: (_command, segments) =>
      segments.some(
        (segment) =>
          /^git\s+clean\b/.test(segment) &&
          (shortFlagPresent(segment, "f") || /(^|\s)--force(\s|$)/.test(segment))
      ),
  },
  {
    label: "discarding uncommitted changes",
    test: (_command, segments) =>
      segments.some(
        (segment) =>
          /^git\s+checkout\b/.test(segment) &&
          (/[^a-zA-Z]--(\s|$)/.test(segment) || /\s\.(\s|$)/.test(segment) || /^git\s+checkout\s+\.$/.test(segment))
      ) || segments.some((segment) => /^git\s+restore\b/.test(segment)),
  },
  {
    label: "deleting a branch",
    test: (_command, segments) =>
      segments.some((segment) => /^git\s+branch\b/.test(segment) && /(\s-D\b|--delete\b)/.test(segment)),
  },
  {
    label: "piping a download into a shell",
    test: (command) =>
      /(curl|wget)\b[^\n|]*\|[^\n]*\b(sh|bash|zsh|dash|python3?|node|perl|ruby)\b/.test(command),
  },
  {
    label: "system power control",
    test: (_command, segments) =>
      segments.some(
        (segment) =>
          /^(shutdown|reboot|poweroff|halt)\b/.test(segment) || /^(Stop-Computer|Restart-Computer)\b/i.test(segment)
      ),
  },
  {
    label: "formatting a disk",
    test: (_command, segments) =>
      segments.some(
        (segment) =>
          /^mkfs(\.\w+)?\b/.test(segment) ||
          /^(fdisk|diskpart)\b/i.test(segment) ||
          /(^|\s)format\s+[a-zA-Z]:/.test(segment)
      ),
  },
  {
    label: "raw disk write",
    test: (_command, segments) =>
      segments.some((segment) => /^dd\b/.test(segment) && /\bof=/.test(segment)),
  },
  {
    label: "publishing a package",
    test: (_command, segments) =>
      segments.some(
        (segment) => /^(npm|pnpm|yarn)\s+publish\b/.test(segment) || /^cargo\s+publish\b/.test(segment)
      ),
  },
];

/** Returns the danger label for a bash command, or null when it is not on the confirmation list. */
export function dangerousCommandLabel(command: string): string | null {
  const normalized = command.replace(/\\\r?\n/g, " ").trim();
  if (!normalized) return null;
  const segments = commandSegments(normalized);
  for (const rule of DANGEROUS_RULES) {
    if (rule.test(normalized, segments)) return rule.label;
  }
  return null;
}
