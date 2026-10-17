import { NativeTabs } from 'expo-router/native-tabs';

import { waitingCount } from '../../core/urgency';
import { useInbox } from '../../state/store';
import { colors } from '../../ui/theme';

export default function TabsLayout() {
  const waiting = useInbox((state) => waitingCount(state.sessions));
  return (
    <NativeTabs tintColor={colors.brand} badgeBackgroundColor={colors.orange}>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>Agents</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="sparkles.rectangle.stack" md="smart_toy" />
        <NativeTabs.Trigger.Badge hidden={waiting === 0}>
          {String(waiting)}
        </NativeTabs.Trigger.Badge>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="history">
        <NativeTabs.Trigger.Label>History</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="clock.arrow.circlepath" md="history" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="gearshape" md="settings" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
