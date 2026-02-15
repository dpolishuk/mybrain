import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "opencode-brain-test-"));
}

describe("OpenCode Brain Plugin", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
    mkdirSync(join(tempDir, ".claude"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should export a Plugin function", async () => {
    const { OpenCodeBrain } = await import("../index.js");
    expect(typeof OpenCodeBrain).toBe("function");
  });

  it("should return tool.execute.after handler", async () => {
    const { OpenCodeBrain } = await import("../index.js");
    const plugin = await OpenCodeBrain({ directory: tempDir });
    expect(plugin["tool.execute.after"]).toBeDefined();
    expect(typeof plugin["tool.execute.after"]).toBe("function");
  });

  it("should return event handler", async () => {
    const { OpenCodeBrain } = await import("../index.js");
    const plugin = await OpenCodeBrain({ directory: tempDir });
    expect(plugin.event).toBeDefined();
    expect(typeof plugin.event).toBe("function");
  });

  it("should skip unobserved tools in tool.execute.after", async () => {
    const { OpenCodeBrain } = await import("../index.js");
    const plugin = await OpenCodeBrain({ directory: tempDir });

    const result = await plugin["tool.execute.after"](
      { tool: "UnknownTool", sessionID: "test-session" },
      { output: "test output", metadata: {} }
    );

    expect(result).toBeUndefined();
  });

  it("should capture observation for Read tool", async () => {
    const { OpenCodeBrain } = await import("../index.js");
    const plugin = await OpenCodeBrain({ directory: tempDir });

    await plugin["tool.execute.after"](
      { tool: "Read", sessionID: "test-session" },
      { output: "file content line 1\nfile content line 2\nfile content line 3", metadata: { file_path: "/test/file.ts" } }
    );

    expect(existsSync(join(tempDir, ".claude", "mind.mv2"))).toBe(true);
  });

  it("should inject context on session.created event", async () => {
    const { OpenCodeBrain } = await import("../index.js");
    const plugin = await OpenCodeBrain({ directory: tempDir });

    const result = await plugin.event({ event: { type: "session.created" } });

    expect(typeof result).toBe("string");
    expect(result).toContain("OpenCode Brain");
    expect(result).toContain("<opencode-brain-context>");
  });

  it("should inject context with memory stats when memory exists", async () => {
    const { OpenCodeBrain } = await import("../index.js");
    
    // Create memory file manually
    writeFileSync(join(tempDir, ".claude", "mind.mv2"), "test");

    const plugin = await OpenCodeBrain({ directory: tempDir });
    const result = await plugin.event({ event: { type: "session.created" } });

    expect(typeof result).toBe("string");
    expect(result).toContain("KB");
  });

  it("should not throw on session.idle event", async () => {
    const { OpenCodeBrain } = await import("../index.js");
    const plugin = await OpenCodeBrain({ directory: tempDir });

    // Should not throw even in non-git directory
    await expect(plugin.event({ event: { type: "session.idle" } })).resolves.not.toThrow();
  });
});