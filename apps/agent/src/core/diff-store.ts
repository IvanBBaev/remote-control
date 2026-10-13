import {
  MAX_CHANGED_FILES,
  MAX_DIFF_LENGTH,
  MAX_DIFF_LINES,
  MAX_MESSAGE_BYTES,
  messageBytes,
  type DiffMessage,
  type DiffRequestMessage,
} from '@remote-control/protocol';
import { structuredPatch } from 'diff';

import type { HookInput } from './hook-dispatcher.js';
import { MAX_FEED_SESSIONS } from './session-feed.js';

// On-demand diffs (M2-02, 05 W11): each file tool's hunks, kept in memory per session and
// file, sent only when a phone asks for one (D21: never pushed, never in the feed).

/** One unified diff hunk; `lines` start with ` `, `+`, `-` or `\`. */
export interface Hunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly string[];
}

/** Characters one file's kept hunks may take; older hunks go first. */
export const MAX_FILE_DIFF_LENGTH = 256 * 1024;
/** Characters all kept hunks may take; the least recently updated session goes first. */
export const MAX_DIFF_STORE_LENGTH = 8 * 1024 * 1024;
/** Characters of one diff line as sent; longer lines are cut. */
export const MAX_DIFF_LINE_LENGTH = 1000;
/** Lines of context around a change the agent computes itself. */
const CONTEXT_LINES = 3;

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function count(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isHunk(value: unknown): value is Hunk {
  const hunk = record(value);
  return (
    count(hunk['oldStart']) &&
    count(hunk['oldLines']) &&
    count(hunk['newStart']) &&
    count(hunk['newLines']) &&
    Array.isArray(hunk['lines']) &&
    hunk['lines'].every((line) => typeof line === 'string' && /^[ +\-\\]/.test(line))
  );
}

function hunksOf(before: string, after: string): Hunk[] {
  return structuredPatch('a', 'b', before, after, '', '', { context: CONTEXT_LINES }).hunks;
}

/**
 * The hunks of an `Edit`, `Write` or `MultiEdit`: Claude Code's `structuredPatch` from the
 * response when it is well formed (real line numbers), else computed from `tool_input`.
 * `undefined` for any other tool or a payload without a file.
 */
export function fileHunks(
  toolName: string,
  input: unknown,
  response: unknown,
): { readonly file: string; readonly hunks: readonly Hunk[] } | undefined {
  const fields = record(input);
  const file = text(fields['file_path']);
  if (file === undefined || file === '' || file.length > 4096) return undefined;
  if (toolName !== 'Write' && toolName !== 'Edit' && toolName !== 'MultiEdit') return undefined;
  const reported = record(response)['structuredPatch'];
  if (Array.isArray(reported) && reported.length > 0 && reported.every(isHunk)) {
    return { file, hunks: reported };
  }
  if (toolName === 'Write') {
    const before = text(record(response)['originalFile']) ?? '';
    return { file, hunks: hunksOf(before, text(fields['content']) ?? '') };
  }
  const edits = toolName === 'Edit' ? [fields] : fields['edits'];
  if (!Array.isArray(edits)) return undefined;
  // An edit is a fragment, not a whole file: its end is no file's end.
  const hunks = edits.flatMap((edit) =>
    hunksOf(text(record(edit)['old_string']) ?? '', text(record(edit)['new_string']) ?? '').map(
      (hunk) => ({ ...hunk, lines: hunk.lines.filter((line) => !line.startsWith('\\')) }),
    ),
  );
  return { file, hunks };
}

function hunkHeader(hunk: Hunk): string {
  const { oldStart, oldLines, newStart, newLines } = hunk;
  return `@@ -${String(oldStart)},${String(oldLines)} +${String(newStart)},${String(newLines)} @@`;
}

function hunkLength(hunk: Hunk): number {
  return hunk.lines.reduce((sum, line) => sum + line.length + 1, hunkHeader(hunk).length + 1);
}

/** The first `keep` lines of `hunk`, its counts recomputed from what is left. */
function cutHunk(hunk: Hunk, keep: number): Hunk {
  const lines = hunk.lines.slice(0, keep);
  return {
    ...hunk,
    oldLines: lines.filter((line) => line[0] === ' ' || line[0] === '-').length,
    newLines: lines.filter((line) => line[0] === ' ' || line[0] === '+').length,
    lines,
  };
}

/** How many of `hunk`'s lines (with its header) fit in `length` characters. */
function linesWithin(hunk: Hunk, length: number): number {
  let used = hunkHeader(hunk).length + 1;
  let keep = 0;
  for (const line of hunk.lines) {
    used += line.length + 1;
    if (used > length) break;
    keep += 1;
  }
  return keep;
}

/**
 * The newest hunks that fit `maxLength` characters, oldest first. A newest hunk too big
 * on its own is cut to its first lines.
 */
function newestWithin(
  hunks: readonly Hunk[],
  maxLength: number,
): { hunks: Hunk[]; truncated: boolean } {
  const kept: Hunk[] = [];
  let used = 0;
  for (let index = hunks.length - 1; index >= 0; index -= 1) {
    const hunk = hunks[index]!;
    const size = hunkLength(hunk);
    if (used + size <= maxLength) {
      kept.unshift(hunk);
      used += size;
      continue;
    }
    if (kept.length === 0) {
      const keep = linesWithin(hunk, maxLength);
      if (keep > 0) kept.unshift(cutHunk(hunk, keep));
    }
    return { hunks: kept, truncated: true };
  }
  return { hunks: kept, truncated: false };
}

/**
 * The patch text a phone gets (`DiffMessage.patch`): the newest hunks within
 * `MAX_DIFF_LINES` lines and `MAX_DIFF_LENGTH` characters, each line cut to
 * `MAX_DIFF_LINE_LENGTH`; `truncated` when anything was left out.
 */
export function fitPatch(
  hunks: readonly Hunk[],
  maxLines: number = MAX_DIFF_LINES,
  maxLength: number = MAX_DIFF_LENGTH,
): { readonly patch: string; readonly truncated: boolean } {
  let truncated = false;
  const clipped = hunks.map((hunk) => {
    if (hunk.lines.every((line) => line.length <= MAX_DIFF_LINE_LENGTH)) return hunk;
    truncated = true;
    return { ...hunk, lines: hunk.lines.map((line) => line.slice(0, MAX_DIFF_LINE_LENGTH)) };
  });
  const kept: Hunk[] = [];
  let lines = 0;
  for (let index = clipped.length - 1; index >= 0; index -= 1) {
    const hunk = clipped[index]!;
    if (lines + hunk.lines.length + 1 <= maxLines) {
      kept.unshift(hunk);
      lines += hunk.lines.length + 1;
      continue;
    }
    truncated = true;
    if (kept.length === 0 && maxLines > 1) kept.unshift(cutHunk(hunk, maxLines - 1));
    break;
  }
  const fitted = newestWithin(kept, maxLength);
  const patch = fitted.hunks.map((hunk) => [hunkHeader(hunk), ...hunk.lines].join('\n')).join('\n');
  return { patch, truncated: truncated || fitted.truncated };
}

/**
 * The answer to a phone's `diff_request`: the fitted patch, shortened further until the
 * message fits one frame (escaped or multi-byte text takes more bytes than characters).
 */
export function diffMessage(
  request: DiffRequestMessage,
  stored: StoredDiff | undefined,
): DiffMessage {
  const base = { t: 'diff' as const, requestId: request.requestId, sessionId: request.sessionId };
  if (stored === undefined) return { ...base, file: request.file, patch: null, truncated: false };
  let maxLength = MAX_DIFF_LENGTH;
  for (;;) {
    const fitted = fitPatch(stored.hunks, MAX_DIFF_LINES, maxLength);
    const message: DiffMessage = {
      ...base,
      file: request.file,
      patch: fitted.patch,
      truncated: stored.truncated || fitted.truncated,
    };
    if (maxLength === 0 || messageBytes(message) <= MAX_MESSAGE_BYTES) return message;
    maxLength = Math.floor(maxLength / 2);
  }
}

interface FileDiff {
  readonly hunks: readonly Hunk[];
  readonly length: number;
  readonly truncated: boolean;
}

export interface StoredDiff {
  readonly hunks: readonly Hunk[];
  /** Older hunks were dropped to fit the store's caps. */
  readonly truncated: boolean;
}

/** Per-session, per-file hunks from hook events; memory only, lost on restart. */
export interface DiffStore {
  observe(input: HookInput): void;
  get(sessionId: string, file: string): StoredDiff | undefined;
}

export interface DiffStoreLimits {
  readonly fileLength?: number;
  readonly storeLength?: number;
  readonly sessions?: number;
}

export function createDiffStore(limits: DiffStoreLimits = {}): DiffStore {
  const fileLength = limits.fileLength ?? MAX_FILE_DIFF_LENGTH;
  const storeLength = limits.storeLength ?? MAX_DIFF_STORE_LENGTH;
  const maxSessions = limits.sessions ?? MAX_FEED_SESSIONS;
  /** Sessions, and each session's files, in least recently updated order. */
  const sessions = new Map<string, Map<string, FileDiff>>();
  let total = 0;

  function dropSession(id: string): void {
    for (const diff of sessions.get(id)?.values() ?? []) total -= diff.length;
    sessions.delete(id);
  }

  function dropFile(files: Map<string, FileDiff>): void {
    const [file, diff] = files.entries().next().value!;
    total -= diff.length;
    files.delete(file);
  }

  return {
    observe(input) {
      if (input.hook_event_name !== 'PostToolUse') return;
      const found = fileHunks(
        text(input['tool_name']) ?? '',
        input['tool_input'],
        input['tool_response'],
      );
      if (found === undefined || found.hunks.length === 0) return;
      const id = input.session_id;
      const files = sessions.get(id) ?? new Map<string, FileDiff>();
      const before = files.get(found.file);
      const fitted = newestWithin([...(before?.hunks ?? []), ...found.hunks], fileLength);
      const length = fitted.hunks.reduce((sum, hunk) => sum + hunkLength(hunk), 0);
      total += length - (before?.length ?? 0);
      files.delete(found.file);
      files.set(found.file, {
        hunks: fitted.hunks,
        length,
        truncated: (before?.truncated ?? false) || fitted.truncated,
      });
      // Re-inserted, so the map's order is least recently updated first.
      sessions.delete(id);
      sessions.set(id, files);
      if (files.size > MAX_CHANGED_FILES) dropFile(files);
      while (sessions.size > maxSessions || (sessions.size > 1 && total > storeLength)) {
        dropSession(sessions.keys().next().value!);
      }
      // One session alone over the budget gives up its least recently changed files.
      while (total > storeLength && files.size > 1) dropFile(files);
    },
    get(sessionId, file) {
      const diff = sessions.get(sessionId)?.get(file);
      return diff === undefined ? undefined : { hunks: diff.hunks, truncated: diff.truncated };
    },
  };
}
