import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Clock, Random } from '@remote-control/protocol';

import { uuidV4 } from './ids.js';

/**
 * Minimal transcript JSONL so `transcript_path` points at a real file (07 §5.3, §5.5).
 * The real format is internal to Claude Code and unstable (04 §2.6); the live feed never
 * parses it (D11) and only the optional backfill reads it (ADR 0014), so the fake writes
 * only the commonly seen fields: `type`, `uuid`, `parentUuid`, `sessionId`, `timestamp`,
 * `cwd`, `message`.
 */
export class TranscriptWriter {
  readonly path: string;
  readonly #clock: Clock;
  readonly #random: Random;
  readonly #sessionId: string;
  readonly #cwd: string;
  #parent: string | null = null;

  constructor(options: {
    path: string;
    clock: Clock;
    random: Random;
    sessionId: string;
    cwd: string;
  }) {
    this.path = options.path;
    this.#clock = options.clock;
    this.#random = options.random;
    this.#sessionId = options.sessionId;
    this.#cwd = options.cwd;
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, '');
  }

  user(text: string): void {
    this.#append('user', { role: 'user', content: text });
  }

  assistantText(text: string): void {
    this.#append('assistant', { role: 'assistant', content: [{ type: 'text', text }] });
  }

  toolUse(id: string, name: string, input: unknown): void {
    this.#append('assistant', {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name, input }],
    });
  }

  toolResult(toolUseId: string, content: unknown, isError: boolean): void {
    this.#append('user', {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }],
    });
  }

  system(text: string): void {
    this.#append('system', { role: 'system', content: text });
  }

  #append(type: string, message: unknown): void {
    const uuid = uuidV4(this.#random);
    const line = {
      type,
      uuid,
      parentUuid: this.#parent,
      sessionId: this.#sessionId,
      timestamp: new Date(this.#clock.now()).toISOString(),
      cwd: this.#cwd,
      message,
    };
    this.#parent = uuid;
    appendFileSync(this.path, `${JSON.stringify(line)}\n`);
  }
}
