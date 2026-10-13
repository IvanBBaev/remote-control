import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { createReadlinePrompt } from './readline-prompt.js';

function terminal() {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk: Buffer) => (written += chunk.toString()));
  return { input, output, written: () => written };
}

describe('createReadlinePrompt', () => {
  it.each([
    ['y\n', true],
    [' YES \n', true],
    ['n\n', false],
    ['\n', false],
    ['yess\n', false],
  ])('answers %j with %s', async (line, expected) => {
    const t = terminal();
    const prompt = createReadlinePrompt(t.input, t.output);
    const answer = prompt.confirm('Pair?', new AbortController().signal);
    t.input.write(line);
    expect(await answer).toBe(expected);
    expect(t.written()).toBe('Pair? [y/N] ');
  });

  it('treats end of input and an abort as no', async () => {
    const t = terminal();
    const prompt = createReadlinePrompt(t.input, t.output);
    const ended = prompt.confirm('Pair?', new AbortController().signal);
    t.input.end();
    expect(await ended).toBe(false);

    const t2 = terminal();
    const controller = new AbortController();
    const aborted = createReadlinePrompt(t2.input, t2.output).confirm('Pair?', controller.signal);
    controller.abort();
    expect(await aborted).toBe(false);
    expect(await createReadlinePrompt(t2.input, t2.output).confirm('x', controller.signal)).toBe(
      false,
    );
  });
});
