import { useEffect, useState } from 'react';

import { systemNow } from '../adapters/system-clock';
import { useInbox } from '../state/store';

/** The current time, refreshed every second; also expires what ran out (D10). */
export function useNow(): number {
  const [now, setNow] = useState(systemNow);
  const expire = useInbox((state) => state.expire);
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(systemNow());
      expire();
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [expire]);
  return now;
}
