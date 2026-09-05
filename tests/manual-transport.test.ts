import { describe, expect, it, vi } from "vitest";
import { ManualTransport } from "../src/control/transports/manual.js";

describe("ManualTransport", () => {
  it("captures and normalizes a ChatGPT reply", async () => {
    const editor = vi.fn(async () => "  [P2C]\nSTATE: PLAN\n  ");
    const transport = new ManualTransport(editor);

    await expect(
      transport.exchange({ title: "Planning", outbound: "[P2C]\nSTATE: INIT" })
    ).resolves.toBe("[P2C]\nSTATE: PLAN");

    expect(editor).toHaveBeenCalledWith(
      expect.stringContaining("Planning"),
      "[P2C]\nSTATE: INIT"
    );
  });

  it("fails when an interactive editor is unavailable", async () => {
    const transport = new ManualTransport();

    await expect(
      transport.exchange({ title: "Planning", outbound: "[P2C]\nSTATE: INIT" })
    ).rejects.toThrow("interactive editor UI");
  });

  it("rejects an unchanged outbound request", async () => {
    const outbound = "[P2C]\nSTATE: INIT";
    const transport = new ManualTransport(async () => outbound);

    await expect(
      transport.exchange({ title: "Planning", outbound })
    ).rejects.toThrow("No ChatGPT reply was captured");
  });
});
