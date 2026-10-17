# ADR 0017 — Native phone app (Expo) with Live Activities and a device signing key

Status: accepted (owner decision, 2026-10-17)
Deviates from:

- D1/D2: "phone PWA" is no longer the only phone client. A React Native app
  (`apps/mobile`, Expo) becomes the primary phone client. The PWA stays as the fallback
  for desktop browsers and for anyone who does not install the app.
- D3: the native app has no WebCrypto, so `@remote-control/crypto` gets a second
  primitives backend on `@noble/curves`, `@noble/ciphers` and `@noble/hashes`. That is
  the fallback D3 chose not to build.
- D5: iOS pushes go through APNs, not Web Push.
- D7: on the native app, the user verification for an Allow, Always, Answer, Instruct
  or Start is a Secure Enclave signature, not a WebAuthn assertion.
- M3 backlog: "native wrappers" moves into a planned milestone (M4).

## Context

The owner benchmarked the PWA against Coucou (github.com/Louis-CFM/coucou), the UX
reference named in the brief (00 §5), and rejected it. Coucou's iPhone app is native
Swift. Its headline features are the ones a web app cannot reach:

- a Live Activity in the Dynamic Island and on the Lock Screen, started by the computer
  through APNs push-to-start, with Allow/Deny buttons;
- actionable notifications: Allow, Review, Deny, a text Reply, and one button per answer;
- home-screen and Lock Screen widgets, and a Control Center control.

A PWA on iOS gets plain Web Push banners and nothing else. The owner chose React Native
with Expo over a Capacitor wrapper and over pure SwiftUI. This keeps the phone code in
TypeScript, close to the rest of the monorepo, and it reaches Android.

## Decision

**App.** `apps/mobile` is an Expo app, built with the development client, not Expo Go.
Swift is used only where iOS allows nothing else. These targets live in the repo as
local Swift targets, added through an Expo config plugin:

- the WidgetKit extension: the Live Activity UI, the widgets and the Control Center
  control;
- the ActivityKit token bridge;
- the `LiveActivityIntent` App Intents behind the Island buttons;
- App Group storage shared by the app and its extensions.

The screens follow Coucou's behaviour, not its code:

- an agents list sorted by urgency, with swipe to Allow or Deny;
- a session screen with the approval card, the question card, the last turn and a
  composer with quick-reply chips;
- a local decision history.

**Crypto.** The protocol and the Noise sessions are shared with the PWA. Only the
primitives backend differs: WebCrypto on the web and in Node, noble on React Native.
Both backends must pass the same Noise vectors and property tests. Keys live in the iOS
Keychain or the Android Keystore, never in AsyncStorage.

**User verification.** At pairing, the app creates a non-exportable P-256 key in the
Secure Enclave (Android: StrongBox or TEE). Its access control is "biometry, current
set", so every signature needs a fresh Face ID.

- The app sends the key's SPKI in pairing msg3, just as ADR 0010 ships passkey SPKIs.
  The XXpsk0 handshake authenticates msg3, so the relay can neither read nor swap the
  key.
- Each non-deny decision carries an ES256 signature over SHA-256(canonical decision).
  The canonical form and the hash input are the same as D7's WebAuthn challenge.
- The agent verifies the signature as it does under ADR 0010. That check is the
  authority. The relay never held authority (I4), so no relay-side check is needed for
  these decisions.
- The user still signs in to the relay account with a passkey: the native passkey API
  needs associated domains on the production domain (Q2).

The device key is what lets an Allow run from a notification button or from the Live
Activity without opening the app. The App Intent asks for Face ID, signs, and sends the
decision. A WebAuthn ceremony cannot run inside an extension.

**Push.** The relay gets a push port with two adapters, Web Push and APNs. APNs uses
token auth; the `.p8` key lives in Railway secrets.

- Push subscriptions gain a `kind`: `webpush`, `apns` or `apns_activity`.
- Alert pushes keep the D5 rules. They carry metadata, plus the opaque `pushBlob`
  (ADR 0001). A Notification Service Extension decrypts the blob with the notification
  key from the shared Keychain group.
- Live Activity updates and push-to-start payloads are shown by the system without our
  code running, so they carry **metadata only**: the machine label, the state (`ok?`,
  `?`, `!`, `✓`, working), the count of pending requests, the earliest expiry and a
  request id. They never carry a command, a path or a summary (I3).
- Every push the relay sends is authenticated end to end. A token only reaches the
  relay over the user's authenticated session, and nothing pushes on request from
  outside. Coucou's relay accepts unauthenticated POSTs; ours does not.

## Consequences

- An Apple Developer Program membership (Q22) is required for APNs, associated
  domains, the App Group and TestFlight. The scaffold, the screens, the crypto backend,
  the device key and the Live Activity UI run in the simulator without one; pushes are
  simulated there with `xcrun simctl push`.
- The production domain (Q2) now blocks native sign-in as well as the PWA.
- The phone client exists twice, as the PWA and the app. Shared, platform-free phone
  logic moves into a `packages/phone-core` (relay client, pairing, session store) so
  that the two do not drift.
- The Island shows less than Coucou's: a state and a count, not the command. The full
  summary is one tap away, in the decrypted notification or in the app.
- `pnpm check` gains the mobile app's typecheck, lint and unit tests. Native builds run
  in a separate macOS CI job, not in `pnpm check`.
