// Must run before any shared package touches crypto or the web platform APIs.
import '../adapters/platform';

import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { loadDevConnection } from '../adapters/dev-connection';
import { useInbox } from '../state/store';
import { startPendingLinkWatch } from '../state/pending-link';
import { startWidgetSync } from '../state/widget-sync';

import { colors } from '../ui/theme';

const theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: colors.brand,
    background: colors.background,
    card: colors.background,
    text: colors.text,
    border: colors.border,
  },
};

export default function RootLayout() {
  const connect = useInbox((state) => state.connect);
  useEffect(() => {
    // Reconnects to the developer relay saved last time (M4-03).
    void loadDevConnection().then((saved) => {
      if (saved !== undefined) void connect(saved);
    });
  }, [connect]);
  // Home-screen, Lock Screen and Control Center widgets read the App Group (M4-07).
  useEffect(() => startWidgetSync(), []);
  // The Control Center control opens the app and leaves the deep link to follow (M4-07).
  useEffect(() => startPendingLinkWatch(), []);

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.background }}>
      <ThemeProvider value={theme}>
        <StatusBar style="light" />
        <Stack screenOptions={{ contentStyle: { backgroundColor: colors.background } }}>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen
            name="session/[id]"
            options={{ title: '', headerBackButtonDisplayMode: 'minimal' }}
          />
        </Stack>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
