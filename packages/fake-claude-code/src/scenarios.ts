import { readFileSync } from 'node:fs';

/** One AskUserQuestion question (04 §2.3: 1–4 questions, 2–4 options each). */
export interface QuestionSpec {
  readonly question: string;
  readonly header: string;
  readonly options: readonly { readonly label: string; readonly description: string }[];
  readonly multiSelect: boolean;
}

export type ScenarioStep =
  | { readonly kind: 'prompt'; readonly text: string }
  | {
      readonly kind: 'tool';
      readonly toolName: string;
      readonly toolInput: Record<string, unknown>;
      readonly toolResponse: unknown;
      /** `allowed` = a permission rule already allows it; `prompt` = Claude Code would ask. */
      readonly permission: 'allowed' | 'prompt';
      readonly permissionSuggestions?: readonly unknown[];
      /** What the person at the terminal answers if no hook decides (default `deny`). */
      readonly terminalAnswer?: 'allow' | 'deny';
    }
  | {
      readonly kind: 'question';
      readonly questions: readonly QuestionSpec[];
      /** Answers given in the terminal dialog if no hook answers (default: none). */
      readonly terminalAnswers?: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: 'notification';
      readonly notificationType: string;
      readonly message: string;
      readonly title: string;
    }
  | { readonly kind: 'subagent'; readonly agentType: string; readonly lastAssistantMessage: string }
  | { readonly kind: 'compact'; readonly trigger: 'manual' | 'auto' }
  | { readonly kind: 'stop'; readonly lastAssistantMessage: string };

export interface Scenario {
  readonly name: string;
  readonly steps: readonly ScenarioStep[];
  /** `SessionEnd.reason` (default `other`). */
  readonly endReason?: string;
}

const rmRf: ScenarioStep = {
  kind: 'tool',
  toolName: 'Bash',
  toolInput: { command: 'rm -rf node_modules', description: 'Remove node_modules directory' },
  toolResponse: { stdout: '', stderr: '', interrupted: false },
  permission: 'prompt',
  permissionSuggestions: [
    {
      type: 'addRules',
      rules: [{ toolName: 'Bash', ruleContent: 'rm -rf node_modules' }],
      behavior: 'allow',
      destination: 'localSettings',
    },
  ],
};

/** The scenario scripts named in ROADMAP M0-07. */
export const SCENARIOS: Readonly<Record<string, Scenario>> = {
  /** One Bash call that needs a permission decision. */
  permission: {
    name: 'permission',
    steps: [
      { kind: 'prompt', text: 'Clean the dependencies' },
      rmRf,
      { kind: 'stop', lastAssistantMessage: 'Removed node_modules.' },
    ],
  },
  /** One AskUserQuestion answered through PreToolUse (04 §2.3). */
  question: {
    name: 'question',
    steps: [
      { kind: 'prompt', text: 'Scaffold the front end' },
      {
        kind: 'question',
        questions: [
          {
            question: 'Which framework?',
            header: 'Framework',
            options: [
              { label: 'React', description: 'Component library' },
              { label: 'Vue', description: 'Progressive framework' },
            ],
            multiSelect: false,
          },
        ],
      },
      { kind: 'stop', lastAssistantMessage: 'Scaffolded the front end.' },
    ],
  },
  /** A mix of allowed and prompted tools, each followed by PostToolUse. */
  tools: {
    name: 'tools',
    steps: [
      { kind: 'prompt', text: 'Fix the failing test' },
      {
        kind: 'tool',
        toolName: 'Read',
        toolInput: { file_path: 'src/sum.ts' },
        toolResponse: { type: 'text', file: { filePath: 'src/sum.ts', content: 'a - b' } },
        permission: 'allowed',
      },
      {
        kind: 'tool',
        toolName: 'Edit',
        toolInput: { file_path: 'src/sum.ts', old_string: 'a - b', new_string: 'a + b' },
        toolResponse: { filePath: 'src/sum.ts', oldString: 'a - b', newString: 'a + b' },
        permission: 'prompt',
        terminalAnswer: 'allow',
      },
      {
        kind: 'tool',
        toolName: 'Bash',
        toolInput: { command: 'npm test', description: 'Run the tests' },
        toolResponse: { stdout: '1 passed', stderr: '', interrupted: false },
        permission: 'allowed',
      },
      { kind: 'stop', lastAssistantMessage: 'The test passes now.' },
    ],
  },
  /** Subagent, compaction and a Stop that a hook may block once. */
  stop: {
    name: 'stop',
    steps: [
      { kind: 'prompt', text: 'Summarise the repository' },
      { kind: 'subagent', agentType: 'Explore', lastAssistantMessage: 'Found 3 packages.' },
      { kind: 'compact', trigger: 'auto' },
      { kind: 'stop', lastAssistantMessage: 'The repository has 3 packages.' },
    ],
    endReason: 'other',
  },
  /**
   * A permission request the hook holds; if it returns without a decision the terminal
   * prompt appears (D10 handoff), a `permission_prompt` notification fires and nobody is
   * at the terminal, so the tool is denied.
   */
  held: {
    name: 'held',
    steps: [
      { kind: 'prompt', text: 'Deploy to staging' },
      {
        kind: 'tool',
        toolName: 'Bash',
        toolInput: { command: 'npm run deploy:staging', description: 'Deploy to staging' },
        toolResponse: { stdout: 'deployed', stderr: '', interrupted: false },
        permission: 'prompt',
      },
      { kind: 'stop', lastAssistantMessage: 'Deployment finished.' },
    ],
  },
};

/** A built-in scenario by name, or a scenario JSON file by path. */
export function resolveScenario(nameOrPath: string): Scenario {
  const builtIn = SCENARIOS[nameOrPath];
  if (builtIn !== undefined) return builtIn;
  const parsed = JSON.parse(readFileSync(nameOrPath, 'utf8')) as Scenario;
  if (!Array.isArray(parsed.steps)) throw new Error(`${nameOrPath}: scenario without steps`);
  return parsed;
}

/** Replaces the first prompt step's text (`claude --bg "<prompt>"`). */
export function withPrompt(scenario: Scenario, prompt: string | undefined): Scenario {
  if (prompt === undefined) return scenario;
  let replaced = false;
  const steps = scenario.steps.map((step) => {
    if (replaced || step.kind !== 'prompt') return step;
    replaced = true;
    return { ...step, text: prompt };
  });
  return { ...scenario, steps: replaced ? steps : [{ kind: 'prompt', text: prompt }, ...steps] };
}
