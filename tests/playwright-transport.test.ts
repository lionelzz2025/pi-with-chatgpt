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
  const response = { waitFor: vi.fn(async () => undefined), innerText: vi.fn(async () => "STATE: DONE\nTASK_ID: abc") };
  const page = {
    goto: vi.fn(async (url: string) => { currentUrl = url; }),
    url: () => currentUrl,
    locator: vi.fn((selector: string) => selector.includes("data-message-author-role") ? ({ count: async () => 0, last: () => response }) : composer),
    getByRole: vi.fn(() => ({ isVisible: async () => false })),
    waitForFunction: vi.fn(async () => undefined),
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
    page.locator = vi.fn((selector: string) => selector.includes("data-message-author-role")
      ? ({ count: async () => 5, last: () => response })
      : makeContext().composer) as typeof page.locator;
    page.waitForFunction = vi.fn(async (predicate: Function, args: object, options: object) => {
      expect(args).toMatchObject({ previousCount: 5, previousText: "old reply" });
      expect(options).toMatchObject({ polling: 250 });
      const evaluate = (text: string, count: number) => {
        const originalDocument = globalThis.document;
        Object.defineProperty(globalThis, "document", { configurable: true, value: {
          querySelectorAll: () => ({ length: count, item: () => ({ textContent: text }) }),
          querySelector: () => null,
        } });
        try { return predicate(args); }
        finally { Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument }); }
      };
      expect(evaluate("old reply", 5)).toBe(false);
      lastText = "STATE: PLAN\\nnew reply";
      expect(evaluate(lastText, 5)).toBe(true);
    }) as typeof page.waitForFunction;
    const transport = new PlaywrightTransport({ launchPersistentContext: async () => context });
    await transport.initialize();
    await transport.openSession("ws-virtualized");
    await expect(transport.exchange({ title: "Plan", outbound: "[P2C]" })).resolves.toContain("new reply");
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
