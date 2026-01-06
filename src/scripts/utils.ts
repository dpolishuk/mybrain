/**
 * Shared utilities for Memvid Mind scripts
 */

import { existsSync, mkdirSync, unlinkSync, renameSync } from "node:fs";
import { dirname } from "node:path";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CreateFn = (path: string, kind: any) => Promise<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type UseFn = (kind: any, path: string) => Promise<any>;

/**
 * Create a fresh memory file at the given path
 */
export async function createFreshMemory(
  memoryPath: string,
  create: CreateFn
): Promise<void> {
  const memoryDir = dirname(memoryPath);
  mkdirSync(memoryDir, { recursive: true });
  await create(memoryPath, "basic");
}

/**
 * Check if an error indicates a corrupted or incompatible memory file
 */
export function isCorruptedMemoryError(error: unknown): boolean {
  const errorMessage =
    error instanceof Error ? error.message : String(error);
  return (
    errorMessage.includes("Deserialization") ||
    errorMessage.includes("UnexpectedVariant") ||
    errorMessage.includes("Invalid") ||
    errorMessage.includes("corrupt") ||
    errorMessage.includes("version mismatch")
  );
}

/**
 * Handle corrupted memory file by backing it up and creating a fresh one
 */
export async function handleCorruptedMemory(
  memoryPath: string,
  create: CreateFn
): Promise<void> {
  console.log(
    "⚠️  Memory file is corrupted or incompatible. Creating fresh memory..."
  );
  // Backup corrupted file
  const backupPath = `${memoryPath}.backup-${Date.now()}`;
  try {
    renameSync(memoryPath, backupPath);
    console.log(`   Old file backed up to: ${backupPath}`);
  } catch {
    try {
      unlinkSync(memoryPath);
    } catch {
      // Ignore unlink errors
    }
  }
  await createFreshMemory(memoryPath, create);
}

/**
 * Open a memory file, handling corruption by creating fresh memory if needed
 * Returns the opened memvid instance, or null if memory was recreated (caller should exit)
 */
export async function openMemorySafely(
  memoryPath: string,
  use: UseFn,
  create: CreateFn
): Promise<{ memvid: unknown; isNew: boolean }> {
  // Auto-create if doesn't exist
  if (!existsSync(memoryPath)) {
    console.log("No memory file found. Creating new memory at:", memoryPath);
    await createFreshMemory(memoryPath, create);
    return { memvid: null, isNew: true };
  }

  // Try to open, handle corrupted files
  try {
    const memvid = await use("basic", memoryPath);
    return { memvid, isNew: false };
  } catch (openError: unknown) {
    if (isCorruptedMemoryError(openError)) {
      await handleCorruptedMemory(memoryPath, create);
      return { memvid: null, isNew: true };
    }
    // Re-throw other errors
    throw openError;
  }
}
