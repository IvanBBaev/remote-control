import type { PathPort } from '../../ports/path-port.js';
import type { TranscriptEntry, TranscriptTailer } from '../../ports/transcript-tailer.js';

// The transcript backfill (M3, 04 W11): our own reader of Claude Code's session JSONL
// (04 §2.6, ADR 0014). It reads only what the thin session view shows (D21) — prompts,
// finished tool calls, turn ends and compactions — and skips everything else. The format
// is unstable, so every line is optional: an unknown or malformed line is counted and
// skipped, never thrown (04 risk 5).

/** Bytes read from the end of a transcript: the feed keeps one turn, not the session. */
export const MAX_TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;

/**
 * A user line that Claude Code writes on the user's behalf: a slash command, its output,
 * a background-task notification or a reminder. Not a prompt the user typed.
 */
const WRAPPED = /^\s*<[a-z][\w-]*>/i;

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function blocks(content: unknown): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(content)) return [];
  return content.map(record).filter((block) => block !== undefined);
}

/** The text of a content field: a string, or its `text` blocks joined. */
function contentText(content: unknown): string {
  const plain = text(content);
  if (plain !== undefined) return plain;
  return blocks(content)
    .filter((block) => block['type'] === 'text')
    .map((block) => text(block['text']) ?? '')
    .join('\n');
}

interface ToolCall {
  readonly name: string;
  readonly input: unknown;
}

export interface ParsedTranscript {
  readonly entries: readonly TranscriptEntry[];
  /** Lines that were not a JSON object. */
  readonly malformed: number;
}

/**
 * The steps a transcript records, as the hook events that report them live. A tool call
 * counts once its result is written (`PostToolUse`); a turn ends at the next prompt
 * (`Stop`, with the turn's last assistant text), or at the end of the text when nothing
 * is left running. Subagent lines (`isSidechain`) belong to their own feed and are skipped.
 */
export function parseTranscript(body: string): ParsedTranscript {
  const entries: TranscriptEntry[] = [];
  const calls = new Map<string, ToolCall>();
  // Compaction boundaries: the user line right after one is the summary, not a prompt.
  const boundaries = new Set<string>();
  let malformed = 0;
  let inTurn = false;
  let answer: string | undefined;
  // The last main line was assistant text with no tool call: the turn may be over.
  let settled = false;
  let cwd: string | undefined;

  const endTurn = () => {
    if (inTurn) {
      entries.push({
        hook_event_name: 'Stop',
        ...(answer === undefined ? {} : { last_assistant_message: answer }),
      });
    }
    inTurn = false;
    answer = undefined;
    settled = false;
    calls.clear();
  };
  const prompt = (value: string) => {
    if (value.trim() === '' || WRAPPED.test(value)) return;
    endTurn();
    entries.push({ hook_event_name: 'UserPromptSubmit', prompt: value });
    inTurn = true;
  };

  for (const raw of body.split('\n')) {
    if (raw.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      malformed += 1;
      continue;
    }
    const line = record(parsed);
    if (line === undefined) {
      malformed += 1;
      continue;
    }
    if (line['isSidechain'] === true) continue;
    cwd = text(line['cwd']) ?? cwd;
    const uuid = text(line['uuid']);
    const message = record(line['message']);
    switch (line['type']) {
      case 'system':
        if (line['subtype'] === 'compact_boundary') {
          if (uuid !== undefined) boundaries.add(uuid);
          entries.push({ hook_event_name: 'PreCompact' });
        }
        break;
      case 'assistant': {
        const content = message?.['content'];
        const said = contentText(content);
        if (said.trim() !== '') answer = said;
        const uses = blocks(content).filter((block) => block['type'] === 'tool_use');
        for (const block of uses) {
          const id = text(block['id']);
          const name = text(block['name']);
          if (id !== undefined && name !== undefined)
            calls.set(id, { name, input: block['input'] ?? null });
        }
        settled = uses.length === 0 && said.trim() !== '';
        break;
      }
      case 'user': {
        if (line['isMeta'] === true || line['isCompactSummary'] === true) break;
        const parent = text(line['parentUuid']);
        if (parent !== undefined && boundaries.has(parent)) break;
        const content = message?.['content'];
        const results = blocks(content).filter((block) => block['type'] === 'tool_result');
        if (results.length === 0) {
          prompt(contentText(content));
          break;
        }
        settled = false;
        for (const result of results) {
          const id = text(result['tool_use_id']);
          const call = id === undefined ? undefined : calls.get(id);
          if (call === undefined) continue;
          calls.delete(id!);
          entries.push({
            hook_event_name: 'PostToolUse',
            tool_name: call.name,
            tool_input: call.input,
            tool_response: contentText(result['content']),
            ...(cwd === undefined ? {} : { cwd }),
          });
        }
        break;
      }
      default:
        break;
    }
  }
  // A turn that ended on assistant text, with no tool call left running, is over.
  if (settled && calls.size === 0) endTurn();
  return { entries, malformed };
}

export interface TranscriptTailerOptions {
  /** Claude Code's config dir (`$CLAUDE_CONFIG_DIR` or `~/.claude`); transcripts live under `projects/`. */
  readonly claudeConfigDir: string;
  readonly paths: PathPort;
  /** Size in bytes; 0 when the file is gone. */
  size(path: string): Promise<number>;
  /** Reads the bytes `[start, end)` as UTF-8. */
  read(path: string, start: number, end: number): Promise<string>;
  /** Counts and codes only, never a path or a line (I3). */
  log(event: string, fields: Readonly<Record<string, unknown>>): void;
  readonly maxBytes?: number;
}

/**
 * The Claude Code `TranscriptTailer`. It reads only a `.jsonl` file inside Claude Code's
 * `projects/` folder (after `realpath`), since the path comes from a hook payload.
 */
export function createTranscriptTailer(options: TranscriptTailerOptions): TranscriptTailer {
  const maxBytes = options.maxBytes ?? MAX_TRANSCRIPT_TAIL_BYTES;
  const allowed = async (path: string): Promise<string | undefined> => {
    if (!path.endsWith('.jsonl') || !options.paths.isAbsolute(path)) return undefined;
    const root = await options.paths.realpath(
      options.paths.join(options.claudeConfigDir, 'projects'),
    );
    const file = await options.paths.realpath(path);
    if (root === undefined || file === undefined) return undefined;
    return options.paths.contains(root, file) && file !== root ? file : undefined;
  };
  return {
    async history(path) {
      try {
        const file = await allowed(path);
        if (file === undefined) {
          options.log('transcript_skipped', { reason: 'path' });
          return [];
        }
        const size = await options.size(file);
        const start = Math.max(0, size - maxBytes);
        let body = await options.read(file, start, size);
        // The first line of a tail is cut; the next newline starts a whole one.
        if (start > 0) {
          const newline = body.indexOf('\n');
          body = newline === -1 ? '' : body.slice(newline + 1);
        }
        const { entries, malformed } = parseTranscript(body);
        options.log('transcript_read', {
          bytes: size - start,
          entries: entries.length,
          malformed,
          truncated: start > 0,
        });
        return entries;
      } catch (error) {
        options.log('transcript_failed', { code: (error as NodeJS.ErrnoException).code ?? null });
        return [];
      }
    },
  };
}
