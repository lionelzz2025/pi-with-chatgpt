import type { ChatGptTransport, ChatGptTransportRequest } from "../transport.js";

export type ManualTransportEditor = (
  title: string,
  prefilled?: string
) => Promise<string | undefined>;

export class ManualTransport implements ChatGptTransport {
  constructor(private readonly editor?: ManualTransportEditor) {}

  async exchange(request: ChatGptTransportRequest): Promise<string> {
    if (!this.editor) {
      throw new Error("Manual ChatGPT transport requires Pi's interactive editor UI.");
    }

    const reply = await this.editor(
      `${request.title} — copy this request to ChatGPT, then replace it with ChatGPT's reply and submit`,
      request.outbound
    );
    const normalized = reply?.trim() ?? "";
    if (!normalized || normalized === request.outbound.trim()) {
      throw new Error(
        "No ChatGPT reply was captured. Paste ChatGPT's control response into the editor before submitting."
      );
    }
    return normalized;
  }
}
