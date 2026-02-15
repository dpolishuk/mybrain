import { existsSync, statSync, readdirSync, unlinkSync } from 'fs';
import { resolve, basename, dirname } from 'path';
import { mkdir, open } from 'fs/promises';
import { randomBytes } from 'crypto';
import lockfile from 'proper-lockfile';
import { execSync } from 'child_process';

// src/hooks/opencode/index.ts

// src/types.ts
var DEFAULT_CONFIG = {
  memoryPath: ".claude/mind.mv2",
  maxContextObservations: 20,
  maxContextTokens: 2e3,
  autoCompress: true,
  minConfidence: 0.6,
  debug: false
};
function generateId() {
  return randomBytes(8).toString("hex");
}
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}
function classifyObservationType(toolName, output) {
  const lowerOutput = output.toLowerCase();
  if (lowerOutput.includes("error") || lowerOutput.includes("failed") || lowerOutput.includes("exception")) {
    return "problem";
  }
  if (lowerOutput.includes("success") || lowerOutput.includes("passed") || lowerOutput.includes("completed")) {
    return "success";
  }
  if (lowerOutput.includes("warning") || lowerOutput.includes("deprecated")) {
    return "warning";
  }
  switch (toolName) {
    case "Read":
    case "Glob":
    case "Grep":
      return "discovery";
    case "Edit":
      if (lowerOutput.includes("fix") || lowerOutput.includes("bug")) {
        return "bugfix";
      }
      return "refactor";
    case "Write":
      return "feature";
    default:
      return "discovery";
  }
}
var LOCK_OPTIONS = {
  stale: 3e4,
  retries: {
    retries: 1e3,
    minTimeout: 5,
    maxTimeout: 50
  }
};
async function withMemvidLock(lockPath, fn) {
  await mkdir(dirname(lockPath), { recursive: true });
  const handle = await open(lockPath, "a");
  await handle.close();
  const release = await lockfile.lock(lockPath, LOCK_OPTIONS);
  try {
    return await fn();
  } finally {
    await release();
  }
}

// src/core/mind.ts
function pruneBackups(memoryPath, keepCount) {
  try {
    const dir = dirname(memoryPath);
    const baseName = memoryPath.split("/").pop() || "mind.mv2";
    const backupPattern = new RegExp(`^${baseName.replace(".", "\\.")}\\.backup-\\d+$`);
    const files = readdirSync(dir);
    const backups = files.filter((f) => backupPattern.test(f)).map((f) => ({
      name: f,
      path: resolve(dir, f),
      time: parseInt(f.split("-").pop() || "0", 10)
    })).sort((a, b) => b.time - a.time);
    for (let i = keepCount; i < backups.length; i++) {
      try {
        unlinkSync(backups[i].path);
        console.error(`[memvid-mind] Pruned old backup: ${backups[i].name}`);
      } catch {
      }
    }
  } catch {
  }
}
var sdkLoaded = false;
var use;
var create;
async function loadSDK() {
  if (sdkLoaded) return;
  const sdk = await import('@memvid/sdk');
  use = sdk.use;
  create = sdk.create;
  sdkLoaded = true;
}
var Mind = class _Mind {
  memvid;
  config;
  sessionId;
  initialized = false;
  constructor(memvid, config) {
    this.memvid = memvid;
    this.config = config;
    this.sessionId = generateId();
  }
  /**
   * Open or create a Mind instance
   */
  static async open(configOverrides = {}) {
    await loadSDK();
    const config = { ...DEFAULT_CONFIG, ...configOverrides };
    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const memoryPath = resolve(projectDir, config.memoryPath);
    const memoryDir = dirname(memoryPath);
    await mkdir(memoryDir, { recursive: true });
    let memvid;
    const MAX_FILE_SIZE_MB = 100;
    const lockPath = `${memoryPath}.lock`;
    await withMemvidLock(lockPath, async () => {
      if (!existsSync(memoryPath)) {
        memvid = await create(memoryPath, "basic");
        return;
      }
      const { statSync: statSync2, renameSync, unlinkSync: unlinkSync2 } = await import('fs');
      const fileSize = statSync2(memoryPath).size;
      const fileSizeMB = fileSize / (1024 * 1024);
      if (fileSizeMB > MAX_FILE_SIZE_MB) {
        console.error(`[memvid-mind] Memory file too large (${fileSizeMB.toFixed(1)}MB), likely corrupted. Creating fresh memory...`);
        const backupPath = `${memoryPath}.backup-${Date.now()}`;
        try {
          renameSync(memoryPath, backupPath);
        } catch {
        }
        memvid = await create(memoryPath, "basic");
        return;
      }
      try {
        memvid = await use("basic", memoryPath);
      } catch (openError) {
        const errorMessage = openError instanceof Error ? openError.message : String(openError);
        if (errorMessage.includes("Deserialization") || errorMessage.includes("UnexpectedVariant") || errorMessage.includes("Invalid") || errorMessage.includes("corrupt") || errorMessage.includes("validation failed") || errorMessage.includes("unable to recover") || errorMessage.includes("table of contents")) {
          console.error("[memvid-mind] Memory file corrupted, creating fresh memory...");
          const backupPath = `${memoryPath}.backup-${Date.now()}`;
          try {
            renameSync(memoryPath, backupPath);
          } catch {
            try {
              unlinkSync2(memoryPath);
            } catch {
            }
          }
          memvid = await create(memoryPath, "basic");
          return;
        }
        throw openError;
      }
    });
    const mind = new _Mind(memvid, config);
    mind.initialized = true;
    pruneBackups(memoryPath, 3);
    if (config.debug) {
      console.error(`[memvid-mind] Opened: ${memoryPath}`);
    }
    return mind;
  }
  async withLock(fn) {
    const memoryPath = this.getMemoryPath();
    const lockPath = `${memoryPath}.lock`;
    return withMemvidLock(lockPath, fn);
  }
  /**
   * Remember an observation
   */
  async remember(input) {
    const observation = {
      id: generateId(),
      timestamp: Date.now(),
      type: input.type,
      tool: input.tool,
      summary: input.summary,
      content: input.content,
      metadata: {
        ...input.metadata,
        sessionId: this.sessionId
      }
    };
    const frameId = await this.withLock(async () => {
      return this.memvid.put({
        title: `[${observation.type}] ${observation.summary}`,
        label: observation.type,
        text: observation.content,
        metadata: {
          observationId: observation.id,
          timestamp: observation.timestamp,
          tool: observation.tool,
          sessionId: this.sessionId,
          ...observation.metadata
        },
        tags: [observation.type, observation.tool].filter(Boolean)
      });
    });
    if (this.config.debug) {
      console.error(`[memvid-mind] Remembered: ${observation.summary}`);
    }
    return frameId;
  }
  /**
   * Search memories by query (uses fast lexical search)
   */
  async search(query, limit = 10) {
    return this.withLock(async () => {
      return this.searchUnlocked(query, limit);
    });
  }
  async searchUnlocked(query, limit) {
    const results = await this.memvid.find(query, { k: limit, mode: "lex" });
    return (results.frames || []).map((frame) => ({
      observation: {
        id: frame.metadata?.observationId || frame.frame_id,
        timestamp: frame.metadata?.timestamp || 0,
        type: frame.label,
        tool: frame.metadata?.tool,
        summary: frame.title?.replace(/^\[.*?\]\s*/, "") || "",
        content: frame.text || "",
        metadata: frame.metadata
      },
      score: frame.score || 0,
      snippet: frame.snippet || frame.text?.slice(0, 200) || ""
    }));
  }
  /**
   * Ask the memory a question (uses fast lexical search)
   */
  async ask(question) {
    return this.withLock(async () => {
      const result = await this.memvid.ask(question, { k: 5, mode: "lex" });
      return result.answer || "No relevant memories found.";
    });
  }
  /**
   * Get context for session start
   */
  async getContext(query) {
    return this.withLock(async () => {
      const timeline = await this.memvid.timeline({
        limit: this.config.maxContextObservations,
        reverse: true
      });
      const frames = Array.isArray(timeline) ? timeline : timeline.frames || [];
      const recentObservations = frames.map(
        (frame) => {
          let ts = frame.metadata?.timestamp || frame.timestamp || 0;
          if (ts > 0 && ts < 4102444800) {
            ts = ts * 1e3;
          }
          return {
            id: frame.metadata?.observationId || frame.frame_id,
            timestamp: ts,
            type: frame.label || frame.metadata?.type || "observation",
            tool: frame.metadata?.tool,
            summary: frame.title?.replace(/^\[.*?\]\s*/, "") || frame.preview?.slice(0, 100) || "",
            content: frame.text || frame.preview || "",
            metadata: frame.metadata
          };
        }
      );
      let relevantMemories = [];
      if (query) {
        const searchResults = await this.searchUnlocked(query, 10);
        relevantMemories = searchResults.map((r) => r.observation);
      }
      let tokenCount = 0;
      for (const obs of recentObservations) {
        const text = `[${obs.type}] ${obs.summary}`;
        const tokens = estimateTokens(text);
        if (tokenCount + tokens > this.config.maxContextTokens) break;
        tokenCount += tokens;
      }
      return {
        recentObservations,
        relevantMemories,
        sessionSummaries: [],
        // TODO: Implement session summaries
        tokenCount
      };
    });
  }
  /**
   * Save a session summary
   */
  async saveSessionSummary(summary) {
    const sessionSummary = {
      id: this.sessionId,
      startTime: Date.now() - 36e5,
      // Approximate
      endTime: Date.now(),
      observationCount: 0,
      // TODO: Track this
      keyDecisions: summary.keyDecisions,
      filesModified: summary.filesModified,
      summary: summary.summary
    };
    return this.withLock(async () => {
      return this.memvid.put({
        title: `Session Summary: ${(/* @__PURE__ */ new Date()).toISOString().split("T")[0]}`,
        label: "session",
        text: JSON.stringify(sessionSummary, null, 2),
        metadata: sessionSummary,
        tags: ["session", "summary"]
      });
    });
  }
  /**
   * Get memory statistics
   */
  async stats() {
    return this.withLock(async () => {
      const stats = await this.memvid.stats();
      const timeline = await this.memvid.timeline({ limit: 1, reverse: false });
      const recentTimeline = await this.memvid.timeline({ limit: 1, reverse: true });
      const oldestFrames = Array.isArray(timeline) ? timeline : timeline.frames || [];
      const newestFrames = Array.isArray(recentTimeline) ? recentTimeline : recentTimeline.frames || [];
      return {
        totalObservations: stats.frame_count || 0,
        totalSessions: 0,
        // TODO: Count unique sessions
        oldestMemory: oldestFrames[0]?.metadata?.timestamp || oldestFrames[0]?.timestamp || 0,
        newestMemory: newestFrames[0]?.metadata?.timestamp || newestFrames[0]?.timestamp || 0,
        fileSize: stats.size_bytes || 0,
        topTypes: {}
        // TODO: Aggregate
      };
    });
  }
  /**
   * Get the session ID
   */
  getSessionId() {
    return this.sessionId;
  }
  /**
   * Get the memory file path
   */
  getMemoryPath() {
    return resolve(process.cwd(), this.config.memoryPath);
  }
  /**
   * Check if initialized
   */
  isInitialized() {
    return this.initialized;
  }
};
var mindInstance = null;
async function getMind(config) {
  if (!mindInstance) {
    mindInstance = await Mind.open(config);
  }
  return mindInstance;
}

// src/utils/compression.ts
var TARGET_COMPRESSED_SIZE = 2e3;
var COMPRESSION_THRESHOLD = 3e3;
function compressToolOutput(toolName, toolInput, output) {
  const originalSize = output.length;
  if (originalSize <= COMPRESSION_THRESHOLD) {
    return { compressed: output, wasCompressed: false, originalSize };
  }
  let compressed;
  switch (toolName) {
    case "Read":
      compressed = compressFileRead(toolInput, output);
      break;
    case "Bash":
      compressed = compressBashOutput(toolInput, output);
      break;
    case "Grep":
      compressed = compressGrepOutput(toolInput, output);
      break;
    case "Glob":
      compressed = compressGlobOutput(toolInput, output);
      break;
    case "Edit":
    case "Write":
      compressed = compressEditOutput(toolInput, output);
      break;
    default:
      compressed = compressGeneric(output);
  }
  return {
    compressed: truncateToTarget(compressed),
    wasCompressed: true,
    originalSize
  };
}
function compressFileRead(toolInput, output) {
  const filePath = toolInput?.file_path || "unknown";
  const fileName = filePath.split("/").pop() || "file";
  const lines = output.split("\n");
  const totalLines = lines.length;
  const imports = extractImports(output);
  const exports$1 = extractExports(output);
  const functions = extractFunctionSignatures(output);
  const classes = extractClassNames(output);
  const errors = extractErrorPatterns(output);
  const parts = [
    `\u{1F4C4} File: ${fileName} (${totalLines} lines)`
  ];
  if (imports.length > 0) {
    parts.push(`
\u{1F4E6} Imports: ${imports.slice(0, 10).join(", ")}${imports.length > 10 ? ` (+${imports.length - 10} more)` : ""}`);
  }
  if (exports$1.length > 0) {
    parts.push(`
\u{1F4E4} Exports: ${exports$1.slice(0, 10).join(", ")}${exports$1.length > 10 ? ` (+${exports$1.length - 10} more)` : ""}`);
  }
  if (functions.length > 0) {
    parts.push(`
\u26A1 Functions: ${functions.slice(0, 10).join(", ")}${functions.length > 10 ? ` (+${functions.length - 10} more)` : ""}`);
  }
  if (classes.length > 0) {
    parts.push(`
\u{1F3D7}\uFE0F Classes: ${classes.join(", ")}`);
  }
  if (errors.length > 0) {
    parts.push(`
\u26A0\uFE0F Errors/TODOs: ${errors.slice(0, 5).join("; ")}`);
  }
  const contextLines = [
    "\n--- First 10 lines ---",
    ...lines.slice(0, 10),
    "\n--- Last 5 lines ---",
    ...lines.slice(-5)
  ];
  parts.push(contextLines.join("\n"));
  return parts.join("");
}
function compressBashOutput(toolInput, output) {
  const command = toolInput?.command || "command";
  const shortCmd = command.split("\n")[0].slice(0, 100);
  const lines = output.split("\n");
  const errorLines = lines.filter(
    (l) => l.toLowerCase().includes("error") || l.toLowerCase().includes("failed") || l.toLowerCase().includes("exception") || l.toLowerCase().includes("warning")
  );
  const successLines = lines.filter(
    (l) => l.toLowerCase().includes("success") || l.toLowerCase().includes("passed") || l.toLowerCase().includes("completed") || l.toLowerCase().includes("done")
  );
  const parts = [`\u{1F5A5}\uFE0F Command: ${shortCmd}`];
  if (errorLines.length > 0) {
    parts.push(`
\u274C Errors (${errorLines.length}):`);
    parts.push(errorLines.slice(0, 10).join("\n"));
  }
  if (successLines.length > 0) {
    parts.push(`
\u2705 Success indicators:`);
    parts.push(successLines.slice(0, 5).join("\n"));
  }
  parts.push(`
\u{1F4CA} Output: ${lines.length} lines total`);
  if (lines.length > 20) {
    parts.push("\n--- First 10 lines ---");
    parts.push(lines.slice(0, 10).join("\n"));
    parts.push("\n--- Last 5 lines ---");
    parts.push(lines.slice(-5).join("\n"));
  } else {
    parts.push("\n--- Full output ---");
    parts.push(lines.join("\n"));
  }
  return parts.join("");
}
function compressGrepOutput(toolInput, output) {
  const pattern = toolInput?.pattern || "pattern";
  const lines = output.split("\n").filter(Boolean);
  const files = /* @__PURE__ */ new Set();
  lines.forEach((line) => {
    const match = line.match(/^([^:]+):/);
    if (match) files.add(match[1]);
  });
  const parts = [
    `\u{1F50D} Grep: "${pattern.slice(0, 50)}"`,
    `\u{1F4C1} Found in ${files.size} files, ${lines.length} matches`
  ];
  if (files.size > 0) {
    parts.push(`
\u{1F4C2} Files: ${Array.from(files).slice(0, 15).join(", ")}${files.size > 15 ? ` (+${files.size - 15} more)` : ""}`);
  }
  parts.push("\n--- Top matches ---");
  parts.push(lines.slice(0, 10).join("\n"));
  if (lines.length > 10) {
    parts.push(`
... and ${lines.length - 10} more matches`);
  }
  return parts.join("");
}
function compressGlobOutput(toolInput, output) {
  const pattern = toolInput?.pattern || "pattern";
  let files = [];
  try {
    const parsed = JSON.parse(output);
    files = parsed.filenames || [];
  } catch {
    files = output.split("\n").filter(Boolean);
  }
  const byDir = {};
  files.forEach((f) => {
    const dir = f.split("/").slice(0, -1).join("/") || "/";
    const file = f.split("/").pop() || f;
    if (!byDir[dir]) byDir[dir] = [];
    byDir[dir].push(file);
  });
  const parts = [
    `\u{1F4C2} Glob: "${pattern.slice(0, 50)}"`,
    `\u{1F4C1} Found ${files.length} files in ${Object.keys(byDir).length} directories`
  ];
  const topDirs = Object.entries(byDir).sort((a, b) => b[1].length - a[1].length).slice(0, 5);
  parts.push("\n--- Top directories ---");
  topDirs.forEach(([dir, dirFiles]) => {
    const shortDir = dir.split("/").slice(-3).join("/");
    parts.push(`${shortDir}/ (${dirFiles.length} files)`);
  });
  parts.push("\n--- Sample files ---");
  parts.push(files.slice(0, 15).map((f) => f.split("/").pop()).join(", "));
  return parts.join("");
}
function compressEditOutput(toolInput, output) {
  const filePath = toolInput?.file_path || "unknown";
  const fileName = filePath.split("/").pop() || "file";
  return [
    `\u270F\uFE0F Edited: ${fileName}`,
    `\u{1F4DD} Changes applied successfully`,
    output.slice(0, 500)
  ].join("\n");
}
function compressGeneric(output) {
  const lines = output.split("\n");
  if (lines.length <= 30) {
    return output;
  }
  return [
    `\u{1F4CA} Output: ${lines.length} lines`,
    "--- First 15 lines ---",
    ...lines.slice(0, 15),
    "--- Last 10 lines ---",
    ...lines.slice(-10)
  ].join("\n");
}
function extractImports(code) {
  const imports = [];
  const patterns = [
    /import\s+(?:{\s*([^}]+)\s*}|(\w+))\s+from\s+['"]([^'"]+)['"]/g,
    /from\s+['"]([^'"]+)['"]\s+import/g,
    /require\s*\(['"]([^'"]+)['"]\)/g,
    /use\s+(\w+(?:::\w+)*)/g
  ];
  patterns.forEach((pattern) => {
    let match;
    while ((match = pattern.exec(code)) !== null) {
      imports.push(match[3] || match[1] || match[2] || match[0]);
    }
  });
  return [...new Set(imports)];
}
function extractExports(code) {
  const exports$1 = [];
  const patterns = [
    /export\s+(?:default\s+)?(?:function|class|const|let|var)\s+(\w+)/g,
    /export\s*{\s*([^}]+)\s*}/g,
    /pub\s+(?:fn|struct|enum|trait|mod)\s+(\w+)/g
  ];
  patterns.forEach((pattern) => {
    let match;
    while ((match = pattern.exec(code)) !== null) {
      const names = (match[1] || "").split(",").map((s) => s.trim());
      exports$1.push(...names.filter(Boolean));
    }
  });
  return [...new Set(exports$1)];
}
function extractFunctionSignatures(code) {
  const functions = [];
  const patterns = [
    /(?:async\s+)?function\s+(\w+)/g,
    /(\w+)\s*:\s*(?:async\s+)?\([^)]*\)\s*=>/g,
    /(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*=>/g,
    /fn\s+(\w+)/g,
    /def\s+(\w+)/g
  ];
  patterns.forEach((pattern) => {
    let match;
    while ((match = pattern.exec(code)) !== null) {
      functions.push(match[1]);
    }
  });
  return [...new Set(functions)];
}
function extractClassNames(code) {
  const classes = [];
  const patterns = [
    /class\s+(\w+)/g,
    /struct\s+(\w+)/g,
    /interface\s+(\w+)/g,
    /type\s+(\w+)\s*=/g
  ];
  patterns.forEach((pattern) => {
    let match;
    while ((match = pattern.exec(code)) !== null) {
      classes.push(match[1]);
    }
  });
  return [...new Set(classes)];
}
function extractErrorPatterns(code) {
  const errors = [];
  const lines = code.split("\n");
  lines.forEach((line) => {
    if (line.includes("TODO") || line.includes("FIXME") || line.includes("HACK") || line.includes("XXX") || line.includes("BUG")) {
      errors.push(line.trim().slice(0, 100));
    }
  });
  return errors.slice(0, 10);
}
function truncateToTarget(text) {
  if (text.length <= TARGET_COMPRESSED_SIZE) {
    return text;
  }
  return text.slice(0, TARGET_COMPRESSED_SIZE - 20) + "\n... (compressed)";
}
async function captureFileChanges(workDir) {
  const allChangedFiles = [];
  let gitDiffContent = "";
  try {
    const diffNames = execSync("git diff --name-only HEAD 2>/dev/null || git diff --name-only 2>/dev/null || echo ''", {
      cwd: workDir,
      encoding: "utf-8",
      timeout: 3e3,
      stdio: ["pipe", "pipe", "pipe"]
    }).trim();
    const stagedNames = execSync("git diff --cached --name-only 2>/dev/null || echo ''", {
      cwd: workDir,
      encoding: "utf-8",
      timeout: 3e3,
      stdio: ["pipe", "pipe", "pipe"]
    }).trim();
    const gitFiles = [.../* @__PURE__ */ new Set([
      ...diffNames.split("\n").filter(Boolean),
      ...stagedNames.split("\n").filter(Boolean)
    ])];
    allChangedFiles.push(...gitFiles);
    if (gitFiles.length > 0) {
      try {
        gitDiffContent = execSync("git diff HEAD --stat 2>/dev/null | head -30", {
          cwd: workDir,
          encoding: "utf-8",
          timeout: 3e3,
          stdio: ["pipe", "pipe", "pipe"]
        }).trim();
      } catch {
      }
    }
  } catch {
  }
  try {
    const recentFiles = execSync(
      `find . -maxdepth 4 -type f \\( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" -o -name "*.md" -o -name "*.json" -o -name "*.py" -o -name "*.rs" \\) -mmin -30 ! -path "*/node_modules/*" ! -path "*/.git/*" ! -path "*/dist/*" ! -path "*/build/*" 2>/dev/null | head -30`,
      {
        cwd: workDir,
        encoding: "utf-8",
        timeout: 5e3,
        stdio: ["pipe", "pipe", "pipe"]
      }
    ).trim();
    const recentFilesList = recentFiles.split("\n").filter(Boolean).map((f) => f.replace(/^\.\//, ""));
    for (const file of recentFilesList) {
      if (!allChangedFiles.includes(file)) {
        allChangedFiles.push(file);
      }
    }
  } catch {
  }
  return { files: allChangedFiles, gitDiffContent };
}

// src/hooks/opencode/index.ts
var OBSERVED_TOOLS = /* @__PURE__ */ new Set([
  "Read",
  "Edit",
  "Write",
  "Bash",
  "Grep",
  "Glob"
]);
function buildSessionContext(memoryPath, projectDir) {
  const projectName = basename(projectDir);
  const memoryExists = existsSync(memoryPath);
  if (memoryExists) {
    try {
      const stats = statSync(memoryPath);
      const fileSizeKB = Math.round(stats.size / 1024);
      return [
        "<opencode-brain-context>",
        "# \u{1F9E0} OpenCode Brain Active",
        "",
        `\u{1F4C1} Project: **${projectName}**`,
        `\u{1F4BE} Memory: \`.claude/mind.mv2\` (${fileSizeKB} KB)`,
        "",
        "**Commands:**",
        "- `/mind:search <query>` - Search memories",
        "- `/mind:ask <question>` - Ask your memory",
        "- `/mind:recent` - View timeline",
        "- `/mind:stats` - View statistics",
        "",
        "_Memories are captured automatically from your tool use._",
        "</opencode-brain-context>"
      ].join("\n");
    } catch {
    }
  }
  return [
    "<opencode-brain-context>",
    "# \u{1F9E0} OpenCode Brain Ready",
    "",
    `\u{1F4C1} Project: **${projectName}**`,
    "\u{1F4BE} Memory will be created at: `.claude/mind.mv2`",
    "",
    "_Your observations will be automatically captured._",
    "</opencode-brain-context>"
  ].join("\n");
}
var OpenCodeBrain = async (ctx) => {
  const projectDir = ctx.directory || ctx.project?.worktree || process.cwd();
  const memoryPath = resolve(projectDir, ".claude/mind.mv2");
  return {
    "tool.execute.after": async ({ tool, sessionID }, { output, metadata }) => {
      if (!OBSERVED_TOOLS.has(tool)) {
        return;
      }
      try {
        const mind = await getMind({ memoryPath });
        const outputStr = typeof output === "string" ? output : typeof output === "object" && output !== null ? JSON.stringify(output) : String(output);
        await mind.remember({
          type: classifyObservationType(tool, outputStr),
          summary: `OpenCode ${tool} completed`,
          content: compressToolOutput(tool, metadata, outputStr).compressed,
          tool,
          metadata: {
            sessionId: sessionID,
            ...metadata
          }
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
          const contentParts = [`## Files Modified This Session

${files.map((f) => `- ${f}`).join("\n")}`];
          if (gitDiffContent) {
            contentParts.push(`
## Git Changes Summary
\`\`\`
${gitDiffContent}
\`\`\``);
          }
          await mind.remember({
            type: "refactor",
            summary: `Session edits: ${files.length} file(s) modified`,
            content: contentParts.join("\n"),
            tool: "FileChanges",
            metadata: {
              files,
              fileCount: files.length
            }
          });
        } catch (e) {
          console.error("[opencode-brain] Error in session.idle:", e);
        }
        return;
      }
      return;
    }
  };
};
var opencode_default = OpenCodeBrain;

export { OpenCodeBrain, opencode_default as default };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map