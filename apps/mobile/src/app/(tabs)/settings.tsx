import type { PendingPairing } from '@remote-control/phone-core/realtime/phone';
import Constants from 'expo-constants';
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { type PushStatus, usePush } from '../../state/push';
import { useInbox } from '../../state/store';
import { Screen, Section } from '../../ui/screen';
import { colors, mono } from '../../ui/theme';

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

function Field({
  label,
  value,
  onChange,
  placeholder,
  first = false,
  secure = false,
}: {
  label: string;
  value: string;
  onChange: (text: string) => void;
  placeholder: string;
  first?: boolean;
  secure?: boolean;
}) {
  return (
    <View style={[styles.field, !first && styles.divider]}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.textTertiary}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry={secure}
        style={styles.input}
      />
    </View>
  );
}

/** Pairing with a computer running `remotectl pair` (D6): code, then matching fingerprints. */
/**
 * Deep links into Settings: `remotecontrol://settings?pair=<code>` starts pairing (the
 * future QR code). Development builds also take `relay` + `token` (sign in) and `confirm`
 * (the fingerprint the computer shows), so a headless simulator can be driven end to end.
 */
type SettingsLink = { pair?: string; relay?: string; token?: string; confirm?: string };

const compact = (fingerprint: string) => fingerprint.replace(/\s+/g, '').toLowerCase();

function PairMachine() {
  const phone = useInbox((state) => state.phone);
  const link = useLocalSearchParams<SettingsLink>();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const linked = useRef<string | undefined>(undefined);
  const awaiting = useRef<PendingPairing | undefined>(undefined);

  useEffect(() => {
    if (phone === undefined || link.pair === undefined || linked.current === link.pair) return;
    linked.current = link.pair;
    setCode(link.pair);
    start(link.pair);
  });

  useEffect(() => {
    const pending = awaiting.current;
    if (!__DEV__ || pending === undefined || link.confirm === undefined) return;
    if (compact(link.confirm) !== compact(pending.fingerprint)) return;
    awaiting.current = undefined;
    void pending.confirm().then(() => {
      setCode('');
    });
  });

  if (phone === undefined) return <Row label="Pair a machine" value="Connect first" />;

  const confirm = (pending: PendingPairing) => {
    awaiting.current = pending;
    Alert.alert(
      `Pair with ${pending.name}?`,
      `Check that your computer shows the same code:\n\n${pending.fingerprint}`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Codes match',
          onPress: () => {
            awaiting.current = undefined;
            pending.confirm().then(
              () => {
                setCode('');
              },
              (error: unknown) => {
                Alert.alert('Pairing failed', String(error));
              },
            );
          },
        },
      ],
    );
  };

  function start(value: string) {
    if (phone === undefined) return;
    setBusy(true);
    phone
      .pair(value.trim())
      .then(confirm, (error: unknown) => {
        Alert.alert('Pairing failed', error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        setBusy(false);
      });
  }

  return (
    <>
      <Field
        label="Pairing code"
        value={code}
        onChange={setCode}
        placeholder="From remotectl pair"
      />
      <Row
        label={busy ? 'Pairing…' : 'Pair a machine'}
        tone={colors.brand}
        {...(!busy &&
          code.trim() !== '' && {
            onPress: () => {
              start(code);
            },
          })}
      />
    </>
  );
}

/** Developer sign-in until the app has its own account sign-in. */
function DeveloperRelay() {
  const live = useInbox((state) => state.live);
  const connect = useInbox((state) => state.connect);
  const disconnect = useInbox((state) => state.disconnect);
  const [origin, setOrigin] = useState('http://localhost:3200');
  const [token, setToken] = useState('');
  const link = useLocalSearchParams<SettingsLink>();
  const linked = useRef(false);

  useEffect(() => {
    if (linked.current || link.relay === undefined || link.token === undefined) return;
    linked.current = true;
    void connect({ origin: link.relay, token: link.token });
  });

  if (live.state === 'live')
    return (
      <Section title="Developer relay">
        <Row first label="Relay" value={live.origin} />
        <Row label="Account" value={live.userId.slice(0, 8)} />
        <Row label="Disconnect" tone={colors.red} onPress={() => void disconnect()} />
      </Section>
    );

  return (
    <Section title="Developer relay">
      <Field
        first
        label="Relay"
        value={origin}
        onChange={setOrigin}
        placeholder="http://localhost:3200"
      />
      <Field
        label="Session token"
        value={token}
        onChange={setToken}
        placeholder="pnpm dev:session"
        secure
      />
      {live.state === 'error' && <Text style={styles.error}>{live.message}</Text>}
      <Row
        label={live.state === 'connecting' ? 'Connecting…' : 'Connect'}
        tone={colors.brand}
        {...(live.state !== 'connecting' &&
          token.trim() !== '' && {
            onPress: () => void connect({ origin: origin.trim(), token: token.trim() }),
          })}
      />
    </Section>
  );
}

const PUSH_LABELS: Readonly<Record<PushStatus, string>> = {
  off: 'When connected',
  on: 'On',
  denied: 'Not allowed',
  failed: 'Not registered',
};

export default function SettingsScreen() {
  const push = usePush((state) => state.status);
  const sample = useInbox((state) => state.sample);
  const sessions = useInbox((state) => state.sessions);
  const paired = useInbox((state) => state.machines);
  const reset = useInbox((state) => state.reset);
  const machines = sample
    ? [...new Set(sessions.map((session) => session.machine))].sort().map((name) => ({
        key: name,
        name,
        value: `${sessions.filter((s) => s.machine === name).length} agents`,
      }))
    : paired.map((machine) => ({
        key: machine.deviceId,
        name: machine.name,
        value: machine.online ? 'Online' : 'Offline',
      }));

  return (
    <Screen title="Settings">
      <Section title="Machines">
        {machines.map((machine, index) => (
          <Row key={machine.key} first={index === 0} label={machine.name} value={machine.value} />
        ))}
        <PairMachine />
      </Section>
      {__DEV__ && <DeveloperRelay />}
      <Section title="Notifications">
        <Row first label="Push notifications" value={PUSH_LABELS[push]} />
        <Row label="Live Activity & Dynamic Island" value="M4-06" />
      </Section>
      <Section title="Security">
        <Row first label="Face ID before Allow" value="On" />
      </Section>
      {sample && (
        <Section title="Sample data">
          <Row first label="Reset sample agents" tone={colors.brand} onPress={reset} />
        </Section>
      )}
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
  field: { paddingHorizontal: 16, paddingVertical: 10, gap: 4 },
  fieldLabel: { color: colors.textSecondary, fontSize: 13 },
  input: { color: colors.text, fontSize: 15, fontFamily: mono, paddingVertical: 4 },
  error: { color: colors.red, fontSize: 13, paddingHorizontal: 16, paddingBottom: 8 },
  about: { alignItems: 'center', gap: 4, paddingTop: 24 },
  aboutText: { color: colors.textTertiary, fontSize: 13 },
});
