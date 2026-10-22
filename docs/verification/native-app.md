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
