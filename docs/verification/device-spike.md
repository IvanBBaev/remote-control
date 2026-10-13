# Device feasibility spike (M0-03)

GO / NO-GO for the PWA on real phones (ROADMAP M0-03, 05 W1). The page is a throwaway
that the relay serves under `/spike/` when `RC_SPIKE=1`. It is deleted, together with
`POST /api/spike/push` and this file's "How to run" section, once the verdict below is
final.

**Status: pending the owner** — needs the production domain (Q2) attached to Railway and
at least one iPhone and one Android phone.

## What is checked

| Id               | Capability                                                                                                     | GO when                                                        |
| ---------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `standalone`     | Installed to the home screen and opened from the icon                                                          | `display-mode: standalone` (or `navigator.standalone`)         |
| `x25519`         | WebCrypto X25519 `generateKey` + `deriveBits`                                                                  | two key pairs derive the same 32-byte secret                   |
| `ed25519`        | WebCrypto Ed25519 `sign` + `verify`                                                                            | the signature verifies                                         |
| `passkey-create` | `navigator.credentials.create` with `residentKey: required`, `userVerification: required` in the installed app | resolves and the authenticator data has the UV flag            |
| `passkey-get`    | `navigator.credentials.get` with `userVerification: required`                                                  | resolves and the UV flag is set                                |
| `push-subscribe` | `PushManager.subscribe` in the installed app                                                                   | a subscription with a known push service endpoint              |
| `push-received`  | Push arrives with the app closed and the phone locked                                                          | the service worker runs with no visible window                 |
| `sw-decrypt`     | The service worker decrypts the payload with a non-extractable AES-GCM key read from IndexedDB                 | the decrypted canary matches                                   |
| `badge`          | `navigator.setAppBadge` from the service worker                                                                | the call resolves **and** the owner sees the badge on the icon |
| `deep-link`      | Tapping the notification opens `/spike/requests/1`                                                             | the page opens at that route                                   |

Timings (crypto, passkey ceremonies, push latency from request to service worker, tap
to page) are recorded in each row's detail.

Push and passkey-with-UV are the gating capabilities (ROADMAP R1): a NO-GO on
`push-subscribe`, `push-received`, `passkey-create` or `passkey-get` on either platform
stops all PWA work until the owner decides between a native wrapper and a scope change.
A NO-GO elsewhere is recorded with the fallback the PWA will use.

## How to run

1. On Railway (`relay` → Variables) set `RC_SPIKE=1`; the VAPID keys
   (`RC_VAPID_PUBLIC`, `RC_VAPID_PRIVATE`) must already be set, and `RC_ORIGIN` /
   `RC_RP_ID` must be the production domain, so the passkeys bind to the final RP ID
   (D9). The spike needs no database.
2. On the phone open `https://<domain>/spike/` in Safari (iOS) or Chrome (Android).
3. Install it: iOS Share → Add to Home Screen; Android menu → Install app. Close the
   browser tab and open the app from the home screen icon. Everything below runs in the
   installed app.
4. Tap buttons 1–3: WebCrypto, Create passkey (Face ID / fingerprint), Use passkey.
5. Tap button 4 and allow notifications.
6. Tap button 5, then within 20 s swipe the app away and lock the phone.
7. When the notification arrives on the lock screen, note whether the icon shows a
   badge, then tap the notification and unlock. The app must open at
   `/spike/requests/1`.
8. Tap **Copy report** and paste the Markdown table into "Runs" below, adding the badge
   observation and anything the table cannot see (prompts shown, failures retried).
9. Repeat on every device of the matrix, then unset `RC_SPIKE`.

Device matrix (05 W1): iOS 17.x, iOS 18.4 or later, Android 14 Chrome. At least one
iPhone and one Android phone are required for the verdict.

### Privacy note (I1, I2)

The test push payload is encrypted on the phone with an AES-GCM key that never leaves
it; the relay forwards ciphertext it cannot read (I1). Unlike production pushes (D5,
metadata only, sent at once), the spike route holds that ciphertext in memory for up to
120 s so the owner can lock the phone first. Nothing is written to the database or the
logs; pending pushes are dropped when the relay stops; the route is off by default and
is deleted after the spike. This is the only payload the relay ever holds, and only
while `RC_SPIKE=1`.

## Verdict

| Capability                                    | iPhone  | Android |
| --------------------------------------------- | ------- | ------- |
| Installable, opens standalone                 | pending | pending |
| X25519                                        | pending | pending |
| Ed25519                                       | pending | pending |
| Passkey create with UV                        | pending | pending |
| Passkey get with UV                           | pending | pending |
| Push subscribe                                | pending | pending |
| Push received, app closed and phone locked    | pending | pending |
| Service worker decrypts with an IndexedDB key | pending | pending |
| App badge                                     | pending | pending |
| Notification tap opens a route                | pending | pending |

**Overall: pending.**

## Runs

<!-- One "Copy report" block per device, newest first, with the device model and OS. -->

_No runs yet._
