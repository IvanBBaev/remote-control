import { describe, expect, it } from 'vitest';

import { assertNoLeaks, findLeaks, PrivacyLeakError, type LeakSource } from './privacy-gate.js';

const CANARY = 'CANARY-TOOLINPUT-1f0b2c3d';

const clean: LeakSource[] = [
  { name: 'relay-log', lines: ['{"event":"ws_open","device_id":"d-1"}'] },
  { name: 'pglite', lines: ['public.devices: {"id":"d-1"}'] },
  { name: 'push', lines: ['{"t":"pending","rid":"e-1","dev":"mac","exp":1}'] },
  { name: 'agent-log', lines: ['{"event":"decision_applied"}'] },
];

describe('privacy gate (07 §5.12)', () => {
  it('passes a clean scan', () => {
    expect(findLeaks(clean, [CANARY])).toEqual([]);
    expect(() => {
      assertNoLeaks(clean, [CANARY]);
    }).not.toThrow();
  });

  it.each(clean.map((source) => source.name))('catches a canary planted in %s', (name) => {
    const planted = clean.map((source) =>
      source.name === name ? { name, lines: [...source.lines, `{"x":"${CANARY}"}`] } : source,
    );
    expect(findLeaks(planted, [CANARY])).toEqual([{ canary: CANARY, source: name, line: 1 }]);
    expect(() => {
      assertNoLeaks(planted, [CANARY]);
    }).toThrow(PrivacyLeakError);
  });

  it('names every leak in the error message', () => {
    const planted = [{ name: 'push', lines: [CANARY, 'ok', `x${CANARY}x`] }];
    expect(() => {
      assertNoLeaks(planted, [CANARY]);
    }).toThrow(`"${CANARY}" in push line 0, "${CANARY}" in push line 2`);
  });

  it('refuses to scan without canaries, or with an empty one', () => {
    expect(() => findLeaks(clean, [])).toThrow(TypeError);
    expect(() => findLeaks(clean, [''])).toThrow(TypeError);
  });
});
