import { deriveNotificationKey, sealPushSummary, type X25519KeyPair } from '@remote-control/crypto';
import {
  encodePushSummary,
  toolInfo,
  type PushSummary,
  type Random,
} from '@remote-control/protocol';

import type { Peer } from '../ports/key-store.js';
import { projectName, toolCall, toolLabel } from './approval-view.js';
import { fromBase64Url } from './from-base64url.js';
import type { HookInput } from './hook-dispatcher.js';
import type { PendingRequest } from './pending-store.js';

/** The summary line cap: a lock screen shows about two lines anyway. */
const MAX_LINE_LENGTH = 120;

const SECRET_NAME = String.raw`[\w.-]*(?:token|secret|key|pass|pwd|auth|credential|cookie|session)[\w.-]*`;
const SECRET_VALUE = String.raw`(?:"[^"]*"|'[^']*'|\S+)`;

/** Secret-looking spans and their replacements; `$1` keeps the part that names them. */
const MASKS: readonly (readonly [RegExp, string])[] = [
  // Bearer xyz, also outside an Authorization header; curl -u user:pass.
  [/(\bBearer\s+)\S+/gi, '$1***'],
  [/(\s-u\s+)\S+/g, '$1***'],
  // NAME=value, NAME: value (env assignments, headers, config).
  [new RegExp(String.raw`(\b${SECRET_NAME}\s*[=:]\s*)${SECRET_VALUE}`, 'gi'), '$1***'],
  // --password value, -token=value.
  [new RegExp(String.raw`(--?${SECRET_NAME}(?:\s+|=))${SECRET_VALUE}`, 'gi'), '$1***'],
  // https://user:pass@host.
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@'],
  // AWS access key ids, then any long token-like run with both letters and digits.
  [/\bAKIA[0-9A-Z]{16}\b/g, '***'],
  [/(?=[\w+=-]*\d)(?=[\w+=-]*[A-Za-z])[\w+=-]{24,}/g, '***'],
];

/** Masks what looks like a secret (D5: a push never carries one). */
export function maskSecrets(text: string): string {
  return MASKS.reduce(
    (masked, [pattern, replacement]) => masked.replace(pattern, replacement),
    text,
  );
}

function stringField(input: unknown, key: string): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function firstLine(text: string): string {
  return text
    .split('\n')
    .find((line) => line.trim() !== '')!
    .trim();
}

/** A file path relative to the session folder when inside it, else its last segment. */
function shortPath(path: string, cwd: unknown): string {
  if (typeof cwd === 'string' && cwd !== '') {
    const base = cwd.replace(/[\\/]+$/, '');
    if (path.startsWith(`${base}/`) || path.startsWith(`${base}\\`)) {
      return path.slice(base.length + 1);
    }
  }
  return path.split(/[\\/]+/).findLast((segment) => segment !== '') ?? path;
}

/** A URL without its query, fragment and credentials; `undefined` when it does not parse. */
function shortUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return undefined;
  }
}

/**
 * The one summary line a push may show (D5): a command's first line, a file path, a
 * search pattern, a URL without its query or a search query, a subagent's description.
 * Never file contents (no `content`, `new_string`, `prompt`); secrets are masked.
 */
export function pushSummaryLine(
  toolName: string,
  toolInput: unknown,
  cwd: unknown,
): string | undefined {
  const field = (key: string) => stringField(toolInput, key);
  let line: string | undefined;
  switch (toolInfo(toolName).kind) {
    case 'command':
      line = field('command');
      break;
    case 'file': {
      const path = field('file_path') ?? field('notebook_path') ?? field('path');
      line = path === undefined ? undefined : shortPath(path, cwd);
      break;
    }
    case 'search':
      line = field('pattern');
      break;
    case 'web': {
      const url = field('url');
      line = url === undefined ? field('query') : shortUrl(url);
      break;
    }
    case 'agent':
      line = field('description');
      break;
    default:
      line = undefined;
  }
  return line === undefined ? undefined : shortLine(line);
}

/** The first non-empty line, secrets masked, cut to {@link MAX_LINE_LENGTH} code points. */
function shortLine(text: string): string {
  const masked = maskSecrets(firstLine(text));
  const points = Array.from(masked);
  return points.length <= MAX_LINE_LENGTH
    ? masked
    : `${points.slice(0, MAX_LINE_LENGTH - 1).join('')}…`;
}

/** The encoded summary of a pending permission request; `undefined` when it has none. */
export function pushSummaryText(request: PendingRequest): string | undefined {
  const { toolName, toolInput } = toolCall(request);
  if (toolName === '') return undefined;
  const cwd = request.payload['cwd'];
  const project = projectName(cwd);
  const line = pushSummaryLine(toolName, toolInput, cwd);
  try {
    return encodePushSummary({
      v: 1,
      l: toolLabel(toolName),
      ...(project === undefined ? {} : { p: project }),
      ...(line === undefined ? {} : { s: line }),
      r: request.id,
    });
  } catch {
    return undefined;
  }
}

/** A turn notice (M2-08): the turn finished, or the agent waits for input. */
export type NoticeKind = NonNullable<PushSummary['k']>;

/** Which turn notices the user turned on (`notifications` in the config, default off). */
export interface NoticeSettings {
  readonly turnFinished: boolean;
  readonly needsInput: boolean;
}

const NOTICE_LABELS: Readonly<Record<NoticeKind, string>> = {
  finished: 'Turn finished',
  input: 'Needs your input',
};

/**
 * The notice a feed hook event asks for, if the user turned it on (M2-08): `Stop` ends a
 * turn (unless a stop hook keeps the agent going), `Notification` of type
 * `agent_needs_input` waits for the terminal (04 §2.4). Anything else: none.
 */
export function noticeKind(input: HookInput, settings: NoticeSettings): NoticeKind | undefined {
  if (input.hook_event_name === 'Stop') {
    return settings.turnFinished && input['stop_hook_active'] !== true ? 'finished' : undefined;
  }
  if (
    input.hook_event_name === 'Notification' &&
    input['notification_type'] === 'agent_needs_input'
  ) {
    return settings.needsInput ? 'input' : undefined;
  }
  return undefined;
}

/**
 * The encoded summary of a turn notice: project and a fixed label. A needs-input notice
 * adds Claude Code's own message line (masked); a finished turn adds nothing, because
 * the last assistant message may quote file contents (D5).
 */
export function noticeSummaryText(input: HookInput, kind: NoticeKind): string {
  const project = projectName(input['cwd']);
  const message = kind === 'input' ? stringField(input, 'message') : undefined;
  return encodePushSummary({
    v: 1,
    l: NOTICE_LABELS[kind],
    ...(project === undefined ? {} : { p: project }),
    ...(message === undefined ? {} : { s: shortLine(message) }),
    k: kind,
  });
}

/** Seals summaries per phone; the notification key is derived once per paired phone. */
export interface PushSealer {
  /** The base64 `pushBlob` for one envelope to `peer`; `undefined` when it cannot seal. */
  seal(peer: Peer, envelopeId: string, summary: string): Promise<string | undefined>;
}

type NotificationKey = Awaited<ReturnType<typeof deriveNotificationKey>>;

export function createPushSealer(
  ownPrivateKey: X25519KeyPair['privateKey'],
  random: Random,
): PushSealer {
  const keys = new Map<string, Promise<NotificationKey>>();
  const encoder = new TextEncoder();

  function keyFor(peer: Peer): Promise<NotificationKey> {
    let key = keys.get(peer.publicKey);
    if (key === undefined) {
      const publicKey = fromBase64Url(peer.publicKey);
      key =
        publicKey === undefined
          ? Promise.reject(new Error('peer public key is not base64url'))
          : deriveNotificationKey(ownPrivateKey, publicKey, ['encrypt']);
      keys.set(peer.publicKey, key);
    }
    return key;
  }

  return {
    async seal(peer, envelopeId, summary) {
      try {
        const sealed = await sealPushSummary(
          await keyFor(peer),
          envelopeId,
          encoder.encode(summary),
          random,
        );
        return Buffer.from(sealed).toString('base64');
      } catch {
        return undefined;
      }
    },
  };
}
