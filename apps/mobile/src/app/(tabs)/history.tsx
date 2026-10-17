import { SymbolView } from 'expo-symbols';
import { StyleSheet, Text, View } from 'react-native';

import { formatAgo } from '../../core/time';
import { useInbox } from '../../state/store';
import { Empty, Screen, Section } from '../../ui/screen';
import { colors, mono, OUTCOMES } from '../../ui/theme';
import { useNow } from '../../ui/use-now';

export default function HistoryScreen() {
  const now = useNow();
  const history = useInbox((state) => state.history);

  return (
    <Screen title="History" subtitle="What you decided, newest first">
      {history.length === 0 ? (
        <Empty text="No decisions yet." />
      ) : (
        <Section title="Decisions">
          {history.map((entry, index) => {
            const outcome = OUTCOMES[entry.outcome];
            return (
              <View key={entry.id} style={[styles.row, index > 0 && styles.divider]}>
                <SymbolView
                  name={outcome.symbol}
                  tintColor={outcome.color}
                  size={26}
                  fallback={<Text style={{ color: outcome.color }}>●</Text>}
                />
                <View style={styles.body}>
                  <View style={styles.titleLine}>
                    <Text style={styles.title} numberOfLines={1}>
                      {outcome.label} · {entry.label}
                    </Text>
                    <Text style={styles.ago}>{formatAgo(entry.at, now)}</Text>
                  </View>
                  <Text style={styles.detail} numberOfLines={2}>
                    {entry.detail}
                  </Text>
                  <Text style={styles.meta}>
                    {entry.project} · {entry.machine}
                  </Text>
                </View>
              </View>
            );
          })}
        </Section>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 12, padding: 14, alignItems: 'flex-start' },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  body: { flex: 1, gap: 3 },
  titleLine: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  title: { flex: 1, color: colors.text, fontSize: 16, fontWeight: '600' },
  ago: { color: colors.textTertiary, fontSize: 13, fontVariant: ['tabular-nums'] },
  detail: { color: colors.text, fontFamily: mono, fontSize: 13 },
  meta: { color: colors.textSecondary, fontSize: 13 },
});
