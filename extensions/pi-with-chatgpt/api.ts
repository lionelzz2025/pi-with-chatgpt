export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  killed?: boolean;
}

export interface PiUI {
  notify(message: string, level?: "info" | "warning" | "error"): void;
  editor(title: string, initialText?: string): Promise<string | undefined>;
}

export interface ExtensionContext {
  cwd: string;
  signal?: AbortSignal;
  hasUI: boolean;
  ui: PiUI;
}

export interface ExtensionAPI {
  exec(
    command: string,
    args: string[],
    options?: { cwd?: string; signal?: AbortSignal; timeout?: number }
  ): Promise<ExecResult>;
  registerCommand(
    name: string,
    options: {
      description?: string;
      handler(args: string, ctx: ExtensionContext): void | Promise<void>;
    }
  ): void;
  on(
    event: "agent_settled",
    handler: (event: { type: "agent_settled" }, ctx: ExtensionContext) => void | Promise<void>
  ): void;
  sendUserMessage(
    content: string,
    options?: { deliverAs?: "steer" | "followUp" }
  ): void | Promise<void>;
}
