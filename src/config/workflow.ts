import path from "node:path";
import { readJsonIfExists, stateSubdir, writeSecureJson } from "./paths.js";

export type ApprovalMode = "plan" | "auto";

interface WorkflowPreferences {
  approvalMode?: ApprovalMode;
  updatedAt?: string;
}

export interface ApprovalModePreference {
  approvalMode: ApprovalMode;
  stored: boolean;
}

const DEFAULT_APPROVAL_MODE: ApprovalMode = "plan";

function preferenceFile(workspaceId: string): string {
  return path.join(stateSubdir("preferences"), `${workspaceId}.json`);
}

function isApprovalMode(value: unknown): value is ApprovalMode {
  return value === "plan" || value === "auto";
}

export function readApprovalMode(workspaceId: string): ApprovalModePreference {
  const stored = readJsonIfExists<WorkflowPreferences>(preferenceFile(workspaceId));
  if (!stored || !isApprovalMode(stored.approvalMode)) {
    return { approvalMode: DEFAULT_APPROVAL_MODE, stored: false };
  }
  return { approvalMode: stored.approvalMode, stored: true };
}

export function writeApprovalMode(workspaceId: string, approvalMode: ApprovalMode): ApprovalModePreference {
  writeSecureJson(preferenceFile(workspaceId), {
    approvalMode,
    updatedAt: new Date().toISOString(),
  } satisfies WorkflowPreferences);
  return { approvalMode, stored: true };
}
