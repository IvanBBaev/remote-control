import {
  deriveNotificationKey,
  generateX25519KeyPair,
  importAesGcmKey,
  openPushSummary,
  sealPushSummary,
  utf8,
} from '@remote-control/crypto';
import type { Random } from '@remote-control/protocol';
import { describe, expect, it } from 'vitest';

import { fixtureInbox } from './fixtures';
import {
  ALLOW_ACTION,
  apnsEnvironment,
  DEFAULT_ACTION,
  DENY_ACTION,
  NOTICE_CATEGORY,
  NOTIFICATION_CATEGORIES,
  notificationIntent,
  notificationRequestId,
  PENDING_CATEGORY,
  rawNotificationKey,
  REPLY_ACTION,
  resolveIntent,
  REVIEW_ACTION,
} from './notifications';

const { sessions } = fixtureInbox(0);
const push = (rid: string) => ({ aps: {}, rc: { t: 'pending', rid, dev: 'Mac', exp: null } });

let counter = 0;
const random: Random = {
  bytes: (length) => Uint8Array.from({ length }, (_, index) => (index + 31 * ++counter) % 256),
};

describe('notification categories (M4-05, ADR 0017)', () => {
  it('offers Allow, Review, Deny and Reply on a pending request', () => {
    const pending = NOTIFICATION_CATEGORIES.find((c) => c.identifier === PENDING_CATEGORY);
    expect(pending?.actions.map((action) => action.buttonTitle)).toEqual([
      'Allow',
      'Review',
      'Deny',
      'Reply',
    ]);
  });

  it('requires an unlocked phone for every action that decides', () => {
    const actions = NOTIFICATION_CATEGORIES.flatMap((category) => category.actions);
    for (const action of actions.filter((a) => a.identifier !== REVIEW_ACTION)) {
      expect(action.options.isAuthenticationRequired).toBe(true);
    }
    expect(actions.find((a) => a.identifier === DENY_ACTION)?.options.isDestructive).toBe(true);
    expect(actions.find((a) => a.identifier === REPLY_ACTION)?.textInput).toBeDefined();
  });

  it('offers only Reply on a turn notice', () => {
    const notice = NOTIFICATION_CATEGORIES.find((c) => c.identifier === NOTICE_CATEGORY);
    expect(notice?.actions.map((action) => action.identifier)).toEqual([REPLY_ACTION]);
  });
});

describe('notificationRequestId', () => {
  it('prefers the request the extension read from the summary', () => {
    expect(notificationRequestId({ ...push('envelope'), body: { request: 'r-1' } })).toBe('r-1');
  });

  it('falls back to the push metadata', () => {
    expect(notificationRequestId(push('envelope'))).toBe('envelope');
    expect(notificationRequestId({ body: { request: '' }, rc: { rid: 'e' } })).toBe('e');
  });

  it('is undefined for anything else', () => {
    expect(notificationRequestId(undefined)).toBeUndefined();
    expect(notificationRequestId('text')).toBeUndefined();
    expect(notificationRequestId({ rc: { rid: 7 } })).toBeUndefined();
  });
});

describe('notificationIntent', () => {
  it('maps the buttons and a tap', () => {
    expect(notificationIntent(ALLOW_ACTION, push('r'))).toEqual({
      requestId: 'r',
      action: 'allow',
    });
    expect(notificationIntent(DENY_ACTION, push('r'))).toEqual({ requestId: 'r', action: 'deny' });
    expect(notificationIntent(REVIEW_ACTION, push('r'))?.action).toBe('review');
    expect(notificationIntent(DEFAULT_ACTION, push('r'))?.action).toBe('review');
  });

  it('keeps the trimmed reply text and drops an empty reply', () => {
    expect(notificationIntent(REPLY_ACTION, push('r'), '  yes  ')).toEqual({
      requestId: 'r',
      action: 'reply',
      text: 'yes',
    });
    expect(notificationIntent(REPLY_ACTION, push('r'), '   ')).toBeUndefined();
    expect(notificationIntent(REPLY_ACTION, push('r'))).toBeUndefined();
  });

  it('ignores unknown actions and pushes without a request', () => {
    expect(notificationIntent('other', push('r'))).toBeUndefined();
    expect(notificationIntent(ALLOW_ACTION, {})).toBeUndefined();
  });
});

describe('resolveIntent', () => {
  it('decides an approval with Allow and Deny', () => {
    expect(resolveIntent(sessions, { requestId: 'r-api-1', action: 'allow' })).toEqual({
      kind: 'decide',
      input: { sessionId: 's-api', kind: 'allow' },
    });
    expect(resolveIntent(sessions, { requestId: 'r-api-1', action: 'deny' })).toEqual({
      kind: 'decide',
      input: { sessionId: 's-api', kind: 'deny' },
    });
  });

  it('answers a question with a Reply and instructs on an approval', () => {
    expect(
      resolveIntent(sessions, { requestId: 'r-web-1', action: 'reply', text: 'Keep both' }),
    ).toEqual({
      kind: 'decide',
      input: { sessionId: 's-web', kind: 'answer', payload: 'Keep both' },
    });
    expect(
      resolveIntent(sessions, { requestId: 'r-api-1', action: 'reply', text: 'Stop' }),
    ).toEqual({ kind: 'decide', input: { sessionId: 's-api', kind: 'instruct', payload: 'Stop' } });
  });

  it('opens the session for Review and for Allow or Deny on a question', () => {
    expect(resolveIntent(sessions, { requestId: 'r-api-1', action: 'review' })).toEqual({
      kind: 'open',
      sessionId: 's-api',
    });
    expect(resolveIntent(sessions, { requestId: 'r-web-1', action: 'allow' })).toEqual({
      kind: 'open',
      sessionId: 's-web',
    });
  });

  it('waits while no session holds the request', () => {
    expect(resolveIntent(sessions, { requestId: 'gone', action: 'allow' })).toBeUndefined();
  });
});

describe('rawNotificationKey (D5)', () => {
  it('is the key the agent seals summaries with', async () => {
    const agent = await generateX25519KeyPair(random);
    const phone = await generateX25519KeyPair(random);
    const seal = await deriveNotificationKey(agent.privateKey, phone.publicKey, ['encrypt']);
    const raw = await rawNotificationKey(phone.privateKey, agent.publicKey);
    expect(raw).toHaveLength(32);
    const sealed = await sealPushSummary(seal, 'rid', utf8('{"v":1,"l":"Run"}'), random);
    const opened = await openPushSummary(await importAesGcmKey(raw, ['decrypt']), 'rid', sealed);
    expect(new TextDecoder().decode(opened)).toBe('{"v":1,"l":"Run"}');
  });
});

describe('apnsEnvironment', () => {
  it('uses the sandbox for development builds', () => {
    expect(apnsEnvironment(true)).toBe('sandbox');
    expect(apnsEnvironment(false)).toBe('production');
  });
});
