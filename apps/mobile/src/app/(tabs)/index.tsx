import { useMemo } from 'react';

import { sortByUrgency, waitingCount } from '../../core/urgency';
import { useInbox } from '../../state/store';
import { Empty, Screen } from '../../ui/screen';
import { SessionRow } from '../../ui/session-row';
import { useNow } from '../../ui/use-now';

export default function AgentsScreen() {
  const now = useNow();
  const sessions = useInbox((state) => state.sessions);
  const decide = useInbox((state) => state.decide);
  const sorted = useMemo(() => sortByUrgency(sessions), [sessions]);
  const waiting = waitingCount(sessions);

  return (
    <Screen
      title="Agents"
      subtitle={
        waiting === 0 ? 'Nothing needs you' : `${waiting} need${waiting === 1 ? 's' : ''} you`
      }
    >
      {sorted.length === 0 && <Empty text="No agents yet." />}
      {sorted.map((session) => (
        <SessionRow
          key={session.id}
          session={session}
          now={now}
          onDecide={(kind) => {
            decide({ sessionId: session.id, kind });
          }}
        />
      ))}
    </Screen>
  );
}
