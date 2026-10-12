import { DeviceId, EpochMs } from '@remote-control/protocol';
import { z } from 'zod';

import { fromBase64Url } from './from-base64url.js';

/** Raw 32-byte X25519 key as unpadded base64url. */
const Key32 = z
  .string()
  .refine((value) => fromBase64Url(value)?.length === 32, 'must be 32 bytes of base64url');

/**
 * `device-key.json` (0600, data dir): the agent's static X25519 key. The private key is
 * stored raw because WebCrypto keeps generated X25519 keys non-extractable; the agent
 * draws the 32 bytes from the `Random` port and imports them (Q16).
 */
export const DeviceKeyFile = z
  .object({
    version: z.literal(1),
    algorithm: z.literal('X25519'),
    privateKey: Key32,
    publicKey: Key32,
    createdAt: EpochMs,
  })
  .strict();
export type DeviceKeyFile = z.infer<typeof DeviceKeyFile>;

/** `peers.json` (0600, data dir): the paired phones and their static public keys. */
export const PeersFile = z
  .object({
    version: z.literal(1),
    peers: z.array(
      z
        .object({
          deviceId: DeviceId,
          name: z.string().min(1).max(64),
          publicKey: Key32,
          pairedAt: EpochMs,
        })
        .strict(),
    ),
  })
  .strict();
export type PeersFile = z.infer<typeof PeersFile>;

/**
 * `agent.json` (0600, data dir): where `hook.cjs` finds the running agent (D11, D22).
 * Rewritten at every start with a fresh token and the next `generation`.
 */
export const AgentEndpointFile = z
  .object({
    version: z.literal(1),
    port: z.int().min(1).max(65_535),
    token: z.string().min(1),
    generation: z.int().nonnegative(),
  })
  .strict();
export type AgentEndpointFile = z.infer<typeof AgentEndpointFile>;
