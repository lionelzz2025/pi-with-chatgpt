import { ManualTransport } from "../../src/control/transports/manual.js";
import type { ExtensionContext } from "./api.js";

export function createManualTransport(ctx: ExtensionContext): ManualTransport {
  if (!ctx.hasUI) {
    throw new Error("ManualTransport requires Pi interactive UI; use the TUI for /p2c workflows");
  }

  return new ManualTransport({
    async exchange(outboundText, exchange) {
      const expected = exchange.expected.join(" / ");
      ctx.ui.notify(
        `ChatGPT ${exchange.outbound.state}: copy the editor contents to ChatGPT, then replace them with its ${expected} reply.`,
        "info"
      );
      return ctx.ui.editor(
        `P2C ${exchange.outbound.state} → ChatGPT · paste back ${expected}`,
        outboundText
      );
    },
  });
}
