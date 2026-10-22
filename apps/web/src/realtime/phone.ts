// The service moved to @remote-control/phone-core (M4-03); the PWA plugs in its WebAuthn
// ceremonies here.
import { createPhoneService as createCorePhoneService } from '@remote-control/phone-core/realtime/phone';
import type {
  PhoneService,
  PhoneServiceOptions as CorePhoneServiceOptions,
} from '@remote-control/phone-core/realtime/phone';

import { assertDecision } from '../auth/assert-decision.js';
import { deleteAccount } from '../auth/delete-account.js';

export * from '@remote-control/phone-core/realtime/phone';

export type PhoneServiceOptions = Omit<CorePhoneServiceOptions, 'authorize' | 'deleteAccount'>;

export function createPhoneService(options: PhoneServiceOptions): PhoneService {
  return createCorePhoneService({
    ...options,
    authorize: (decision) => assertDecision(decision, options.relay),
    deleteAccount: (userId) => deleteAccount(userId, options.relay),
  });
}
