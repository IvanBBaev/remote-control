import { hkdfSha256, NOTIFICATION_KEY_INFO, utf8, x25519 } from '@remote-control/crypto';

import type { DecisionInput } from './inbox';
import type { AgentSession } from './model';

/** A pending request: the relay sends it, the Notification Service Extension keeps it. */
export const PENDING_CATEGORY = 'rc.pending';
/** A turn notice (summary `k`): nothing to decide, only a reply to the session. */
export const NOTICE_CATEGORY = 'rc.notice';

export const ALLOW_ACTION = 'rc.allow';
export const REVIEW_ACTION = 'rc.review';
export const DENY_ACTION = 'rc.deny';
export const REPLY_ACTION = 'rc.reply';
/** What iOS reports when the notification itself was tapped. */
export const DEFAULT_ACTION = 'expo.modules.notifications.actions.DEFAULT';

/** One action button, in the shape `setNotificationCategoryAsync` takes. */
export interface CategoryAction {
  readonly identifier: string;
  readonly buttonTitle: string;
  readonly textInput?: { readonly submitButtonTitle: string; readonly placeholder: string };
  readonly options: {
    readonly opensAppToForeground: boolean;
    readonly isAuthenticationRequired: boolean;
    readonly isDestructive: boolean;
  };
}

export interface NotificationCategory {
  readonly identifier: string;
  readonly actions: readonly CategoryAction[];
}

/**
 * Every action needs an unlocked phone (ADR 0017): Allow opens the app because only the
 * foreground app can ask Face ID for the device key's signature (M4-04), and Deny and
 * Reply open it because the decision goes out over the app's live session with the agent.
 */
const LOCKED = { opensAppToForeground: true, isAuthenticationRequired: true } as const;

const reply: CategoryAction = {
  identifier: REPLY_ACTION,
  buttonTitle: 'Reply',
  textInput: { submitButtonTitle: 'Send', placeholder: 'Answer or instruct the agent' },
  options: { ...LOCKED, isDestructive: false },
};

/** The categories the app registers on start (M4-05). */
export const NOTIFICATION_CATEGORIES: readonly NotificationCategory[] = [
  {
    identifier: PENDING_CATEGORY,
    actions: [
      {
        identifier: ALLOW_ACTION,
        buttonTitle: 'Allow',
        options: { ...LOCKED, isDestructive: false },
      },
      {
        identifier: REVIEW_ACTION,
        buttonTitle: 'Review',
        options: {
          opensAppToForeground: true,
          isAuthenticationRequired: false,
          isDestructive: false,
        },
      },
      { identifier: DENY_ACTION, buttonTitle: 'Deny', options: { ...LOCKED, isDestructive: true } },
      reply,
    ],
  },
  { identifier: NOTICE_CATEGORY, actions: [reply] },
];

/** What the user asked for from a notification. */
export interface NotificationIntent {
  readonly requestId: string;
  readonly action: 'allow' | 'deny' | 'review' | 'reply';
  /** The typed text of a Reply. */
  readonly text?: string;
}

const ACTIONS: Readonly<Record<string, NotificationIntent['action']>> = {
  [ALLOW_ACTION]: 'allow',
  [DENY_ACTION]: 'deny',
  [REVIEW_ACTION]: 'review',
  [REPLY_ACTION]: 'reply',
  [DEFAULT_ACTION]: 'review',
};

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * The request a remote notification is about: the summary's request id, which the
 * extension copies to `body.request` once it opened the summary, else the push's `rc.rid`.
 */
export function notificationRequestId(payload: unknown): string | undefined {
  const fields = record(payload);
  return nonEmpty(record(fields?.body)?.request) ?? nonEmpty(record(fields?.rc)?.rid);
}

/**
 * Turns a notification response into an intent; `undefined` for an unknown action, a
 * push that names no request, or a Reply without text.
 */
export function notificationIntent(
  actionIdentifier: string,
  payload: unknown,
  userText?: string,
): NotificationIntent | undefined {
  const action = ACTIONS[actionIdentifier];
  const requestId = notificationRequestId(payload);
  if (action === undefined || requestId === undefined) return undefined;
  if (action !== 'reply') return { requestId, action };
  const text = userText?.trim();
  return text ? { requestId, action, text } : undefined;
}

/** What the app does with an intent once its sessions are known. */
export type IntentOutcome =
  | { readonly kind: 'decide'; readonly input: DecisionInput }
  | { readonly kind: 'open'; readonly sessionId: string };

/**
 * Matches an intent to the session that waits on its request. Allow and Deny decide an
 * approval; a Reply answers a question (an option label picks that option, other text
 * is the free answer) or instructs the session; Review, and Allow or Deny on a question,
 * open the session. `undefined` while no session waits on the request (not loaded yet,
 * or already decided elsewhere).
 */
export function resolveIntent(
  sessions: readonly AgentSession[],
  intent: NotificationIntent,
): IntentOutcome | undefined {
  const session = sessions.find(
    (candidate) =>
      candidate.approval?.requestId === intent.requestId ||
      candidate.question?.requestId === intent.requestId,
  );
  if (session === undefined) return undefined;
  const sessionId = session.id;
  const approval = session.approval?.requestId === intent.requestId;
  switch (intent.action) {
    case 'allow':
    case 'deny':
      return approval
        ? { kind: 'decide', input: { sessionId, kind: intent.action } }
        : { kind: 'open', sessionId };
    case 'reply':
      return {
        kind: 'decide',
        input: { sessionId, kind: approval ? 'instruct' : 'answer', payload: intent.text },
      };
    case 'review':
      return { kind: 'open', sessionId };
  }
}

/** One pairing's notification key, as the extension reads it from the shared Keychain. */
export interface SharedNotificationKey {
  readonly deviceId: string;
  /** The raw 32-byte AES-256-GCM key, base64. */
  readonly key: string;
}

/**
 * The raw notification key of a pairing (D5): the same HKDF over the static–static X25519
 * secret as `deriveNotificationKey`, kept as bytes because the Swift extension imports it
 * into CryptoKit itself.
 */
export async function rawNotificationKey(
  ownStaticPrivateKey: CryptoKey,
  peerStaticPublicKey: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const shared = await x25519(ownStaticPrivateKey, peerStaticPublicKey);
  return hkdfSha256(shared, new Uint8Array(0), utf8(NOTIFICATION_KEY_INFO), 32);
}

/** The APNs environment a build talks to: development builds use the sandbox. */
export function apnsEnvironment(development: boolean): 'sandbox' | 'production' {
  return development ? 'sandbox' : 'production';
}
