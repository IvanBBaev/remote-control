# Native phone app (M4)

Verification log for the Expo app in `apps/mobile` (ADR 0017). Each M4 work package adds
its evidence here; the M4 exit (a real iPhone allowing a real Claude Code request from
the Lock Screen Live Activity) is recorded in the last section.

## M4-01 — scaffold and screens (2026-10-18)

**Result: pass.** The app builds as a dev client and runs in the iOS simulator (iPhone 18
Pro) on Expo SDK 58.0.7, React Native 0.88.0-rc.4 and expo-router 58.0.17. The
store holds fixture sessions until M4-03 wires the relay; a banner on every screen says so.

| Screen           | Screenshot                                              | Checked                                                                                                                       |
| ---------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Agents           | [agents.png](native-app/agents.png)                     | Sorted by urgency (needs OK, question, error, working, done, idle); countdown on pending rows; tab badge counts waiting rows. |
| Session approval | [session-approval.png](native-app/session-approval.png) | Tool, command, cwd, countdown; Deny / Allow / Always; composer locked while a request is pending.                             |
| Session question | [session-question.png](native-app/session-question.png) | Question header, prompt and options with descriptions; answering sends the option label.                                      |
| History          | [history.png](native-app/history.png)                   | Decisions newest first, with outcome, tool, detail, project and machine.                                                      |
| Settings         | [settings.png](native-app/settings.png)                 | Machines, pairing, notifications, Face ID and sample-data reset; unbuilt rows name their work package.                        |

Swipe right to Allow and left to Deny on an Agents row uses `ReanimatedSwipeable`, which
decides only when a drag is released past the threshold. Navigating between screens by
deep link was checked not to decide anything: the store's `decide` was traced across
the sequence session → history → session and was never called.

The screens are checked by these screenshots, not by unit tests: `src/{app,ui,state,adapters}`
are excluded from coverage, and `src/core` (urgency order, expiry, history) is held at
100 % (`vitest.config.ts`).

### How to run

```sh
pnpm install
cd apps/mobile
pnpm exec expo prebuild --platform ios   # generates ios/, never committed
pnpm exec expo run:ios                   # builds the dev client and opens the simulator
```

Deep links: `remotecontrol://session/<id>`, `remotecontrol://history`,
`remotecontrol://settings`.

## M4-03 — shared phone core, live relay (2026-10-22)

**Result: pass.** The pure phone logic moved from `apps/web/src` to `packages/phone-core`
(realtime client and store, pairing, envelopes, relay API, passkey key derivation); the
PWA imports it from there and its tests run unchanged. The app runs the same code on
Hermes through `src/adapters/platform.ts` (noble crypto backend, `getRandomValues` from
expo-crypto, `crypto.subtle.digest`, `AbortSignal.timeout`, `TextDecoder`), keeps its
identity and paired computers in the Keychain (expo-secure-store,
`AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`) and sends the session cookie and `Origin` itself
on fetch and on the WebSocket upgrade.

Checked against a local relay (`RC_ORIGIN=http://localhost:3200`, `RC_RP_ID=localhost`)
and a `remotectl` built from this tree, in the iPhone 18 Pro simulator:

| Step                                                | Evidence                                                                                                                                                                                                                      |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App signs in with a dev session and binds the phone | Relay log: `phone_bind` 201, then `ws_open` with `kind: phone`.                                                                                                                                                               |
| Pairing                                             | `remotectl pair` and the app showed the same fingerprint; both confirmed; the computer is listed Online ([live-settings.png](native-app/live-settings.png)).                                                                  |
| A real pending request                              | A `PermissionRequest` sent through the installed `hook.cjs` appears on Agents with its countdown ([live-agents.png](native-app/live-agents.png)) and on the session screen ([live-session.png](native-app/live-session.png)). |
| Reconnect                                           | After the app is killed and relaunched it signs in again from the Keychain and shows the request.                                                                                                                             |

Until the app has its own passkey (M4-04) it sends only what needs no assertion (Deny,
handing back to the terminal); Allow, Always, answers and instructions say they need
Face ID. The agent therefore records the phone without passkey keys and relies on the
relay's check, as it says when pairing.

### How to run (development builds)

```sh
pnpm --filter @remote-control/relay build
# relay with RC_ORIGIN=http://localhost:3200 RC_RP_ID=localhost RC_PORT=3200 and your DB env
node apps/relay/dist/admin.js invite                       # one-time invite code
pnpm dev:session --relay http://localhost:3200 --invite <code>   # prints a session token
```

Deep links into Settings drive the app without typing (a headless simulator has no
taps): `remotecontrol://settings?relay=<url>&token=<token>` signs in (development
builds only), `remotecontrol://settings?pair=<code>` starts pairing, and in
development builds `&confirm=<fingerprint>` confirms it when it matches what the app
computed. The session token is a credential: keep it out of shell history and files
that are committed.

## M4-07 — widgets and Control Center (2026-10-22)

**Result: pass** for the home-screen widgets and the Control Center control. Lock Screen
accessories are not covered (see the end of this section).

The app writes a privacy-reduced snapshot to the App Group `group.dev.ivanbaev.remotecontrol`
(`src/core/widget-snapshot.ts`, `src/state/widget-sync.ts`). Each row holds only the
machine, project, state, a plain label, the deadline and a deep link, which is the push
summary level (D5). The snapshot is written only when something the widgets show
changes. The WidgetKit extension (`targets/widgets`, via `@bacons/apple-targets`) contains:

- **AgentsWidget**: small (most urgent session, countdown), medium (three rows, each its
  own link), and the Lock Screen `accessoryCircular`, `accessoryRectangular` and
  `accessoryInline` families.
- **WaitingControl** (iOS 18): a Control Center button labelled "N waiting" that opens the
  most urgent waiting session, or the agents list when nothing waits. Control Center does
  not follow an `OpenURLIntent`, so the control's intent opens the app and leaves the link
  in the App Group. The app opens it when it becomes active (`src/state/pending-link.ts`)
  and ignores records older than 30 s.

Checked in a scratch iPhone 18 Pro simulator (iOS 27) against the Release build, running
on sample data. The widgets were placed by hand. The taps run as an XCUITest against
SpringBoard ([WidgetTapUITests.swift](native-app/WidgetTapUITests.swift), in a UI-test
target added locally to the git-ignored `ios/` project). All four tests pass:

| Step                               | Evidence                                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Widgets render the sample data     | Small widget shows billing-api; medium shows three rows ([widgets-home.png](native-app/widgets-home.png)). |
| Medium row 2 opens its session     | marketing-site session screen ([widget-tap-marketing-site.png](native-app/widget-tap-marketing-site.png)). |
| Medium row 3 opens its session     | infra session screen ([widget-tap-infra.png](native-app/widget-tap-infra.png)).                            |
| Small widget opens the most urgent | billing-api session screen ([widget-tap-billing-api.png](native-app/widget-tap-billing-api.png)).          |
| Control shows the live count       | "2 waiting" in Control Center ([control-center.png](native-app/control-center.png)).                       |
| Control opens the most urgent      | billing-api session screen ([control-tap-billing-api.png](native-app/control-tap-billing-api.png)).        |

The sample deadlines count from app launch, so relaunch the app before you run the tests.

**Not verified:** the Lock Screen accessory families compile and use the same views and
links, but none was placed on a Lock Screen. A headless simulator cannot reliably drive the
Lock Screen editor. This check is left for a device.

## M4-05 — APNs and actionable notifications (2026-10-28)

**Result: partial.** The relay half is verified by unit tests; the simulator run is
blocked by the same CoreSimulator issue as M4-04.

Relay (`apps/relay`): the APNs sender signs an ES256 provider token from the `.p8` in the
environment and posts to the sandbox or production host the token was registered for
(`push_subscriptions.kind`, migration 0004). Unit tests check the payload shape: a
generic alert, `category: rc.pending`, `mutable-content: 1` and the metadata-only `rc`
object (D5). They also check that config never echoes the `.p8` key (D19) and that a gone token
(410) is deleted.

App (`apps/mobile`): the app registers the APNs token with the relay when it goes live,
shares each pairing's notification key with the Notification Service Extension through
the App Group Keychain, and registers the categories. Pending requests get Allow, Review,
Deny and Reply. Turn notices get Reply only. Every action that decides needs an unlocked
phone. The extension (`targets/notification-service`) opens `rc.sum` with AES-GCM, using
the AAD `rc/v1/push` + rid, and replaces the title, body and category. When the summary is
missing or cannot be opened, it keeps the generic alert.

### How to run

```sh
xcrun simctl push booted docs/verification/native-app/apns-pending.json
```

[apns-pending.json](native-app/apns-pending.json) carries no `rc.sum`, so it shows the
generic alert with the action buttons. To see a decrypted summary, the push must come
from a paired agent, because the summary is sealed with that pairing's key.

**Not verified:**

- The simulator run. CoreSimulator needs `sudo xcodebuild -runFirstLaunch`, and the
  iOS SDK is not installed (see M4-04).
- Per-option answer buttons. The summary carries no options, so a question is answered
  by a Reply whose text matches an option label.
