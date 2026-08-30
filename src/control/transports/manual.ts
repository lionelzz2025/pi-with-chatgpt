import {
  parseControlMessage,
  serializeControlMessage,
  type ChatGptTransport,
  type ControlMessage,
  type ControlState,
} from "../types.js";

export interface ManualExchangeContext {
  taskId: string;
  iteration: number;
  expected: ControlState[];
  outbound: ControlMessage;
}

export interface ManualTransportIO {
  exchange(outboundText: string, context: ManualExchangeContext): Promise<string | null | undefined>;
}

export class ManualTransport implements ChatGptTransport {
  private pending: ControlMessage | null = null;

  constructor(private readonly io: ManualTransportIO) {}

  async initialize(): Promise<void> {
    // No connection to establish. The human carries the control message.
  }

  async send(message: ControlMessage): Promise<void> {
    if (this.pending) throw new Error("ManualTransport already has a pending control message");
    this.pending = { ...message };
  }

  async waitForReply(taskId: string, expected: ControlState[]): Promise<ControlMessage> {
    const outbound = this.pending;
    if (!outbound) throw new Error("ManualTransport has no pending control message");
    if (outbound.taskId !== taskId) {
      throw new Error(`Pending task mismatch: expected ${taskId}, got ${outbound.taskId}`);
    }

    try {
      const rawReply = await this.io.exchange(serializeControlMessage(outbound), {
        taskId,
        iteration: outbound.iteration,
        expected,
        outbound,
      });
      if (!rawReply?.trim()) throw new Error("Manual ChatGPT exchange was cancelled");

      const reply = parseControlMessage(rawReply);
      if (reply.taskId !== taskId) {
        throw new Error(`ChatGPT reply TASK_ID mismatch: expected ${taskId}, got ${reply.taskId}`);
      }
      if (reply.iteration !== outbound.iteration) {
        throw new Error(
          `ChatGPT reply ITERATION mismatch: expected ${outbound.iteration}, got ${reply.iteration}`
        );
      }
      if (!expected.includes(reply.state)) {
        throw new Error(`Unexpected ChatGPT state ${reply.state}; expected ${expected.join(" or ")}`);
      }
      return reply;
    } finally {
      this.pending = null;
    }
  }

  async close(): Promise<void> {
    this.pending = null;
  }
}
