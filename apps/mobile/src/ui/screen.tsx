import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useInbox } from '../state/store';
import { colors, radius, tint } from './theme';

/** A tab screen: large title, optional subtitle, scrolling content. */
export function Screen({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <SafeAreaView edges={['top']} style={styles.safe}>
      <ScrollView contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="never">
        <View style={styles.header}>
          <Text style={styles.title}>{title}</Text>
          {subtitle !== undefined && <Text style={styles.subtitle}>{subtitle}</Text>}
        </View>
        <SampleBanner />
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

/** Says plainly that the list is not live until a machine is paired (M4-03). */
function SampleBanner() {
  const sample = useInbox((state) => state.sample);
  if (!sample) return null;
  return (
    <View style={styles.banner}>
      <Text style={styles.bannerText}>Sample data — pair a machine to see your agents.</Text>
    </View>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.group}>{children}</View>
    </View>
  );
}

export function Empty({ text }: { text: string }) {
  return <Text style={styles.empty}>{text}</Text>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: 16, paddingBottom: 120, gap: 10 },
  header: { paddingTop: 12, paddingBottom: 8, gap: 2 },
  title: { color: colors.text, fontSize: 34, fontWeight: '800', letterSpacing: 0.3 },
  subtitle: { color: colors.textSecondary, fontSize: 16 },
  banner: {
    borderRadius: radius.button,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: tint(colors.brand, 0.14),
    borderWidth: 1,
    borderColor: tint(colors.brand, 0.35),
  },
  bannerText: { color: colors.text, fontSize: 13 },
  section: { gap: 8, marginTop: 10 },
  sectionTitle: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    paddingHorizontal: 4,
  },
  group: { borderRadius: radius.row, overflow: 'hidden', backgroundColor: colors.surface },
  empty: { color: colors.textTertiary, fontSize: 15, textAlign: 'center', paddingVertical: 40 },
});
