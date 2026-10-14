import {
  accountDeletionHash,
  encodeFrame,
  VERSION_TABLE,
  type Clock,
} from '@remote-control/protocol';
import type { Logger } from 'pino';

import type { DeviceIdentity } from '../ports/device-directory.js';
import type { DeviceRevocations } from '../ports/device-revocations.js';
import type { HubPort } from '../ports/hub.js';
import type { DecisionVerifier } from './decision-verifier.js';
import { CloseCode } from './hub-limits.js';

export interface RevocationServiceDeps {
  readonly store: DeviceRevocations;
  readonly hub: HubPort;
  readonly verifier: Pick<DecisionVerifier, 'consume'>;
  readonly clock: Clock;
  readonly logger: Logger;
}

export type RevokeResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: 'unknown_device' };

export type DeleteAccountResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'not_verified' | 'unknown_account' };

/**
 * Device revocation and account deletion (M1-10, 02 §5.9). The relay drops the rows and
 * closes the sockets; it holds no key, so it can only tell the agents to forget a peer
 * (`peer_revoked`), which they do on their own (I1, I4).
 */
export class RevocationService {
  constructor(private readonly deps: RevocationServiceDeps) {}

  /**
   * Revokes `deviceId`: a phone may revoke any device of its user, an agent only phones
   * (`remotectl devices revoke`); anything else is `unknown_device`. The revoked socket closes with 4002 and, for a phone,
   * every live agent of the user is told to drop it.
   */
  async revoke(actor: DeviceIdentity, deviceId: string): Promise<RevokeResult> {
    const owner = actor.userId;
    const kind = await this.deps.store.revokeDevice({
      userId: owner,
      deviceId,
      kinds: actor.kind === 'phone' ? ['phone', 'agent'] : ['phone'],
      now: this.deps.clock.now(),
    });
    if (kind === null) return { ok: false, reason: 'unknown_device' };
    this.deps.logger.info(
      { event: 'device_revoked', user_id: owner, device_id: deviceId, by: actor.deviceId },
      'device revoked',
    );
    this.deps.hub.connection(owner, deviceId)?.close(CloseCode.revoked, 'revoked');
    if (kind === 'phone') {
      const frame = encodeFrame({ v: VERSION_TABLE.v, kind: 'peer_revoked', deviceId });
      for (const connection of this.deps.hub.connections(owner)) {
        if (connection.identity.kind === 'agent') connection.send(frame);
      }
    }
    return { ok: true };
  }

  /**
   * Deletes the phone's account once the phone verified (UV) its deletion hash, then
   * closes every socket of the account with 4002 `account_deleted`.
   */
  async deleteAccount(phone: DeviceIdentity): Promise<DeleteAccountResult> {
    const hash = await accountDeletionHash(phone.userId);
    if (!(await this.deps.verifier.consume(phone, hash)))
      return { ok: false, reason: 'not_verified' };
    if (!(await this.deps.store.deleteAccount(phone.userId))) {
      return { ok: false, reason: 'unknown_account' };
    }
    this.deps.logger.info({ event: 'account_deleted' }, 'account deleted');
    for (const connection of this.deps.hub.connections(phone.userId)) {
      connection.close(CloseCode.revoked, 'account_deleted');
    }
    return { ok: true };
  }
}
