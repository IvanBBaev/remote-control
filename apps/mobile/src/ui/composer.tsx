import * as Haptics from 'expo-haptics';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { QUICK_REPLIES } from '../core/inbox';
import { colors, radius } from './theme';

/**
 * Instruct the agent: quick-reply chips over a text field (Coucou). Disabled while the
 * session waits on an approval or a question, which have to be answered first.
 */
export function Composer({
  disabled,
  onSend,
}: {
  disabled: boolean;
  onSend: (text: string) => void;
}) {
  const [text, setText] = useState('');
  const send = (value: string) => {
    if (disabled || !value.trim()) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onSend(value);
    setText('');
  };
  return (
    <View style={[styles.container, disabled && styles.disabled]}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chips}
        keyboardShouldPersistTaps="handled"
      >
        {QUICK_REPLIES.map((reply) => (
          <Pressable
            key={reply}
            disabled={disabled}
            onPress={() => send(reply)}
            style={({ pressed }) => [styles.chip, pressed && styles.pressed]}
          >
            <Text style={styles.chipText}>{reply}</Text>
          </Pressable>
        ))}
      </ScrollView>
      <View style={styles.inputRow}>
        <TextInput
          value={text}
          onChangeText={setText}
          editable={!disabled}
          placeholder={disabled ? 'Answer the request first' : 'Tell the agent what to do'}
          placeholderTextColor={colors.textTertiary}
          style={styles.input}
          multiline
          returnKeyType="send"
          submitBehavior="submit"
          onSubmitEditing={() => send(text)}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send"
          disabled={disabled || !text.trim()}
          onPress={() => send(text)}
          style={({ pressed }) => [
            styles.send,
            (disabled || !text.trim()) && styles.sendOff,
            pressed && styles.pressed,
          ]}
        >
          <SymbolView
            name="arrow.up"
            tintColor="#fff"
            size={18}
            weight="bold"
            fallback={<Text style={styles.sendText}>↑</Text>}
          />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 10,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.background,
  },
  disabled: { opacity: 0.45 },
  chips: { gap: 8, paddingHorizontal: 16 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipText: { color: colors.text, fontSize: 14, fontWeight: '500' },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 16 },
  input: {
    flex: 1,
    minHeight: 42,
    maxHeight: 120,
    paddingHorizontal: 14,
    paddingTop: 11,
    paddingBottom: 11,
    borderRadius: 21,
    backgroundColor: colors.surface,
    color: colors.text,
    fontSize: 16,
  },
  send: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.brand,
  },
  sendOff: { backgroundColor: colors.surfaceRaised },
  sendText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  pressed: { opacity: 0.7 },
});
