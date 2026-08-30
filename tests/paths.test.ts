import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveStateDir } from "../src/config/paths.js";

describe("resolveStateDir", () => {
  it("prefers P2C_STATE_DIR over the legacy override", () => {
    const result = resolveStateDir({
      env: {
        P2C_STATE_DIR: "/tmp/p2c-state",
        C2C_STATE_DIR: "/tmp/c2c-state",
      },
      home: "/home/tester",
      platform: "linux",
      existsSync: () => false,
    });

    expect(result).toBe(path.resolve("/tmp/p2c-state"));
  });

  it("keeps C2C_STATE_DIR as an explicit compatibility fallback", () => {
    const result = resolveStateDir({
      env: { C2C_STATE_DIR: "/tmp/c2c-state" },
      home: "/home/tester",
      platform: "linux",
      existsSync: () => false,
    });

    expect(result).toBe(path.resolve("/tmp/c2c-state"));
  });

  it("uses the Pi-named directory for a fresh installation", () => {
    const result = resolveStateDir({
      env: {},
      home: "/home/tester",
      platform: "linux",
      existsSync: () => false,
    });

    expect(result).toBe("/home/tester/.local/state/pi-with-chatgpt");
  });

  it("reuses an existing legacy state directory when Pi state does not exist", () => {
    const legacy = "/home/tester/.local/state/codex-with-chatgpt";
    const result = resolveStateDir({
      env: {},
      home: "/home/tester",
      platform: "linux",
      existsSync: (candidate) => candidate === legacy,
    });

    expect(result).toBe(legacy);
  });

  it("prefers an existing Pi state directory when both directories exist", () => {
    const current = "/home/tester/.local/state/pi-with-chatgpt";
    const result = resolveStateDir({
      env: {},
      home: "/home/tester",
      platform: "linux",
      existsSync: () => true,
    });

    expect(result).toBe(current);
  });

  it("honors XDG_STATE_HOME for new Linux installations", () => {
    const result = resolveStateDir({
      env: { XDG_STATE_HOME: "/state" },
      home: "/home/tester",
      platform: "linux",
      existsSync: () => false,
    });

    expect(result).toBe("/state/pi-with-chatgpt");
  });
});
