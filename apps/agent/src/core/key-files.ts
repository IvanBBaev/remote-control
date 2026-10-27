import { DeviceId, EpochMs, PairedDeviceKey, PairedPasskey } from '@remote-control/protocol';
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

/**
 * `peers.json` (0600, data dir): the paired phones, their static public keys and the
 * passkeys they handed over at pairing (M2-03; absent for a phone paired before), and
 * the native app's device key (M4-04).
 */
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
          passkeys: z
            .array(
              PairedPasskey.extend({
                counter: z.int().min(0).max(0xffff_ffff),
              }),
            )
            .max(16)
            .optional(),
          deviceKey: PairedDeviceKey.optional(),
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

/**
 * `relay.json` (0600, data dir): the agent's relay bearer token (from `remotectl login`)
 * and the account it belongs to. The relay never tells a device its user id, but the
 * Noise prologues bind it (D3, D6), so `login` records it next to the token.
 */
export const RelayCredentialsFile = z
  .object({
    version: z.literal(1),
    token: z.string().min(1).max(512),
    userId: DeviceId,
  })
  .strict();
export type RelayCredentialsFile = z.infer<typeof RelayCredentialsFile>;
