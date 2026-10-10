import path from "node:path";
import type { BrowserContext, LaunchOptions } from "playwright";
import { getStateDir, ensureDir } from "../../config/paths.js";
import type { ChatGptTransport, ChatGptTransportRequest } from "../transport.js";
import { readChatGptSession, saveChatGptSession, type ChatGptSession } from "../session-store.js";

export interface PlaywrightTransportOptions {
  profileDir?: string;
  launchOptions?: LaunchOptions;
  /** Dependency injection seam for tests and embedding applications. */
  launchPersistentContext?: (
    userDataDir: string,
    options?: LaunchOptions
  ) => Promise<BrowserContext>;
}

/** Persistent, application-owned browser context for ChatGPT Web. */
export class PlaywrightTransport implements ChatGptTransport {
  readonly profileDir: string;
  private context: BrowserContext | null = null;

  constructor(private readonly options: PlaywrightTransportOptions = {}) {
    this.profileDir = path.resolve(
      options.profileDir ?? path.join(getStateDir(), "browser-profile")
    );
  }

  /** Launch an isolated persistent profile; never uses the user's default browser profile. */
  async initialize(): Promise<void> {
    if (this.context) return;
    ensureDir(this.profileDir);
    let launch = this.options.launchPersistentContext;
    if (!launch) {
      let chromium: typeof import("playwright")["chromium"];
      try {
        ({ chromium } = await import("playwright"));
      } catch (error) {
        throw new Error(
          "Playwright browser support is optional. Install the package with `pnpm add playwright` to use PlaywrightTransport.",
          { cause: error }
        );
      }
      launch = (userDataDir, launchOptions) =>
        chromium.launchPersistentContext(userDataDir, {
          headless: false,
          ...launchOptions,
        });
    }
    this.context = await launch(this.profileDir, this.options.launchOptions);
  }

  /** Open the saved workspace conversation, or start a new ChatGPT conversation. */
  async openSession(workspaceId: string): Promise<string> {
    const context = this.requireContext();
    const page = context.pages()[0] ?? await context.newPage();
    const saved = readChatGptSession(workspaceId);
    await page.goto(saved?.url ?? "https://chatgpt.com/", { waitUntil: "domcontentloaded" });
    return page.url();
  }

  /** Persist the current conversation URL for a workspace. */
  saveSession(workspaceId: string, title?: string): ChatGptSession {
    const page = this.requireContext().pages()[0];
    if (!page) throw new Error("No ChatGPT page is open to save as a session.");
    return saveChatGptSession(workspaceId, { url: page.url(), title });
  }

  /**
   * Browser send/reply automation is intentionally not enabled yet. ChatGPT's
   * composer and reply DOM are volatile; implement behind this class with
   * explicit login/session checks and bounded waits before enabling exchange.
   */
  async exchange(_request: ChatGptTransportRequest): Promise<string> {
    throw new Error(
      "Playwright ChatGPT exchange is not implemented yet. Initialize the browser, sign in, and use ManualTransport for control messages."
    );
  }

  async close(): Promise<void> {
    const context = this.context;
    this.context = null;
    await context?.close();
  }

  private requireContext(): BrowserContext {
    if (!this.context) {
      throw new Error("Playwright transport is not initialized; call initialize() first.");
    }
    return this.context;
  }
}
