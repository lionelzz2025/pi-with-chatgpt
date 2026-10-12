import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserContext, Page } from "playwright";
import { PlaywrightTransport } from "../src/control/transports/playwright.js";
import { saveChatGptSession } from "../src/control/session-store.js";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function makeContext() {
  let currentUrl = "about:blank";
  const composer = {
    fill: vi.fn(async () => undefined),
    press: vi.fn(async () => undefined),
    waitFor: vi.fn(async () => undefined),
    first: vi.fn(function (this: unknown) { return this; }),
  };
  const response = { waitFor: vi.fn(async () => undefined), innerText: vi.fn(async () => "STATE: DONE\nTASK_ID: abc"), textContent: vi.fn(async () => "STATE: DONE\nTASK_ID: abc") };
  const page = {
    goto: vi.fn(async (url: string) => { currentUrl = url; }),
    url: () => currentUrl,
    locator: vi.fn((selector: string) => selector.includes("data-message-author-role") ? ({ count: async () => 0, last: () => response }) : composer),
    getByRole: vi.fn(() => ({ isVisible: async () => false })),
    waitForFunction: vi.fn(async (predicate: Function, args: object) => {
      const originalDocument = globalThis.document;
      Object.defineProperty(globalThis, "document", { configurable: true, value: {
        querySelectorAll: () => ({ length: 1, item: () => ({
          textContent: "STATE: DONE\nTASK_ID: abc",
          closest: () => ({ getAttribute: () => "complete" }),
        }) }),
        querySelector: () => null,
      } });
      try {
        if (!predicate(args)) throw new Error("completion predicate rejected a finished reply");
      } finally {
        Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
      }
    }),
  };
  const context = {
    pages: vi.fn(() => [page]),
    newPage: vi.fn(async () => page),
    setDefaultTimeout: vi.fn(),
    close: vi.fn(async () => undefined),
  };
  return { context: context as unknown as BrowserContext, page: page as unknown as Page, composer, response };
}

describe("PlaywrightTransport", () => {
  it("launches an isolated persistent profile once and reuses the saved conversation", async () => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "p2c-profile-"));
    tempDirs.push(profileDir);
    const { context, page } = makeContext();
    const launchPersistentContext = vi.fn(async () => context);
    const previousStateDir = process.env.P2C_STATE_DIR;
    const transport = new PlaywrightTransport({ profileDir, launchPersistentContext });

    await transport.initialize();
    await transport.initialize();
    process.env.P2C_STATE_DIR = profileDir;
    saveChatGptSession("ws1", { url: "https://chatgpt.com/c/abc" });
    await expect(transport.openSession("ws1")).resolves.toBe("https://chatgpt.com/c/abc");
    if (previousStateDir === undefined) delete process.env.P2C_STATE_DIR;
    else process.env.P2C_STATE_DIR = previousStateDir;

    expect(launchPersistentContext).toHaveBeenCalledTimes(1);
    expect(launchPersistentContext).toHaveBeenCalledWith(profileDir, undefined);
    expect(page.goto).toHaveBeenCalledWith("https://chatgpt.com/c/abc", { waitUntil: "domcontentloaded", timeout: 120_000 });
    await transport.close();
    expect(context.close).toHaveBeenCalledOnce();
    if (previousStateDir === undefined) delete process.env.P2C_STATE_DIR;
    else process.env.P2C_STATE_DIR = previousStateDir;
  });

  it("rejects non-loopback CDP endpoints before connecting", async () => {
    const connectOverCDP = vi.fn();
    const transport = new PlaywrightTransport({ cdpEndpoint: "http://192.168.1.10:9222", connectOverCDP });
    await expect(transport.initialize()).rejects.toThrow("local loopback");
    expect(connectOverCDP).not.toHaveBeenCalled();
  });

  it("attaches to an explicitly configured CDP browser and disconnects without closing its context", async () => {
    const { context, page } = makeContext();
    const browser = { contexts: () => [context], newContext: vi.fn(), close: vi.fn() };
    const connectOverCDP = vi.fn(async () => browser);
    const transport = new PlaywrightTransport({ cdpEndpoint: "http://127.0.0.1:9222", connectOverCDP });

    await transport.initialize();
    await transport.openSession("ws-cdp");
    await transport.close();

    expect(connectOverCDP).toHaveBeenCalledWith("http://127.0.0.1:9222");
    expect(page.goto).toHaveBeenCalledWith("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 120_000 });
    expect(context.close).not.toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("opens a fresh conversation for a new task instead of reusing an older workspace session", async () => {
    const old = makeContext();
    await old.page.goto("https://chatgpt.com/c/old-task");
    const fresh = makeContext();
    const { context } = makeContext();
    (context.pages as unknown as ReturnType<typeof vi.fn>).mockReturnValue([old.page, fresh.page]);
    (context.newPage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(fresh.page);
    const transport = new PlaywrightTransport({ launchPersistentContext: async () => context });
    await transport.initialize();
    await expect(transport.openSession("ws-new-task", { newChat: true })).resolves.toBe("https://chatgpt.com/");
    await transport.exchange({ title: "New task", outbound: "[P2C]" });
    expect(context.newPage).toHaveBeenCalledOnce();
    expect(fresh.page.goto).toHaveBeenCalledWith("https://chatgpt.com/", expect.any(Object));
    expect(old.page.locator).not.toHaveBeenCalled();
    expect(fresh.page.locator).toHaveBeenCalled();
  });

  it("finds a unique existing project and opens its new-chat composer", async () => {
    const { context, page } = makeContext();
    const projectId = "g-p-abc123";
    const create = { waitFor: vi.fn(async () => undefined), dispatchEvent: vi.fn() };
    const rows = { evaluateAll: vi.fn(async (_fn: unknown, name: string) => name === "demo" ? [projectId] : []) };
    const originalLocator = page.locator;
    page.locator = vi.fn((selector: string) => selector === '[data-app-action-sidebar-project-create]'
      ? create : selector === '[data-app-action-sidebar-project-row]' ? rows : originalLocator(selector)) as typeof page.locator;
    const transport = new PlaywrightTransport({ launchPersistentContext: async () => context });
    await transport.initialize();
    await expect(transport.openSession("ws-project", { newChat: true, projectName: "demo" }))
      .resolves.toBe(`https://chatgpt.com/g/${projectId}/project`);
    expect(page.goto).toHaveBeenLastCalledWith(`https://chatgpt.com/g/${projectId}/project`, expect.any(Object));
    expect(create.dispatchEvent).not.toHaveBeenCalled();
    expect(rows.evaluateAll).toHaveBeenCalledWith(expect.any(Function), "demo");
  });

  it("creates an absent project then opens its new-chat composer", async () => {
    const { context, page } = makeContext();
    const projectId = "g-p-new456";
    const create = { waitFor: vi.fn(async () => undefined), dispatchEvent: vi.fn(async () => undefined) };
    const rows = { evaluateAll: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([projectId]) };
    const fill = vi.fn(async () => undefined), click = vi.fn(async () => undefined);
    const dialog = { waitFor: vi.fn(async () => undefined), locator: vi.fn(() => ({ fill })), getByRole: vi.fn(() => ({ click })) };
    const originalLocator = page.locator;
    page.locator = vi.fn((selector: string) => selector === '[data-app-action-sidebar-project-create]'
      ? create : selector === '[data-app-action-sidebar-project-row]' ? rows : originalLocator(selector)) as typeof page.locator;
    page.getByRole = vi.fn((role: string) => role === "dialog" ? dialog : { isVisible: async () => false }) as typeof page.getByRole;
    page.waitForURL = vi.fn(async () => undefined) as typeof page.waitForURL;
    page.waitForTimeout = vi.fn(async () => undefined) as typeof page.waitForTimeout;
    page.waitForFunction = vi.fn(async () => undefined) as typeof page.waitForFunction;
    const transport = new PlaywrightTransport({ launchPersistentContext: async () => context });
    await transport.initialize();
    await transport.openSession("ws-created", { newChat: true, projectName: "demo" });
    expect(page.waitForTimeout).toHaveBeenCalledWith(750);
    expect(create.dispatchEvent).toHaveBeenCalledWith("click");
    expect(fill).toHaveBeenCalledWith("demo");
    expect(click).toHaveBeenCalledOnce();
    expect(page.goto).toHaveBeenLastCalledWith(`https://chatgpt.com/g/${projectId}/project`, expect.any(Object));
  });

  it("refuses duplicate projects before creating or sending", async () => {
    const { context, page, composer } = makeContext();
    const rows = { evaluateAll: vi.fn(async () => ["g-p-first", "g-p-second"]) };
    const originalLocator = page.locator;
    page.locator = vi.fn((selector: string) => selector === '[data-app-action-sidebar-project-create]'
      ? { waitFor: async () => undefined } : selector === '[data-app-action-sidebar-project-row]'
        ? rows : originalLocator(selector)) as typeof page.locator;
    const transport = new PlaywrightTransport({ launchPersistentContext: async () => context });
    await transport.initialize();
    await expect(transport.openSession("ws-duplicate", { newChat: true, projectName: "demo" }))
      .rejects.toThrow("exactly one matching ChatGPT project");
    expect(composer.press).not.toHaveBeenCalled();
  });

  it("refuses review without a saved conversation instead of choosing another trusted tab", async () => {
    const { context, page } = makeContext();
    await page.goto("https://chatgpt.com/c/unrelated");
    const transport = new PlaywrightTransport({ launchPersistentContext: async () => context });
    await transport.initialize();
    await expect(transport.openSession("ws-no-task-session", { requireSavedSession: true }))
      .rejects.toThrow("No saved ChatGPT conversation");
    expect(page.locator).not.toHaveBeenCalled();
  });

  it("reuses the trusted ChatGPT tab instead of an unrelated first tab", async () => {
    const trusted = makeContext();
    await trusted.page.goto("https://chatgpt.com/c/existing");
    const unrelated = makeContext();
    await unrelated.page.goto("http://127.0.0.1:9222/json");
    unrelated.page.goto.mockClear();
    const { context } = makeContext();
    (context.pages as unknown as ReturnType<typeof vi.fn>).mockReturnValue([unrelated.page, trusted.page]);
    const transport = new PlaywrightTransport({ launchPersistentContext: async () => context });
    await transport.initialize();

    await expect(transport.openSession("ws-multi-tab")).resolves.toBe("https://chatgpt.com/c/existing");
    await expect(transport.exchange({ title: "Review", outbound: "[P2C]" })).resolves.toContain("STATE: DONE");
    expect(trusted.page.locator).toHaveBeenCalled();
    expect(unrelated.page.locator).not.toHaveBeenCalled();
    expect(unrelated.page.goto).not.toHaveBeenCalled();
  });

  it("uploads a bounded in-memory evidence attachment before sending the message", async () => {
    const { context, page, composer } = makeContext();
    const setInputFiles = vi.fn(async () => undefined);
    const originalLocator = page.locator;
    page.getByText = vi.fn(() => ({ first: () => ({ waitFor: async () => undefined }) })) as typeof page.getByText;
    const sendClick = vi.fn(async () => undefined);
    page.locator = vi.fn((selector: string) => selector === 'input[type="file"][aria-label="附加文件"]:not([disabled])'
      ? { count: async () => 1, setInputFiles }
      : selector === 'button[type="submit"][aria-label="发送"]'
        ? { click: sendClick }
        : originalLocator(selector)) as typeof page.locator;
    const transport = new PlaywrightTransport({ launchPersistentContext: async () => context });
    await transport.initialize();
    await transport.openSession("ws-attachment");
    await transport.exchange({ title: "Plan", outbound: "[P2C]", attachments: [{ name: "evidence.md", mimeType: "text/markdown", content: Buffer.from("safe") }] });
    expect(setInputFiles).toHaveBeenCalledWith([{ name: "evidence.md", mimeType: "text/markdown", buffer: Buffer.from("safe") }]);
    expect(setInputFiles.mock.invocationCallOrder[0]).toBeLessThan(sendClick.mock.invocationCallOrder[0]);
    expect(composer.press).not.toHaveBeenCalled();
  });

  it("fails before sending when the document picker cannot be identified", async () => {
    const { context, page, composer } = makeContext();
    const originalLocator = page.locator;
    page.locator = vi.fn((selector: string) => selector === 'input[type="file"][aria-label="附加文件"]:not([disabled])'
      ? { count: async () => 0 }
      : originalLocator(selector)) as typeof page.locator;
    const transport = new PlaywrightTransport({ launchPersistentContext: async () => context });
    await transport.initialize();
    await transport.openSession("ws-picker");
    await expect(transport.exchange({ title: "Plan", outbound: "[P2C]", attachments: [{ name: "evidence.md", mimeType: "text/markdown", content: Buffer.from("safe") }] })).rejects.toThrow("document attachment input");
    expect(composer.press).not.toHaveBeenCalled();
  });

  it("navigates to a saved conversation even when another ChatGPT tab is already open", async () => {
    const { context, page } = makeContext();
    await page.goto("https://chatgpt.com/c/other");
    page.goto.mockClear();
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "p2c-saved-"));
    tempDirs.push(stateDir);
    const previousStateDir = process.env.P2C_STATE_DIR;
    process.env.P2C_STATE_DIR = stateDir;
    try {
      saveChatGptSession("ws-saved", { url: "https://chatgpt.com/c/target" });
      const transport = new PlaywrightTransport({ launchPersistentContext: async () => context });
      await transport.initialize();
      await expect(transport.openSession("ws-saved")).resolves.toBe("https://chatgpt.com/c/target");
      expect(page.goto).toHaveBeenCalledWith("https://chatgpt.com/c/target", expect.any(Object));
    } finally {
      if (previousStateDir === undefined) delete process.env.P2C_STATE_DIR;
      else process.env.P2C_STATE_DIR = previousStateDir;
    }
  });

  it("does not treat a lookalike hostname as a trusted ChatGPT tab", async () => {
    const trusted = makeContext();
    await trusted.page.goto("https://chatgpt.com/c/real");
    const lookalike = makeContext();
    await lookalike.page.goto("https://chatgpt.com.attacker.example/");
    lookalike.page.goto.mockClear();
    const { context } = makeContext();
    (context.pages as unknown as ReturnType<typeof vi.fn>).mockReturnValue([lookalike.page, trusted.page]);
    const transport = new PlaywrightTransport({ launchPersistentContext: async () => context });
    await transport.initialize();
    await expect(transport.openSession("ws-spoof")).resolves.toBe("https://chatgpt.com/c/real");
    expect(lookalike.page.goto).not.toHaveBeenCalled();
    expect(lookalike.page.locator).not.toHaveBeenCalled();
  });

  it("uses ChatGPT home for a new conversation and rejects use before initialize", async () => {
    const { context, page } = makeContext();
    const transport = new PlaywrightTransport({ launchPersistentContext: async () => context });

    await expect(transport.openSession("ws2")).rejects.toThrow("not initialized");
    await transport.initialize();
    await expect(transport.openSession("ws2")).resolves.toBe("https://chatgpt.com/");
    expect(page.goto).toHaveBeenCalledWith("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 120_000 });
  });

  it("sends the prompt and captures a completed reply on an open ChatGPT session", async () => {
    const { context, page, composer } = makeContext();
    const transport = new PlaywrightTransport({ launchPersistentContext: async () => context });
    await transport.initialize();
    await transport.openSession("ws-exchange");

    await expect(transport.exchange({ title: "Review", outbound: "[P2C]\nSTATE: EXECUTED" }))
      .resolves.toContain("STATE: DONE");
    expect(page.locator).toHaveBeenCalledWith('#prompt-textarea:visible, [role="textbox"][contenteditable="true"]:visible');
    expect(composer.fill).toHaveBeenCalledWith("[P2C]\nSTATE: EXECUTED");
    expect(composer.press).toHaveBeenCalledWith("Enter");
    expect(page.waitForFunction).toHaveBeenCalledOnce();
    expect(page.waitForFunction.mock.calls[0]?.[1]).toMatchObject({
      selector: '[data-message-author-role="assistant"], [data-markdown-text-style="assistant-message"]',
      previousCount: 0,
      outbound: "[P2C]\nSTATE: EXECUTED",
    });
  });

  it("accepts a new reply when ChatGPT virtualizes an older turn and the message count stays constant", async () => {
    const { context, page, response } = makeContext();
    let lastText = "old reply";
    response.innerText = vi.fn(async () => lastText);
    response.textContent = vi.fn(async () => lastText);
    page.locator = vi.fn((selector: string) => selector.includes("data-message-author-role")
      ? ({ count: async () => 5, last: () => response })
      : makeContext().composer) as typeof page.locator;
    page.waitForFunction = vi.fn(async (predicate: Function, args: object, options: object) => {
      expect(args).toMatchObject({ previousCount: 5, previousText: "old reply" });
      expect(options).toMatchObject({ polling: 250 });
      const evaluate = (text: string, count: number, turnState: string | null) => {
        const originalDocument = globalThis.document;
        Object.defineProperty(globalThis, "document", { configurable: true, value: {
          querySelectorAll: () => ({ length: count, item: () => ({
            textContent: text,
            closest: () => turnState === null ? null : { getAttribute: () => turnState },
          }) }),
          querySelector: () => null,
        } });
        try { return predicate(args); }
        finally { Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument }); }
      };
      expect(evaluate("old reply", 5, "complete")).toBe(false);
      lastText = "STATE: PLAN\nTASK_ID: abc\nITER";
      expect(evaluate(lastText, 5, null)).toBe(false);
      expect(evaluate(lastText, 5, "streaming")).toBe(false);
      lastText = "STATE: PLAN\nTASK_ID: abc\nITERATION: 0\nPLAN:\nFull steps";
      expect(evaluate(lastText, 5, "complete")).toBe(true);
    }) as typeof page.waitForFunction;
    const transport = new PlaywrightTransport({ launchPersistentContext: async () => context });
    await transport.initialize();
    await transport.openSession("ws-virtualized");
    await expect(transport.exchange({ title: "Plan", outbound: "[P2C]" })).resolves.toContain("PLAN:\nFull steps");
  });

  it("does not accept a prior completed reply while a new answer is starting", async () => {
    const { context, page, response } = makeContext();
    response.textContent = vi.fn(async () => "Previous complete reply");
    // Rendered text can differ from textContent after Markdown/virtualized turn hydration.
    response.innerText = vi.fn(async () => "Previous rendered reply");
    page.locator = vi.fn((selector: string) => selector.includes("data-message-author-role")
      ? ({ count: async () => 5, last: () => response })
      : makeContext().composer) as typeof page.locator;
    page.waitForFunction = vi.fn(async (predicate: Function, args: object) => {
      expect(args).toMatchObject({ previousCount: 5, previousText: "Previous complete reply" });
      const originalDocument = globalThis.document;
      Object.defineProperty(globalThis, "document", { configurable: true, value: {
        querySelectorAll: () => ({ length: 5, item: () => ({
          textContent: "Previous complete reply",
          closest: () => ({ getAttribute: () => "complete" }),
        }) }),
      } });
      try {
        expect(predicate(args)).toBe(false);
        throw new Error("no new completed reply");
      } finally {
        Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
      }
    }) as typeof page.waitForFunction;
    const transport = new PlaywrightTransport({ launchPersistentContext: async () => context });
    await transport.initialize();
    await transport.openSession("ws-prior-reply");
    await expect(transport.exchange({ title: "Review", outbound: "[P2C]" })).rejects.toThrow("Timed out waiting for ChatGPT");
  });

  it("fails with login guidance instead of sending on a signed-out page", async () => {
    const { context, page, composer } = makeContext();
    page.getByRole = vi.fn(() => ({ isVisible: async () => true })) as typeof page.getByRole;
    const transport = new PlaywrightTransport({ launchPersistentContext: async () => context });
    await transport.initialize();
    await transport.openSession("ws-login");

    await expect(transport.exchange({ title: "Plan", outbound: "[P2C]" })).rejects.toThrow("not signed in");
    expect(composer.fill).not.toHaveBeenCalled();
  });

  it("reports bounded reply timeouts with manual recovery guidance", async () => {
    const { context, page } = makeContext();
    page.waitForFunction = vi.fn(async () => { throw new Error("timeout"); });
    const transport = new PlaywrightTransport({ timeoutMs: 5, launchPersistentContext: async () => context });
    await transport.initialize();
    await transport.openSession("ws-timeout");

    await expect(transport.exchange({ title: "Plan", outbound: "[P2C]" })).rejects.toThrow("Timed out waiting for ChatGPT");
  });
});
