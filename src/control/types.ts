export type ControlProtocol = "P2C" | "C2C";

export type ControlState = "INIT" | "PLAN" | "EXECUTED" | "DONE" | "BLOCKED";

export interface ControlMessage {
  protocol: ControlProtocol;
  state: ControlState;
  taskId: string;
  iteration: number;
  body?: string;
}

export interface ChatGptTransport {
  initialize(): Promise<void>;
  send(message: ControlMessage): Promise<void>;
  waitForReply(taskId: string, expected: ControlState[]): Promise<ControlMessage>;
  close(): Promise<void>;
}

const BODY_LABELS: Record<ControlState, string> = {
  INIT: "GOAL",
  PLAN: "PLAN",
  EXECUTED: "SUMMARY",
  DONE: "REVIEW",
  BLOCKED: "REASON",
};

export function serializeControlMessage(message: ControlMessage): string {
  const lines = [
    `[${message.protocol}]`,
    `STATE: ${message.state}`,
    `TASK_ID: ${message.taskId}`,
    `ITERATION: ${message.iteration}`,
  ];
  const body = message.body?.trim();
  if (body) {
    lines.push("", `${BODY_LABELS[message.state]}:`, body);
  }
  return lines.join("\n");
}

export function parseControlMessage(input: string): ControlMessage {
  const text = input.trim();
  if (!text) throw new Error("Empty ChatGPT control reply");

  const protocolMatch = /^\[(P2C|C2C)\]\s*$/im.exec(text);
  if (!protocolMatch) throw new Error("Missing [P2C] or [C2C] protocol marker");

  const stateRaw = readHeader(text, "STATE").toUpperCase();
  if (!isControlState(stateRaw)) throw new Error(`Unsupported control state: ${stateRaw}`);

  const taskId = readHeader(text, "TASK_ID").trim();
  if (!taskId) throw new Error("TASK_ID must not be empty");

  const iterationRaw = readHeader(text, "ITERATION");
  const iteration = Number.parseInt(iterationRaw, 10);
  if (!Number.isInteger(iteration) || iteration < 0) {
    throw new Error(`Invalid ITERATION: ${iterationRaw}`);
  }

  const body = extractBody(text);
  return {
    protocol: protocolMatch[1].toUpperCase() as ControlProtocol,
    state: stateRaw,
    taskId,
    iteration,
    body: body || undefined,
  };
}

function readHeader(text: string, key: string): string {
  const match = new RegExp(`^${key}\\s*:\\s*(.+?)\\s*$`, "im").exec(text);
  if (!match) throw new Error(`Missing ${key} header`);
  return match[1];
}

function isControlState(value: string): value is ControlState {
  return value === "INIT" || value === "PLAN" || value === "EXECUTED" || value === "DONE" || value === "BLOCKED";
}

function extractBody(text: string): string {
  const lines = text.split(/\r?\n/);
  let headerEnd = -1;
  let seenIteration = false;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^ITERATION\s*:/i.test(lines[index])) {
      seenIteration = true;
      headerEnd = index;
      break;
    }
  }
  if (!seenIteration) return "";

  const rest = lines.slice(headerEnd + 1);
  while (rest.length > 0 && rest[0].trim() === "") rest.shift();
  if (rest.length > 0 && /^(GOAL|PLAN|SUMMARY|REVIEW|REASON)\s*:\s*$/i.test(rest[0])) {
    rest.shift();
  }
  return rest.join("\n").trim();
}
