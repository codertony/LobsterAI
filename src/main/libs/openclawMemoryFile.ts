/**
 * OpenClaw MEMORY.md file-based memory management.
 *
 * Reads and writes the curated long-term memory file that OpenClaw's
 * memory_search / memory_get tools index automatically.
 *
 * File format:
 *   # User Memories
 *
 *   - Entry one
 *   - Entry two
 */

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TAG = '[OpenClaw Memory]';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OpenClawMemoryEntry {
  /** SHA-1 of the normalised text – stable across reads. */
  id: string;
  /** Raw text without the leading "- ". */
  text: string;
}

export interface OpenClawMemoryStats {
  total: number;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const DEFAULT_OPENCLAW_WORKSPACE = path.join(os.homedir(), '.openclaw', 'workspace');

/**
 * Resolve the MEMORY.md path from the user-configured working directory.
 * Falls back to `~/.openclaw/workspace/MEMORY.md` when unset.
 */
export function resolveMemoryFilePath(workingDirectory: string | undefined): string {
  const dir = (workingDirectory || '').trim();
  const resolved = path.join(dir || DEFAULT_OPENCLAW_WORKSPACE, 'MEMORY.md');
  console.log(`${TAG} resolveMemoryFilePath: workingDirectory=${dir || '(empty)'} → ${resolved}`);
  return resolved;
}

// ---------------------------------------------------------------------------
// Fingerprinting (matches sqliteStore.ts logic)
// ---------------------------------------------------------------------------

function normalizeForFingerprint(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fingerprint(text: string): string {
  return crypto.createHash('sha1').update(normalizeForFingerprint(text)).digest('hex');
}

// ---------------------------------------------------------------------------
// Parsing & serialisation
// ---------------------------------------------------------------------------

const HEADER = '# User Memories';

/**
 * Parse a MEMORY.md file into entries.
 *
 * Recognises lines starting with `- ` (one or more dashes + space).
 * Code blocks are stripped before parsing to avoid false positives.
 */
export function parseMemoryMd(content: string): OpenClawMemoryEntry[] {
  const stripped = content.replace(/```[\s\S]*?```/g, ' ');
  const lines = stripped.split(/\r?\n/);
  const entries: OpenClawMemoryEntry[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const match = line.trim().match(/^-+\s+(.+)$/);
    if (!match?.[1]) continue;
    const text = match[1].replace(/\s+/g, ' ').trim();
    if (!text || text.length < 2) continue;

    const fp = fingerprint(text);
    if (seen.has(fp)) continue;
    seen.add(fp);
    entries.push({ id: fp, text });
  }

  return entries;
}

/**
 * Serialise entries back to MEMORY.md format.
 */
export function serializeMemoryMd(entries: OpenClawMemoryEntry[]): string {
  if (entries.length === 0) return `${HEADER}\n`;
  const lines = entries.map((e) => `- ${e.text}`);
  return `${HEADER}\n\n${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// File I/O helpers
// ---------------------------------------------------------------------------

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    console.log(`${TAG} Creating directory: ${dir}`);
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readFileOrEmpty(filePath: string): string {
  try {
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      return fs.readFileSync(filePath, 'utf8');
    }
  } catch (error) {
    console.warn(`${TAG} Failed to read file ${filePath}:`, error instanceof Error ? error.message : error);
  }
  return '';
}

// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------

export function readMemoryEntries(filePath: string): OpenClawMemoryEntry[] {
  const entries = parseMemoryMd(readFileOrEmpty(filePath));
  console.log(`${TAG} readMemoryEntries: ${filePath} → ${entries.length} entries`);
  return entries;
}

export function writeMemoryEntries(filePath: string, entries: OpenClawMemoryEntry[]): void {
  ensureDir(filePath);
  fs.writeFileSync(filePath, serializeMemoryMd(entries), 'utf8');
  console.log(`${TAG} writeMemoryEntries: wrote ${entries.length} entries to ${filePath}`);
}

export function addMemoryEntry(filePath: string, text: string): OpenClawMemoryEntry {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (!trimmed) throw new Error('Memory text is required');

  const entries = readMemoryEntries(filePath);
  const entry: OpenClawMemoryEntry = { id: fingerprint(trimmed), text: trimmed };

  // Deduplicate
  if (entries.some((e) => e.id === entry.id)) {
    console.log(`${TAG} addMemoryEntry: duplicate skipped (id=${entry.id.slice(0, 8)}…)`);
    return entry;
  }

  entries.push(entry);
  writeMemoryEntries(filePath, entries);
  console.log(`${TAG} addMemoryEntry: added "${trimmed.slice(0, 40)}…" (id=${entry.id.slice(0, 8)}…)`);
  return entry;
}

export function updateMemoryEntry(
  filePath: string,
  id: string,
  newText: string,
): OpenClawMemoryEntry | null {
  const trimmed = newText.replace(/\s+/g, ' ').trim();
  if (!trimmed) throw new Error('Memory text is required');

  const entries = readMemoryEntries(filePath);
  const idx = entries.findIndex((e) => e.id === id);
  if (idx === -1) {
    console.warn(`${TAG} updateMemoryEntry: entry not found (id=${id.slice(0, 8)}…)`);
    return null;
  }

  const updated: OpenClawMemoryEntry = { id: fingerprint(trimmed), text: trimmed };
  const oldText = entries[idx].text;
  entries[idx] = updated;
  writeMemoryEntries(filePath, entries);
  console.log(`${TAG} updateMemoryEntry: "${oldText.slice(0, 30)}…" → "${trimmed.slice(0, 30)}…"`);
  return updated;
}

export function deleteMemoryEntry(filePath: string, id: string): boolean {
  const entries = readMemoryEntries(filePath);
  const target = entries.find((e) => e.id === id);
  const filtered = entries.filter((e) => e.id !== id);
  if (filtered.length === entries.length) {
    console.warn(`${TAG} deleteMemoryEntry: entry not found (id=${id.slice(0, 8)}…)`);
    return false;
  }

  writeMemoryEntries(filePath, filtered);
  console.log(`${TAG} deleteMemoryEntry: removed "${target?.text.slice(0, 40)}…" (${entries.length} → ${filtered.length})`);
  return true;
}

export function searchMemoryEntries(
  filePath: string,
  query: string,
): OpenClawMemoryEntry[] {
  const q = query.toLowerCase().trim();
  if (!q) return readMemoryEntries(filePath);
  const all = readMemoryEntries(filePath);
  const results = all.filter((e) => e.text.toLowerCase().includes(q));
  console.log(`${TAG} searchMemoryEntries: query="${q}" → ${results.length}/${all.length} matched`);
  return results;
}

// ---------------------------------------------------------------------------
// SQLite → MEMORY.md migration (lazy, one-time)
// ---------------------------------------------------------------------------

export interface MigrationDataSource {
  /** Whether migration was already performed. */
  isMigrationDone(): boolean;
  /** Mark migration as completed. */
  markMigrationDone(): void;
  /** Retrieve active memory texts from SQLite (status != 'deleted'). */
  getActiveMemoryTexts(): string[];
}

/**
 * Migrate old SQLite user_memories to MEMORY.md.
 * Returns the number of entries migrated (0 if already done or nothing to migrate).
 */
export function migrateSqliteToMemoryMd(
  filePath: string,
  source: MigrationDataSource,
): number {
  if (source.isMigrationDone()) return 0;

  console.log(`${TAG} Migration: starting SQLite → MEMORY.md migration (target: ${filePath})`);

  const texts = source.getActiveMemoryTexts();
  if (texts.length === 0) {
    console.log(`${TAG} Migration: no active SQLite memories found, marking done`);
    source.markMigrationDone();
    return 0;
  }

  console.log(`${TAG} Migration: found ${texts.length} active SQLite memories to migrate`);

  try {
    const existing = readMemoryEntries(filePath);
    const existingIds = new Set(existing.map((e) => e.id));
    console.log(`${TAG} Migration: MEMORY.md has ${existing.length} existing entries`);

    let added = 0;
    let skipped = 0;
    for (const raw of texts) {
      const text = raw.replace(/\s+/g, ' ').trim();
      if (!text || text.length < 2) continue;
      const id = fingerprint(text);
      if (existingIds.has(id)) {
        skipped++;
        continue;
      }
      existing.push({ id, text });
      existingIds.add(id);
      added++;
    }

    if (added > 0) {
      writeMemoryEntries(filePath, existing);
    }

    console.log(`${TAG} Migration: completed — added=${added}, skipped(duplicate)=${skipped}, total=${existing.length}`);
    source.markMigrationDone();
    return added;
  } catch (error) {
    console.error(`${TAG} Migration: FAILED —`, error instanceof Error ? error.message : error);
    // Do NOT mark done so it retries next time
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Workspace change sync
// ---------------------------------------------------------------------------

/**
 * Sync MEMORY.md when workspace directory changes.
 * Copies entries from old path to new path (merge-dedup, keeps old file as backup).
 */
export function syncMemoryFileOnWorkspaceChange(
  oldWorkingDirectory: string | undefined,
  newWorkingDirectory: string | undefined,
): { synced: boolean; error?: string } {
  const oldPath = resolveMemoryFilePath(oldWorkingDirectory);
  const newPath = resolveMemoryFilePath(newWorkingDirectory);

  if (oldPath === newPath) {
    console.log(`${TAG} Workspace sync: same path, skipping`);
    return { synced: false };
  }

  console.log(`${TAG} Workspace sync: ${oldPath} → ${newPath}`);

  try {
    const oldContent = readFileOrEmpty(oldPath);
    if (!oldContent.trim()) {
      console.log(`${TAG} Workspace sync: old MEMORY.md empty or missing, skipping`);
      return { synced: false };
    }

    const oldEntries = parseMemoryMd(oldContent);
    if (oldEntries.length === 0) {
      console.log(`${TAG} Workspace sync: old MEMORY.md has no entries, skipping`);
      return { synced: false };
    }

    const newEntries = readMemoryEntries(newPath);
    const newIds = new Set(newEntries.map((e) => e.id));

    let added = 0;
    for (const entry of oldEntries) {
      if (newIds.has(entry.id)) continue;
      newEntries.push(entry);
      newIds.add(entry.id);
      added++;
    }

    if (added > 0) {
      writeMemoryEntries(newPath, newEntries);
    }

    // Ensure memory/ directory exists for OpenClaw daily logs
    const memoryDir = path.join(
      (newWorkingDirectory || '').trim() || DEFAULT_OPENCLAW_WORKSPACE,
      'memory',
    );
    if (!fs.existsSync(memoryDir)) {
      console.log(`${TAG} Workspace sync: creating memory/ dir at ${memoryDir}`);
      fs.mkdirSync(memoryDir, { recursive: true });
    }

    console.log(`${TAG} Workspace sync: done — copied ${added} new entries (old=${oldEntries.length}, new total=${newEntries.length})`);
    return { synced: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${TAG} Workspace sync: FAILED —`, message);
    return { synced: false, error: message };
  }
}
