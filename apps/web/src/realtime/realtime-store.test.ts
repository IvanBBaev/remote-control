import { describe, expect, it } from 'vitest';

import type { RequestView } from './realtime-store.js';
import {
  createRealtimeStore,
  pendingRequests,
  presenceLabel,
  PRESENCE_STALE_MS,
} from './realtime-store.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('realtime store', () => {
  it('starts stopped and empty', () => {
    expect(createRealtimeStore().getState()).toEqual({
      connection: 'stopped',
      failures: 0,
      polling: false,
      relayOffset: 0,
      confirmedAt: null,
      machines: {},
      requests: {},
      commands: {},
      diffs: {},
    });
  });

  it('lists pending requests by deadline', () => {
    const view = (id: string, deadline: number, status: RequestView['status']) =>
      ({ machineId: 'm', request: { id }, deadline, status }) as unknown as RequestView;
    const store = createRealtimeStore();
    store.setState({
      requests: {
        a: view('a', 30, 'pending'),
        b: view('b', 10, 'pending'),
        c: view('c', 5, 'resolved'),
      },
    });
    expect(pendingRequests(store.getState()).map((request) => request.deadline)).toEqual([10, 30]);
  });
});

describe('presenceLabel', () => {
  const now = 1_000_000_000;

  it('is online while the relay confirmed it within two heartbeats', () => {
    expect(
      presenceLabel(
        { online: true, lastSeen: null },
        { relayOffset: 500, confirmedAt: now + 500 - PRESENCE_STALE_MS },
        now,
      ),
    ).toEqual({ online: true, text: 'Online' });
  });

  it('turns a stale online into offline, last seen when it was confirmed', () => {
    expect(
      presenceLabel(
        { online: true, lastSeen: 1 },
        { relayOffset: 0, confirmedAt: now - 3 * MINUTE },
        now,
      ),
    ).toEqual({ online: false, text: 'Machine offline — last seen 3 minutes ago' });
    expect(
      presenceLabel({ online: true, lastSeen: 1 }, { relayOffset: 0, confirmedAt: null }, now),
    ).toEqual({
      online: false,
      text: 'Machine offline',
    });
  });

  it('measures last seen in relay time', () => {
    const label = (lastSeen: number | null, offset = 0) =>
      presenceLabel({ online: false, lastSeen }, { relayOffset: offset, confirmedAt: now }, now)
        .text;
    expect(label(null)).toBe('Machine offline');
    expect(label(now - 30_000)).toBe('Machine offline — last seen less than a minute ago');
    // A phone clock ahead of the relay never shows a future last-seen.
    expect(label(now, -5_000)).toBe('Machine offline — last seen less than a minute ago');
    expect(label(now - MINUTE)).toBe('Machine offline — last seen 1 minute ago');
    expect(label(now - 2 * MINUTE, 0)).toBe('Machine offline — last seen 2 minutes ago');
    expect(label(now, 2 * HOUR)).toBe('Machine offline — last seen 2 hours ago');
    expect(label(now - HOUR)).toBe('Machine offline — last seen 1 hour ago');
    expect(label(now - DAY)).toBe('Machine offline — last seen 1 day ago');
    expect(label(now - 3 * DAY)).toBe('Machine offline — last seen 3 days ago');
  });
});
