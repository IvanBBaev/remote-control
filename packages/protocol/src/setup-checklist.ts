/**
 * The "Can't connect?" checklist (M1-07, 01 W8, 04 §4.1): one wording for the phone's
 * `/machines` screen and `remotectl status`, so what the phone tells the user to check
 * is what the computer prints.
 */

export type SetupCheckId = 'agent' | 'relay' | 'hooks' | 'trust';

export interface SetupCheck {
  readonly id: SetupCheckId;
  /** The question both surfaces ask ("Is the agent running?"). */
  readonly question: string;
  /** What to do when the answer is no. */
  readonly fix: string;
}

/** The checks in the order a request travels: agent, relay, hooks, trusted folder. */
export const SETUP_CHECKLIST: readonly SetupCheck[] = Object.freeze([
  {
    id: 'agent',
    question: 'Is the agent running?',
    fix: 'Run `remotectl install` on the computer (or `remotectl run` in a terminal).',
  },
  {
    id: 'relay',
    question: 'Can the agent reach the relay?',
    fix: 'Check the computer’s internet connection and the relay URL in `remotectl status`.',
  },
  {
    id: 'hooks',
    question: 'Are the Claude Code hooks installed?',
    fix: 'Run `remotectl hooks install` on the computer.',
  },
  {
    id: 'trust',
    question: 'Is each repository trusted in Claude Code?',
    fix: 'Open the repository once with `claude` and accept the trust prompt.',
  },
]);

/** A repository no hook has come from yet (04 §2.6: hooks are inert until trusted). */
export const NO_HOOK_SEEN = 'no hook seen yet — trust the folder in Claude Code';
/** A repository a hook came from: Claude Code trusts it and runs the hooks. */
export const HOOK_SEEN = 'hooks seen';

/** The text of one check: `[ok]`, `[no]` or `[?]`, the question, and the fix when not ok. */
export function setupCheckLine(check: SetupCheck, ok: boolean | undefined): string {
  const mark = ok === undefined ? '[?] ' : ok ? '[ok]' : '[no]';
  return ok === true ? `${mark} ${check.question}` : `${mark} ${check.question} ${check.fix}`;
}
