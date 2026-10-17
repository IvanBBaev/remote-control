import * as Haptics from 'expo-haptics';
import { Link } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import ReanimatedSwipeable, {
  SwipeDirection,
} from 'react-native-gesture-handler/ReanimatedSwipeable';

import type { AgentSession, PhoneDecision } from '../core/model';
import { formatAgo, formatCountdown } from '../core/time';
import { deadlineOf, stateOf } from '../core/urgency';
import { StateBadge } from './state-badge';
import { colors, mono, radius, TONES } from './theme';

interface Props {
  session: AgentSession;
  now: number;
  onDecide: (kind: PhoneDecision) => void;
}

function SwipeAction({ kind }: { kind: 'allow' | 'deny' }) {
  const allow = kind === 'allow';
  return (
    <View style={[styles.action, { backgroundColor: allow ? colors.green : colors.red }]}>
      <SymbolView
        name={allow ? 'checkmark' : 'xmark'}
        tintColor="#fff"
        size={20}
        weight="bold"
        fallback={<Text style={styles.actionText}>{allow ? '✓' : '✕'}</Text>}
      />
      <Text style={styles.actionText}>{allow ? 'Allow' : 'Deny'}</Text>
    </View>
  );
}

/** What the row says under the title: the most useful line for the session's state. */
function subtitle(session: AgentSession): { text: string; code: boolean } {
  if (session.approval) return { text: session.approval.detail, code: true };
  if (session.question) return { text: session.question.prompt, code: false };
  if (session.error) return { text: session.error, code: false };
  return { text: session.lastTurn ?? 'No activity yet', code: false };
}

/**
 * One agent in the list. A row that needs an OK swipes right to Allow and left to Deny
 * (Coucou); Always and the question answers stay on the session screen.
 */
export function SessionRow({ session, now, onDecide }: Props) {
  const state = stateOf(session);
  const tone = TONES[state];
  const deadline = deadlineOf(session);
  const line = subtitle(session);

  const onOpen = (direction: SwipeDirection.LEFT | SwipeDirection.RIGHT) => {
    const kind = direction === SwipeDirection.LEFT ? 'deny' : 'allow';
    void Haptics.notificationAsync(
      kind === 'allow'
        ? Haptics.NotificationFeedbackType.Success
        : Haptics.NotificationFeedbackType.Warning,
    );
    onDecide(kind);
  };

  const row = (
    <Link href={{ pathname: '/session/[id]', params: { id: session.id } }} asChild>
      <Pressable>
        {({ pressed }) => (
          <View style={[styles.row, pressed && styles.pressed]}>
            <StateBadge state={state} />
            <View style={styles.body}>
              <View style={styles.titleLine}>
                <Text style={styles.project} numberOfLines={1}>
                  {session.project}
                </Text>
                <Text style={[styles.meta, deadline !== undefined && { color: tone.color }]}>
                  {deadline !== undefined
                    ? formatCountdown(deadline, now)
                    : formatAgo(session.updatedAt, now)}
                </Text>
              </View>
              <Text style={styles.machine} numberOfLines={1}>
                {session.approval ? session.approval.toolLabel : session.title} · {session.machine}
              </Text>
              <Text
                style={[styles.detail, line.code && styles.code, state === 'error' && styles.error]}
                numberOfLines={2}
              >
                {line.text}
              </Text>
            </View>
          </View>
        )}
      </Pressable>
    </Link>
  );

  if (!session.approval) return <View style={styles.container}>{row}</View>;
  return (
    <View style={styles.container}>
      <ReanimatedSwipeable
        friction={1.6}
        leftThreshold={90}
        rightThreshold={90}
        overshootLeft={false}
        overshootRight={false}
        renderLeftActions={() => <SwipeAction kind="allow" />}
        renderRightActions={() => <SwipeAction kind="deny" />}
        onSwipeableOpen={onOpen}
      >
        {row}
      </ReanimatedSwipeable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { borderRadius: radius.row, overflow: 'hidden', backgroundColor: colors.surface },
  row: {
    flexDirection: 'row',
    gap: 14,
    padding: 14,
    backgroundColor: colors.surface,
  },
  pressed: { backgroundColor: colors.surfaceRaised },
  body: { flex: 1, gap: 3 },
  titleLine: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  project: { flex: 1, color: colors.text, fontSize: 17, fontWeight: '700' },
  meta: { color: colors.textTertiary, fontSize: 13, fontVariant: ['tabular-nums'] },
  machine: { color: colors.textSecondary, fontSize: 14 },
  detail: { color: colors.textSecondary, fontSize: 14, lineHeight: 19, marginTop: 2 },
  code: { fontFamily: mono, fontSize: 13, color: colors.text },
  error: { color: colors.red },
  action: {
    width: 110,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  actionText: { color: '#fff', fontSize: 14, fontWeight: '700' },
});
