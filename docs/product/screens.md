# Screen inventory

Every PWA screen with its route, the data it needs, and its empty, offline and error
states (01 W3, 01 §5.6, 05 Rec-3, 05 Rec-7). The route table lives in
`apps/web/src/routes.tsx`; a screen marked _planned_ has no route yet.

Conventions:

- **Offline** means the relay WebSocket is down. Lists keep showing the last known data
  with an "Offline — showing what this phone last saw" notice; actions that need the relay
  are disabled with that reason next to them. Nothing is queued silently.
- **Error** means a request failed. The screen shows one sentence on what failed and a
  "Try again" button; nothing is lost from the screen.
- Empty, offline and error states share one look: the notice block (`.notice`).
- Navigation after onboarding: tabs **Sessions** and **Computers** today; **Inbox** and
  **Settings** join when their screens land (01 §5.6 lists Inbox, Sessions, Settings).

## Onboarding

The gate (`apps/web/src/onboarding.ts`) sends the user to the first unmet step, in the
order passkey → install → notifications → pair (05 Rec-3). The main app is reachable only
when every step is done; a step out of order redirects to the current one.

| Screen                         | Route                                      | Data needed                                                                                 | Empty                                    | Offline                                                                                    | Error                                                                                                                                                                                        |
| ------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Update your browser            | `/onboarding/update-browser`               | Capability report: missing capabilities                                                     | — (shown only when something is missing) | Works offline: the probe is local                                                          | — (no requests)                                                                                                                                                                              |
| Create your passkey            | `/onboarding/passkey`                      | Invite code (typed, or `?invite=` from the invite link), optional display name; relay RP ID | —                                        | "You are offline — connect to create your passkey"; button disabled                        | WebAuthn cancelled or failed: "Passkey not created — try again"; relay rejected the invite: "This invite code is not valid"; rate limited: "Too many attempts — wait a minute and try again" |
| Save your recovery code        | `/onboarding/passkey` (after registration) | Recovery code from the registration response, shown once (D8)                               | —                                        | Works offline: nothing is sent                                                             | — (no requests). "Continue" stays disabled until "I saved my recovery code somewhere safe" is checked                                                                                        |
| Install the app                | `/onboarding/install`                      | Capability report: verdict, standalone                                                      | —                                        | Works offline: instructions only                                                           | — (no requests). Shows "Continue in the browser" only where push already works (Android, desktop)                                                                                            |
| Turn on notifications          | `/onboarding/notifications`                | `Notification.permission`; push subscription (push WP)                                      | —                                        | Permission can be granted offline; the subscription upload waits for the relay and says so | Denied: "Notifications are blocked — allow them in your phone's settings"; unsupported: "This browser cannot show notifications. Install the app first."                                     |
| Add your first computer (Pair) | `/onboarding/pair`                         | Pairing code or QR from `npx remotectl pair`; pairing session (M0-20)                       | —                                        | "You are offline — pairing needs a connection"; Pair disabled                              | Wrong or expired code: "That code did not work — run `remotectl pair` again"; self-test timed out: "Still waiting for the computer — check its terminal"                                     |

## Signed out

| Screen  | Route    | Data needed                                                                                                    | Empty | Offline                                                 | Error                                                                                                                                                                                                                      |
| ------- | -------- | -------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign in | `/login` | Relay RP ID; passkey assertion from the button or from the autofill list of the account field (conditional UI) | —     | "You are offline — connect to sign in"; button disabled | Assertion cancelled: stays on the screen; unknown passkey: "This passkey is not registered here — create an account"; rate limited: "Too many attempts — wait a minute and try again"; other: "Sign-in failed — try again" |

### End-to-end hooks (P1, wired in M1-12)

Playwright spec P1 (register + login with the CDP virtual authenticator) drives these
screens through their accessible names, which are part of the screen contract:

- Register: open `/onboarding/passkey?invite=<code>`, press **Create passkey**, read the
  code from the element labelled **Recovery code**, check **I saved my recovery code
  somewhere safe**, press **Continue**.
- Login: open `/login`, press **Sign in with passkey**; the conditional-UI path focuses
  `#login-username` (`autocomplete="username webauthn"`).
- The virtual authenticator must report user verification (`isUserVerified: true`):
  registration, login and decision assertions all require UV.

## Main app

| Screen               | Route                  | Data needed                                                                                              | Empty                                                                                 | Offline                                                                      | Error                                                                                                                                                                                           |
| -------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sessions (home)      | `/sessions` (also `/`) | Machines with online state; sessions per machine with state (working, idle, needs you) and last activity | "No sessions yet. Start one here or run an agent on a paired computer." + New session | Last known list with "offline since" per machine; New session disabled       | "Could not load sessions" + Try again                                                                                                                                                           |
| Session              | `/sessions/:id`        | Session header (project, machine), "needs you" banner, transcript steps (decrypted on the phone), state  | "Nothing has happened in this session yet"                                            | Last known transcript; compose box disabled with "Offline"                   | Unknown id: "This session no longer exists" + back to Sessions; decrypt failure: "Could not read this session on this phone"                                                                    |
| Approval request     | `/requests/:id`        | Request (tool, summary, command on tap, suggested rule), `expiresAt`, session and machine                | — (always one request)                                                                | Allow/Deny disabled: "Offline — the terminal will take over if this expires" | Expired: no buttons, "Expired 1 min ago — the terminal took over"; already decided elsewhere: shows that decision; decision not delivered: "Not delivered — try again or reply in the terminal" |
| New session          | `/new`                 | Paired machines (online), repositories per machine, prompt                                               | No computer: "Pair a computer first" + link to pairing                                | Start disabled: "Offline"                                                    | Machine refused or went offline: "The computer did not start the session" + Try again                                                                                                           |
| Computers (machines) | `/machines`            | Paired machines: name, online state, last seen                                                           | "No computers yet" + Add your first computer                                          | Last known list, marked offline                                              | "Could not load computers" + Try again                                                                                                                                                          |
| Page not found       | any other path         | —                                                                                                        | —                                                                                     | Works offline                                                                | —                                                                                                                                                                                               |

## Planned (no route yet)

| Screen   | Route (planned)                             | Data needed                                                                                              | Empty                         | Offline                                                       | Error                                                       |
| -------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------- |
| Inbox    | `/inbox`                                    | Pending requests and questions (badge count); recent decisions kept on this phone                        | "Nothing needs you right now" | Pending list as last seen, marked offline; decisions disabled | "Could not load the inbox" + Try again                      |
| Question | `/requests/:id` (same route, question kind) | Question text and options, `expiresAt`                                                                   | —                             | Answer disabled: "Offline"                                    | Expired: "The terminal took over"; not delivered: Try again |
| Machine  | `/machines/:id`                             | Machine name, online state, agent and Claude Code versions, hooks status, repositories, permission mode  | "No repositories seen yet"    | Last known details, marked offline                            | Unknown id: back to Computers; "Can't connect?" checklist   |
| Settings | `/settings`                                 | Account (name, passkeys), devices (phones, machines), notification preferences per project, stats, about | —                             | Read-only, marked offline                                     | "Could not save" + Try again                                |
