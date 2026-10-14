import {
  applyFeedEvent,
  clip,
  EMPTY_CONTENT,
  MAX_FEED_TEXT_LENGTH,
  MAX_STEP_LENGTH,
  MAX_TOOL_DETAIL_LENGTH,
  toolInfo,
  type ChangedFile,
  type FeedEvent,
  type SessionContent,
} from '@remote-control/protocol';

import type { TranscriptEntry } from '../ports/transcript-tailer.js';
import { toolContent, toolLabel } from './approval-view.js';
import type { HookInput } from './hook-dispatcher.js';

// The live feed (M1-05, 04 §5.5): hook events mapped to the thin session view (D21).

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function lines(value: unknown): string[] {
  const body = text(value) ?? '';
  return body === '' ? [] : body.replace(/\n$/, '').split('\n');
}

/** `+N −M` of replacing `before` with `after`: the lines between the common ends. */
export function lineCounts(before: unknown, after: unknown): { added: number; removed: number } {
  const old = lines(before);
  const next = lines(after);
  let start = 0;
  while (start < old.length && start < next.length && old[start] === next[start]) start += 1;
  let end = 0;
  while (
    end < old.length - start &&
    end < next.length - start &&
    old[old.length - 1 - end] === next[next.length - 1 - end]
  ) {
    end += 1;
  }
  return { added: next.length - start - end, removed: old.length - start - end };
}

/**
 * The changed file of an `Edit`, `Write` or `MultiEdit`, counted from `tool_input` (the
 * response's patch format is not pinned, 04 §2.4). `Write` counts every line as added.
 */
export function changedFile(toolName: string, input: unknown): ChangedFile | undefined {
  const fields = record(input);
  const name = text(fields['file_path']);
  if (name === undefined || name === '' || name.length > 4096) return undefined;
  if (toolName === 'Write') return { name, added: lines(fields['content']).length, removed: 0 };
  if (toolName === 'Edit') {
    return { name, ...lineCounts(fields['old_string'], fields['new_string']) };
  }
  if (toolName === 'MultiEdit' && Array.isArray(fields['edits'])) {
    const total = { name, added: 0, removed: 0 };
    for (const edit of fields['edits']) {
      const counts = lineCounts(record(edit)['old_string'], record(edit)['new_string']);
      total.added += counts.added;
      total.removed += counts.removed;
    }
    return total;
  }
  return undefined;
}

/** A tool's response, as a short text: a command's output, else the JSON. */
function responseText(response: unknown): string {
  if (response === undefined || response === null) return '';
  if (typeof response === 'string') return response;
  const fields = record(response);
  const stdout = text(fields['stdout']);
  if (stdout !== undefined) {
    const stderr = text(fields['stderr']) ?? '';
    return stderr === '' ? stdout : `${stdout}\n${stderr}`;
  }
  return JSON.stringify(response) ?? '';
}

/**
 * What a file tool's input shows: the path inside the session's folder, else the file
 * name (D21: no full path without a tap).
 */
function fileInput(content: string, cwd: unknown): string {
  const root = text(cwd);
  if (root !== undefined && root !== '') {
    const prefix = root.endsWith('/') || root.endsWith('\\') ? root : `${root}/`;
    if (content.startsWith(prefix)) return content.slice(prefix.length);
  }
  return content.split(/[\\/]/).at(-1)!;
}

function toolEvent(input: HookInput): FeedEvent | undefined {
  const tool = text(input['tool_name']);
  if (tool === undefined || tool === '') return undefined;
  const { kind } = toolInfo(tool);
  const toolInput = input['tool_input'] ?? null;
  let content = toolContent(toolInput, tool);
  if (kind === 'file') content = fileInput(content, input['cwd']);
  // A file tool's response repeats the file's contents: no diff bodies (D21).
  const response = kind === 'file' ? '' : responseText(input['tool_response']);
  const file = changedFile(tool, toolInput);
  return {
    kind: 'tool',
    tool: clip(tool, MAX_STEP_LENGTH),
    label: clip(toolLabel(tool), MAX_STEP_LENGTH),
    input: clip(content, MAX_TOOL_DETAIL_LENGTH),
    response: clip(response, MAX_TOOL_DETAIL_LENGTH),
    truncated: content.length > MAX_TOOL_DETAIL_LENGTH || response.length > MAX_TOOL_DETAIL_LENGTH,
    ...(file === undefined ? {} : { file }),
  };
}

/** The feed event of a hook event, or `undefined` when the view does not show it. */
export function mapHookEvent(input: HookInput): FeedEvent | undefined {
  switch (input.hook_event_name) {
    case 'UserPromptSubmit':
      return { kind: 'prompt', text: clip(text(input['prompt']) ?? '', MAX_FEED_TEXT_LENGTH) };
    case 'PostToolUse':
      return toolEvent(input);
    case 'Stop': {
      const answer = text(input['last_assistant_message']);
      return {
        kind: 'stop',
        text: answer === undefined ? null : clip(answer, MAX_FEED_TEXT_LENGTH),
      };
    }
    case 'SubagentStop':
      return { kind: 'subagent_stop' };
    case 'PreCompact':
      return { kind: 'compact' };
    case 'Notification': {
      const message = text(input['message'])?.trim() ?? '';
      return { kind: 'notification', text: clip(message || 'Notification', MAX_STEP_LENGTH) };
    }
    default:
      return undefined;
  }
}

/** Sessions whose content the feed keeps; the oldest-updated one goes first. */
export const MAX_FEED_SESSIONS = 100;

export interface FeedEntry {
  readonly content: SessionContent;
  /** Events applied so far (`EventMessage.seq` of the last one). */
  readonly seq: number;
}

/** What a backfill matches a history event to a live one by: kind and visible text. */
function eventKey(event: FeedEvent): string {
  switch (event.kind) {
    case 'prompt':
      return `prompt\0${event.text}`;
    case 'tool':
      return `tool\0${event.tool}\0${event.input}`;
    default:
      return event.kind;
  }
}

export interface MergedHistory {
  /** The session's events: history, then live, each event once. */
  readonly events: FeedEvent[];
  /** History events past the live ones: their hooks have not arrived yet. */
  readonly ahead: FeedEvent[];
}

/**
 * `history` and `live` as one run of events. The transcript is read while live events
 * arrive, so it may already hold some of them, and some it holds may not have arrived
 * yet: the live events are placed at the latest point of `history` they continue (the
 * history from there is a head of `live`, or `live` is a head of it).
 */
export function mergeHistory(
  history: readonly FeedEvent[],
  live: readonly FeedEvent[],
): MergedHistory {
  if (live.length === 0) return { events: [...history], ahead: [] };
  const historyKeys = history.map(eventKey);
  const liveKeys = live.map(eventKey);
  for (let start = history.length - 1; start >= 0; start -= 1) {
    const shared = Math.min(history.length - start, live.length);
    if (liveKeys.slice(0, shared).every((key, i) => key === historyKeys[start + i])) {
      const ahead = history.slice(start + live.length);
      return { events: [...history.slice(0, start), ...live, ...ahead], ahead };
    }
  }
  return { events: [...history, ...live], ahead: [] };
}

/** Per-session content, built from hook events; lost on restart. */
export interface SessionFeed {
  /** Applies a hook event; the session's new sequence number, or `undefined` if not shown. */
  observe(input: HookInput): { readonly event: FeedEvent; readonly seq: number } | undefined;
  get(sessionId: string): FeedEntry | undefined;
  /**
   * Starts a transcript backfill (M3, 04 W11) for a session the feed has not seen: its
   * live events are also kept until `backfill`. False when the session is known or a
   * backfill is already running.
   */
  startBackfill(sessionId: string): boolean;
  /**
   * Rebuilds the session from its transcript `history` and the live events since
   * `startBackfill`, under a new sequence number (the phone takes it from a snapshot).
   * Live events the history already showed are then skipped by `observe`. `undefined`
   * when the history adds nothing or no backfill was started.
   */
  backfill(sessionId: string, history: readonly TranscriptEntry[]): FeedEntry | undefined;
}

export function createSessionFeed(): SessionFeed {
  const entries = new Map<string, FeedEntry>();
  // Session id → live events seen while its backfill runs.
  const pending = new Map<string, FeedEvent[]>();
  // Session id → keys of history events a backfill showed before their hooks arrived.
  const ahead = new Map<string, string[]>();
  const store = (id: string, entry: FeedEntry) => {
    // Re-inserted, so the map's order is least recently updated first.
    entries.delete(id);
    entries.set(id, entry);
    if (entries.size > MAX_FEED_SESSIONS) entries.delete(entries.keys().next().value!);
  };
  return {
    observe(input) {
      const event = mapHookEvent(input);
      if (event === undefined) return undefined;
      const id = input.session_id;
      const expected = ahead.get(id);
      if (expected !== undefined) {
        if (expected[0] === eventKey(event)) {
          expected.shift();
          if (expected.length === 0) ahead.delete(id);
          return undefined;
        }
        ahead.delete(id);
      }
      pending.get(id)?.push(event);
      const before = entries.get(id) ?? { content: EMPTY_CONTENT, seq: 0 };
      const entry = { content: applyFeedEvent(before.content, event), seq: before.seq + 1 };
      store(id, entry);
      return { event, seq: entry.seq };
    },
    get(sessionId) {
      return entries.get(sessionId);
    },
    startBackfill(sessionId) {
      if (entries.has(sessionId) || pending.has(sessionId)) return false;
      pending.set(sessionId, []);
      return true;
    },
    backfill(sessionId, history) {
      const live = pending.get(sessionId);
      if (live === undefined) return undefined;
      pending.delete(sessionId);
      const events = history
        .map((entry) => mapHookEvent({ ...entry, session_id: sessionId }))
        .filter((event) => event !== undefined);
      const merged = mergeHistory(events, live);
      if (merged.events.length === live.length) return undefined;
      if (merged.ahead.length > 0) ahead.set(sessionId, merged.ahead.map(eventKey));
      const entry = {
        content: merged.events.reduce(applyFeedEvent, EMPTY_CONTENT),
        seq: (entries.get(sessionId)?.seq ?? 0) + 1,
      };
      store(sessionId, entry);
      return entry;
    },
  };
}
