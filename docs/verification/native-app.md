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
