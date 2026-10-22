import type { X25519KeyPair } from '@remote-control/crypto';

/** A computer this phone completed pairing with (D6). */
export interface PairedMachine {
  /** The agent's relay device id. */
  readonly deviceId: string;
  /** The name the agent told the phone inside the pairing handshake. */
  readonly name: string;
  /** The agent's static X25519 key: the KK responder's `rs` (D3). */
  readonly publicKey: Uint8Array;
  readonly pairedAt: number;
}

/** The phone's own identity: its static key pair and the relay device id it is bound to. */
export interface PhoneIdentity {
  readonly keyPair: X25519KeyPair;
  /** Set once `POST /api/devices/phone` bound this phone; `null` before. */
  readonly deviceId: string | null;
}

/** Where the phone keeps its static key and its pairings. */
export interface KeyStore {
  /** The identity, created on first use. */
  identity(): Promise<PhoneIdentity>;
  setDeviceId(deviceId: string): Promise<void>;
  machines(): Promise<PairedMachine[]>;
  saveMachine(machine: PairedMachine): Promise<void>;
  removeMachine(deviceId: string): Promise<void>;
}
