import type { Clock } from '../ports/clock.js';
import type { FileSystem } from '../ports/file-system.js';
import type { PathPort } from '../ports/path-port.js';
import {
  type JsonArrayNode,
  type JsonNode,
  type JsonObjectNode,
  JsonTextError,
  appendArrayItem,
  appendObjectMember,
  findMember,
  parseJsonText,
  removeArrayItem,
  removeObjectMember,
} from './json-text-edit.js';

/** Blocking events (D11): held up to `hooks.holdSeconds`. */
export const BLOCKING_HOOKS = [
  { event: 'PermissionRequest' },
  { event: 'PreToolUse', matcher: '^AskUserQuestion$' },
] as const;
/** Feed events (D11): never decide, answered at once. */
export const FEED_EVENTS = [
  'PostToolUse',
  'UserPromptSubmit',
  'Notification',
  'Stop',
  'SubagentStop',
  'SessionStart',
  'SessionEnd',
  'PreCompact',
] as const;
/** Timeout of a feed hook in seconds (D11). */
export const FEED_TIMEOUT_SECONDS = 5;
/** Our hook script, copied into the data directory next to `agent.json`. */
export const HOOK_SCRIPT_FILE = 'hook.cjs';
export const SETTINGS_FILE = 'settings.json';
const SETTINGS_FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** One hook entry the installer manages. */
export interface HookSpec {
  readonly event: string;
  readonly matcher?: string;
  readonly timeout: number;
}

/** The D11 hook set: two blocking hooks with `holdSeconds`, eight feed hooks with 5 s. */
export function hookSpecs(holdSeconds: number): readonly HookSpec[] {
  return [
    ...BLOCKING_HOOKS.map((hook) => ({ ...hook, timeout: holdSeconds })),
    ...FEED_EVENTS.map((event) => ({ event, timeout: FEED_TIMEOUT_SECONDS })),
  ];
}

/**
 * Our entries are recognised by the script path in the command: `remotectl/hook.cjs`
 * (env-paths data dir; `remotectl\Data\hook.cjs` on Windows) or 04's earlier
 * `.remote-control/hook.js`. Anything else is foreign and never touched.
 */
const OWN_COMMAND = [
  /remotectl[\\/]+(?:Data[\\/]+)?hook\.c?js\b/,
  /\.remote-control[\\/]+hook\.js\b/,
];

export function isOwnCommand(command: string): boolean {
  return OWN_COMMAND.some((pattern) => pattern.test(command));
}

/** `"<node>" "<data>/hook.cjs" <T>`: absolute paths, so Claude Code's PATH does not matter. */
export function hookCommand(execPath: string, scriptPath: string, timeout: number): string {
  return `"${execPath}" "${scriptPath}" ${timeout}`;
}

/** The settings file cannot be edited safely; nothing was changed. */
export class HooksSettingsError extends Error {
  override readonly name = 'HooksSettingsError';
}

interface OwnHook {
  readonly event: string;
  readonly eventIndex: number;
  readonly eventArray: JsonArrayNode;
  readonly group: JsonObjectNode;
  readonly groupIndex: number;
  readonly hooks: JsonArrayNode;
  readonly hookIndex: number;
  readonly hook: JsonObjectNode;
}

interface Settings {
  readonly root: JsonObjectNode;
  readonly hooks?: { readonly node: JsonObjectNode; readonly index: number };
}

function parseSettings(text: string, path: string): Settings {
  let root: JsonNode;
  try {
    root = parseJsonText(text);
  } catch (error) {
    if (error instanceof JsonTextError) {
      throw new HooksSettingsError(
        `${path} is not valid JSON (${error.message}); fix or move it and retry — nothing was changed`,
      );
    }
    throw error;
  }
  if (root.type !== 'object') {
    throw new HooksSettingsError(
      `${path}: the top level is not a JSON object; nothing was changed`,
    );
  }
  const found = findMember(root, 'hooks');
  if (found === undefined) return { root };
  if (found.member.value.type !== 'object') {
    throw new HooksSettingsError(`${path}: "hooks" is not an object; nothing was changed`);
  }
  return { root, hooks: { node: found.member.value, index: found.index } };
}

function scalarOf(object: JsonObjectNode, key: string): unknown {
  const value = findMember(object, key)?.member.value;
  return value?.type === 'scalar' ? value.value : undefined;
}

function ownHooks(settings: Settings): OwnHook[] {
  const found: OwnHook[] = [];
  settings.hooks?.node.members.forEach((member, eventIndex) => {
    if (member.value.type !== 'array') return;
    const eventArray = member.value;
    eventArray.items.forEach((group, groupIndex) => {
      if (group.type !== 'object') return;
      const hooks = findMember(group, 'hooks')?.member.value;
      if (hooks?.type !== 'array') return;
      hooks.items.forEach((hook, hookIndex) => {
        if (hook.type !== 'object') return;
        const command = scalarOf(hook, 'command');
        if (typeof command !== 'string' || !isOwnCommand(command)) return;
        found.push({
          event: member.key,
          eventIndex,
          eventArray,
          group,
          groupIndex,
          hooks,
          hookIndex,
          hook,
        });
      });
    });
  });
  return found;
}

/**
 * Removes our entries. A group, event array or `hooks` object left empty by the removal
 * goes too, so `remove` after `install` restores the original bytes.
 */
export function removeOwnHooks(text: string, path: string): string {
  for (;;) {
    const settings = parseSettings(text, path);
    const [own] = ownHooks(settings);
    if (own === undefined || settings.hooks === undefined) return text;
    if (own.hooks.items.length > 1) {
      text = removeArrayItem(text, own.hooks, own.hookIndex);
    } else if (own.eventArray.items.length > 1) {
      text = removeArrayItem(text, own.eventArray, own.groupIndex);
    } else if (settings.hooks.node.members.length > 1) {
      text = removeObjectMember(text, settings.hooks.node, own.eventIndex);
    } else {
      text = removeObjectMember(text, settings.root, settings.hooks.index);
    }
  }
}

function groupFor(spec: HookSpec, command: string): Record<string, unknown> {
  return {
    ...(spec.matcher !== undefined ? { matcher: spec.matcher } : {}),
    hooks: [{ type: 'command', command, timeout: spec.timeout }],
  };
}

/**
 * Replaces our entries with the given set: our old entries are removed, one matcher
 * group per spec is appended at the end of its event array. Foreign entries keep their
 * bytes. `text` is `undefined` for a missing file.
 */
export function installOwnHooks(
  text: string | undefined,
  path: string,
  specs: readonly HookSpec[],
  commandFor: (spec: HookSpec) => string,
): string {
  let current = removeOwnHooks(text ?? '{}\n', path);
  for (const spec of specs) {
    const settings = parseSettings(current, path);
    const group = groupFor(spec, commandFor(spec));
    if (settings.hooks === undefined) {
      current = appendObjectMember(current, settings.root, 'hooks', { [spec.event]: [group] });
      continue;
    }
    const event = findMember(settings.hooks.node, spec.event);
    if (event === undefined) {
      current = appendObjectMember(current, settings.hooks.node, spec.event, [group]);
    } else if (event.member.value.type === 'array') {
      current = appendArrayItem(current, event.member.value, group);
    } else {
      throw new HooksSettingsError(
        `${path}: "hooks.${spec.event}" is not an array; nothing was changed`,
      );
    }
  }
  return current;
}

export type HookState = 'installed' | 'outdated' | 'missing';

export interface HookStateEntry {
  readonly event: string;
  readonly matcher?: string;
  readonly state: HookState;
}

/** Per spec: `installed` (exactly our entry), `outdated` (ours but different), `missing`. */
export function ownHookStates(
  text: string | undefined,
  path: string,
  specs: readonly HookSpec[],
  commandFor: (spec: HookSpec) => string,
): readonly HookStateEntry[] {
  const own = text === undefined ? [] : ownHooks(parseSettings(text, path));
  return specs.map((spec) => {
    const mine = own.filter((hook) => hook.event === spec.event);
    const base = {
      event: spec.event,
      ...(spec.matcher !== undefined ? { matcher: spec.matcher } : {}),
    };
    if (mine.length === 0) return { ...base, state: 'missing' };
    const [hook] = mine;
    const exact =
      mine.length === 1 &&
      hook !== undefined &&
      hook.hooks.items.length === 1 &&
      scalarOf(hook.group, 'matcher') === spec.matcher &&
      scalarOf(hook.hook, 'command') === commandFor(spec) &&
      scalarOf(hook.hook, 'timeout') === spec.timeout;
    return { ...base, state: exact ? 'installed' : 'outdated' };
  });
}

export interface HooksInstallerOptions {
  readonly fs: FileSystem;
  readonly paths: PathPort;
  readonly clock: Clock;
  /** `$CLAUDE_CONFIG_DIR`, else `~/.claude`. */
  readonly settingsDir: string;
  /** The agent's data dir: `hook.cjs` goes next to `agent.json`. */
  readonly dataDir: string;
  /** The bundled `hook.cjs` shipped with the package. */
  readonly hookSource: string;
  /** Absolute path of the Node binary for the hook command. */
  readonly execPath: string;
  readonly holdSeconds: number;
}

export interface HooksChange {
  readonly settingsPath: string;
  readonly scriptPath: string;
  /** False when the file already had exactly this content. */
  readonly changed: boolean;
  /** Copy of the previous file, written before a change. */
  readonly backupPath?: string;
}

export interface HooksStatus {
  readonly settingsPath: string;
  readonly settingsExists: boolean;
  readonly scriptPath: string;
  readonly script: 'current' | 'outdated' | 'missing';
  readonly hooks: readonly HookStateEntry[];
}

/** `settings.json` install, remove and status (D11, 04 §5.6). */
export function createHooksInstaller(options: HooksInstallerOptions) {
  const { fs, paths } = options;
  const settingsPath = paths.join(options.settingsDir, SETTINGS_FILE);
  const scriptPath = paths.join(options.dataDir, HOOK_SCRIPT_FILE);
  const specs = hookSpecs(options.holdSeconds);
  const commandFor = (spec: HookSpec): string =>
    hookCommand(options.execPath, scriptPath, spec.timeout);

  /** Writes through a symlinked `settings.json` to its target, keeping its mode. */
  async function writeSettings(
    previous: string | undefined,
    next: string,
  ): Promise<string | undefined> {
    await fs.ensureDir(options.settingsDir, DIR_MODE);
    const target = (await paths.realpath(settingsPath)) ?? settingsPath;
    let backupPath: string | undefined;
    if (previous !== undefined) {
      const stamp = new Date(options.clock.now()).toISOString().replace(/[:.]/g, '-');
      backupPath = `${settingsPath}.backup-${stamp}`;
      await fs.writeTextAtomic(backupPath, previous, SETTINGS_FILE_MODE);
    }
    const mode = (await fs.permissions(target)) ?? SETTINGS_FILE_MODE;
    await fs.writeTextAtomic(target, next, mode);
    return backupPath;
  }

  async function readSource(): Promise<string> {
    const source = await fs.readText(options.hookSource);
    if (source === undefined) {
      throw new HooksSettingsError(
        `hook script not found at ${options.hookSource}; reinstall remotectl`,
      );
    }
    return source;
  }

  return {
    settingsPath,
    scriptPath,
    async install(): Promise<HooksChange> {
      const previous = await fs.readText(settingsPath);
      const next = installOwnHooks(previous, settingsPath, specs, commandFor);
      const source = await readSource();
      // The script first: settings never point at a missing file.
      if ((await fs.readText(scriptPath)) !== source) {
        await fs.ensureDir(options.dataDir, DIR_MODE);
        await fs.writeTextAtomic(scriptPath, source, SETTINGS_FILE_MODE);
      }
      if (next === previous) return { settingsPath, scriptPath, changed: false };
      const backupPath = await writeSettings(previous, next);
      return { settingsPath, scriptPath, changed: true, ...(backupPath ? { backupPath } : {}) };
    },
    async remove(): Promise<HooksChange> {
      const previous = await fs.readText(settingsPath);
      if (previous === undefined) return { settingsPath, scriptPath, changed: false };
      const next = removeOwnHooks(previous, settingsPath);
      if (next === previous) return { settingsPath, scriptPath, changed: false };
      const backupPath = await writeSettings(previous, next);
      return { settingsPath, scriptPath, changed: true, ...(backupPath ? { backupPath } : {}) };
    },
    async status(): Promise<HooksStatus> {
      const text = await fs.readText(settingsPath);
      const hooks = ownHookStates(text, settingsPath, specs, commandFor);
      const installed = await fs.readText(scriptPath);
      const source = await fs.readText(options.hookSource);
      const script =
        installed === undefined
          ? 'missing'
          : source === undefined || installed === source
            ? 'current'
            : 'outdated';
      return { settingsPath, settingsExists: text !== undefined, scriptPath, script, hooks };
    },
  };
}

export type HooksInstaller = ReturnType<typeof createHooksInstaller>;
