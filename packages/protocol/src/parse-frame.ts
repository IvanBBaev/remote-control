import { Frame, FRAME_KINDS } from './frame.js';
import { VERSION_TABLE } from './version.js';

/** Why a frame was refused, and the WebSocket close code that goes with it. */
export type FrameError =
  | { readonly code: 'bad_frame'; readonly closeCode: 1008 }
  | { readonly code: 'unsupported_version'; readonly closeCode: 4001 };

export type ParseFrameResult =
  { readonly ok: true; readonly frame: Frame } | { readonly ok: false; readonly error: FrameError };

const BAD_FRAME: ParseFrameResult = { ok: false, error: { code: 'bad_frame', closeCode: 1008 } };
const UNSUPPORTED: ParseFrameResult = {
  ok: false,
  error: { code: 'unsupported_version', closeCode: 4001 },
};

const knownKinds: ReadonlySet<unknown> = new Set(FRAME_KINDS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSupportedVersion(v: number): boolean {
  return v >= VERSION_TABLE.min_supported && v <= VERSION_TABLE.v;
}

/**
 * Decodes one WebSocket text message. Malformed JSON, a missing or non-integer `v`, a
 * missing `kind`, an unknown key or any schema violation is `bad_frame` (close 1008,
 * D14); a `v` outside the supported range or an unknown `kind` is `unsupported_version`
 * (close 4001, 03 §5.10).
 */
export function parseFrame(text: string): ParseFrameResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return BAD_FRAME;
  }
  if (!isRecord(value) || !Number.isInteger(value.v) || typeof value.kind !== 'string') {
    return BAD_FRAME;
  }
  if (!isSupportedVersion(value.v as number) || !knownKinds.has(value.kind)) {
    return UNSUPPORTED;
  }
  const parsed = Frame.safeParse(value);
  return parsed.success ? { ok: true, frame: parsed.data } : BAD_FRAME;
}
