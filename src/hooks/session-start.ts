#!/usr/bin/env node
/**
 * Memvid Mind - Session Start Hook
 *
 * LIGHTWEIGHT startup - does NOT load the SDK.
 * SDK is loaded lazily on first tool use instead.
 * This keeps Claude startup fast (< 1 second).
 */

import { readStdin, writeOutput, debug } from "../utils/helpers.js";
import type { HookInput } from "../types.js";
import { existsSync, statSync } from "node:fs";
import { resolve, basename } from "node:path";

async function main() {
  try {
    // Read hook input from stdin
    const input = await readStdin();
    const hookInput: HookInput = JSON.parse(input);

    debug(`Session starting: ${hookInput.session_id}`);

    // Get project info without loading SDK
    const projectDir = hookInput.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const projectName = basename(projectDir);
    const memoryPath = resolve(projectDir, ".claude/mind.mv2");

    // Quick check if memory file exists (no SDK needed)
    const memoryExists = existsSync(memoryPath);

    // Build minimal context without loading SDK
    const contextLines: string[] = [];

    if (memoryExists) {
      try {
        const stats = statSync(memoryPath);
        const fileSizeKB = Math.round(stats.size / 1024);

        contextLines.push("<memvid-mind-context>");
        contextLines.push("# 🧠 Claude Mind Active");
        contextLines.push("");
        contextLines.push(`📁 Project: **${projectName}**`);
        contextLines.push(`💾 Memory: \`.claude/mind.mv2\` (${fileSizeKB} KB)`);
        contextLines.push("");
        contextLines.push("**Commands:**");
        contextLines.push("- `/mind:search <query>` - Search memories");
        contextLines.push("- `/mind:ask <question>` - Ask your memory");
        contextLines.push("- `/mind:recent` - View timeline");
        contextLines.push("- `/mind:stats` - View statistics");
        contextLines.push("");
        contextLines.push("_Memories are captured automatically from your tool use._");
        contextLines.push("</memvid-mind-context>");
      } catch {
        // Ignore stat errors
      }
    } else {
      // First time - memory will be created on first observation
      contextLines.push("<memvid-mind-context>");
      contextLines.push("# 🧠 Claude Mind Ready");
      contextLines.push("");
      contextLines.push(`📁 Project: **${projectName}**`);
      contextLines.push("💾 Memory will be created at: `.claude/mind.mv2`");
      contextLines.push("");
      contextLines.push("_Your observations will be automatically captured._");
      contextLines.push("</memvid-mind-context>");
    }

// SessionStart hooks use hookSpecificOutput.additionalContext
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const output: any = {
      continue: true,
    };

    if (contextLines.length > 0) {
      output.hookSpecificOutput = {
        hookEventName: "SessionStart",
        additionalContext: contextLines.join("\n"),
      };
    }

    writeOutput(output);
  } catch (error) {
    debug(`Error: ${error}`);
    // Don't block on errors
    writeOutput({ continue: true });
  }
}

main();
