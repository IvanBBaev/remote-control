import { describe, expect, it } from 'vitest';

import {
  CLAUDE_CODE_TOOL_NAMES,
  CLAUDE_CODE_TOOLS,
  MAX_TOOL_LABEL_LENGTH,
  mcpToolName,
  toolInfo,
  toolLabel,
  unknownToolLabel,
} from './tool-labels.js';

/** The built-ins 01 W4 names explicitly, plus the rest Claude Code ships. */
const EXPECTED_BUILT_INS = [
  'Agent',
  'AskUserQuestion',
  'Bash',
  'BashOutput',
  'Edit',
  'EnterPlanMode',
  'ExitPlanMode',
  'Glob',
  'Grep',
  'KillBash',
  'KillShell',
  'LS',
  'ListMcpResourcesTool',
  'MultiEdit',
  'NotebookEdit',
  'NotebookRead',
  'Read',
  'ReadMcpResourceTool',
  'SlashCommand',
  'Skill',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
  'Write',
];

describe('CLAUDE_CODE_TOOLS', () => {
  it('lists every Claude Code built-in tool', () => {
    expect([...CLAUDE_CODE_TOOL_NAMES].sort()).toEqual([...EXPECTED_BUILT_INS].sort());
  });

  it.each(CLAUDE_CODE_TOOL_NAMES)('%s has a plain label, not the fallback', (name) => {
    const label = toolLabel(name);
    expect(label.trim()).not.toBe('');
    expect(label).not.toBe(unknownToolLabel(name));
    expect(label.length).toBeLessThanOrEqual(MAX_TOOL_LABEL_LENGTH);
    expect(toolInfo(name)).toBe(CLAUDE_CODE_TOOLS[name]);
  });

  it.each([
    ['Bash', 'Run a command', 'command'],
    ['Edit', 'Edit a file', 'file'],
    ['Write', 'Write a file', 'file'],
    ['Read', 'Read a file', 'file'],
    ['WebFetch', 'Fetch a web page', 'web'],
    ['Grep', 'Search in files', 'search'],
    ['Task', 'Start a subagent', 'agent'],
    ['AskUserQuestion', 'Ask you a question', 'question'],
  ])('%s -> %s (%s)', (name, label, kind) => {
    expect(toolInfo(name)).toEqual({ label, kind });
  });
});

describe('MCP tools', () => {
  it('splits server and tool', () => {
    expect(mcpToolName('mcp__github__create_issue')).toEqual({
      server: 'github',
      tool: 'create_issue',
    });
    expect(mcpToolName('mcp__github')).toEqual({ server: 'github', tool: '' });
    expect(mcpToolName('mcp____x')).toBeUndefined();
    expect(mcpToolName('Bash')).toBeUndefined();
  });

  it('labels by server name', () => {
    expect(toolInfo('mcp__github__create_issue')).toEqual({
      label: 'github: create issue',
      kind: 'mcp',
    });
    expect(toolLabel('mcp__claude_ai_Docs__read-file')).toBe('claude ai Docs: read file');
    expect(toolLabel('mcp__github')).toBe('Use github');
    expect(toolLabel('mcp____')).toBe('Use tool mcp____');
    expect(toolLabel('mcp_____x')).toBe('Use tool mcp_____x');
  });

  it('keeps a server name made only of separators', () => {
    expect(toolLabel('mcp___-__run')).toBe('_-: run');
  });

  it('caps a long MCP label', () => {
    expect(toolLabel(`mcp__s__${'x'.repeat(300)}`)).toHaveLength(MAX_TOOL_LABEL_LENGTH);
  });
});

describe('unknown tools', () => {
  it('fall back to the raw name', () => {
    expect(toolInfo('FutureTool')).toEqual({ label: 'Use tool FutureTool', kind: 'other' });
    expect(toolLabel('')).toBe('Use a tool');
    expect(toolLabel('toString')).toBe('Use tool toString');
  });

  it('cap a long name', () => {
    expect(toolLabel('x'.repeat(300))).toHaveLength(MAX_TOOL_LABEL_LENGTH);
  });
});
