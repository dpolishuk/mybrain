/**
 * OpenCode Brain Plugin
 *
 * Persistent memory for OpenCode via single .mv2 file.
 * Maps Claude Code hooks to OpenCode events.
 */

import { existsSync, statSync } from "node:fs";
import { resolve, basename } from "node:path";
import { getMind } from "../../core/mind.js";
import { classifyObservationType } from "../../utils/helpers.js";
import { compressToolOutput } from "../../utils/compression.js";
import { captureFileChanges } from "../../utils/file-capture.js";

const OBSERVED_TOOLS = new Set([
  "Read",
  "Edit",
  "Write",
  "Bash",
  "Grep",
  "Glob",
]);

export interface OpenCodeContext {
  directory?: string;
  project?: {
    worktree?: string;
    id?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface OpenCodePlugin {
  "tool.execute.after": (params: { tool: string; sessionID: string }, output: { output: unknown; metadata?: Record<string, unknown> }) => Promise<void>;
  event: (params: { event: { type: string; [key: string]: unknown } }) => Promise<string | void>;
  [key: string]: unknown;
}

function buildSessionContext(memoryPath: string, projectDir: string): string {
  const projectName = basename(projectDir);
  const memoryExists = existsSync(memoryPath);

  if (memoryExists) {
    try {
      const stats = statSync(memoryPath);
      const fileSizeKB = Math.round(stats.size / 1024);

      return [
        "<opencode-brain-context>",
        "# 🧠 OpenCode Brain Active",
        "",
        `📁 Project: **${projectName}**`,
        `💾 Memory: \`.claude/mind.mv2\` (${fileSizeKB} KB)`,
        "",
        "**Commands:**",
        "- `/mind:search <query>` - Search memories",
        "- `/mind:ask <question>` - Ask your memory",
        "- `/mind:recent` - View timeline",
        "- `/mind:stats` - View statistics",
        "",
        "_Memories are captured automatically from your tool use._",
        "</opencode-brain-context>",
      ].join("\n");
    } catch {
      // Ignore stat errors
    }
  }

  return [
    "<opencode-brain-context>",
    "# 🧠 OpenCode Brain Ready",
    "",
    `📁 Project: **${projectName}**`,
    "💾 Memory will be created at: `.claude/mind.mv2`",
    "",
    "_Your observations will be automatically captured._",
    "</opencode-brain-context>",
  ].join("\n");
}

export const OpenCodeBrain = async (ctx: OpenCodeContext): Promise<OpenCodePlugin> => {
  const projectDir = ctx.directory || ctx.project?.worktree || process.cwd();
  const memoryPath = resolve(projectDir, ".claude/mind.mv2");

  return {
    "tool.execute.after": async ({ tool, sessionID }, { output, metadata }) => {
      if (!OBSERVED_TOOLS.has(tool)) {
        return;
      }

      try {
        const mind = await getMind({ memoryPath });
        const outputStr = typeof output === "string" 
          ? output 
          : (typeof output === "object" && output !== null)
            ? JSON.stringify(output)
            : String(output);
        
        await mind.remember({
          type: classifyObservationType(tool, outputStr),
          summary: `OpenCode ${tool} completed`,
          content: compressToolOutput(tool, metadata, outputStr).compressed,
          tool,
          metadata: {
            sessionId: sessionID,
            ...metadata,
          },
        });
      } catch (e) {
        console.error("[opencode-brain] Error capturing observation:", e);
      }
    },

    event: async ({ event }) => {
      if (event.type === "session.created") {
        return buildSessionContext(memoryPath, projectDir);
      }
      if (event.type === "session.idle") {
        try {
          const mind = await getMind({ memoryPath });
          const { files, gitDiffContent } = await captureFileChanges(projectDir);

          if (files.length === 0) {
            return;
          }

          const contentParts = [`## Files Modified This Session\n\n${files.map(f => `- ${f}`).join("\n")}`];

          if (gitDiffContent) {
            contentParts.push(`\n## Git Changes Summary\n\`\`\`\n${gitDiffContent}\n\`\`\``);
          }

          await mind.remember({
            type: "refactor",
            summary: `Session edits: ${files.length} file(s) modified`,
            content: contentParts.join("\n"),
            tool: "FileChanges",
            metadata: {
              files,
              fileCount: files.length,
            },
          });
        } catch (e) {
          console.error("[opencode-brain] Error in session.idle:", e);
        }
        return;
      }
      return;
    },
  };
};

export default OpenCodeBrain;