import { X25519_KEY_LENGTH, bytesEqual, x25519KeyPairFromPrivateKey } from '@remote-control/crypto';
import { toBase64Url } from '@remote-control/protocol';

import { fromBase64Url } from '../core/from-base64url.js';
import { DeviceKeyFile, PeersFile } from '../core/key-files.js';
import type { Clock } from '../ports/clock.js';
import type { FileSystem } from '../ports/file-system.js';
import type { DeviceKey, KeyStore, Peer } from '../ports/key-store.js';
import type { PathPort } from '../ports/path-port.js';
import type { Random } from '../ports/random.js';

/** Owner read/write only (Q16). */
export const SECRET_FILE_MODE = 0o600;
/** Owner-only data directory. */
export const SECRET_DIR_MODE = 0o700;
export const DEVICE_KEY_FILE = 'device-key.json';
export const PEERS_FILE = 'peers.json';

/** A key file exists but cannot be used; the agent refuses to start rather than re-key. */
export class KeyStoreError extends Error {
  override readonly name = 'KeyStoreError';
}

export interface FileKeyStoreOptions {
  /** The env-paths `data` directory. */
  readonly dir: string;
  readonly fs: FileSystem;
  readonly paths: PathPort;
  readonly random: Random;
  readonly clock: Clock;
  /** POSIX permission handling; off on Windows, where ACLs of the profile apply. */
  readonly enforcePermissions: boolean;
  /** Reports a repaired permission (a file found wider than 0600). */
  readonly onWarning?: (message: string) => void;
}

function decodeJson(text: string, file: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new KeyStoreError(`${file} is not valid JSON`);
  }
}

/**
 * `KeyStore` as plain files in the data directory (Q16, D22): `device-key.json` and
 * `peers.json`, both 0600 in a 0700 directory, written atomically. A file found with
 * group/other permission bits is tightened back to 0600 and reported.
 */
export function createFileKeyStore(options: FileKeyStoreOptions): KeyStore {
  const { dir, fs, paths } = options;
  const keyPath = paths.join(dir, DEVICE_KEY_FILE);
  const peersPath = paths.join(dir, PEERS_FILE);

  async function readSecret(path: string): Promise<string | undefined> {
    const text = await fs.readText(path);
    if (text === undefined || !options.enforcePermissions) return text;
    const mode = await fs.permissions(path);
    if (mode !== undefined && (mode & 0o077) !== 0) {
      await fs.chmod(path, SECRET_FILE_MODE);
      options.onWarning?.(
        `${path} had mode ${mode.toString(8).padStart(3, '0')}; tightened to 600`,
      );
    }
    return text;
  }

  async function writeSecret(path: string, value: unknown): Promise<void> {
    await fs.ensureDir(dir, SECRET_DIR_MODE);
    await fs.writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`, SECRET_FILE_MODE);
  }

  async function readDeviceKey(): Promise<DeviceKey | undefined> {
    const text = await readSecret(keyPath);
    if (text === undefined) return undefined;
    const parsed = DeviceKeyFile.safeParse(decodeJson(text, DEVICE_KEY_FILE));
    if (!parsed.success) throw new KeyStoreError(`${DEVICE_KEY_FILE} has an invalid format`);
    // Both fields are validated as 32-byte base64url by the schema.
    const secret = fromBase64Url(parsed.data.privateKey) as Uint8Array;
    const keyPair = await x25519KeyPairFromPrivateKey(secret);
    if (!bytesEqual(keyPair.publicKey, fromBase64Url(parsed.data.publicKey) as Uint8Array)) {
      throw new KeyStoreError(`${DEVICE_KEY_FILE}: public key does not match the private key`);
    }
    return { keyPair, createdAt: parsed.data.createdAt, created: false };
  }

  async function readPeersFile(): Promise<PeersFile> {
    const text = await readSecret(peersPath);
    if (text === undefined) return { version: 1, peers: [] };
    const parsed = PeersFile.safeParse(decodeJson(text, PEERS_FILE));
    if (!parsed.success) throw new KeyStoreError(`${PEERS_FILE} has an invalid format`);
    return parsed.data;
  }

  return {
    readDeviceKey,
    async loadOrCreateDeviceKey() {
      const existing = await readDeviceKey();
      if (existing !== undefined) return existing;
      const secret = options.random.bytes(X25519_KEY_LENGTH);
      const keyPair = await x25519KeyPairFromPrivateKey(secret);
      const createdAt = options.clock.now();
      const file: DeviceKeyFile = {
        version: 1,
        algorithm: 'X25519',
        privateKey: toBase64Url(secret),
        publicKey: toBase64Url(keyPair.publicKey),
        createdAt,
      };
      secret.fill(0);
      await writeSecret(keyPath, file);
      return { keyPair, createdAt, created: true };
    },
    async listPeers() {
      return (await readPeersFile()).peers;
    },
    async addPeer(peer: Peer) {
      const parsed = PeersFile.shape.peers.element.safeParse(peer);
      if (!parsed.success) throw new KeyStoreError('peer record has an invalid format');
      const current = await readPeersFile();
      const peers = current.peers.filter((entry) => entry.deviceId !== peer.deviceId);
      await writeSecret(peersPath, { version: 1, peers: [...peers, parsed.data] });
    },
    async removePeer(deviceId: string) {
      const current = await readPeersFile();
      const peers = current.peers.filter((entry) => entry.deviceId !== deviceId);
      if (peers.length === current.peers.length) return false;
      await writeSecret(peersPath, { version: 1, peers });
      return true;
    },
  };
}
