/**
 * Shared file capture utilities for session end hooks
 */

import { execSync } from "node:child_process";

export interface FileCaptureResult {
  files: string[];
  gitDiffContent: string;
}

export async function captureFileChanges(workDir: string): Promise<FileCaptureResult> {
  const allChangedFiles: string[] = [];
  let gitDiffContent = "";

  try {
    const diffNames = execSync("git diff --name-only HEAD 2>/dev/null || git diff --name-only 2>/dev/null || echo ''", {
      cwd: workDir,
      encoding: "utf-8",
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    const stagedNames = execSync("git diff --cached --name-only 2>/dev/null || echo ''", {
      cwd: workDir,
      encoding: "utf-8",
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    const gitFiles = [...new Set([
      ...diffNames.split("\n").filter(Boolean),
      ...stagedNames.split("\n").filter(Boolean),
    ])];

    allChangedFiles.push(...gitFiles);

    if (gitFiles.length > 0) {
      try {
        gitDiffContent = execSync("git diff HEAD --stat 2>/dev/null | head -30", {
          cwd: workDir,
          encoding: "utf-8",
          timeout: 3000,
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
      } catch {
        // Ignore
      }
    }
  } catch {
    // Not a git repo or git not available
  }

  try {
    const recentFiles = execSync(
      `find . -maxdepth 4 -type f \\( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" -o -name "*.md" -o -name "*.json" -o -name "*.py" -o -name "*.rs" \\) -mmin -30 ! -path "*/node_modules/*" ! -path "*/.git/*" ! -path "*/dist/*" ! -path "*/build/*" 2>/dev/null | head -30`,
      {
        cwd: workDir,
        encoding: "utf-8",
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    ).trim();

    const recentFilesList = recentFiles.split("\n").filter(Boolean).map(f => f.replace(/^\.\//, ""));

    for (const file of recentFilesList) {
      if (!allChangedFiles.includes(file)) {
        allChangedFiles.push(file);
      }
    }
  } catch {
    // find command failed
  }

  return { files: allChangedFiles, gitDiffContent };
}