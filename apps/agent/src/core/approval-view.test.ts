import { requestHash } from '@remote-control/protocol';
import { describe, expect, it } from 'vitest';

import {
  MAX_CONTENT_LENGTH,
  approvalView,
  pendingRequestHash,
  toolContent,
  toolLabel,
} from './approval-view.js';
import type { PendingRequest } from './pending-store.js';

const HASH = 'a'.repeat(64);

function pending(payload: Record<string, unknown>, sessionId = 's1'): PendingRequest {
  return {
    id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    sessionId,
    kind: 'permission',
    fingerprint: 'f',
    payload,
    createdAt: 1000,
    deadline: 2000,
  };
}

describe('toolLabel', () => {
  it.each([
    ['Bash', 'Run a command'],
    ['Edit', 'Edit a file'],
    ['MultiEdit', 'Edit a file'],
    ['Write', 'Write a file'],
    ['Read', 'Read a file'],
    ['WebFetch', 'Fetch a web page'],
    ['Glob', 'Use Glob'],
  ])('%s -> %s', (name, label) => {
    expect(toolLabel(name)).toBe(label);
  });

  it('caps a long label', () => {
    expect(toolLabel('x'.repeat(300))).toHaveLength(200);
  });
});

describe('toolContent', () => {
  it('prefers the command, then the file path, then the url, then JSON', () => {
    expect(toolContent({ command: 'ls', file_path: '/a' })).toBe('ls');
    expect(toolContent({ file_path: '/a' })).toBe('/a');
    expect(toolContent({ url: 'https://x' })).toBe('https://x');
    expect(toolContent({ pattern: '*.ts' })).toBe('{"pattern":"*.ts"}');
    expect(toolContent(null)).toBe('null');
    expect(toolContent({ command: 1 })).toBe('{"command":1}');
  });
});

describe('approvalView', () => {
  it('builds an ApprovalRequest from a permission hook', () => {
    const view = approvalView(
      pending({ tool_name: 'Bash', tool_input: { command: 'npm test' } }),
      HASH,
    );
    expect(view).toEqual({
      id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
      sessionId: 's1',
      requestHash: HASH,
      toolLabel: 'Run a command',
      toolName: 'Bash',
      content: 'npm test',
      truncated: false,
      suggestions: [],
      expiresAt: 2000,
      alwaysSupported: false,
    });
  });

  it('truncates long content and flags it', () => {
    const view = approvalView(
      pending({ tool_name: 'Bash', tool_input: { command: 'x'.repeat(5000) } }),
      HASH,
    );
    expect(view?.content).toHaveLength(MAX_CONTENT_LENGTH);
    expect(view?.truncated).toBe(true);
  });

  it('refuses a hook without a tool name or with an unusable session id', () => {
    expect(approvalView(pending({ tool_input: {} }), HASH)).toBeUndefined();
    expect(approvalView(pending({ tool_name: 'Bash' }, 'x'.repeat(200)), HASH)).toBeUndefined();
  });
});

describe('pendingRequestHash', () => {
  it('hashes the tool name and input (D7)', async () => {
    const request = pending({ tool_name: 'Bash', tool_input: { command: 'ls' } });
    await expect(pendingRequestHash(request)).resolves.toBe(
      await requestHash({ toolName: 'Bash', toolInput: { command: 'ls' } }),
    );
    await expect(pendingRequestHash(pending({}))).resolves.toBe(
      await requestHash({ toolName: '', toolInput: null }),
    );
  });
});
