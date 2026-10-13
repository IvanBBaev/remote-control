import { z } from 'zod';

import {
  Ack,
  Hello,
  HelloOk,
  PeerRevoked,
  Ping,
  Pong,
  Presence,
  RelayError,
} from './control-frames.js';
import { Envelope } from './envelope.js';

/** Every frame that can travel on the WebSocket, discriminated by `kind`. */
export const Frame = z.discriminatedUnion('kind', [
  Envelope,
  Hello,
  HelloOk,
  Ack,
  Presence,
  Ping,
  Pong,
  RelayError,
  PeerRevoked,
]);
export type Frame = z.infer<typeof Frame>;

/** Every `kind` this protocol version knows. */
export const FRAME_KINDS: readonly Frame['kind'][] = [
  'data',
  'hello',
  'hello_ok',
  'ack',
  'presence',
  'ping',
  'pong',
  'error',
  'peer_revoked',
];
