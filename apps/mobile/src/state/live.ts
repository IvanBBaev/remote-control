import { createRelayApi } from '@remote-control/phone-core/auth/relay-api';
import type { AssertDecisionResult } from '@remote-control/phone-core/auth/results';
import { createPhoneService } from '@remote-control/phone-core/realtime/phone';
import type { PhoneService } from '@remote-control/phone-core/realtime/phone';
import type { RealtimeState } from '@remote-control/phone-core/realtime/realtime-store';
import type { Question } from '@remote-control/protocol';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

import { systemTimer } from '../adapters/system-clock';
import { systemRandom } from '../adapters/system-random';
import { createSecureKeyStore } from '../adapters/secure-key-store';
import {
  nativeSocketFactory,
  relayFetch,
  relaySocketUrl,
  type RelayConnection,
} from '../adapters/relay-transport';
import { authorizeWithoutPasskey, deleteAccountWithoutPasskey } from '../core/authorize';
import { pendingRequestFor } from '../core/realtime-inbox';
import type { AgentSession } from '../core/model';
import type { DecisionInput } from '../core/inbox';

/** A signed-in phone service on a relay, connected. */
export interface LivePhone {
  readonly phone: PhoneService;
  readonly userId: string;
}

/** Signs in with `connection` and connects; rejects when the relay refuses the session. */
export async function startLivePhone(connection: RelayConnection): Promise<LivePhone> {
  const relay = createRelayApi(relayFetch(connection));
  const phone = createPhoneService({
    relay,
    keyStore: createSecureKeyStore(systemRandom),
    timer: systemTimer,
    random: systemRandom,
    createSocket: nativeSocketFactory(connection),
    url: relaySocketUrl(connection.origin),
    version: Constants.expoConfig?.version ?? '0.0.0',
    phoneName: Platform.OS === 'ios' ? 'iPhone' : 'Android phone',
    authorize: authorizeWithoutPasskey,
    deleteAccount: deleteAccountWithoutPasskey,
  });
  const session = await relay.session();
  if (session === null) throw new Error('The relay does not accept this session token.');
  await phone.connect(session.userId);
  return { phone, userId: session.userId };
}

function machineOfSession(state: RealtimeState, sessionId: string): string | undefined {
  return Object.values(state.machines).find((machine) =>
    machine.sessions.some((session) => session.id === sessionId),
  )?.deviceId;
}

/** Sends a decision taken on `session` through the phone core. */
export function sendDecision(
  phone: PhoneService,
  session: AgentSession,
  input: DecisionInput,
): Promise<AssertDecisionResult> {
  const state = phone.realtime.getState();
  const offline = Promise.resolve<AssertDecisionResult>({ ok: false, failure: 'offline' });
  switch (input.kind) {
    case 'allow':
    case 'always':
    case 'deny': {
      const view = session.approval && pendingRequestFor(state, session.approval.requestId);
      return view ? phone.decide(view.machineId, view.request, input.kind) : offline;
    }
    case 'answer': {
      const view = session.question && pendingRequestFor(state, session.question.requestId);
      const answer = input.payload?.trim();
      if (!view || !answer) return offline;
      const question = view.request as Question;
      const labels = question.questions[0]?.options.map((option) => option.label) ?? [];
      return phone.answer(view.machineId, question, {
        answers: [labels.includes(answer) ? { labels: [answer] } : { labels: [], other: answer }],
      });
    }
    case 'instruct': {
      const machineId = machineOfSession(state, session.id);
      const text = input.payload?.trim();
      return machineId && text ? phone.instruct(machineId, session.id, text) : offline;
    }
  }
}

/** What the user reads when a decision did not go out. */
export function failureText(result: Exclude<AssertDecisionResult, { ok: true }>): string {
  const { failure } = result;
  if (failure === 'cancelled')
    return 'This needs Face ID with a passkey, which the app gets in M4-04. Deny works now.';
  if (failure === 'offline') return 'Not connected to the relay, or the request is gone.';
  if (failure === 'rate_limited') return 'Too many attempts; try again in a moment.';
  if (typeof failure === 'object') return `The relay refused: ${failure.relay}.`;
  return 'The decision did not go out.';
}
