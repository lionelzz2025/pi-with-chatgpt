import { describe, expect, it } from "vitest";
import { parseControlMessage, serializeControlMessage } from "../src/control/types.js";
import { ManualTransport } from "../src/control/transports/manual.js";

describe("P2C control protocol", () => {
  it("round-trips a small control message without source payloads", () => {
    const text = serializeControlMessage({
      protocol: "P2C",
      state: "INIT",
      taskId: "p2c_demo",
      iteration: 0,
      body: "Add argument validation and tests",
    });

    expect(text).toContain("[P2C]");
    expect(text).toContain("GOAL:\nAdd argument validation and tests");
    expect(parseControlMessage(text)).toEqual({
      protocol: "P2C",
      state: "INIT",
      taskId: "p2c_demo",
      iteration: 0,
      body: "Add argument validation and tests",
    });
  });

  it("accepts legacy C2C replies during migration", () => {
    expect(
      parseControlMessage("[C2C]\nSTATE: PLAN\nTASK_ID: p2c_demo\nITERATION: 1\n\nPLAN:\nFix the validator")
    ).toMatchObject({ protocol: "C2C", state: "PLAN", taskId: "p2c_demo", iteration: 1 });
  });
});

describe("ManualTransport", () => {
  it("validates task, iteration and expected reply state", async () => {
    const transport = new ManualTransport({
      async exchange() {
        return "[P2C]\nSTATE: PLAN\nTASK_ID: p2c_demo\nITERATION: 0\n\nPLAN:\n1. Edit validator\n2. Add tests";
      },
    });

    await transport.send({ protocol: "P2C", state: "INIT", taskId: "p2c_demo", iteration: 0, body: "goal" });
    const reply = await transport.waitForReply("p2c_demo", ["PLAN", "BLOCKED"]);
    expect(reply.state).toBe("PLAN");
    expect(reply.body).toContain("Add tests");
  });

  it("rejects a stale reply from another iteration", async () => {
    const transport = new ManualTransport({
      async exchange() {
        return "[P2C]\nSTATE: DONE\nTASK_ID: p2c_demo\nITERATION: 0\n\nREVIEW:\nLooks good";
      },
    });

    await transport.send({ protocol: "P2C", state: "EXECUTED", taskId: "p2c_demo", iteration: 1 });
    await expect(transport.waitForReply("p2c_demo", ["DONE", "PLAN"])).rejects.toThrow("ITERATION mismatch");
  });
});
