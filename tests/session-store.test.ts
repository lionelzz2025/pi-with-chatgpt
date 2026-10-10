import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readChatGptSession, saveChatGptSession } from "../src/control/session-store.js";

let stateDir = "";
let previousStateDir: string | undefined;
afterEach(async () => {
  if (stateDir) await rm(stateDir, { recursive: true, force: true });
  stateDir = "";
  if (previousStateDir === undefined) delete process.env.P2C_STATE_DIR;
  else process.env.P2C_STATE_DIR = previousStateDir;
  previousStateDir = undefined;
});

async function setup() {
  previousStateDir = process.env.P2C_STATE_DIR;
  stateDir = await mkdtemp(path.join(os.tmpdir(), "p2c-session-"));
  process.env.P2C_STATE_DIR = stateDir;
  return stateDir;
}

describe("ChatGPT session store", () => {
  it("persists an allowed conversation URL with owner-only file permissions", async () => {
    const root = await setup();
    const saved = saveChatGptSession("workspace-1", { url: "https://chatgpt.com/c/abc", title: "Project" });
    expect(readChatGptSession("workspace-1")).toEqual(saved);
    const file = await readFile(path.join(root, "sessions", "workspace-1.json"), "utf8");
    expect(JSON.parse(file).url).toBe("https://chatgpt.com/c/abc");
    if (process.platform !== "win32") {
      expect((await stat(path.join(root, "sessions", "workspace-1.json"))).mode & 0o777).toBe(0o600);
    }
  });

  it("rejects unsafe URLs and workspace IDs", async () => {
    await setup();
    expect(() => saveChatGptSession("../escape", { url: "https://chatgpt.com/c/abc" })).toThrow("Invalid workspace id");
    expect(() => saveChatGptSession("workspace-1", { url: "http://chatgpt.com/c/abc" })).toThrow("HTTPS");
    expect(() => saveChatGptSession("workspace-1", { url: "https://example.com/c/abc" })).toThrow("HTTPS");
  });

  it("returns null for invalid persisted ChatGPT URLs", async () => {
    const root = await setup();
    const dir = path.join(root, "sessions");
    const fs = await import("node:fs/promises");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "workspace-1.json"), JSON.stringify({ url: "https://example.com/" }));
    expect(readChatGptSession("workspace-1")).toBeNull();
  });
});
