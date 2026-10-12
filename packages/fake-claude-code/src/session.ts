import type { Clock, Random } from '@remote-control/protocol';

import type { HookEventName } from './events.js';
import { type FireResult, type HookInput, HookRunner } from './hook-runner.js';
import { prefixedId, uuidV4 } from './ids.js';
import { type Env, transcriptPath } from './paths.js';
import {
  type PayloadContext,
  notificationPayload,
  permissionRequestPayload,
  postToolUsePayload,
  preCompactPayload,
  preToolUsePayload,
  sessionEndPayload,
  sessionStartPayload,
  stopPayload,
  subagentStopPayload,
  userPromptSubmitPayload,
} from './payloads.js';
import { type AgentEntry, writeAgentEntry } from './roster.js';
import type { Scenario, ScenarioStep } from './scenarios.js';
import { loadHooks } from './settings.js';
import { TranscriptWriter } from './transcript.js';

export interface SessionOptions {
  readonly env: Env;
  readonly cwd: string;
  readonly clock: Clock;
  readonly random: Random;
  readonly scenario: Scenario;
  /** Defaults to a fresh UUID. */
  readonly sessionId?: string;
  readonly name?: string;
  readonly kind?: AgentEntry['kind'];
  readonly pid?: number;
  /** `SessionStart.source` (04 §2.4). */
  readonly source?: 'startup' | 'resume' | 'clear' | 'compact' | 'fork';
  readonly permissionMode?: string;
  /** Upper bound on Stop-hook re-runs, so a hook that always blocks cannot loop forever. */
  readonly maxStopBlocks?: number;
}

export interface ToolRecord {
  readonly toolName: string;
  readonly toolUseId: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly outcome: 'ran' | 'denied';
  /** Who decided: a rule, a PreToolUse hook, a PermissionRequest hook or the terminal. */
  readonly decidedBy: 'rule' | 'PreToolUse' | 'PermissionRequest' | 'terminal';
  readonly reason?: string;
}

export interface SessionResult {
  readonly sessionId: string;
  readonly transcriptPath: string;
  readonly fired: readonly FireResult[];
  readonly tools: readonly ToolRecord[];
  /** AskUserQuestion answers per question text. */
  readonly answers: readonly Readonly<Record<string, string>>[];
  /** Why the session ended early, if it did (`continue: false`, a blocked prompt, an interrupt). */
  readonly stoppedEarly?: string;
  readonly warnings: readonly string[];
}

/**
 * Plays a scenario as one Claude Code session (07 §5.3): fires every hook event in the
 * documented order, writes the transcript and keeps the `agents --json` roster entry
 * current. It models the hook contract only, not a model or a real tool.
 */
export class FakeSession {
  readonly #options: SessionOptions;
  readonly #runner: HookRunner;
  readonly #transcript: TranscriptWriter;
  readonly #ctx: { -readonly [K in keyof PayloadContext]: PayloadContext[K] };
  readonly #fired: FireResult[] = [];
  readonly #tools: ToolRecord[] = [];
  readonly #answers: Record<string, string>[] = [];
  readonly #warnings: string[];
  readonly #entry: { -readonly [K in keyof AgentEntry]: AgentEntry[K] };
  #stoppedEarly: string | undefined;

  constructor(options: SessionOptions) {
    this.#options = options;
    const settings = loadHooks({ env: options.env, cwd: options.cwd });
    this.#warnings = [...settings.warnings];
    this.#runner = new HookRunner({
      settings,
      cwd: options.cwd,
      env: options.env,
      clock: options.clock,
    });
    const sessionId = options.sessionId ?? uuidV4(options.random);
    const path = transcriptPath(options.env, options.cwd, sessionId);
    this.#transcript = new TranscriptWriter({
      path,
      clock: options.clock,
      random: options.random,
      sessionId,
      cwd: options.cwd,
    });
    this.#ctx = {
      sessionId,
      transcriptPath: path,
      cwd: options.cwd,
      permissionMode: options.permissionMode ?? 'default',
    };
    this.#entry = {
      cwd: options.cwd,
      kind: options.kind ?? 'interactive',
      startedAt: new Date(options.clock.now()).toISOString(),
      id: sessionId.slice(0, 8),
      state: 'working',
      pid: options.pid ?? 0,
      status: 'busy',
      sessionId,
      ...(options.name !== undefined ? { name: options.name } : {}),
    };
  }

  get sessionId(): string {
    return this.#ctx.sessionId;
  }

  async run(): Promise<SessionResult> {
    this.#updateRoster({ state: 'working', status: 'busy' });
    await this.#fire(
      'SessionStart',
      sessionStartPayload(this.#ctx, this.#options.source ?? 'startup'),
    );
    for (const step of this.#options.scenario.steps) {
      if (this.#stoppedEarly !== undefined) break;
      await this.#step(step);
    }
    await this.#fire(
      'SessionEnd',
      sessionEndPayload(this.#ctx, this.#options.scenario.endReason ?? 'other'),
    );
    await this.#runner.drain();
    this.#updateRoster({ state: 'done', status: 'idle' });
    return {
      sessionId: this.#ctx.sessionId,
      transcriptPath: this.#ctx.transcriptPath,
      fired: this.#fired,
      tools: this.#tools,
      answers: this.#answers,
      ...(this.#stoppedEarly !== undefined ? { stoppedEarly: this.#stoppedEarly } : {}),
      warnings: this.#warnings,
    };
  }

  async #fire(event: HookEventName, input: HookInput): Promise<FireResult> {
    const result = await this.#runner.fire(event, input);
    this.#fired.push(result);
    if (!result.continue && this.#stoppedEarly === undefined) {
      // 04 §2.1: `continue: false` stops Claude after the hook.
      this.#stoppedEarly = result.stopReason ?? `continue: false from ${event}`;
    }
    return result;
  }

  async #step(step: ScenarioStep): Promise<void> {
    switch (step.kind) {
      case 'prompt':
        return this.#prompt(step.text);
      case 'tool':
        return this.#tool(step);
      case 'question':
        return this.#question(step);
      case 'notification':
        await this.#fire(
          'Notification',
          notificationPayload(this.#ctx, {
            message: step.message,
            title: step.title,
            notificationType: step.notificationType,
          }),
        );
        return;
      case 'subagent':
        return this.#subagent(step);
      case 'compact':
        await this.#fire(
          'PreCompact',
          preCompactPayload(this.#ctx, { trigger: step.trigger, customInstructions: '' }),
        );
        this.#transcript.system(`Conversation compacted (${step.trigger})`);
        return;
      case 'stop':
        return this.#stop(step.lastAssistantMessage);
    }
  }

  async #prompt(text: string): Promise<void> {
    this.#ctx.promptId = prefixedId('prompt_', this.#options.random);
    const result = await this.#fire('UserPromptSubmit', userPromptSubmitPayload(this.#ctx, text));
    if (result.decision === 'block') {
      // 04 §2.4: a blocked prompt is erased and never reaches the model.
      this.#stoppedEarly = `prompt blocked: ${result.reason ?? ''}`;
      return;
    }
    this.#transcript.user(text);
  }

  async #tool(step: Extract<ScenarioStep, { kind: 'tool' }>): Promise<void> {
    const toolUseId = prefixedId('toolu_', this.#options.random);
    this.#transcript.toolUse(toolUseId, step.toolName, step.toolInput);
    const pre = await this.#fire(
      'PreToolUse',
      preToolUsePayload(this.#ctx, {
        toolName: step.toolName,
        toolInput: step.toolInput,
        toolUseId,
      }),
    );
    const record = (
      outcome: ToolRecord['outcome'],
      decidedBy: ToolRecord['decidedBy'],
      input: Readonly<Record<string, unknown>>,
      reason?: string,
    ): ToolRecord => ({
      toolName: step.toolName,
      toolUseId,
      input,
      outcome,
      decidedBy,
      ...(reason !== undefined ? { reason } : {}),
    });
    if (pre.decision === 'deny') {
      return this.#denied(record('denied', 'PreToolUse', step.toolInput, pre.reason));
    }
    if (pre.decision === 'allow') {
      // 04 §2.3: `allow` skips the permission prompt; `updatedInput` replaces the input.
      return this.#ran(step, record('ran', 'PreToolUse', pre.updatedInput ?? step.toolInput));
    }
    // `ask` forces the permission flow; `defer` and no decision leave it to the rules.
    // Assumption: `defer` behaves like no decision outside `-p` mode (04 §2.3).
    const input = pre.updatedInput ?? step.toolInput;
    if (pre.decision !== 'ask' && step.permission === 'allowed') {
      return this.#ran(step, record('ran', 'rule', input));
    }
    this.#updateRoster({ state: 'blocked', status: 'waiting', waitingFor: 'permission prompt' });
    const permission = await this.#fire(
      'PermissionRequest',
      permissionRequestPayload(this.#ctx, {
        toolName: step.toolName,
        toolInput: input,
        ...(step.permissionSuggestions !== undefined
          ? { permissionSuggestions: step.permissionSuggestions }
          : {}),
      }),
    );
    this.#updateRoster({ state: 'working', status: 'busy' });
    if (permission.decision === 'allow') {
      return this.#ran(step, record('ran', 'PermissionRequest', permission.updatedInput ?? input));
    }
    if (permission.decision === 'deny') {
      this.#denied(record('denied', 'PermissionRequest', input, permission.reason));
      // 04 §2.2: `interrupt: true` on a deny stops Claude.
      if (permission.interrupt) this.#stoppedEarly = `interrupted: ${permission.reason ?? ''}`;
      return;
    }
    // D10 handoff: no decision → the terminal prompt appears and `permission_prompt` fires.
    await this.#fire(
      'Notification',
      notificationPayload(this.#ctx, {
        message: `Claude needs your permission to use ${step.toolName}`,
        title: 'Permission needed',
        notificationType: 'permission_prompt',
      }),
    );
    if (step.terminalAnswer === 'allow') {
      return this.#ran(step, record('ran', 'terminal', input));
    }
    // Assumption: nobody answers the terminal in a test, so the scripted default is deny.
    this.#denied(record('denied', 'terminal', input, 'denied in the terminal'));
  }

  async #ran(step: Extract<ScenarioStep, { kind: 'tool' }>, tool: ToolRecord): Promise<void> {
    this.#tools.push(tool);
    this.#transcript.toolResult(tool.toolUseId, step.toolResponse, false);
    const started = this.#options.clock.now();
    await this.#fire(
      'PostToolUse',
      postToolUsePayload(this.#ctx, {
        toolName: tool.toolName,
        toolInput: tool.input,
        toolResponse: step.toolResponse,
        toolUseId: tool.toolUseId,
        durationMs: Math.max(0, this.#options.clock.now() - started),
      }),
    );
  }

  #denied(tool: ToolRecord): void {
    this.#tools.push(tool);
    this.#transcript.toolResult(tool.toolUseId, tool.reason ?? 'denied', true);
  }

  async #question(step: Extract<ScenarioStep, { kind: 'question' }>): Promise<void> {
    const toolUseId = prefixedId('toolu_', this.#options.random);
    const toolInput = { questions: step.questions };
    this.#transcript.toolUse(toolUseId, 'AskUserQuestion', toolInput);
    this.#updateRoster({ state: 'blocked', status: 'waiting', waitingFor: 'input needed' });
    // 04 §2.3: AskUserQuestion goes through PreToolUse only; `allow` + `updatedInput.answers`
    // answers it without the terminal dialog.
    const pre = await this.#fire(
      'PreToolUse',
      preToolUsePayload(this.#ctx, { toolName: 'AskUserQuestion', toolInput, toolUseId }),
    );
    this.#updateRoster({ state: 'working', status: 'busy' });
    const hookAnswers = pre.updatedInput?.answers;
    if (pre.decision === 'deny') {
      this.#tools.push({
        toolName: 'AskUserQuestion',
        toolUseId,
        input: toolInput,
        outcome: 'denied',
        decidedBy: 'PreToolUse',
        ...(pre.reason !== undefined ? { reason: pre.reason } : {}),
      });
      this.#transcript.toolResult(toolUseId, pre.reason ?? 'denied', true);
      return;
    }
    const answers =
      pre.decision === 'allow' && typeof hookAnswers === 'object' && hookAnswers !== null
        ? (hookAnswers as Record<string, string>)
        : { ...(step.terminalAnswers ?? {}) };
    this.#answers.push(answers);
    this.#tools.push({
      toolName: 'AskUserQuestion',
      toolUseId,
      input: pre.updatedInput ?? toolInput,
      outcome: 'ran',
      decidedBy: pre.decision === 'allow' ? 'PreToolUse' : 'terminal',
    });
    this.#transcript.toolResult(toolUseId, { answers }, false);
  }

  async #subagent(step: Extract<ScenarioStep, { kind: 'subagent' }>): Promise<void> {
    const agentId = prefixedId('agent_', this.#options.random, 8);
    await this.#fire(
      'SubagentStop',
      subagentStopPayload(this.#ctx, {
        stopHookActive: false,
        lastAssistantMessage: step.lastAssistantMessage,
        agentId,
        agentType: step.agentType,
        agentTranscriptPath: this.#ctx.transcriptPath.replace(
          /\.jsonl$/,
          `/subagents/${agentId}.jsonl`,
        ),
      }),
    );
  }

  async #stop(lastAssistantMessage: string): Promise<void> {
    this.#transcript.assistantText(lastAssistantMessage);
    const limit = this.#options.maxStopBlocks ?? 1;
    // 04 §2.4: a blocked Stop makes Claude continue; the re-fired Stop carries
    // `stop_hook_active: true` so a hook can avoid an endless loop.
    for (let attempt = 0; attempt <= limit; attempt += 1) {
      const result = await this.#fire(
        'Stop',
        stopPayload(this.#ctx, { stopHookActive: attempt > 0, lastAssistantMessage }),
      );
      if (result.decision !== 'block' || this.#stoppedEarly !== undefined) return;
      this.#transcript.user(`Stop hook feedback: ${result.reason ?? ''}`);
    }
  }

  #updateRoster(
    patch: Pick<AgentEntry, 'state' | 'status'> & { waitingFor?: AgentEntry['waitingFor'] },
  ): void {
    this.#entry.state = patch.state;
    this.#entry.status = patch.status;
    if (patch.waitingFor === undefined) delete this.#entry.waitingFor;
    else this.#entry.waitingFor = patch.waitingFor;
    writeAgentEntry(this.#options.env, this.#entry);
  }
}
