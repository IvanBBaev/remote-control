import { requestHash } from '@remote-control/protocol';
import { describe, expect, it } from 'vitest';

import {
  MAX_CONTENT_LENGTH,
  approvalView,
  pendingRequestHash,
  projectName,
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
    ['Glob', 'Find files'],
    ['mcp__github__create_issue', 'github: create issue'],
    ['FutureTool', 'Use tool FutureTool'],
  ])('%s -> %s', (name, label) => {
    expect(toolLabel(name)).toBe(label);
  });

  it('caps a long label', () => {
    expect(toolLabel('x'.repeat(300))).toHaveLength(200);
  });
});

describe('projectName', () => {
  it('keeps only the folder name (D21)', () => {
    expect(projectName('/Users/me/dev/remote-control')).toBe('remote-control');
    expect(projectName('/Users/me/dev/app/')).toBe('app');
    expect(projectName('C:\\work\\api')).toBe('api');
    expect(projectName('x'.repeat(300))).toHaveLength(128);
  });

  it('has nothing to show for a missing or root directory', () => {
    expect(projectName(undefined)).toBeUndefined();
    expect(projectName(42)).toBeUndefined();
    expect(projectName('/')).toBeUndefined();
    expect(projectName('')).toBeUndefined();
  });
});

describe('toolContent', () => {
  it('falls back through command, file path and url for unknown tools, then JSON', () => {
    expect(toolContent({ command: 'ls', file_path: '/a' })).toBe('ls');
    expect(toolContent({ file_path: '/a' })).toBe('/a');
    expect(toolContent({ url: 'https://x' })).toBe('https://x');
    expect(toolContent({ pattern: '*.ts' })).toBe('{"pattern":"*.ts"}');
    expect(toolContent(null)).toBe('null');
    expect(toolContent({ command: 1 })).toBe('{"command":1}');
  });

  it.each([
    ['Bash', { command: 'npm test', description: 'Run tests' }, 'npm test'],
    ['Edit', { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' }, '/repo/a.ts'],
    ['NotebookEdit', { notebook_path: '/repo/n.ipynb', new_source: 'x' }, '/repo/n.ipynb'],
    ['LS', { path: '/repo' }, '/repo'],
    ['Grep', { pattern: 'TODO', path: '/repo/src' }, 'TODO\nin /repo/src'],
    ['Glob', { pattern: '**/*.ts' }, '**/*.ts'],
    ['WebFetch', { url: 'https://example.com', prompt: 'summarise' }, 'https://example.com'],
    ['WebSearch', { query: 'zod 4 strictObject' }, 'zod 4 strictObject'],
    ['Task', { description: 'Find the bug', prompt: 'long prompt' }, 'Find the bug'],
    ['Skill', { skill: 'worklog' }, 'worklog'],
    ['SlashCommand', { command: '/review' }, '/review'],
    ['ExitPlanMode', { plan: '1. Do it' }, '1. Do it'],
    ['mcp__github__create_issue', { title: 'Bug' }, '{"title":"Bug"}'],
    ['AskUserQuestion', { questions: [] }, '{"questions":[]}'],
    ['Edit', { old_string: 'a' }, '{"old_string":"a"}'],
  ])('%s shows what it will do', (name, input, content) => {
    expect(toolContent(input, name)).toBe(content);
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

  it('offers "Always" with every session rule it would grant (D24)', () => {
    const view = approvalView(
      pending({
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        permission_suggestions: [
          {
            type: 'addRules',
            rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
            behavior: 'allow',
            destination: 'localSettings',
          },
        ],
      }),
      HASH,
    );
    expect(view).toMatchObject({ suggestions: ['Bash(npm test)'], alwaysSupported: true });
    expect(view).not.toHaveProperty('alwaysDestinations');
  });

  it('lists the "Always" destinations only when there is a choice (M2-07)', () => {
    const payload = {
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      permission_suggestions: [
        { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow' },
      ],
    };
    const both = ['session', 'projectSettings'] as const;
    expect(approvalView(pending(payload), HASH, both)?.alwaysDestinations).toEqual(both);
    expect(approvalView(pending(payload), HASH, ['session'])).not.toHaveProperty(
      'alwaysDestinations',
    );
    // No rule to grant: no "Always" at all, so no destinations either.
    const none = approvalView(pending({ ...payload, permission_suggestions: [] }), HASH, both);
    expect(none).toMatchObject({ alwaysSupported: false });
    expect(none).not.toHaveProperty('alwaysDestinations');
  });

  it('marks a deny-only request and grants no "Always" rules (04 A6)', () => {
    const payload = {
      tool_name: 'run_shell_command',
      tool_input: { command: 'ls' },
      permission_suggestions: [
        { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow' },
      ],
    };
    const view = approvalView(pending(payload), HASH, ['session', 'projectSettings'], false);
    expect(view).toMatchObject({ allowSupported: false, alwaysSupported: false, suggestions: [] });
    expect(view).not.toHaveProperty('alwaysDestinations');
    expect(approvalView(pending(payload), HASH)).not.toHaveProperty('allowSupported');
  });

  it('names the project by its folder, never the full path (D21)', () => {
    const view = approvalView(
      pending({
        tool_name: 'Edit',
        cwd: '/Users/me/dev/remote-control',
        tool_input: { file_path: 'src/a.ts' },
      }),
      HASH,
    );
    expect(view).toMatchObject({
      toolLabel: 'Edit a file',
      project: 'remote-control',
      content: 'src/a.ts',
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
