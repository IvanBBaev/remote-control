import type { X25519KeyPair } from '@remote-control/crypto';

/** The agent's long-term static key (Noise `s`), loaded from the data directory. */
export interface DeviceKey {
  readonly keyPair: X25519KeyPair;
  /** Unix epoch milliseconds of key creation. */
  readonly createdAt: number;
  /** True when this call generated the key (first start). */
  readonly created: boolean;
}

/**
 * A passkey of the account, handed over by the phone inside the pairing handshake, so
 * the agent verifies decision assertions itself (D7 phase 2, M2-03).
 */
export interface PeerPasskey {
  /** Credential id, unpadded base64url. */
  readonly id: string;
  /** SubjectPublicKeyInfo (ES256), unpadded base64url. */
  readonly publicKey: string;
  /** The relying party id the credential is scoped to. */
  readonly rpId: string;
  /** The signature counter of the last verified assertion; 0 when none or unsupported. */
  readonly counter: number;
}

/** A paired phone, as stored in `peers.json`. */
export interface Peer {
  readonly deviceId: string;
  readonly name: string;
  /** The phone's static X25519 public key, unpadded base64url. */
  readonly publicKey: string;
  /** Unix epoch milliseconds. */
  readonly pairedAt: number;
  /**
   * The passkeys the phone handed over at pairing (M2-03). With at least one, every
   * decision that needs a passkey must carry an assertion the agent verifies; a phone
   * paired before M2-03 has none and keeps the relay's verification (phase 1).
   */
  readonly passkeys?: readonly PeerPasskey[];
}

/** The hook endpoint published in `agent.json` for `hook.cjs` (D11). */
export interface HookEndpoint {
  readonly port: number;
  /** Bearer token, unpadded base64url of 32 random bytes; new at every agent start. */
  readonly token: string;
  /** Increments at every publish, so a stale reader can tell agent restarts apart. */
  readonly generation: number;
}

/** The agent's relay credentials, as stored in `relay.json`. */
export interface RelayCredentials {
  /** Bearer token for the relay's agent endpoints and WebSocket. */
  readonly token: string;
  /** The account's user id, lower-case canonical UUID (bound into the Noise prologues). */
  readonly userId: string;
}

/**
 * Agent key material (Q16: plain files at 0600 in the env-paths data dir, no OS
 * keychain in MVP). Pairing (M0-16) adds peers; revocation (M1-10) removes them.
 */
export interface KeyStore {
  /** Loads the device key, generating and persisting it on first use. */
  loadOrCreateDeviceKey(): Promise<DeviceKey>;
  /** Loads the device key without creating it; `undefined` before the first `run`. */
  readDeviceKey(): Promise<DeviceKey | undefined>;
  listPeers(): Promise<readonly Peer[]>;
  /** Adds a peer, replacing an existing entry with the same `deviceId`. */
  addPeer(peer: Peer): Promise<void>;
  /**
   * Stores a passkey's new signature counter after a verified assertion (M2-03); a
   * missing peer or passkey is ignored.
   */
  recordPasskeyUse(deviceId: string, credentialId: string, counter: number): Promise<void>;
  /** Removes a peer; returns false when it was not present. */
  removePeer(deviceId: string): Promise<boolean>;
  /** Writes `agent.json` with the bound port and token; returns the stored endpoint. */
  publishHookEndpoint(endpoint: { port: number; token: string }): Promise<HookEndpoint>;
  /** The current `agent.json`, or `undefined` when missing or unreadable. */
  readHookEndpoint(): Promise<HookEndpoint | undefined>;
  /** The stored relay credentials, or `undefined` before `remotectl login`. */
  readRelayCredentials(): Promise<RelayCredentials | undefined>;
  /** Stores the relay credentials (0600); rejects an invalid record with `KeyStoreError`. */
  writeRelayCredentials(credentials: RelayCredentials): Promise<void>;
}
