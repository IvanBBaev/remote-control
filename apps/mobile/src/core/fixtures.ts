import type { Inbox } from './inbox';
import type { AgentSession, HistoryEntry } from './model';

const MINUTE = 60_000;

/**
 * Sample sessions for the screens until the app talks to a real agent (M4-03). Times are
 * relative to `now` so countdowns run.
 */
export function fixtureInbox(now: number): Inbox {
  const sessions: AgentSession[] = [
    {
      id: 's-api',
      machine: 'MacBook Pro',
      project: 'billing-api',
      branch: 'fix/invoice-rounding',
      title: 'Fix rounding in invoice totals',
      status: 'working',
      updatedAt: now - 1 * MINUTE,
      approval: {
        requestId: 'r-api-1',
        toolLabel: 'Run a command',
        toolKind: 'command',
        detail: 'pnpm vitest run src/invoice --coverage',
        cwd: '~/code/billing-api',
        expiresAt: now + 4 * MINUTE + 12_000,
        canAlways: true,
      },
      lastTurn:
        'The totals were rounded per line instead of once per invoice. I changed `sumLines` to keep cents as integers and added a regression test. Running the suite next.',
    },
    {
      id: 's-web',
      machine: 'Mac mini',
      project: 'marketing-site',
      branch: 'main',
      title: 'Migrate the blog to the new layout',
      status: 'working',
      updatedAt: now - 3 * MINUTE,
      question: {
        requestId: 'r-web-1',
        header: 'Image format',
        prompt: 'The old posts embed PNG screenshots. Which format should the new layout use?',
        options: [
          { label: 'AVIF', description: 'Smallest files, newer browsers only' },
          { label: 'WebP', description: 'Small files, every current browser' },
          { label: 'Keep PNG', description: 'No conversion' },
        ],
        expiresAt: now + 9 * MINUTE,
      },
      lastTurn: 'I moved 14 of 22 posts. The remaining ones use inline images.',
    },
    {
      id: 's-infra',
      machine: 'MacBook Pro',
      project: 'infra',
      title: 'Bump the Postgres image',
      status: 'error',
      updatedAt: now - 12 * MINUTE,
      error: 'docker compose up failed: port 5432 is already in use.',
      lastTurn: 'The new image starts, but the health check never passes.',
    },
    {
      id: 's-mobile',
      machine: 'Mac mini',
      project: 'remote-control',
      branch: 'native-app',
      title: 'Scaffold the native app',
      status: 'working',
      updatedAt: now - 30_000,
      lastTurn: 'Writing the agents list and the session screen.',
    },
    {
      id: 's-docs',
      machine: 'MacBook Pro',
      project: 'handbook',
      title: 'Proofread the onboarding chapter',
      status: 'done',
      updatedAt: now - 47 * MINUTE,
      lastTurn: 'Done. I fixed 31 typos and two broken links; nothing else changed.',
    },
    {
      id: 's-old',
      machine: 'Mac mini',
      project: 'scratch',
      title: 'Try the new router',
      status: 'idle',
      updatedAt: now - 26 * 60 * MINUTE,
    },
  ];
  // Newest first, as the store keeps it.
  const history: HistoryEntry[] = [
    {
      id: 'h-2',
      sessionId: 's-infra',
      machine: 'MacBook Pro',
      project: 'infra',
      outcome: 'deny',
      label: 'Run a command',
      detail: 'docker system prune -af',
      at: now - 15 * MINUTE,
    },
    {
      id: 'h-3',
      sessionId: 's-web',
      machine: 'Mac mini',
      project: 'marketing-site',
      outcome: 'answer',
      label: 'Layout',
      detail: 'Two columns',
      at: now - 20 * MINUTE,
    },
    {
      id: 'h-1',
      sessionId: 's-docs',
      machine: 'MacBook Pro',
      project: 'handbook',
      outcome: 'allow',
      label: 'Edit a file',
      detail: 'docs/onboarding.md',
      at: now - 52 * MINUTE,
    },
  ];
  return { sessions, history };
}
