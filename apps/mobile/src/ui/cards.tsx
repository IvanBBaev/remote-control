import * as Haptics from 'expo-haptics';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { PendingApproval, PendingQuestion, PhoneDecision } from '../core/model';
import { formatCountdown } from '../core/time';
import { colors, mono, radius, tint } from './theme';

function Card({ color, children }: { color: string; children: ReactNode }) {
  return (
    <View
      style={[styles.card, { borderColor: tint(color, 0.5), backgroundColor: tint(color, 0.07) }]}
    >
      {children}
    </View>
  );
}

function CardHeader({
  color,
  title,
  deadline,
  now,
}: {
  color: string;
  title: string;
  deadline: number;
  now: number;
}) {
  return (
    <View style={styles.header}>
      <Text style={[styles.title, { color }]}>{title}</Text>
      <Text style={[styles.countdown, { color }]}>{formatCountdown(deadline, now)}</Text>
    </View>
  );
}

function Button({
  label,
  color,
  filled = false,
  onPress,
}: {
  label: string;
  color: string;
  filled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        filled
          ? { backgroundColor: color }
          : { backgroundColor: tint(color, 0.14), borderColor: tint(color, 0.4), borderWidth: 1 },
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.buttonText, { color: filled ? '#0B0D10' : color }]}>{label}</Text>
    </Pressable>
  );
}

function haptic(kind: PhoneDecision) {
  void Haptics.notificationAsync(
    kind === 'deny'
      ? Haptics.NotificationFeedbackType.Warning
      : Haptics.NotificationFeedbackType.Success,
  );
}

export function ApprovalCard({
  approval,
  now,
  onDecide,
}: {
  approval: PendingApproval;
  now: number;
  onDecide: (kind: PhoneDecision) => void;
}) {
  const decide = (kind: PhoneDecision) => {
    haptic(kind);
    onDecide(kind);
  };
  return (
    <Card color={colors.orange}>
      <CardHeader
        color={colors.orange}
        title={approval.toolLabel}
        deadline={approval.expiresAt}
        now={now}
      />
      <View style={styles.codeBox}>
        <Text style={styles.code} selectable>
          {approval.detail}
        </Text>
      </View>
      <Text style={styles.caption}>in {approval.cwd}</Text>
      <View style={styles.buttons}>
        <Button label="Deny" color={colors.red} onPress={() => decide('deny')} />
        <Button label="Allow" color={colors.green} filled onPress={() => decide('allow')} />
      </View>
      {approval.canAlways && (
        <Pressable onPress={() => decide('always')} style={styles.link}>
          <Text style={styles.linkText}>Always allow this in the session</Text>
        </Pressable>
      )}
    </Card>
  );
}

export function QuestionCard({
  question,
  now,
  onAnswer,
}: {
  question: PendingQuestion;
  now: number;
  onAnswer: (answer: string) => void;
}) {
  return (
    <Card color={colors.cyan}>
      <CardHeader
        color={colors.cyan}
        title={question.header}
        deadline={question.expiresAt}
        now={now}
      />
      <Text style={styles.prompt}>{question.prompt}</Text>
      <View style={styles.options}>
        {question.options.map((option) => (
          <Pressable
            key={option.label}
            accessibilityRole="button"
            onPress={() => {
              haptic('answer');
              onAnswer(option.label);
            }}
            style={({ pressed }) => [styles.option, pressed && styles.pressed]}
          >
            <Text style={styles.optionLabel}>{option.label}</Text>
            {option.description && <Text style={styles.caption}>{option.description}</Text>}
          </Pressable>
        ))}
      </View>
    </Card>
  );
}

export function ErrorCard({ message }: { message: string }) {
  return (
    <Card color={colors.red}>
      <Text style={[styles.title, { color: colors.red }]}>Stopped on an error</Text>
      <Text style={styles.prompt}>{message}</Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.card, borderWidth: 1, padding: 16, gap: 12 },
  header: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  title: { fontSize: 17, fontWeight: '700' },
  countdown: { fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'] },
  codeBox: { backgroundColor: colors.background, borderRadius: 10, padding: 12 },
  code: { fontFamily: mono, fontSize: 14, lineHeight: 20, color: colors.text },
  caption: { color: colors.textSecondary, fontSize: 13 },
  prompt: { color: colors.text, fontSize: 16, lineHeight: 22 },
  buttons: { flexDirection: 'row', gap: 10 },
  button: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 14,
    borderRadius: radius.button,
  },
  buttonText: { fontSize: 17, fontWeight: '700' },
  pressed: { opacity: 0.7, transform: [{ scale: 0.98 }] },
  link: { alignItems: 'center', paddingVertical: 4 },
  linkText: { color: colors.orange, fontSize: 15, fontWeight: '600' },
  options: { gap: 8 },
  option: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.button,
    padding: 14,
    gap: 2,
  },
  optionLabel: { color: colors.text, fontSize: 16, fontWeight: '600' },
});
