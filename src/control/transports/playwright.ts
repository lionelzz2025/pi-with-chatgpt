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
  private activePage: Page | null = null;

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

  async openSession(workspaceId: string, options: { newChat?: boolean; projectName?: string; requireSavedSession?: boolean } = {}): Promise<string> {
    const context = this.requireContext();
    // A new task must not inherit an older task's conversation or draft attachment.
    const saved = options.newChat ? null : readChatGptSession(workspaceId);
    if (options.requireSavedSession && !saved) {
      throw new Error("No saved ChatGPT conversation for this task; refusing to review in another chat.");
    }
    const page = options.newChat ? await context.newPage()
      : context.pages().find((candidate) => saved && candidate.url() === saved.url)
        ?? context.pages().find((candidate) => isTrustedChatGptUrl(candidate.url()))
        ?? await context.newPage();
    if (saved && !isTrustedChatGptUrl(saved.url)) {
      throw new Error(`Refusing to open an untrusted saved ChatGPT URL: ${saved.url}`);
    }
    if (options.newChat && options.projectName) {
      await this.openProjectChat(page, options.projectName);
    } else if (options.newChat || (saved && page.url() !== saved.url) || !isTrustedChatGptUrl(page.url())) {
      await page.goto(saved?.url ?? "https://chatgpt.com/", {
        waitUntil: "domcontentloaded", timeout: this.timeoutMs,
      });
    }
    const url = page.url();
    if (!isTrustedChatGptUrl(url)) {
      throw new Error(`Unexpected page after opening ChatGPT session: ${url}`);
    }
    this.activeWorkspaceId = workspaceId;
    this.activePage = page;
    return url;
  }

  saveSession(workspaceId: string, title?: string): ChatGptSession {
    const page = this.activePage;
    if (!page || !isTrustedChatGptUrl(page.url())) throw new Error("No active ChatGPT page is open to save as a session.");
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
    if (request.attachments?.length) {
      // The active composer exposes a document input; hidden/disabled clones may also exist.
      const picker = page.locator('input[type="file"][aria-label="附加文件"]:not([disabled])');
      if (await picker.count() !== 1) throw new Error("Could not identify the ChatGPT document attachment input; nothing was sent.");
      await picker.setInputFiles(request.attachments.map(({ name, mimeType, content }) => ({ name, mimeType, buffer: content })));
      for (const attachment of request.attachments) {
        try {
          await page.getByText(attachment.name, { exact: true }).first().waitFor({ state: "visible", timeout: this.timeoutMs });
        } catch (error) {
          throw new Error(`ChatGPT did not confirm attachment ${attachment.name}; message was not sent. Clear the draft attachment before retrying.`, { cause: error });
        }
      }
    }
    await composer.fill(request.outbound);
    if (request.attachments?.length) {
      // Enter may only insert a newline while an attachment chip has focus.
      await page.locator('button[type="submit"][aria-label="发送"]').click();
    } else {
      await composer.press("Enter");
    }

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
    this.activePage = null;
    if (this.ownsContext) await context?.close();
    else await browser?.close(); // Playwright CDP close disconnects this client; it leaves Chrome running.
  }

  private get timeoutMs(): number { return this.options.timeoutMs ?? 120_000; }

  private async openProjectChat(page: Page, projectName: string): Promise<void> {
    if (!projectName.trim() || projectName.length > 100) throw new Error("Invalid ChatGPT project name; no project was created.");
    await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: this.timeoutMs });
    const create = page.locator('[data-app-action-sidebar-project-create]');
    await this.waitVisible(create, "ChatGPT project sidebar is unavailable; no message was sent.");
    const matchingIds = async () => page.locator('[data-app-action-sidebar-project-row]').evaluateAll(
      (rows, name) => rows.filter((row) => row.getAttribute("data-app-action-sidebar-project-label") === name)
        .map((row) => row.getAttribute("data-app-action-sidebar-project-id")), projectName,
    );
    let ids = await matchingIds();
    if (ids.length === 0) {
      // Sidebar rows may hydrate after the create button, but a new account has none.
      // Settle hydration briefly and recheck; the dialog path checks again before creating.
      await page.waitForTimeout(750);
      ids = await matchingIds();
    }
    if (ids.length === 0) {
      await create.dispatchEvent("click"); // The sidebar heading intercepts the small plus button's pointer hitbox.
      const dialog = page.getByRole("dialog", { name: /创建项目|Create project/i });
      await this.waitVisible(dialog, "ChatGPT project creation dialog did not open; no message was sent.");
      await dialog.locator('#chatgpt-project-name').fill(projectName);
      // Recheck immediately before creating, so a duplicate or ambiguous project fails closed.
      ids = await matchingIds();
      if (ids.length !== 0) throw new Error("A ChatGPT project appeared during creation; close the dialog and retry.");
      await dialog.getByRole("button", { name: /创建项目|Create project/i }).click();
      await page.waitForURL(/\/g\/g-p-[^/]+\/project(?:[?#].*)?$/, { timeout: this.timeoutMs });
      await page.waitForFunction((name) =>
        [...document.querySelectorAll('[data-app-action-sidebar-project-row]')]
          .some((row) => row.getAttribute("data-app-action-sidebar-project-label") === name),
      projectName, { timeout: this.timeoutMs });
      ids = await matchingIds();
    }
    if (ids.length !== 1 || !ids[0] || !/^g-p-[a-zA-Z0-9-]+$/.test(ids[0])) {
      throw new Error("Could not identify exactly one matching ChatGPT project; no message was sent.");
    }
    const projectUrl = `https://chatgpt.com/g/${ids[0]}/project`;
    if (page.url() !== projectUrl) {
      await page.goto(projectUrl, { waitUntil: "domcontentloaded", timeout: this.timeoutMs });
    }
    await this.waitVisible(page.locator(VISIBLE_COMPOSER_SELECTOR).first(),
      "ChatGPT project new-chat composer is unavailable; no message was sent.");
  }

  private async getPage(): Promise<Page> {
    const context = this.requireContext();
    const page = this.activePage;
    if (!page || !context.pages().includes(page) || !isTrustedChatGptUrl(page.url())) {
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
