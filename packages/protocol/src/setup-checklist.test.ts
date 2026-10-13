import { describe, expect, it } from 'vitest';

import { SETUP_CHECKLIST, setupCheckLine } from './setup-checklist.js';

describe('SETUP_CHECKLIST (M1-07)', () => {
  it('lists the four checks in the order a request travels', () => {
    expect(SETUP_CHECKLIST.map((check) => check.id)).toEqual(['agent', 'relay', 'hooks', 'trust']);
    expect(Object.isFrozen(SETUP_CHECKLIST)).toBe(true);
  });

  it('prints the fix only when the check is not ok', () => {
    const [agent] = SETUP_CHECKLIST;
    expect(setupCheckLine(agent!, true)).toBe('[ok] Is the agent running?');
    expect(setupCheckLine(agent!, false)).toBe(`[no] Is the agent running? ${agent!.fix}`);
    expect(setupCheckLine(agent!, undefined)).toBe(`[?]  Is the agent running? ${agent!.fix}`);
  });
});
