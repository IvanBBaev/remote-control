import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { toBase64Url } from '@remote-control/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Peer } from '../ports/key-store.js';
import {
  DEVICE_KEY_FILE,
  KeyStoreError,
  PEERS_FILE,
  createFileKeyStore,
  type FileKeyStoreOptions,
} from './file-key-store.js';
import { createNodeFileSystem, nodePaths } from './node-file-system.js';
import { systemRandom } from './system-random.js';

const posixOnly = process.platform === 'win32' ? it.skip : it;
const NOW = 1_760_000_000_000;

const peer = (n: number, name = `phone ${n}`): Peer => ({
  deviceId: `00000000-0000-4000-8000-00000000000${n}`,
  name,
  publicKey: toBase64Url(new Uint8Array(32).fill(n)),
  pairedAt: NOW + n,
});

describe('createFileKeyStore', () => {
  let base: string;
  let dir: string;
  let warnings: string[];

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'remotectl-keys-'));
    dir = join(base, 'data');
    warnings = [];
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  function store(overrides: Partial<FileKeyStoreOptions> = {}) {
    return createFileKeyStore({
      dir,
      fs: createNodeFileSystem(systemRandom),
      paths: nodePaths,
      random: systemRandom,
      clock: { now: () => NOW },
      enforcePermissions: true,
      onWarning: (message) => warnings.push(message),
      ...overrides,
    });
  }

  it('creates the device key once and loads the same key afterwards', async () => {
    const keys = store();
    expect(await keys.readDeviceKey()).toBeUndefined();
    const created = await keys.loadOrCreateDeviceKey();
    expect(created).toMatchObject({ created: true, createdAt: NOW });
    const loaded = await keys.loadOrCreateDeviceKey();
    expect(loaded.created).toBe(false);
    expect(loaded.keyPair.publicKey).toEqual(created.keyPair.publicKey);
    const file = JSON.parse(await readFile(join(dir, DEVICE_KEY_FILE), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(file).toMatchObject({
      version: 1,
      algorithm: 'X25519',
      publicKey: toBase64Url(created.keyPair.publicKey),
      createdAt: NOW,
    });
    expect(file['privateKey']).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  posixOnly('keeps key files at 0600 in a 0700 directory (Q16)', async () => {
    const keys = store();
    await keys.loadOrCreateDeviceKey();
    await keys.addPeer(peer(1));
    expect((await stat(join(dir, DEVICE_KEY_FILE))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, PEERS_FILE))).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  posixOnly('tightens a key file found with a wider mode and warns', async () => {
    const keys = store();
    await keys.loadOrCreateDeviceKey();
    await chmod(join(dir, DEVICE_KEY_FILE), 0o644);
    await keys.readDeviceKey();
    expect((await stat(join(dir, DEVICE_KEY_FILE))).mode & 0o777).toBe(0o600);
    expect(warnings).toEqual([expect.stringMatching(/mode 644; tightened to 600$/)]);
  });

  it('leaves modes alone when permissions are not enforced (Windows)', async () => {
    const keys = store({ enforcePermissions: false });
    await keys.loadOrCreateDeviceKey();
    await chmod(join(dir, DEVICE_KEY_FILE), 0o644);
    await keys.readDeviceKey();
    expect(warnings).toEqual([]);
  });

  it('refuses a corrupt, malformed or mismatched device key instead of re-keying', async () => {
    const keys = store();
    await keys.loadOrCreateDeviceKey();
    const path = join(dir, DEVICE_KEY_FILE);
    const good = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;

    await writeFile(path, 'not json', { mode: 0o600 });
    await expect(keys.loadOrCreateDeviceKey()).rejects.toThrow(KeyStoreError);

    await writeFile(path, JSON.stringify({ ...good, version: 2 }), { mode: 0o600 });
    await expect(keys.readDeviceKey()).rejects.toThrow(/invalid format/);

    await writeFile(path, JSON.stringify({ ...good, publicKey: toBase64Url(new Uint8Array(32)) }), {
      mode: 0o600,
    });
    await expect(keys.readDeviceKey()).rejects.toThrow(/does not match/);
  });

  it('adds, replaces, lists and removes peers', async () => {
    const keys = store();
    expect(await keys.listPeers()).toEqual([]);
    await keys.addPeer(peer(1));
    await keys.addPeer(peer(2));
    await keys.addPeer(peer(1, 'renamed'));
    expect((await keys.listPeers()).map((entry) => entry.name)).toEqual(['phone 2', 'renamed']);
    expect(await keys.removePeer(peer(2).deviceId)).toBe(true);
    expect(await keys.removePeer(peer(2).deviceId)).toBe(false);
    expect(await keys.listPeers()).toEqual([peer(1, 'renamed')]);
  });

  it('refuses an invalid peer record and a corrupt peers file', async () => {
    const keys = store();
    await expect(keys.addPeer({ ...peer(1), publicKey: 'short' })).rejects.toThrow(KeyStoreError);
    await expect(keys.addPeer({ ...peer(1), deviceId: 'nope' })).rejects.toThrow(KeyStoreError);
    await keys.addPeer(peer(1));
    await writeFile(join(dir, PEERS_FILE), '{"version":1,"peers":[{}]}', { mode: 0o600 });
    await expect(keys.listPeers()).rejects.toThrow(/invalid format/);
  });
});
