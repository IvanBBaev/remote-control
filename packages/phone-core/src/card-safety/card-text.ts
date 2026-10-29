import { toolInfo } from '@remote-control/protocol';
import type { PushSummary, ToolKind } from '@remote-control/protocol';

import { hiddenCount, revealHidden } from './hidden-characters.js';
import type { RevealedText } from './hidden-characters.js';
import { mixedScriptNames, punycodeNames } from './mixed-script.js';

/**
 * Tool kinds whose card content is written by the model, not parsed from an action: a
 * subagent's task and a plan. The card shows it in a demoted "Agent says" box (02 §4.5).
 */
const MODEL_AUTHORED: ReadonlySet<ToolKind> = new Set<ToolKind>(['agent', 'plan']);

/** Whether a tool kind's card content is model-authored text. */
export function isModelAuthored(kind: ToolKind): boolean {
  return MODEL_AUTHORED.has(kind);
}

const plural = (count: number, word: string) => `${String(count)} ${word}${count === 1 ? '' : 's'}`;

/**
 * The warnings for the texts one card shows (V3-S03): direction-changing and invisible
 * characters (each shown as its `⟨U+XXXX⟩` marker), names that mix look-alike scripts,
 * and punycode host names. Empty when the texts are plain.
 */
export function cardWarnings(texts: readonly string[]): string[] {
  const revealed = texts.map(revealHidden);
  const bidi = revealed.flatMap((text) => text.parts.filter((part) => part.kind === 'bidi'));
  const invisible = revealed.flatMap((text) =>
    text.parts.filter((part) => part.kind === 'invisible' || part.kind === 'control'),
  );
  const warnings: string[] = [];
  if (bidi.length > 0) {
    warnings.push(
      `${plural(bidi.length, 'direction-changing character')}, shown as ${bidi[0]!.text}. The text may run differently from how it reads.`,
    );
  }
  if (invisible.length > 0) {
    warnings.push(
      `${plural(invisible.length, 'invisible character')}, shown as ${invisible[0]!.text}.`,
    );
  }
  const all = texts.join('\n');
  for (const name of mixedScriptNames(all)) {
    warnings.push(
      `"${name.name}" mixes ${name.scripts.join(' and ')} letters (${name.letters.join(', ')}): it may imitate another name.`,
    );
  }
  for (const name of punycodeNames(all)) {
    warnings.push(`"${name}" is an encoded international name: check what it spells.`);
  }
  return warnings;
}

/** What an approval card shows, made safe to read (V3-S03). */
export interface ApprovalCardText {
  /** The headline: the tool's plain label, derived from the tool, never from free text. */
  readonly title: string;
  /** The content with every hidden character as a visible marker; never cut. */
  readonly content: RevealedText;
  /** `true` when the content is the model's own words: show it as "Agent says". */
  readonly agentSays: boolean;
  /** The folder the action runs in, with markers; `undefined` when none was given. */
  readonly folder: RevealedText | undefined;
  /** Hidden characters in the content or the title. */
  readonly hidden: number;
  readonly warnings: readonly string[];
}

/**
 * The safe text of an approval card from the parsed action: the tool's kind and label,
 * the content the agent parsed from the tool input and the folder it runs in. `extra`
 * holds more texts the card shows (the "Always" rules) to scan for warnings.
 */
export function approvalCardText(action: {
  readonly toolLabel: string;
  readonly toolKind: ToolKind;
  readonly content: string;
  readonly folder?: string;
  readonly extra?: readonly string[];
}): ApprovalCardText {
  const title = revealHidden(action.toolLabel);
  const content = revealHidden(action.content);
  const folder = action.folder === undefined ? [] : [action.folder];
  return {
    title: title.text,
    content,
    agentSays: isModelAuthored(action.toolKind),
    folder: action.folder === undefined ? undefined : revealHidden(action.folder),
    hidden: hiddenCount(title) + hiddenCount(content),
    warnings: cardWarnings([action.toolLabel, action.content, ...folder, ...(action.extra ?? [])]),
  };
}

/** One answer of a question card: `answer` is sent back as given, `label` is shown. */
export interface QuestionOptionText {
  readonly answer: string;
  readonly label: RevealedText;
  readonly description: RevealedText | undefined;
}

/** What a question card shows, made safe to read (V3-S03d). */
export interface QuestionCardText {
  /** The model's short header, shown demoted under "Agent asks", never as the title. */
  readonly header: RevealedText;
  readonly prompt: RevealedText;
  readonly options: readonly QuestionOptionText[];
  readonly warnings: readonly string[];
}

/** The safe text of a question card: every text is the model's, so all of it is revealed. */
export function questionCardText(question: {
  readonly header: string;
  readonly prompt: string;
  readonly options: readonly { readonly label: string; readonly description?: string }[];
}): QuestionCardText {
  return {
    header: revealHidden(question.header),
    prompt: revealHidden(question.prompt),
    options: question.options.map((option) => ({
      answer: option.label,
      label: revealHidden(option.label),
      description: option.description === undefined ? undefined : revealHidden(option.description),
    })),
    warnings: cardWarnings([
      question.header,
      question.prompt,
      ...question.options.flatMap((option) => [option.label, option.description ?? '']),
    ]),
  };
}

/** An error card's message (it can quote the agent or a tool) with markers (V3-S03d). */
export function errorCardText(message: string): RevealedText {
  return revealHidden(message);
}

/**
 * {@link approvalCardText} for a protocol request: kind and label come from the tool name;
 * the "Always" rules and the project folder are scanned too.
 */
export function requestCardText(request: {
  readonly toolName: string;
  readonly content: string;
  readonly suggestions?: readonly string[];
  readonly project?: string;
}): ApprovalCardText {
  const { label, kind } = toolInfo(request.toolName);
  return approvalCardText({
    toolLabel: label,
    toolKind: kind,
    content: request.content,
    ...(request.project === undefined ? {} : { folder: request.project }),
    extra: request.suggestions ?? [],
  });
}

/**
 * The push summary fields a lock-screen headline may use (a notification title, a Live
 * Activity title, ADR 0017): the project folder and the tool's label, both derived by
 * the agent from the session and the tool name. The summary line `s` can be the model's
 * words (a subagent's task), so it stays in the body.
 */
export const LOCK_SCREEN_TITLE_FIELDS = [
  'p',
  'l',
] as const satisfies readonly (keyof PushSummary)[];

/** The lock-screen headline for a push summary: `"<project>: <label>"`, hidden characters shown. */
export function lockScreenTitle(summary: Pick<PushSummary, 'p' | 'l'>): string {
  const label = revealHidden(summary.l).text;
  return summary.p === undefined ? label : `${revealHidden(summary.p).text}: ${label}`;
}

/** A lock-screen body line with its hidden characters shown as markers. */
export function lockScreenLine(line: string): string {
  return revealHidden(line).text;
}
