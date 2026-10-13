import { expect, type Page } from '@playwright/test';

import { title } from './fixtures.js';

import type { ControlAgent, HookResult } from './control.js';

/** Taps closer than this to the card appearing are ignored (TAP_GUARD_MS, 05 Rec-2). */
const TAP_GUARD_MS = 700;

/**
 * Fires a hook on `agent` and opens the app the way a user does: a request pending at
 * launch opens itself (05 Rec-2). Resolves with the request screen ready for a tap and
 * the hook's answer, which settles once the phone decides — wrapped, so awaiting this
 * call does not also await the decision.
 */
export async function openRequest(
  page: Page,
  agent: ControlAgent,
  hook: 'permission' | 'question',
  body: Readonly<Record<string, unknown>>,
): Promise<{ answer: Promise<HookResult> }> {
  await page.goto('/sessions');
  await expect(title(page)).toHaveText('Sessions');
  const answer = agent.fire(hook, body);
  // The hook result is awaited by the spec; keep an early failure from going unhandled.
  answer.catch(() => undefined);
  await expect(page).toHaveURL(/\/requests\//);
  await page.waitForTimeout(TAP_GUARD_MS);
  return { answer };
}
