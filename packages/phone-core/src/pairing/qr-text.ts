import { PSK_LENGTH } from '@remote-control/crypto';
import { toBase64Url } from '@remote-control/protocol';

/** What `remotectl pair` puts in the QR: `rc1:<relay-host>:<agent_device_id>:<psk>` (02 §5.3). */
export interface ScannedPairing {
  /** `host[:port]` of the relay the computer is connected to. */
  readonly relayHost: string;
  readonly agentDeviceId: string;
  /** The full 32-byte pre-shared key; never leaves the phone. */
  readonly psk: Uint8Array;
}

const PREFIX = 'rc1:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOST = /^[a-z0-9.-]+(:\d{1,5})?$/i;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Canonical unpadded base64url only, so one key has exactly one spelling. */
function decodeBase64Url(text: string): Uint8Array | undefined {
  if (!BASE64URL.test(text)) return undefined;
  const padded = text
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(text.length / 4) * 4, '=');
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return undefined;
  }
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return toBase64Url(bytes) === text ? bytes : undefined;
}

/**
 * Reads a scanned `rc1:` text; `undefined` for anything else. The host may carry a port,
 * so the fields are taken from the right.
 */
export function parsePairingQr(text: string): ScannedPairing | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith(PREFIX)) return undefined;
  const rest = trimmed.slice(PREFIX.length);
  const pskAt = rest.lastIndexOf(':');
  const idAt = rest.lastIndexOf(':', pskAt - 1);
  if (pskAt < 0 || idAt <= 0) return undefined;
  const relayHost = rest.slice(0, idAt);
  const agentDeviceId = rest.slice(idAt + 1, pskAt);
  const psk = decodeBase64Url(rest.slice(pskAt + 1));
  if (!HOST.test(relayHost) || !UUID.test(agentDeviceId)) return undefined;
  if (psk?.length !== PSK_LENGTH) return undefined;
  return { relayHost, agentDeviceId, psk };
}
