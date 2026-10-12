import type { X25519KeyPair } from '@remote-control/crypto';

/** The agent's long-term static key (Noise `s`), loaded from the data directory. */
export interface DeviceKey {
  readonly keyPair: X25519KeyPair;
  /** Unix epoch milliseconds of key creation. */
  readonly createdAt: number;
  /** True when this call generated the key (first start). */
  readonly created: boolean;
}

/** A paired phone, as stored in `peers.json`. */
export interface Peer {
  readonly deviceId: string;
  readonly name: string;
  /** The phone's static X25519 public key, unpadded base64url. */
  readonly publicKey: string;
  /** Unix epoch milliseconds. */
  readonly pairedAt: number;
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
  /** Removes a peer; returns false when it was not present. */
  removePeer(deviceId: string): Promise<boolean>;
}
