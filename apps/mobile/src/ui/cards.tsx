import {
  approvalCardText,
  errorCardText,
  questionCardText,
} from '@remote-control/phone-core/card-safety/card-text';
import type { RevealedText } from '@remote-control/phone-core/card-safety/hidden-characters';
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

/**
 * Text from the computer as the card shows it (V3-S03): every hidden or
 * direction-changing character is a highlighted `⟨U+XXXX⟩` marker in its place. It takes
 * only a `RevealedText` from the shared card text (V3-S03d), never a raw string, so no
 * card can show computer text that skipped the tested reveal.
 */
function Revealed({ text }: { text: RevealedText }) {
  return (
    <>
      {text.parts.map((part, index) =>
        part.kind === 'text' ? (
          part.text
        ) : (
          <Text key={index} style={styles.hiddenChar}>
            {part.text}
          </Text>
        ),
      )}
    </>
  );
}

/** The card's warnings (V3-S03): hidden characters and look-alike names. */
function Warnings({ warnings }: { warnings: readonly string[] }) {
  if (warnings.length === 0) return null;
  return (
    <View style={styles.warnings} accessibilityRole="alert">
      {warnings.map((warning) => (
        <Text key={warning} style={styles.warningText}>
          {warning}
        </Text>
      ))}
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
  // V3-S03: the title is the tool's label, the detail is shown whole with hidden characters
  // as markers, a subagent's task or a plan sits in a demoted "Agent says" box.
  const card = approvalCardText({
    toolLabel: approval.toolLabel,
    toolKind: approval.toolKind,
    content: approval.detail,
    folder: approval.cwd,
  });
  return (
    <Card color={colors.orange}>
      <CardHeader
        color={colors.orange}
        title={card.title}
        deadline={approval.expiresAt}
        now={now}
      />
      {card.agentSays && (
        <Text style={styles.caption}>Agent says (the model's own words, not what runs):</Text>
      )}
      <View style={[styles.codeBox, card.agentSays && styles.agentSays]}>
        <Text style={[styles.code, card.agentSays && styles.agentSaysText]} selectable>
          <Revealed text={card.content} />
        </Text>
      </View>
      {card.folder && (
        <Text style={styles.caption}>
          in <Revealed text={card.folder} />
        </Text>
      )}
      <Warnings warnings={card.warnings} />
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
  // V3-S03: the header and prompt are the model's words, so the title stays fixed and the
  // header is shown demoted under "Agent asks".
  const card = questionCardText(question);
  return (
    <Card color={colors.cyan}>
      <CardHeader color={colors.cyan} title="Question" deadline={question.expiresAt} now={now} />
      <Text style={styles.caption}>
        Agent asks · <Revealed text={card.header} />
      </Text>
      <Text style={styles.prompt}>
        <Revealed text={card.prompt} />
      </Text>
      <Warnings warnings={card.warnings} />
      <View style={styles.options}>
        {card.options.map((option) => (
          <Pressable
            key={option.answer}
            accessibilityRole="button"
            onPress={() => {
              haptic('answer');
              onAnswer(option.answer);
            }}
            style={({ pressed }) => [styles.option, pressed && styles.pressed]}
          >
            <Text style={styles.optionLabel}>
              <Revealed text={option.label} />
            </Text>
            {option.description && (
              <Text style={styles.caption}>
                <Revealed text={option.description} />
              </Text>
            )}
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
      <Text style={styles.prompt}>
        <Revealed text={errorCardText(message)} />
      </Text>
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
  hiddenChar: { color: colors.background, backgroundColor: colors.red, fontWeight: '700' },
  warnings: {
    borderColor: colors.red,
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    gap: 4,
  },
  warningText: { color: colors.red, fontSize: 14, lineHeight: 19 },
  agentSays: { borderLeftColor: colors.textSecondary, borderLeftWidth: 3 },
  agentSaysText: { fontStyle: 'italic', color: colors.textSecondary },
});
