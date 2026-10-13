import type {
  ApprovalRequest,
  DecisionResultMessage,
  Machine,
  PairedDevice,
  ProjectHistory,
  Question,
  RelayErrorCode,
  Repository,
  Session,
} from '@remote-control/protocol';
import { createStore } from 'zustand/vanilla';
import type { StoreApi } from 'zustand/vanilla';

import type { SocketStatus } from './relay-socket.js';

/** The agent's heartbeat (D15); presence older than twice that is not trusted (Rec-5). */
export const AGENT_HEARTBEAT_MS = 25_000;
export const PRESENCE_STALE_MS = 2 * AGENT_HEARTBEAT_MS;

export type SessionStatus = 'none' | 'handshaking' | 'open';

/** One paired computer as the phone sees it. */
export interface MachineView {
  readonly deviceId: string;
  /** The name from the pairing handshake, until a snapshot brings the current one. */
  readonly name: string;
  /** Relay presence: online flag and last-seen, both in relay time. */
  readonly online: boolean;
  readonly lastSeen: number | null;
  readonly session: SessionStatus;
  /** From the latest snapshot. */
  readonly machine: Machine | null;
  readonly sessions: readonly Session[];
  /** The computer's per-project counters (M2-06), from its latest history message. */
  readonly history: readonly ProjectHistory[] | null;
  /** The computer's allow-listed repositories (M1-04), from its latest snapshot. */
  readonly repositories: readonly Repository[];
  /** The phones paired with the computer (M1-07), from its latest snapshot. */
  readonly devices?: readonly PairedDevice[];
  /** Whether the computer's Claude Code hooks are installed (M1-07); unknown when absent. */
  readonly hooksInstalled?: boolean;
}

export type RequestStatus = 'pending' | 'resolved' | 'expired';

interface RequestViewBase {
  readonly machineId: string;
  /** Local-clock deadline: arrival time plus the agent's `ttlMs` (D10). */
  readonly deadline: number;
  readonly status: RequestStatus;
  readonly outcome?: 'allow' | 'deny' | 'answer' | 'terminal' | 'withdrawn';
  /** The agent's answer to this phone's decision, once it arrived. */
  readonly result?: DecisionResultMessage;
  /** The relay refused the decision's envelope (e.g. `unverified`, `expired`). */
  readonly relayError?: RelayErrorCode;
}

/** A pending approval (`kind` absent) or an `AskUserQuestion` to answer (M1-01). */
export type ApprovalView = RequestViewBase & {
  readonly kind?: 'approval';
  readonly request: ApprovalRequest;
};
export type QuestionView = RequestViewBase & {
  readonly kind: 'question';
  readonly request: Question;
};
export type RequestView = ApprovalView | QuestionView;
/** What arrives later for a request: its status, outcome and decision result. */
export type RequestUpdate = Partial<Omit<RequestViewBase, 'machineId'>>;

/**
 * A session start or follow-up instruction this phone sent (M1-04). It has no request
 * on the agent, so its answer is tracked here by the phone's own `request_id`.
 */
export interface CommandView {
  readonly machineId: string;
  readonly kind: 'start' | 'instruct';
  /** The repository a start runs in, or the session an instruction goes to. */
  readonly target: string;
  readonly text: string;
  /** The agent's answer; an accepted start may name the new session. */
  readonly result?: DecisionResultMessage;
  /** The relay refused the envelope, or the decision expired before it could be sent. */
  readonly relayError?: RelayErrorCode;
}

/**
 * One changed file's diff, asked for from the session screen (M2-02). Diff bodies are
 * fetched on demand, never pushed (D21); `unavailable` when the agent kept none, the
 * computer is not connected, or it did not answer in time.
 */
export interface DiffView {
  readonly requestId: string;
  readonly status: 'loading' | 'ready' | 'unavailable';
  readonly patch?: string;
  /** The agent left out older hunks or lines to fit its caps. */
  readonly truncated?: boolean;
}

/** The `diffs` key of one machine's session's changed file. */
export function diffKey(machineId: string, sessionId: string, file: string): string {
  return JSON.stringify([machineId, sessionId, file]);
}

export interface RealtimeState {
  readonly connection: SocketStatus;
  /** Consecutive socket attempts that never reached `hello_ok`. */
  readonly failures: number;
  /** `true` while `/api/state` polling stands in for the socket (Rec-5). */
  readonly polling: boolean;
  /** Relay time minus local time, from the latest relay timestamp. */
  readonly relayOffset: number;
  /** Relay time at which the presence below was last known to be current. */
  readonly confirmedAt: number | null;
  readonly machines: Readonly<Record<string, MachineView>>;
  readonly requests: Readonly<Record<string, RequestView>>;
  /** Starts and instructions by `request_id` (M1-04). */
  readonly commands: Readonly<Record<string, CommandView>>;
  /** Requested diffs by `diffKey` (M2-02), in memory only. */
  readonly diffs: Readonly<Record<string, DiffView>>;
}

export type RealtimeStore = StoreApi<RealtimeState>;

export function createRealtimeStore(): RealtimeStore {
  return createStore<RealtimeState>()(() => ({
    connection: 'stopped',
    failures: 0,
    polling: false,
    relayOffset: 0,
    confirmedAt: null,
    machines: {},
    requests: {},
    commands: {},
    diffs: {},
  }));
}

/** Requests still waiting for a decision, oldest deadline first. */
export function pendingRequests(state: RealtimeState): RequestView[] {
  return Object.values(state.requests)
    .filter((view) => view.status === 'pending')
    .sort((a, b) => a.deadline - b.deadline);
}

/** `5 minutes`, `1 hour`, `2 days`. */
export function ago(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return minutes === 1 ? '1 minute' : `${String(minutes)} minutes`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 hour' : `${String(hours)} hours`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day' : `${String(days)} days`;
}

export interface PresenceLabel {
  readonly online: boolean;
  readonly text: string;
}

/**
 * What the machine list says about a computer (05 Rec-5). Everything is relay time:
 * `localNow + relayOffset`, never the phone's own clock against the relay's stamps. An
 * "online" that has not been confirmed for twice the agent heartbeat is shown as
 * offline, last seen when it was confirmed.
 */
export function presenceLabel(
  machine: Pick<MachineView, 'online' | 'lastSeen'>,
  state: Pick<RealtimeState, 'relayOffset' | 'confirmedAt'>,
  localNow: number,
): PresenceLabel {
  const relayNow = localNow + state.relayOffset;
  const fresh = state.confirmedAt !== null && relayNow - state.confirmedAt <= PRESENCE_STALE_MS;
  if (machine.online && fresh) return { online: true, text: 'Online' };
  const lastSeen = machine.online ? state.confirmedAt : machine.lastSeen;
  if (lastSeen === null) return { online: false, text: 'Machine offline' };
  return {
    online: false,
    text: `Machine offline — last seen ${ago(Math.max(0, relayNow - lastSeen))} ago`,
  };
}
