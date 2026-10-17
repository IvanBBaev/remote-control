import { create } from 'zustand';

import { systemNow } from '../adapters/system-clock';
import { fixtureInbox } from '../core/fixtures';
import { decide, type DecisionInput, expire, type Inbox } from '../core/inbox';

interface InboxStore extends Inbox {
  /** Sample data until the app pairs with a machine (M4-03). */
  readonly sample: boolean;
  decide: (input: DecisionInput) => void;
  expire: () => void;
  reset: () => void;
}

export const useInbox = create<InboxStore>()((set, get) => ({
  ...fixtureInbox(systemNow()),
  sample: true,
  decide: (input) => {
    set(decide(get(), input, systemNow()));
  },
  expire: () => {
    const current = get();
    const next = expire(current, systemNow());
    if (next !== current) set(next);
  },
  reset: () => {
    set(fixtureInbox(systemNow()));
  },
}));
