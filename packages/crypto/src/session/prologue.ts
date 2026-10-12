import { concatBytes, utf8 } from '../bytes.js';
import { CryptoError } from '../errors.js';

// Canonical lower-case UUID text, as `users.id` and device ids are stored (D8).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function uuidBytes(value: string, what: string): Uint8Array<ArrayBuffer> {
  if (!UUID.test(value)) {
    throw new CryptoError('invalid_argument', `${what} must be a lower-case canonical UUID`);
  }
  return utf8(value);
}

/** Identity of the two ends of a phone ↔ agent session. */
export interface SessionPrologueInput {
  readonly userId: string;
  readonly phoneDeviceId: string;
  readonly agentDeviceId: string;
}

/**
 * KK prologue (D3): `"rc/v1" || user_id || phone_device_id || agent_device_id`, each id
 * as its 36-byte canonical UUID text. Fixed-length fields make plain concatenation
 * unambiguous; a handshake between any other pair of devices or users fails.
 */
export function sessionPrologue(input: SessionPrologueInput): Uint8Array<ArrayBuffer> {
  return concatBytes(
    utf8('rc/v1'),
    uuidBytes(input.userId, 'userId'),
    uuidBytes(input.phoneDeviceId, 'phoneDeviceId'),
    uuidBytes(input.agentDeviceId, 'agentDeviceId'),
  );
}

/** Identity of the pairing slot: the user and the agent device being paired. */
export interface PairingPrologueInput {
  readonly userId: string;
  readonly agentDeviceId: string;
}

/** XXpsk0 pairing prologue (02 §5.3): `"rc/v1/pair" || user_id || agent_device_id`. */
export function pairingPrologue(input: PairingPrologueInput): Uint8Array<ArrayBuffer> {
  return concatBytes(
    utf8('rc/v1/pair'),
    uuidBytes(input.userId, 'userId'),
    uuidBytes(input.agentDeviceId, 'agentDeviceId'),
  );
}
