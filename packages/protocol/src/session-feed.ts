import { z } from 'zod';

import { ChangedFile, type Session } from './domain/session.js';
import type { SnapshotMessage } from './messages.js';

// The live feed (M1-05): what a session did, mapped by the agent from its hook events and
// applied by both sides to the thin session view (D21). No diff bodies: a changed file
// carries only its name and line counts.

/**
 * Largest end-to-end message, in UTF-8 bytes of its JSON: one Noise transport frame's
 * plaintext (`MAX_PLAINTEXT_BYTES` in `@remote-control/crypto`, mirrored here because
 * the protocol package does not depend on crypto).
 */
export const MAX_MESSAGE_BYTES = 65_276;
/** Steps a session keeps, newest last (D21). */
export const MAX_SESSION_STEPS = 20;
/** Characters per step. */
export const MAX_STEP_LENGTH = 200;
/** Changed files a session keeps, most recently first-changed last. */
export const MAX_CHANGED_FILES = 50;
/** Characters of a prompt or an answer. */
export const MAX_FEED_TEXT_LENGTH = 4000;
/** Characters of a tool call's input or response summary. */
export const MAX_TOOL_DETAIL_LENGTH = 2000;

const Step = z.string().min(1).max(MAX_STEP_LENGTH);

/**
 * One thing a session did. Every variant fits in a frame even when each character needs
 * a six-byte JSON escape, so an event never needs trimming after it is built.
 */
export const FeedEvent = z.discriminatedUnion('kind', [
  /** The user sent a prompt; a new turn starts. */
  z.strictObject({ kind: z.literal('prompt'), text: z.string().max(MAX_FEED_TEXT_LENGTH) }),
  /** A tool call finished. `file` is set for an edit, with its `+N −M`. */
  z.strictObject({
    kind: z.literal('tool'),
    tool: z.string().min(1).max(MAX_STEP_LENGTH),
    label: Step,
    input: z.string().max(MAX_TOOL_DETAIL_LENGTH),
    response: z.string().max(MAX_TOOL_DETAIL_LENGTH),
    truncated: z.boolean(),
    file: ChangedFile.optional(),
  }),
  /** The turn ended; `text` is the agent's last message, when it had one. */
  z.strictObject({
    kind: z.literal('stop'),
    text: z.string().max(MAX_FEED_TEXT_LENGTH).nullable(),
  }),
  z.strictObject({ kind: z.literal('subagent_stop') }),
  z.strictObject({ kind: z.literal('compact') }),
  z.strictObject({ kind: z.literal('notification'), text: Step }),
]);
export type FeedEvent = z.infer<typeof FeedEvent>;

/** The part of a session the feed writes; the agent's registry owns the rest. */
export type SessionContent = Pick<Session, 'lastPrompt' | 'lastAnswer' | 'steps' | 'changedFiles'>;

/** A session with nothing in it yet. */
export const EMPTY_CONTENT: SessionContent = Object.freeze({
  lastPrompt: null,
  lastAnswer: null,
  steps: [],
  changedFiles: [],
});

/** `text`, cut to `max` characters with an ellipsis. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The step a tool call shows: its label and the first line of its input. */
export function toolStep(label: string, input: string): string {
  const line = input.trim().split('\n', 1)[0]!.trim();
  return clip(line === '' ? label : `${label}: ${line}`, MAX_STEP_LENGTH);
}

function addStep(steps: readonly string[], step: string): string[] {
  return [...steps, step].slice(-MAX_SESSION_STEPS);
}

function addFile(files: readonly ChangedFile[], file: ChangedFile): ChangedFile[] {
  const index = files.findIndex((entry) => entry.name === file.name);
  if (index === -1) return [...files, file].slice(-MAX_CHANGED_FILES);
  const merged = {
    name: file.name,
    added: files[index]!.added + file.added,
    removed: files[index]!.removed + file.removed,
  };
  return files.map((entry, i) => (i === index ? merged : entry));
}

/**
 * The session content after `event`. A prompt starts a new turn: it clears the steps and
 * the answer but keeps the changed files, which add up over the whole session.
 */
export function applyFeedEvent<T extends SessionContent>(session: T, event: FeedEvent): T {
  switch (event.kind) {
    case 'prompt':
      return { ...session, lastPrompt: event.text, lastAnswer: null, steps: [] };
    case 'tool':
      return {
        ...session,
        steps: addStep(session.steps, toolStep(event.label, event.input)),
        changedFiles:
          event.file === undefined
            ? session.changedFiles
            : addFile(session.changedFiles, event.file),
      };
    case 'stop':
      return { ...session, lastAnswer: event.text };
    case 'subagent_stop':
      return { ...session, steps: addStep(session.steps, 'Subagent finished') };
    case 'compact':
      return { ...session, steps: addStep(session.steps, 'Context compacted') };
    case 'notification':
      return { ...session, steps: addStep(session.steps, event.text) };
  }
}

const encoder = new TextEncoder();

/** The UTF-8 size of a message's JSON, as the agent seals it. */
export function messageBytes(message: unknown): number {
  return encoder.encode(JSON.stringify(message)).length;
}

function contentBytes(session: Session): number {
  return messageBytes([
    session.lastPrompt,
    session.lastAnswer,
    session.steps,
    session.changedFiles,
  ]);
}

/**
 * A snapshot that fits in one frame: while it is too large, the session with the most
 * content loses it (it stays listed, thin), then the last sessions are left out. Returns
 * the snapshot unchanged when it already fits; it may still not fit when the rest of it
 * (machine, repositories) is too large on its own.
 */
export function fitSnapshot(
  message: SnapshotMessage,
  maxBytes: number = MAX_MESSAGE_BYTES,
): SnapshotMessage {
  if (messageBytes(message) <= maxBytes) return message;
  const sessions = [...message.sessions];
  const order = sessions
    .map((session, index) => ({ index, size: contentBytes(session) }))
    .sort((a, b) => b.size - a.size);
  const fitted = (): SnapshotMessage => ({ ...message, sessions });
  for (const { index } of order) {
    sessions[index] = { ...sessions[index]!, ...EMPTY_CONTENT };
    if (messageBytes(fitted()) <= maxBytes) return fitted();
  }
  while (sessions.length > 0) {
    sessions.pop();
    if (messageBytes(fitted()) <= maxBytes) return fitted();
  }
  return fitted();
}
