import { Stack, useLocalSearchParams } from 'expo-router';
import { KeyboardAvoidingView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { formatAgo } from '../../core/time';
import { stateOf } from '../../core/urgency';
import { useInbox } from '../../state/store';
import { ApprovalCard, ErrorCard, QuestionCard } from '../../ui/cards';
import { Composer } from '../../ui/composer';
import { Empty } from '../../ui/screen';
import { StatePill } from '../../ui/state-badge';
import { colors, radius } from '../../ui/theme';
import { useNow } from '../../ui/use-now';

export default function SessionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const now = useNow();
  const session = useInbox((state) => state.sessions.find((s) => s.id === id));
  const decide = useInbox((state) => state.decide);

  if (!session) return <Empty text="This agent is gone." />;
  const pending = session.approval !== undefined || session.question !== undefined;

  return (
    <KeyboardAvoidingView behavior="padding" style={styles.flex} keyboardVerticalOffset={90}>
      <Stack.Screen options={{ title: session.project }} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.head}>
          <StatePill state={stateOf(session)} />
          <Text style={styles.title}>{session.title}</Text>
          <Text style={styles.meta}>
            {session.machine}
            {session.branch !== undefined && ` · ${session.branch}`} · updated{' '}
            {formatAgo(session.updatedAt, now)}
          </Text>
        </View>
        {session.approval && (
          <ApprovalCard
            approval={session.approval}
            now={now}
            onDecide={(kind) => {
              decide({ sessionId: session.id, kind });
            }}
          />
        )}
        {session.question && (
          <QuestionCard
            question={session.question}
            now={now}
            onAnswer={(answer) => {
              decide({ sessionId: session.id, kind: 'answer', payload: answer });
            }}
          />
        )}
        {session.error !== undefined && <ErrorCard message={session.error} />}
        {session.lastTurn !== undefined && (
          <View style={styles.turn}>
            <Text style={styles.turnLabel}>Last turn</Text>
            <Text style={styles.turnText}>{session.lastTurn}</Text>
          </View>
        )}
      </ScrollView>
      <SafeAreaView edges={['bottom']} style={styles.composer}>
        <Composer
          disabled={pending}
          onSend={(text) => {
            decide({ sessionId: session.id, kind: 'instruct', payload: text });
          }}
        />
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.background },
  content: { padding: 16, gap: 14 },
  head: { gap: 8 },
  title: { color: colors.text, fontSize: 24, fontWeight: '700' },
  meta: { color: colors.textSecondary, fontSize: 14 },
  turn: { backgroundColor: colors.surface, borderRadius: radius.card, padding: 16, gap: 6 },
  turnLabel: { color: colors.textTertiary, fontSize: 13, fontWeight: '600' },
  turnText: { color: colors.text, fontSize: 15, lineHeight: 21 },
  composer: { backgroundColor: colors.background, paddingBottom: 8 },
});
