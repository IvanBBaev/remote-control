import Constants from 'expo-constants';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useInbox } from '../../state/store';
import { Screen, Section } from '../../ui/screen';
import { colors } from '../../ui/theme';

function Row({
  label,
  value,
  first = false,
  onPress,
  tone,
}: {
  label: string;
  value?: string;
  first?: boolean;
  onPress?: () => void;
  tone?: string;
}) {
  return (
    <Pressable
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [styles.row, !first && styles.divider, pressed && styles.pressed]}
    >
      <Text style={[styles.label, tone !== undefined && { color: tone }]}>{label}</Text>
      {value !== undefined && <Text style={styles.value}>{value}</Text>}
    </Pressable>
  );
}

export default function SettingsScreen() {
  const sessions = useInbox((state) => state.sessions);
  const reset = useInbox((state) => state.reset);
  const machines = [...new Set(sessions.map((session) => session.machine))].sort();

  return (
    <Screen title="Settings">
      <Section title="Machines">
        {machines.map((machine, index) => (
          <Row
            key={machine}
            first={index === 0}
            label={machine}
            value={`${sessions.filter((s) => s.machine === machine).length} agents`}
          />
        ))}
        <Row label="Pair a machine" value="M4-03" />
      </Section>
      <Section title="Notifications">
        <Row first label="Push notifications" value="M4-06" />
        <Row label="Live Activity & Dynamic Island" value="M4-06" />
      </Section>
      <Section title="Security">
        <Row first label="Face ID before Allow" value="M4-04" />
      </Section>
      <Section title="Sample data">
        <Row first label="Reset sample agents" tone={colors.brand} onPress={reset} />
      </Section>
      <View style={styles.about}>
        <Text style={styles.aboutText}>
          remote-control {Constants.expoConfig?.version ?? '0.0.0'}
        </Text>
        <Text style={styles.aboutText}>Approve your coding agents from your phone.</Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  pressed: { backgroundColor: colors.surfaceRaised },
  label: { color: colors.text, fontSize: 16 },
  value: { color: colors.textTertiary, fontSize: 15 },
  about: { alignItems: 'center', gap: 4, paddingTop: 24 },
  aboutText: { color: colors.textTertiary, fontSize: 13 },
});
