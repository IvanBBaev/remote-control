import { seededRandom } from '@remote-control/fake-claude-code';
import { EnvelopeId, RequestId } from '@remote-control/protocol';
import { describe, expect, it } from 'vitest';

import { uuidV4, uuidV7 } from './uuid.js';

describe('uuid', () => {
  it('draws version 4 ids', () => {
    const id = uuidV4(seededRandom(1));
    expect(RequestId.parse(id)).toBe(id);
    expect(id[14]).toBe('4');
    expect(uuidV4(seededRandom(2))).not.toBe(id);
  });

  it('draws version 7 ids that sort by time', () => {
    const random = seededRandom(3);
    const first = uuidV7({ now: () => 1_760_000_000_000 }, random);
    const second = uuidV7({ now: () => 1_760_000_000_001 }, random);
    expect(EnvelopeId.parse(first)).toBe(first);
    expect(first.slice(0, 13)).toBe('0199c82c-c000');
    expect(second > first).toBe(true);
  });
});
