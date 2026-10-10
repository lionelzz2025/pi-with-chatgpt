import path from "node:path";
import { readJsonIfExists, stateSubdir, writeSecureJson } from "./paths.js";

export type ApprovalMode = "plan" | "auto";
export type TransportMode = "manual" | "browser";

interface WorkflowPreferences {
  approvalMode?: ApprovalMode;
  transport?: TransportMode;
  cdpEndpoint?: string;
  updatedAt?: string;
}

export interface ApprovalModePreference {
  approvalMode: ApprovalMode;
  stored: boolean;
}

export interface TransportPreference {
  mode: TransportMode;
  cdpEndpoint?: string;
  stored: boolean;
}

const DEFAULT_APPROVAL_MODE: ApprovalMode = "plan";
const DEFAULT_TRANSPORT_MODE: TransportMode = "manual";

function preferenceFile(workspaceId: string): string {
  return path.join(stateSubdir("preferences"), `${workspaceId}.json`);
}

function isApprovalMode(value: unknown): value is ApprovalMode {
  return value === "plan" || value === "auto";
}

function isTransportMode(value: unknown): value is TransportMode {
  return value === "manual" || value === "browser";
}

function readPreferences(workspaceId: string): WorkflowPreferences {
  return readJsonIfExists<WorkflowPreferences>(preferenceFile(workspaceId)) ?? {};
}

/** Merge-on-write so independent preferences in the same file do not clobber each other. */
function writePreferences(workspaceId: string, patch: WorkflowPreferences): void {
  writeSecureJson(preferenceFile(workspaceId), {
    ...readPreferences(workspaceId),
    ...patch,
    updatedAt: new Date().toISOString(),
  } satisfies WorkflowPreferences);
}

export function readApprovalMode(workspaceId: string): ApprovalModePreference {
  const stored = readPreferences(workspaceId);
  if (!isApprovalMode(stored.approvalMode)) {
    return { approvalMode: DEFAULT_APPROVAL_MODE, stored: false };
  }
  return { approvalMode: stored.approvalMode, stored: true };
}

export function writeApprovalMode(workspaceId: string, approvalMode: ApprovalMode): ApprovalModePreference {
  writePreferences(workspaceId, { approvalMode });
  return { approvalMode, stored: true };
}

export function readTransport(workspaceId: string): TransportPreference {
  const stored = readPreferences(workspaceId);
  const mode = isTransportMode(stored.transport) ? stored.transport : DEFAULT_TRANSPORT_MODE;
  const cdpEndpoint = typeof stored.cdpEndpoint === "string" && stored.cdpEndpoint ? stored.cdpEndpoint : undefined;
  return {
    mode,
    ...(cdpEndpoint ? { cdpEndpoint } : {}),
    stored: isTransportMode(stored.transport),
  };
}

export function writeTransport(
  workspaceId: string,
  mode: TransportMode,
  cdpEndpoint?: string
): TransportPreference {
  writePreferences(workspaceId, { transport: mode, cdpEndpoint });
  return { mode, ...(cdpEndpoint ? { cdpEndpoint } : {}), stored: true };
}
