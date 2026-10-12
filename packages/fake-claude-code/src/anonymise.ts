/**
 * Fixture anonymiser for recorded hook payloads (07 §5.4). It keeps the shape (the key
 * set, the enum-like fields) and replaces every path, ID and piece of content with a
 * synthetic value, then refuses the result if anything that looks personal survived.
 */

/** 07 §5.4: no committed fixture may match this. */
export const FORBIDDEN_PATTERN = /\/Users\/|\/home\/(?!synthetic)|C:\\Users|ivan|baev|@gmail/i;

export const SYNTHETIC_CWD = '/home/synthetic/project';
export const SYNTHETIC_IDS: Readonly<Record<string, string>> = {
  session_id: '00000000-0000-4000-8000-000000000001',
  prompt_id: 'prompt_synthetic01',
  agent_id: 'agent_synthetic01',
  tool_use_id: 'toolu_synthetic01',
};

const TRANSCRIPT_DIR = '/home/synthetic/.claude/projects/-home-synthetic-project';
const SYNTHETIC_PATHS: Readonly<Record<string, string>> = {
  cwd: SYNTHETIC_CWD,
  transcript_path: `${TRANSCRIPT_DIR}/${SYNTHETIC_IDS.session_id}.jsonl`,
  agent_transcript_path: `${TRANSCRIPT_DIR}/${SYNTHETIC_IDS.session_id}/subagents/${SYNTHETIC_IDS.agent_id}.jsonl`,
  scratchpad_dir: '/home/synthetic/scratchpad',
};

/** Top-level fields kept verbatim: they carry the contract, not the user's content. */
const KEPT_FIELDS = new Set([
  'hook_event_name',
  'tool_name',
  'permission_mode',
  'notification_type',
  'source',
  'reason',
  'stop_hook_active',
  'trigger',
  'agent_type',
]);

/** Keys inside content whose short identifier-like values are enums (07 §5.4). */
const ENUM_KEYS = new Set([
  'type',
  'behavior',
  'destination',
  'toolName',
  'mode',
  'multiSelect',
  'interrupted',
]);

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENUM_VALUE = /^[A-Za-z_][A-Za-z0-9_:-]{0,63}$/;

export const PLACEHOLDER = '<redacted>';

export class AnonymiseError extends Error {
  /** JSON paths of the offending values; the values themselves are never echoed. */
  readonly paths: readonly string[];

  constructor(paths: readonly string[]) {
    super(`forbidden content survived anonymisation at: ${paths.join(', ')}`);
    this.paths = paths;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Replaces strings with a placeholder, recursively; numbers, booleans and null stay. */
function scrub(value: unknown, key: string | undefined): unknown {
  if (typeof value === 'string') {
    return key !== undefined && ENUM_KEYS.has(key) && ENUM_VALUE.test(value) ? value : PLACEHOLDER;
  }
  if (Array.isArray(value)) return value.map((item) => scrub(item, key));
  if (isRecord(value)) {
    let renamed = 0;
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => {
        // Keys that are content themselves (a question text, a file path) are renamed.
        const safeKey = IDENTIFIER.test(childKey) ? childKey : `key_${String((renamed += 1))}`;
        return [safeKey, scrub(child, childKey)];
      }),
    );
  }
  return value;
}

function findForbidden(value: unknown, path: string, found: string[]): void {
  if (typeof value === 'string') {
    if (FORBIDDEN_PATTERN.test(value)) found.push(path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => findForbidden(item, `${path}[${String(index)}]`, found));
    return;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_PATTERN.test(key)) found.push(`${path}{key}`);
      findForbidden(child, `${path}.${key}`, found);
    }
  }
}

/** Throws `AnonymiseError` if any key or string value matches `FORBIDDEN_PATTERN`. */
export function assertNoForbidden(value: unknown): void {
  const found: string[] = [];
  findForbidden(value, '$', found);
  if (found.length > 0) throw new AnonymiseError(found);
}

export interface AnonymiseMeta {
  readonly claudeCodeVersion: string;
  /** ISO 8601 capture time (from the recording, not from a clock). */
  readonly capturedAt: string;
}

/** Anonymises one recorded hook payload (07 §5.4) and verifies the result. */
export function anonymisePayload(
  payload: Readonly<Record<string, unknown>>,
  meta: AnonymiseMeta,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === '_meta') continue;
    const syntheticPath = SYNTHETIC_PATHS[key];
    const syntheticId = SYNTHETIC_IDS[key];
    if (syntheticPath !== undefined && typeof value === 'string') out[key] = syntheticPath;
    else if (syntheticId !== undefined && typeof value === 'string') out[key] = syntheticId;
    else if (KEPT_FIELDS.has(key)) out[key] = value;
    else out[key] = scrub(value, undefined);
  }
  out._meta = { claude_code_version: meta.claudeCodeVersion, captured_at: meta.capturedAt };
  assertNoForbidden(out);
  return out;
}

/** The sorted top-level key set of a payload, without `_meta`. */
export function keySet(payload: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(payload)
    .filter((key) => key !== '_meta')
    .sort();
}

/** Per event: the distinct key sets seen, each as a sorted list (stable for snapshots). */
export function keySetsByEvent(
  payloads: readonly Readonly<Record<string, unknown>>[],
): Record<string, string[][]> {
  const byEvent = new Map<string, Map<string, string[]>>();
  for (const payload of payloads) {
    const event = typeof payload.hook_event_name === 'string' ? payload.hook_event_name : 'Unknown';
    const keys = keySet(payload);
    const seen = byEvent.get(event) ?? new Map<string, string[]>();
    seen.set(keys.join(','), keys);
    byEvent.set(event, seen);
  }
  return Object.fromEntries(
    [...byEvent.keys()].sort().map((event) => {
      const seen = byEvent.get(event) as Map<string, string[]>;
      return [event, [...seen.keys()].sort().map((signature) => seen.get(signature) as string[])];
    }),
  );
}
