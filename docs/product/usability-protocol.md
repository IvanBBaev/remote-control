# Second-user usability protocol

How the owner runs the M1 second-user test (ROADMAP M1-14, 01 W14, 01 §5.7). The filled-in
run goes to [docs/verification/second-user.md](../verification/second-user.md).

## Setup

- **Participant:** the named second user (ROADMAP §6 Q13). A developer who uses Claude
  Code daily, has not seen this project's code or design, and owns the computer and phone
  used.
- **Before the session:** the relay is deployed (M0-02b), `remotectl@0.1.0` is on npm
  (M1-09b), and the owner mints one invite (`node dist/admin.js invite`, see
  [apps/relay/README.md](../../apps/relay/README.md)). The participant gets the invite link and the README
  link, nothing else.
- **Rules:** the owner watches (in person or screen share) and does not help. If the
  participant is stuck for 3 minutes, the owner may give one hint; each hint is logged
  and marks the task as "with help".
- **Clock:** take timestamps from the agent's log (`remotectl logs`) and the relay's
  account creation time where they exist; the owner's watch otherwise.

## Tasks

| #   | Task                                                                                                                        | Starts when                           | Done when                                                         |
| --- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------- |
| T1  | Create an account and install the app on the phone                                                                          | The participant opens the invite link | The app runs from the home-screen icon with notifications allowed |
| T2  | Install `remotectl`, configure the relay and one folder, log in, pair                                                       | T1 done                               | The phone shows the computer online                               |
| T3  | Run the self-test and approve it                                                                                            | T2 done                               | `remotectl status --self-test` prints the phone's Allow           |
| T4  | In Claude Code, in the allowed folder, trigger a command that needs approval, lock the phone, approve from the notification | T3 done                               | Claude Code runs the command                                      |
| T5  | Start a new session in the allowed folder from the phone                                                                    | T4 done                               | The session appears on Sessions with its first step               |
| T6  | Revoke the phone from the computer, then pair again                                                                         | T5 done                               | The phone shows the computer online again                         |

**Pass (01 §5.7):** T1 start → T3 done in **≤ 10 minutes without help**; T4 and T5
unaided; **≤ 2 blocking issues**. T6 is informational.

## Questions after the session

1. What was the most confusing step? Where did you expect something else?
2. Which notification or screen text did you not understand?
3. Would you keep it running? (The owner checks "last seen" on Computers after 7 days.)
4. Would you keep it if Claude Code's Remote Control did the same? Why?

## Known friction to watch

- The relay URL must be typed into `config.json` before `remotectl login` works; the
  README says so, but no command writes it.
- The repository allow-list is edited by hand in the same file.
- Claude Code runs hooks only in trusted folders; the "hooks seen" line on Computers is
  the signal.

Every blocking issue becomes a work package in ROADMAP §4 (or an entry in an existing
one) before M1 is declared done.
