import { fromBase64, toBase64 } from '@remote-control/phone-core/realtime/envelope';
import { requireOptionalNativeModule } from 'expo';

import type { DeviceSigner } from '../core/authorize';

/** The `DeviceKey` Expo module in `modules/device-key` (Swift, Secure Enclave). */
interface DeviceKeyModule {
  getOrCreate(): Promise<{ publicKey: string; secureEnclave: boolean }>;
  sign(message: string, reason: string): Promise<string | null>;
  remove(): Promise<void>;
}

const native = requireOptionalNativeModule<DeviceKeyModule>('DeviceKey');

function module(): DeviceKeyModule {
  if (native === null) throw new Error('This build has no device key module.');
  return native;
}

/** The device signing key behind Face ID / Touch ID (ADR 0017, M4-04). */
export const nativeDeviceSigner: DeviceSigner = {
  async publicKey() {
    return fromBase64((await module().getOrCreate()).publicKey);
  },
  async sign(message, reason) {
    const signature = await module().sign(toBase64(message), reason);
    return signature === null ? null : fromBase64(signature);
  },
};
