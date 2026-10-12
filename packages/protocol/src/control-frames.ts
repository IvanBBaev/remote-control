import { z } from 'zod';

import { DeviceId, EnvelopeId, EpochMs } from './ids.js';
import { VERSION_TABLE } from './version.js';

// Control frames are plaintext and terminated by the relay (D14, 03 §5.5). Every frame
// carries `v` and is parsed strictly: an unknown key closes the socket with 1008.

const v = z.literal(VERSION_TABLE.v);
const ProtocolVersion = z.int().positive();
const DeviceKind = z.enum(['phone', 'agent']);

/** First frame from a device: the protocol range it speaks and its software version. */
export const Hello = z.strictObject({
  v,
  kind: z.literal('hello'),
  protocol: z.strictObject({ min: ProtocolVersion, max: ProtocolVersion }),
  client: z.strictObject({
    kind: DeviceKind,
    /** The device's package version (for the agent: the `remotectl` version). */
    version: z.string().min(1).max(64),
  }),
});
export type Hello = z.infer<typeof Hello>;

/** One device in the relay's presence snapshot. */
export const PresenceEntry = z.strictObject({
  deviceId: DeviceId,
  kind: DeviceKind,
  name: z.string().min(1).max(64),
  online: z.boolean(),
  lastSeen: EpochMs.nullable(),
});
export type PresenceEntry = z.infer<typeof PresenceEntry>;

/** Relay's answer to `hello`: negotiated version, its floor, and a presence snapshot. */
export const HelloOk = z.strictObject({
  v,
  kind: z.literal('hello_ok'),
  /** The negotiated protocol version. */
  protocol: ProtocolVersion,
  /** The oldest protocol version the relay still accepts. */
  min_supported: ProtocolVersion,
  deviceId: DeviceId,
  relayTs: EpochMs,
  presence: z.array(PresenceEntry).max(32),
});
export type HelloOk = z.infer<typeof HelloOk>;

/** Receipt for delivered envelopes. */
export const Ack = z.strictObject({
  v,
  kind: z.literal('ack'),
  ids: z.array(EnvelopeId).min(1).max(100),
});
export type Ack = z.infer<typeof Ack>;

/** A device of the same user came online or went offline. */
export const Presence = z.strictObject({
  v,
  kind: z.literal('presence'),
  deviceId: DeviceId,
  online: z.boolean(),
  at: EpochMs,
});
export type Presence = z.infer<typeof Presence>;

/** Application-level heartbeat. */
export const Ping = z.strictObject({ v, kind: z.literal('ping'), t: EpochMs });
export type Ping = z.infer<typeof Ping>;

/** Heartbeat answer; echoes `t` and adds the relay clock. */
export const Pong = z.strictObject({ v, kind: z.literal('pong'), t: EpochMs, relayTs: EpochMs });
export type Pong = z.infer<typeof Pong>;

/** Error codes the relay reports in an `error` frame. */
export const RelayErrorCode = z.enum([
  'bad_frame',
  'unknown_device',
  'expired',
  'rate_limited',
  'unsupported_version',
]);
export type RelayErrorCode = z.infer<typeof RelayErrorCode>;

/** Relay-reported error, optionally referring to the envelope that caused it. */
export const RelayError = z.strictObject({
  v,
  kind: z.literal('error'),
  code: RelayErrorCode,
  ref: EnvelopeId.nullable(),
  message: z.string().max(200),
});
export type RelayError = z.infer<typeof RelayError>;
