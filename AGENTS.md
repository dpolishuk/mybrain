# AGENTS.md - Claude Brain

Guidelines for agentic coding agents working in this repository.

## Build, Test, and Lint Commands

```bash
# Build the project (outputs to dist/)
npm run build

# Run all tests
npm test

# Run a single test file
npx vitest run src/__tests__/mind-lock.test.ts

# Run a single test by name pattern
npx vitest run -t "writes all frames"

# Run tests in watch mode
npx vitest

# Type checking
npm run typecheck

# Linting
npm run lint

# Run lint with auto-fix
npx eslint src/ --fix

# Full verification before commit
npm run typecheck && npm run lint && npm test && npm run build
```

## Project Overview

Claude Brain is a dual-platform plugin that provides persistent memory via a single portable `.mv2` file. Works with both Claude Code and OpenCode. The architecture consists of:

- **src/core/mind.ts** - Main Mind class using @memvid/sdk for storage
- **src/hooks/** - Claude Code hooks (session-start, post-tool-use, stop, smart-install)
- **src/hooks/opencode/** - OpenCode plugin (exports Plugin with event handlers)
- **src/utils/** - Helpers, compression, file locking, file capture
- **src/scripts/** - CLI scripts for search/ask/stats/timeline
- **commands/** - Slash command definitions (.md files)
- **skills/** - Skill definitions for Claude Code
- **.opencode/** - OpenCode plugin manifest

## Code Style Guidelines

### Imports

```typescript
// Node.js built-ins use "node:" prefix
import { existsSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { mkdir } from "node:fs/promises";

// Type-only imports use `type` keyword
import {
  type Observation,
  type ObservationType,
  DEFAULT_CONFIG,
} from "../types.js";

// Relative imports MUST include .js extension (ESM requirement)
import { generateId, estimateTokens } from "../utils/helpers.js";
```

### Type Definitions

```typescript
// Union types with inline comments for each variant
export type ObservationType =
  | "discovery"      // New information discovered
  | "decision"       // Decision made
  | "problem"        // Problem identified
  | "solution";      // Solution implemented

// Interfaces for object shapes
export interface Observation {
  id: string;
  timestamp: number;
  type: ObservationType;
  tool?: string;           // Optional properties use ?
  metadata?: ObservationMetadata;
}

// Use `as const` for constant objects
const LOCK_OPTIONS = {
  stale: 30000,
  retries: {
    retries: 1000,
    minTimeout: 5,
    maxTimeout: 50,
  },
} as const;

// Use Record for simple key-value types
topTypes: Record<ObservationType, number>;

// Index signatures for flexible objects
[key: string]: unknown;  // Allow additional properties
```

### Functions and Methods

```typescript
/**
 * JSDoc comment describing purpose
 * @param paramName - Description of parameter
 * @returns Description of return value
 */
export function generateId(): string {
  return randomBytes(8).toString("hex");
}

// Early returns preferred over nested conditionals
function classifyObservationType(toolName: string, output: string): ObservationType {
  const lowerOutput = output.toLowerCase();

  if (lowerOutput.includes("error")) {
    return "problem";
  }

  if (lowerOutput.includes("success")) {
    return "success";
  }

  return "discovery";
}

// Private helper functions without JSDoc
function extractImports(code: string): string[] {
  // Implementation
}
```

### Error Handling

```typescript
// Hooks MUST NOT block on errors - always continue
try {
  await mind.remember({ type, summary, content });
} catch (error) {
  debug(`Error: ${error}`);
  // Don't block - continue execution
  writeOutput({ continue: true });
}

// Non-critical operations use empty catch blocks
try {
  unlinkSync(backups[i].path);
} catch {
  // Ignore errors deleting backups
}

// Safe JSON parsing with fallback
export function safeJsonParse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
```

### Classes

```typescript
export class Mind {
  private memvid: Memvid;
  private config: MindConfig;
  private initialized = false;  // Inline initialization for defaults

  private constructor(memvid: Memvid, config: MindConfig) {
    this.memvid = memvid;
    this.config = config;
  }

  // Static factory methods preferred over constructors
  static async open(configOverrides: Partial<MindConfig> = {}): Promise<Mind> {
    const config = { ...DEFAULT_CONFIG, ...configOverrides };
    // ...
  }

  // Public methods with JSDoc
  async remember(input: { type: ObservationType; summary: string }): Promise<string> {
    // Implementation
  }

  // Private methods for internal logic
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    // Implementation
  }
}
```

### File Organization

```typescript
/**
 * File header comment describing the module's purpose
 * 
 * Additional context about implementation details.
 */

// 1. Type definitions and constants at the top
type Memvid = any;

const TARGET_COMPRESSED_SIZE = 2000;

// 2. Imports grouped by source
import { existsSync } from "node:fs";
import { type Observation, DEFAULT_CONFIG } from "../types.js";
import { generateId } from "../utils/helpers.js";

// 3. Helper functions
function pruneBackups(memoryPath: string): void { /* ... */ }

// 4. Main exports (classes, functions)
export class Mind { /* ... */ }

// 5. Singleton instances at the bottom
let mindInstance: Mind | null = null;

export function getMind(): Promise<Mind> { /* ... */ }
```

### ESLint Rules

- `@typescript-eslint/no-unused-vars`: Error (args starting with `_` ignored)
- `@typescript-eslint/no-explicit-any`: Warning (use `// eslint-disable-next-line` when intentional)

```typescript
// When any is necessary, add disable comment
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let use: any;
```

### Testing

```typescript
import { describe, it, expect } from "vitest";

describe("Feature name", () => {
  it("should do something specific", async () => {
    const { dir, path } = makeTempMemoryPath();
    try {
      // Arrange
      const writes = 5;

      // Act
      for (let i = 0; i < writes; i++) {
        await writeOnce(path, i);
      }

      // Assert
      const stats = await mind.stats();
      expect(stats.totalObservations).toBe(writes);
    } finally {
      // Always clean up resources
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Set timeout for slow tests
  it("handles concurrent access", async () => {
    // ...
  }, 15000);
});
```

## Project-Specific Patterns

### Claude Code Hook Implementation

- SessionStart: Lightweight, no SDK loading (fast startup)
- PostToolUse: Capture observations, compress large outputs
- Stop: Capture file changes, generate session summary
- All hooks use `writeOutput({ continue: true })` on error to never block

### OpenCode Plugin Implementation

- **tool.execute.after**: Maps from PostToolUse - captures observations for Read/Edit/Write/Bash/Grep/Glob
- **event handler**: Handles session.created (context injection) and session.idle (file changes)
- Uses function parameters directly instead of stdin/stdout
- All handlers catch errors and continue gracefully

### File Locking

Use `withMemvidLock` for all memvid file operations:

```typescript
await withMemvidLock(lockPath, async () => {
  return memvid.put({ title, label, text, metadata });
});
```

### Debug Logging

```typescript
// Debug messages only shown when MEMVID_MIND_DEBUG=1
debug(`Processing: ${toolName}`);
console.error(`[memvid-mind] Important error message`);
```

### Memory File Paths

```typescript
// Always resolve relative to CLAUDE_PROJECT_DIR
const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const memoryPath = resolve(projectDir, ".claude/mind.mv2");
```

## Git Conventions

- Use conventional commits: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`
- Feature branches only - never commit directly to main
- Run tests before every commit
- Releases: Update version in package.json, create git tag `v*`, push tag

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd sync
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
