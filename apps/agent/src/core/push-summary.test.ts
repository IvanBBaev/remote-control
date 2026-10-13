import {
  deriveNotificationKey,
  generateX25519KeyPair,
  openPushSummary,
} from '@remote-control/crypto';
import { seededRandom } from '@remote-control/fake-claude-code';
import { decodePushSummary, toBase64Url } from '@remote-control/protocol';
import { describe, expect, it } from 'vitest';

import type { PendingRequest } from './pending-store.js';
import { createPushSealer, maskSecrets, pushSummaryLine, pushSummaryText } from './push-summary.js';

const REQUEST = '0199a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b';
const ENVELOPE = '0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';

function pending(payload: Record<string, unknown>): PendingRequest {
  return { id: REQUEST, payload } as unknown as PendingRequest;
}

describe('maskSecrets (D5: never secrets)', () => {
  it.each([
    ['API_TOKEN=abc123 npm run deploy', 'API_TOKEN=*** npm run deploy'],
    ['export AWS_SECRET_ACCESS_KEY="x y z"', 'export AWS_SECRET_ACCESS_KEY=***'],
    ["mysql --password 'hunter 2' -h db", 'mysql --password *** -h db'],
    ['psql --pwd=hunter2', 'psql --pwd=***'],
    ['curl -H "Authorization: Bearer eyJhbGci.x.y" api', 'curl -H "Authorization: *** *** api'],
    ['wget --header=Bearer:x Bearer abc', 'wget --header=Bearer:x Bearer ***'],
    ['curl -u admin:hunter2 https://x', 'curl -u *** https://x'],
    ['git clone https://bob:pa55@github.com/a/b', 'git clone https://***@github.com/a/b'],
    ['aws s3 ls AKIAIOSFODNN7EXAMPLE', 'aws s3 ls ***'],
    ['echo ghp_16C7e42F292c6912E7710c838347Ae178B4a', 'echo ***'],
  ])('%s', (input, expected) => {
    expect(maskSecrets(input)).toBe(expected);
  });

  it('leaves ordinary commands alone', () => {
    expect(maskSecrets('pnpm --filter remotectl test -- --run')).toBe(
      'pnpm --filter remotectl test -- --run',
    );
  });
});

describe('pushSummaryLine', () => {
  const cwd = '/Users/me/work/remote-control';

  it('shows the first non-empty line of a command, masked and capped', () => {
    expect(pushSummaryLine('Bash', { command: '\n  TOKEN=s3cr3t make\nrm -rf /' }, cwd)).toBe(
      'TOKEN=*** make',
    );
    const long = pushSummaryLine('Bash', { command: 'x '.repeat(100) }, cwd)!;
    expect(Array.from(long)).toHaveLength(120);
    expect(long.endsWith('…')).toBe(true);
  });

  it('shows a file path relative to the project, else its name — never the content', () => {
    expect(
      pushSummaryLine('Write', { file_path: `${cwd}/src/a.ts`, content: 'SECRET BODY' }, cwd),
    ).toBe('src/a.ts');
    expect(pushSummaryLine('Edit', { file_path: '/etc/hosts', new_string: 'x' }, cwd)).toBe(
      'hosts',
    );
    expect(pushSummaryLine('NotebookEdit', { notebook_path: 'C:\\w\\n.ipynb' }, 'C:\\w\\')).toBe(
      'n.ipynb',
    );
    expect(pushSummaryLine('LS', { path: `${cwd}/` }, undefined)).toBe('remote-control');
    expect(pushSummaryLine('Read', { file_path: '/' }, '')).toBe('/');
    expect(pushSummaryLine('Read', {}, cwd)).toBeUndefined();
  });

  it('shows a search pattern', () => {
    expect(pushSummaryLine('Grep', { pattern: 'TODO', path: 'src' }, cwd)).toBe('TODO');
  });

  it('shows a URL without its query or credentials, or the search query', () => {
    expect(
      pushSummaryLine('WebFetch', { url: 'https://u:p@api.example.com/v1/x?key=abc#f' }, cwd),
    ).toBe('https://api.example.com/v1/x');
    expect(pushSummaryLine('WebFetch', { url: 'not a url' }, cwd)).toBeUndefined();
    expect(pushSummaryLine('WebSearch', { query: 'vitest coverage' }, cwd)).toBe('vitest coverage');
  });

  it("shows a subagent's description, never its prompt", () => {
    expect(
      pushSummaryLine('Task', { description: 'Review the diff', prompt: 'secret plan' }, cwd),
    ).toBe('Review the diff');
  });

  it('has no line for other tools or a blank field', () => {
    expect(pushSummaryLine('TodoWrite', { todos: [] }, cwd)).toBeUndefined();
    expect(pushSummaryLine('mcp__github__create_issue', { title: 'x' }, cwd)).toBeUndefined();
    expect(pushSummaryLine('Bash', { command: '   ' }, cwd)).toBeUndefined();
    expect(pushSummaryLine('Bash', null, cwd)).toBeUndefined();
  });
});

describe('pushSummaryText', () => {
  it('encodes project, label, line and request id', () => {
    const text = pushSummaryText(
      pending({ tool_name: 'Bash', tool_input: { command: 'npm test' }, cwd: '/w/app' }),
    );
    expect(decodePushSummary(text!)).toEqual({
      v: 1,
      p: 'app',
      l: 'Run a command',
      s: 'npm test',
      r: REQUEST,
    });
  });

  it('leaves out what is missing and has nothing without a tool name', () => {
    expect(decodePushSummary(pushSummaryText(pending({ tool_name: 'TodoWrite' }))!)).toEqual({
      v: 1,
      l: 'Update the to-do list',
      r: REQUEST,
    });
    expect(pushSummaryText(pending({}))).toBeUndefined();
  });

  it('has nothing when the summary does not validate', () => {
    const request = {
      id: 'not-a-uuid',
      payload: { tool_name: 'Bash' },
    } as unknown as PendingRequest;
    expect(pushSummaryText(request)).toBeUndefined();
  });
});

describe('createPushSealer', () => {
  it("seals for the phone's notification key, once derived per phone", async () => {
    const random = seededRandom(5);
    const agent = await generateX25519KeyPair(random);
    const phone = await generateX25519KeyPair(random);
    const peer = {
      deviceId: 'p',
      name: 'Pixel',
      publicKey: toBase64Url(phone.publicKey),
      pairedAt: 1,
    };
    const sealer = createPushSealer(agent.privateKey, random);
    const first = await sealer.seal(peer, ENVELOPE, '{"v":1,"l":"x"}');
    const second = await sealer.seal(peer, ENVELOPE, '{"v":1,"l":"x"}');
    expect(first).not.toBe(second);
    const opened = await deriveNotificationKey(phone.privateKey, agent.publicKey, ['decrypt']).then(
      (key) => openPushSummary(key, ENVELOPE, Buffer.from(first!, 'base64')),
    );
    expect(new TextDecoder().decode(opened)).toBe('{"v":1,"l":"x"}');
  });

  it('gives up quietly on a bad peer key or an oversized summary', async () => {
    const random = seededRandom(6);
    const agent = await generateX25519KeyPair(random);
    const sealer = createPushSealer(agent.privateKey, random);
    const bad = { deviceId: 'p', name: 'x', publicKey: '!!', pairedAt: 1 };
    expect(await sealer.seal(bad, ENVELOPE, 'x')).toBeUndefined();
    const phone = await generateX25519KeyPair(random);
    const peer = { ...bad, publicKey: toBase64Url(phone.publicKey) };
    expect(await sealer.seal(peer, ENVELOPE, 'x'.repeat(2000))).toBeUndefined();
  });
});
