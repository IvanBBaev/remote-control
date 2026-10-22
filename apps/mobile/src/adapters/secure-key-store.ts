import { X25519_KEY_LENGTH, x25519KeyPairFromPrivateKey } from '@remote-control/crypto';
import type {
  KeyStore,
  PairedMachine,
  PhoneIdentity,
} from '@remote-control/phone-core/pairing/key-store';
import { fromBase64, toBase64 } from '@remote-control/phone-core/realtime/envelope';
import type { Random } from '@remote-control/protocol';
import * as SecureStore from 'expo-secure-store';

const IDENTITY = 'rc.identity';
const MACHINES = 'rc.machines';
/** Readable after the first unlock, so a push can decrypt while the phone is locked. */
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

interface StoredIdentity {
  readonly seed: string;
  readonly deviceId: string | null;
}

interface StoredMachine {
  readonly deviceId: string;
  readonly name: string;
  readonly publicKey: string;
  readonly pairedAt: number;
}

/**
 * The key store on the iOS Keychain (expo-secure-store). The noble backend keeps the X25519
 * private key as raw bytes, so the 32-byte seed is stored and re-imported on load; it never
 * leaves this device (`THIS_DEVICE_ONLY`: no iCloud Keychain sync).
 */
export function createSecureKeyStore(random: Random): KeyStore {
  let identity: Promise<PhoneIdentity> | undefined;

  async function readJson<T>(key: string): Promise<T | undefined> {
    const text = await SecureStore.getItemAsync(key, OPTIONS);
    return text === null ? undefined : (JSON.parse(text) as T);
  }

  async function writeJson(key: string, value: unknown): Promise<void> {
    await SecureStore.setItemAsync(key, JSON.stringify(value), OPTIONS);
  }

  async function load(): Promise<PhoneIdentity> {
    let stored = await readJson<StoredIdentity>(IDENTITY);
    if (stored === undefined) {
      stored = { seed: toBase64(random.bytes(X25519_KEY_LENGTH)), deviceId: null };
      await writeJson(IDENTITY, stored);
    }
    const keyPair = await x25519KeyPairFromPrivateKey(fromBase64(stored.seed));
    return { keyPair, deviceId: stored.deviceId };
  }

  async function machines(): Promise<PairedMachine[]> {
    const stored = (await readJson<StoredMachine[]>(MACHINES)) ?? [];
    return stored.map((machine) => ({ ...machine, publicKey: fromBase64(machine.publicKey) }));
  }

  async function saveMachines(list: readonly PairedMachine[]): Promise<void> {
    await writeJson(
      MACHINES,
      list.map((machine) => ({ ...machine, publicKey: toBase64(machine.publicKey) })),
    );
  }

  return {
    identity: () => (identity ??= load()),
    async setDeviceId(deviceId) {
      const current = await (identity ??= load());
      const stored = await readJson<StoredIdentity>(IDENTITY);
      if (stored === undefined) throw new Error('the phone identity is missing');
      await writeJson(IDENTITY, { ...stored, deviceId });
      identity = Promise.resolve({ ...current, deviceId });
    },
    machines,
    async saveMachine(machine) {
      const others = (await machines()).filter((m) => m.deviceId !== machine.deviceId);
      await saveMachines([...others, machine]);
    },
    async removeMachine(deviceId) {
      await saveMachines((await machines()).filter((m) => m.deviceId !== deviceId));
    },
  };
}

/** Forgets the identity and every pairing (developer reset). */
export async function clearSecureKeyStore(): Promise<void> {
  await SecureStore.deleteItemAsync(IDENTITY, OPTIONS);
  await SecureStore.deleteItemAsync(MACHINES, OPTIONS);
}
