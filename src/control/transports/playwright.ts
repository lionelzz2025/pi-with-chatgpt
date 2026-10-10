import path from "node:path";
import type { Browser, BrowserContext, LaunchOptions, Locator, Page } from "playwright";
import { getStateDir, ensureDir } from "../../config/paths.js";
import type { ChatGptTransport, ChatGptTransportRequest } from "../transport.js";
import { readChatGptSession, saveChatGptSession, type ChatGptSession } from "../session-store.js";

const CHATGPT_MESSAGE_SELECTOR = '[data-message-author-role="assistant"], [data-markdown-text-style="assistant-message"]';
const VISIBLE_COMPOSER_SELECTOR = '#prompt-textarea:visible, [role="textbox"][contenteditable="true"]:visible';
const CDP_ENDPOINT_PATTERN = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\/?$/i;

/** Loopback-only rule shared by the CLI configuration and the transport itself. */
export function isLoopbackCdpEndpoint(value: string): boolean {
  return CDP_ENDPOINT_PATTERN.test(value);
}

function isTrustedChatGptUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ["chatgpt.com", "chat.openai.com"].includes(url.hostname);
  } catch {
    return false;
  }
}

export interface PlaywrightTransportOptions {
  profileDir?: string;
  launchOptions?: LaunchOptions;
  /** Dependency injection seams for tests and embedding applications. */
  launchPersistentContext?: (userDataDir: string, options?: LaunchOptions) => Promise<BrowserContext>;
  connectOverCDP?: (endpointURL: string) => Promise<Browser>;
  /** Attach to an already-running browser explicitly; never auto-connect to arbitrary local browsers. */
  cdpEndpoint?: string;
  timeoutMs?: number;
}

/** Persistent application-owned context or explicitly attached CDP browser for ChatGPT Web. */
export class PlaywrightTransport implements ChatGptTransport {
  readonly profileDir: string;
  private context: BrowserContext | null = null;
  private browser: Browser | null = null;
  private ownsContext = false;
  private activeWorkspaceId: string | null = null;

  constructor(private readonly options: PlaywrightTransportOptions = {}) {
    this.profileDir = path.resolve(options.profileDir ?? path.join(getStateDir(), "browser-profile"));
  }

  async initialize(): Promise<void> {
    if (this.context) return;
    if (this.options.cdpEndpoint) {
      if (!isLoopbackCdpEndpoint(this.options.cdpEndpoint)) {
        throw new Error("CDP endpoint must be a local loopback HTTP(S) URL with an optional port. Exposing CDP remotely grants control of the browser session.");
      }
      const chromium = await this.loadChromium();
      const connect = this.options.connectOverCDP ?? chromium.connectOverCDP.bind(chromium);
      this.browser = await connect(this.options.cdpEndpoint);
      this.context = this.browser.contexts()[0] ?? await this.browser.newContext();
      this.ownsContext = false;
      this.context.setDefaultTimeout(this.timeoutMs);
      return;
    }
    ensureDir(this.profileDir);
    const chromium = this.options.launchPersistentContext ? undefined : await this.loadChromium();
    const launch = this.options.launchPersistentContext ?? ((userDataDir: string, launchOptions?: LaunchOptions) =>
      chromium!.launchPersistentContext(userDataDir, { headless: false, ...launchOptions }));
    this.context = await launch(this.profileDir, this.options.launchOptions);
    this.ownsContext = true;
    this.context.setDefaultTimeout(this.timeoutMs);
  }

  async openSession(workspaceId: string): Promise<string> {
    const context = this.requireContext();
    const page = context.pages().find((candidate) => isTrustedChatGptUrl(candidate.url())) ?? await context.newPage();
    const saved = readChatGptSession(workspaceId);
    if (saved && !isTrustedChatGptUrl(saved.url)) {
      throw new Error(`Refusing to open an untrusted saved ChatGPT URL: ${saved.url}`);
    }
    if ((saved && page.url() !== saved.url) || !isTrustedChatGptUrl(page.url())) {
      await page.goto(saved?.url ?? "https://chatgpt.com/", {
        waitUntil: "domcontentloaded", timeout: this.timeoutMs,
      });
    }
    const url = page.url();
    if (!isTrustedChatGptUrl(url)) {
      throw new Error(`Unexpected page after opening ChatGPT session: ${url}`);
    }
    this.activeWorkspaceId = workspaceId;
    return url;
  }

  saveSession(workspaceId: string, title?: string): ChatGptSession {
    const page = this.requireContext().pages().find((candidate) => isTrustedChatGptUrl(candidate.url()));
    if (!page) throw new Error("No ChatGPT page is open to save as a session.");
    return saveChatGptSession(workspaceId, { url: page.url(), title });
  }

  async exchange(request: ChatGptTransportRequest): Promise<string> {
    const page = await this.getPage();
    await this.assertLoggedIn(page);
    const composer = page.locator(VISIBLE_COMPOSER_SELECTOR).first();
    await this.waitVisible(composer, "ChatGPT message composer was not found; sign in or update the supported UI selectors.");
    const previousMessages = page.locator(CHATGPT_MESSAGE_SELECTOR);
    const previousCount = await previousMessages.count();
    const previousText = previousCount ? (await previousMessages.last().innerText()).trim() : "";
    await composer.fill(request.outbound);
    await composer.press("Enter");

    const timeout = this.timeoutMs;
    const response = page.locator(CHATGPT_MESSAGE_SELECTOR).last();
    try {
      await page.waitForFunction(
        ({ selector, previousCount, previousText, outbound }) => {
          const messages = document.querySelectorAll(selector);
          const last = messages.item(messages.length - 1);
          const stopButton = document.querySelector('[data-testid="stop-button"], button[aria-label*="Stop generating" i], button[aria-label*="停止生成"]');
          const sendButton = document.querySelector('[data-testid="send-button"], button[aria-label*="Send prompt" i], button[aria-label*="发送提示"]');
          const text = last?.textContent?.trim() ?? "";
          // ChatGPT virtualizes older turns; the count may remain constant after a new reply.
          return Boolean(text) && (messages.length > previousCount || text !== previousText) && text !== outbound &&
            stopButton === null && (sendButton === null || !sendButton.hasAttribute("disabled"));
        },
        { selector: CHATGPT_MESSAGE_SELECTOR, previousCount, previousText, outbound: request.outbound },
        { timeout, polling: 250 },
      );
      await response.waitFor({ state: "visible", timeout });
    } catch (error) {
      throw new Error("Timed out waiting for ChatGPT to finish its reply. Check the browser and retry manually.", { cause: error });
    }
    const text = (await response.innerText()).trim();
    if (!text) throw new Error("ChatGPT returned an empty response; retry manually.");
    if (this.activeWorkspaceId) {
      const url = page.url();
      if (!isTrustedChatGptUrl(url)) {
        throw new Error("ChatGPT navigated outside its trusted host; refusing to save the session URL.");
      }
      saveChatGptSession(this.activeWorkspaceId, { url, title: request.title });
    }
    return text;
  }

  async close(): Promise<void> {
    const context = this.context;
    const browser = this.browser;
    this.context = null;
    this.browser = null;
    this.activeWorkspaceId = null;
    if (this.ownsContext) await context?.close();
    else await browser?.close(); // Playwright CDP close disconnects this client; it leaves Chrome running.
  }

  private get timeoutMs(): number { return this.options.timeoutMs ?? 120_000; }

  private async getPage(): Promise<Page> {
    const context = this.requireContext();
    const page = context.pages().find((candidate) => isTrustedChatGptUrl(candidate.url()));
    if (!page) {
      throw new Error("Open a ChatGPT conversation with PlaywrightTransport.openSession() before exchanging messages.");
    }
    return page;
  }

  private async assertLoggedIn(page: Page): Promise<void> {
    const login = page.getByRole("button", { name: /log in|sign up/i });
    if (await login.isVisible().catch(() => false)) {
      throw new Error("ChatGPT is not signed in. Sign in to the persistent Playwright browser profile, then retry.");
    }
    try {
      await page.locator(VISIBLE_COMPOSER_SELECTOR).first().waitFor({ state: "visible", timeout: this.timeoutMs });
    } catch (error) {
      throw new Error("ChatGPT composer is unavailable. Sign in and verify the conversation page before retrying.", { cause: error });
    }
  }

  private async waitVisible(locator: Locator, message: string): Promise<void> {
    try { await locator.waitFor({ state: "visible", timeout: this.timeoutMs }); }
    catch (error) { throw new Error(message, { cause: error }); }
  }

  private async loadChromium(): Promise<typeof import("playwright")["chromium"]> {
    try { return (await import("playwright")).chromium; }
    catch (error) {
      throw new Error("Playwright browser support is optional. Install the package with `pnpm add playwright` to use PlaywrightTransport.", { cause: error });
    }
  }

  private requireContext(): BrowserContext {
    if (!this.context) throw new Error("Playwright transport is not initialized; call initialize() first.");
    return this.context;
  }
}
