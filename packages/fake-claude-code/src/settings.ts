import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type HookEventName, isHookEventName } from './events.js';
import { type Env, configDir } from './paths.js';

/** One `command` hook entry from a settings file (04 §2.1). */
export interface CommandHook {
  readonly type: 'command';
  readonly command: string;
  /** Seconds. Fractions are accepted by the fake so tests stay fast (assumption). */
  readonly timeout?: number;
  readonly async?: boolean;
  /** 04 §2.1: `"block"` turns a hook error or timeout into a block (v2.1.295+). */
  readonly onFailure?: 'block';
}

export interface MatcherGroup {
  readonly matcher?: string;
  readonly hooks: readonly CommandHook[];
  /** Settings file the group came from. */
  readonly source: string;
}

export interface HookSettings {
  readonly disableAllHooks: boolean;
  readonly groups: Readonly<Partial<Record<HookEventName, readonly MatcherGroup[]>>>;
  /** Entries the fake skipped (unreadable file, unsupported hook type, bad shape). */
  readonly warnings: readonly string[];
}

/**
 * Settings files in load order (07 §5.3): user `~/.claude/settings.json` (respecting
 * `CLAUDE_CONFIG_DIR`), project `.claude/settings.json`, local `.claude/settings.local.json`.
 * 04 §2.5: hooks from all files are loaded and run together.
 */
export function settingsFiles(env: Env, cwd: string): string[] {
  return [
    join(configDir(env), 'settings.json'),
    join(cwd, '.claude', 'settings.json'),
    join(cwd, '.claude', 'settings.local.json'),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseHook(raw: unknown, where: string, warnings: string[]): CommandHook | undefined {
  if (!isRecord(raw)) {
    warnings.push(`${where}: hook entry is not an object`);
    return undefined;
  }
  if (raw.type !== 'command') {
    // D11: only `command` hooks are part of the integration surface; the fake skips the rest.
    warnings.push(`${where}: unsupported hook type ${JSON.stringify(raw.type)}`);
    return undefined;
  }
  if (typeof raw.command !== 'string' || raw.command.length === 0) {
    warnings.push(`${where}: command hook without a command`);
    return undefined;
  }
  return {
    type: 'command',
    command: raw.command,
    ...(typeof raw.timeout === 'number' && raw.timeout > 0 ? { timeout: raw.timeout } : {}),
    ...(raw.async === true ? { async: true } : {}),
    ...(raw.onFailure === 'block' ? { onFailure: 'block' as const } : {}),
  };
}

function readSettingsFile(file: string, warnings: string[]): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) return parsed;
    warnings.push(`${file}: not a JSON object`);
  } catch {
    warnings.push(`${file}: invalid JSON`);
  }
  return undefined;
}

/** Loads and merges hook configuration from every settings file. */
export function loadHooks(options: { env: Env; cwd: string }): HookSettings {
  const warnings: string[] = [];
  const groups: Partial<Record<HookEventName, MatcherGroup[]>> = {};
  let disableAllHooks = false;
  for (const file of settingsFiles(options.env, options.cwd)) {
    const settings = readSettingsFile(file, warnings);
    if (settings === undefined) continue;
    if (settings.disableAllHooks === true) disableAllHooks = true;
    if (settings.hooks === undefined) continue;
    if (!isRecord(settings.hooks)) {
      warnings.push(`${file}: "hooks" is not an object`);
      continue;
    }
    for (const [event, rawGroups] of Object.entries(settings.hooks)) {
      if (!isHookEventName(event)) {
        warnings.push(`${file}: event ${event} is not simulated by the fake`);
        continue;
      }
      if (!Array.isArray(rawGroups)) {
        warnings.push(`${file}: hooks.${event} is not an array`);
        continue;
      }
      rawGroups.forEach((rawGroup: unknown, index) => {
        const where = `${file}: hooks.${event}[${index}]`;
        if (!isRecord(rawGroup) || !Array.isArray(rawGroup.hooks)) {
          warnings.push(`${where}: matcher group without a hooks array`);
          return;
        }
        const hooks = rawGroup.hooks
          .map((hook: unknown, hookIndex) =>
            parseHook(hook, `${where}.hooks[${hookIndex}]`, warnings),
          )
          .filter((hook): hook is CommandHook => hook !== undefined);
        const list = groups[event] ?? [];
        list.push({
          ...(typeof rawGroup.matcher === 'string' ? { matcher: rawGroup.matcher } : {}),
          hooks,
          source: file,
        });
        groups[event] = list;
      });
    }
  }
  return { disableAllHooks, groups, warnings };
}
