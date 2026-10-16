/**
 * Plain-word labels for coding-agent tools (01 W4, 01 §5.3): the phone never shows a raw
 * tool name as the headline, and a push carries the label only (D5).
 */

/** What a tool touches; the card picks its reveal wording and content from it. */
export type ToolKind =
  'command' | 'file' | 'search' | 'web' | 'agent' | 'plan' | 'question' | 'mcp' | 'other';

export interface ToolInfo {
  /** Short human phrase ("Run a command"); at most `MAX_TOOL_LABEL_LENGTH` characters. */
  readonly label: string;
  readonly kind: ToolKind;
}

/** `ApprovalRequest.toolLabel` cap. */
export const MAX_TOOL_LABEL_LENGTH = 200;

/** Every Claude Code built-in tool, including the names older versions used. */
export const CLAUDE_CODE_TOOLS = Object.freeze({
  Bash: { label: 'Run a command', kind: 'command' },
  BashOutput: { label: 'Read command output', kind: 'command' },
  KillShell: { label: 'Stop a command', kind: 'command' },
  KillBash: { label: 'Stop a command', kind: 'command' },
  SlashCommand: { label: 'Run a slash command', kind: 'command' },
  Edit: { label: 'Edit a file', kind: 'file' },
  MultiEdit: { label: 'Edit a file', kind: 'file' },
  Write: { label: 'Write a file', kind: 'file' },
  Read: { label: 'Read a file', kind: 'file' },
  NotebookEdit: { label: 'Edit a notebook', kind: 'file' },
  NotebookRead: { label: 'Read a notebook', kind: 'file' },
  LS: { label: 'List a folder', kind: 'file' },
  Glob: { label: 'Find files', kind: 'search' },
  Grep: { label: 'Search in files', kind: 'search' },
  WebFetch: { label: 'Fetch a web page', kind: 'web' },
  WebSearch: { label: 'Search the web', kind: 'web' },
  Task: { label: 'Start a subagent', kind: 'agent' },
  Agent: { label: 'Start a subagent', kind: 'agent' },
  TaskOutput: { label: 'Read subagent output', kind: 'agent' },
  TaskStop: { label: 'Stop a subagent', kind: 'agent' },
  Skill: { label: 'Use a skill', kind: 'agent' },
  TodoWrite: { label: 'Update the to-do list', kind: 'plan' },
  EnterPlanMode: { label: 'Start planning', kind: 'plan' },
  ExitPlanMode: { label: 'Finish planning', kind: 'plan' },
  AskUserQuestion: { label: 'Ask you a question', kind: 'question' },
  ListMcpResourcesTool: { label: 'List MCP resources', kind: 'mcp' },
  ReadMcpResourceTool: { label: 'Read an MCP resource', kind: 'mcp' },
} satisfies Readonly<Record<string, ToolInfo>>);

export type ClaudeCodeTool = keyof typeof CLAUDE_CODE_TOOLS;

/** The built-in tool names, for tests and docs. */
export const CLAUDE_CODE_TOOL_NAMES: readonly ClaudeCodeTool[] = Object.freeze(
  Object.keys(CLAUDE_CODE_TOOLS) as ClaudeCodeTool[],
);

/**
 * Built-in tools of the other agents that reach the phone (04 §2.11–2.12): Codex's `shell`
 * and the tools Gemini's `BeforeTool` gate matches. Claude Code names win on a clash.
 */
const OTHER_AGENT_TOOLS: ReadonlyMap<string, ToolInfo> = new Map<string, ToolInfo>([
  ['shell', { label: 'Run a command', kind: 'command' }],
  ['run_shell_command', { label: 'Run a command', kind: 'command' }],
  ['write_file', { label: 'Write a file', kind: 'file' }],
  ['replace', { label: 'Edit a file', kind: 'file' }],
]);

const MCP_PREFIX = 'mcp__';

/** `mcp__<server>__<tool>` split into its parts; `undefined` for any other name. */
export function mcpToolName(
  name: string,
): { readonly server: string; readonly tool: string } | undefined {
  if (!name.startsWith(MCP_PREFIX)) return undefined;
  const rest = name.slice(MCP_PREFIX.length);
  const split = rest.indexOf('__');
  const server = split === -1 ? rest : rest.slice(0, split);
  const tool = split === -1 ? '' : rest.slice(split + 2);
  return server === '' ? undefined : { server, tool };
}

/** `create_issue` → `create issue`. */
function words(identifier: string): string {
  return identifier.replace(/[_-]+/g, ' ').trim();
}

const cap = (label: string): string => label.slice(0, MAX_TOOL_LABEL_LENGTH);

/** The label an unknown tool falls back to: the raw name, never JSON (01 W4). */
export function unknownToolLabel(name: string): string {
  return cap(name === '' ? 'Use a tool' : `Use tool ${name}`);
}

function isBuiltIn(name: string): name is ClaudeCodeTool {
  return Object.hasOwn(CLAUDE_CODE_TOOLS, name);
}

/**
 * Label and kind for a tool name: Claude Code built-in, Codex or Gemini built-in, MCP (by
 * server name), or the raw-name fallback.
 */
export function toolInfo(name: string): ToolInfo {
  if (isBuiltIn(name)) return CLAUDE_CODE_TOOLS[name];
  const other = OTHER_AGENT_TOOLS.get(name);
  if (other !== undefined) return other;
  const mcp = mcpToolName(name);
  if (mcp !== undefined) {
    const server = words(mcp.server) || mcp.server;
    const tool = words(mcp.tool);
    return { label: cap(tool === '' ? `Use ${server}` : `${server}: ${tool}`), kind: 'mcp' };
  }
  return { label: unknownToolLabel(name), kind: 'other' };
}

/** A short human label for the tool ("Run a command", "github: create issue"). */
export function toolLabel(name: string): string {
  return toolInfo(name).label;
}
