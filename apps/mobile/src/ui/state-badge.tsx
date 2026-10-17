import { StyleSheet, Text, View } from 'react-native';

import type { AgentState } from '../core/model';
import { radius, TONES, tint } from './theme';

export function StateBadge({ state, size = 44 }: { state: AgentState; size?: number }) {
  const tone = TONES[state];
  return (
    <View
      accessibilityLabel={tone.label}
      style={[
        styles.badge,
        {
          width: size,
          height: size,
          backgroundColor: tint(tone.color, 0.16),
          borderColor: tint(tone.color, 0.45),
        },
      ]}
    >
      <Text
        style={[styles.glyph, { color: tone.color, fontSize: tone.glyph.length > 1 ? 13 : 20 }]}
      >
        {tone.glyph}
      </Text>
    </View>
  );
}

export function StatePill({ state }: { state: AgentState }) {
  const tone = TONES[state];
  return (
    <View style={[styles.pill, { backgroundColor: tint(tone.color, 0.16) }]}>
      <View style={[styles.dot, { backgroundColor: tone.color }]} />
      <Text style={[styles.pillText, { color: tone.color }]}>{tone.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth * 2,
  },
  glyph: { fontWeight: '800', letterSpacing: -0.3 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.pill,
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
  pillText: { fontSize: 13, fontWeight: '600' },
});
