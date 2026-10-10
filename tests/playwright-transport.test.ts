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
  const page = { goto: vi.fn(async (url: string) => { currentUrl = url; }), url: () => currentUrl };
  let currentUrl = "about:blank";
  const context = {
    pages: () => [page],
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => undefined),
  };
  return { context: context as unknown as BrowserContext, page: page as unknown as Page };
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
    expect(page.goto).toHaveBeenCalledWith("https://chatgpt.com/c/abc", { waitUntil: "domcontentloaded" });
    await transport.close();
    expect(context.close).toHaveBeenCalledOnce();
    if (previousStateDir === undefined) delete process.env.P2C_STATE_DIR;
    else process.env.P2C_STATE_DIR = previousStateDir;
  });

  it("uses ChatGPT home for a new conversation and rejects use before initialize", async () => {
    const { context, page } = makeContext();
    const transport = new PlaywrightTransport({ launchPersistentContext: async () => context });

    await expect(transport.openSession("ws2")).rejects.toThrow("not initialized");
    await transport.initialize();
    await expect(transport.openSession("ws2")).resolves.toBe("https://chatgpt.com/");
    expect(page.goto).toHaveBeenCalledWith("https://chatgpt.com/", { waitUntil: "domcontentloaded" });
  });

  it("keeps message exchange disabled until the ChatGPT UI flow is implemented", async () => {
    const transport = new PlaywrightTransport();
    await expect(transport.exchange({ title: "Plan", outbound: "[P2C]" })).rejects.toThrow(
      "exchange is not implemented"
    );
  });
});
