import type { RelayApi } from '@remote-control/phone-core/auth/relay-api';
import type { PhoneService } from '@remote-control/phone-core/realtime/phone';
import { Alert } from 'react-native';
import { create } from 'zustand';

import { clearDevConnection, saveDevConnection } from '../adapters/dev-connection';
import type { RelayConnection } from '../adapters/relay-transport';
import { systemNow } from '../adapters/system-clock';
import { fixtureInbox } from '../core/fixtures';
import { decide, type DecisionInput, expire, type Inbox } from '../core/inbox';
import { sessionsFromRealtime } from '../core/realtime-inbox';
import { failureText, sendDecision, startLivePhone } from './live';

/** A paired computer as the settings list it. */
export interface MachineRow {
  readonly deviceId: string;
  readonly name: string;
  readonly online: boolean;
}

export type LiveStatus =
  | { readonly state: 'off' }
  | { readonly state: 'connecting' }
  | { readonly state: 'live'; readonly userId: string; readonly origin: string }
  | { readonly state: 'error'; readonly message: string };

interface InboxStore extends Inbox {
  /** Sample data until the app is connected to a relay (M4-03). */
  readonly sample: boolean;
  readonly live: LiveStatus;
  readonly phone: PhoneService | undefined;
  /** The signed-in relay API while live (APNs token registration, M4-05). */
  readonly relay: RelayApi | undefined;
  readonly machines: readonly MachineRow[];
  decide: (input: DecisionInput) => void;
  expire: () => void;
  reset: () => void;
  /** Signs in on a relay and swaps the sample agents for the live ones. */
  connect: (connection: RelayConnection, remember?: boolean) => Promise<void>;
  /** Back to the sample agents; forgets the saved connection. */
  disconnect: () => Promise<void>;
}

let unsubscribe: (() => void) | undefined;

export const useInbox = create<InboxStore>()((set, get) => ({
  ...fixtureInbox(systemNow()),
  sample: true,
  live: { state: 'off' },
  phone: undefined,
  relay: undefined,
  machines: [],
  decide: (input) => {
    const { phone, sessions } = get();
    if (phone === undefined) {
      set(decide(get(), input, systemNow()));
      return;
    }
    const session = sessions.find((candidate) => candidate.id === input.sessionId);
    if (!session) return;
    void sendDecision(phone, session, input).then((result) => {
      if (result.ok) {
        // Sessions follow the relay; only the local history records the decision.
        set({
          history: decide({ sessions: [session], history: get().history }, input, systemNow())
            .history,
        });
      } else {
        Alert.alert('Not sent', failureText(result));
      }
    });
  },
  expire: () => {
    const current = get();
    // Live requests expire in the phone core, on the relay's clock.
    if (current.phone !== undefined) return;
    const next = expire(current, systemNow());
    if (next !== current) set(next);
  },
  reset: () => {
    if (get().phone === undefined) set(fixtureInbox(systemNow()));
  },
  async connect(connection, remember = true) {
    await get().disconnect();
    set({ live: { state: 'connecting' } });
    try {
      const { phone, relay, userId } = await startLivePhone(connection);
      if (remember) await saveDevConnection(connection);
      const show = (state = phone.realtime.getState()) => {
        set({
          sessions: sessionsFromRealtime(state, systemNow()),
          machines: Object.values(state.machines).map(({ deviceId, machine, name, online }) => ({
            deviceId,
            name: machine?.name ?? name,
            online,
          })),
        });
      };
      unsubscribe = phone.realtime.subscribe((state) => {
        show(state);
      });
      set({
        phone,
        relay,
        sample: false,
        history: [],
        live: { state: 'live', userId, origin: connection.origin },
      });
      show();
    } catch (error) {
      set({
        live: { state: 'error', message: error instanceof Error ? error.message : String(error) },
      });
    }
  },
  async disconnect() {
    const { phone } = get();
    unsubscribe?.();
    unsubscribe = undefined;
    if (phone === undefined) return;
    phone.disconnect();
    await clearDevConnection();
    set({
      ...fixtureInbox(systemNow()),
      sample: true,
      phone: undefined,
      relay: undefined,
      machines: [],
      live: { state: 'off' },
    });
  },
}));
