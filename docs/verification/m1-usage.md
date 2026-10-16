# Two weeks of owner use (M1 exit, criterion 4)

Log for ROADMAP §3 M1 (4): two weeks of owner use, **≥ 20 approvals from outside home,
zero agent-caused hangs**.

**Status: pending the owner** — starts once `remotectl@0.1.0` is installed from npm
(M1-09b) against the production relay (M0-02b).

## Definitions

- **From outside home**: the decision is made on the phone while the phone is not on
  the home network (mobile data or other Wi-Fi). Decisions at the desk do not count.
- **Approval**: an Allow, Always or Answer sent from the phone that Claude Code acted on.
  Denials are logged too but do not count toward the 20.
- **Agent-caused hang**: Claude Code waits on a request with no way forward that the
  agent caused — the phone shows no card although the agent is online, a decision sent
  from the phone does not reach Claude Code, or the terminal gets no prompt after a
  handoff. A handoff to the terminal (`deadline`, `released`, `paused`, `disconnected`)
  is **not** a hang by itself; it is D10 working as designed.

## How to collect

1. On day 1 and day 14, record the agent's local counters:
   `remotectl status` (the "local counters" line: approved, denied, sessions, tool calls).
   The difference is the total for the period, home and away together.
2. Per day, note the decisions made away from home (the agent cannot tell networks
   apart, so this column is the owner's own count).
3. For a suspected hang, keep the agent log around that time:
   `remotectl logs -n 200`. Each request ends with a `pending_removed` line whose
   `outcome` is `decided` or a handoff reason (`deadline`, `disconnected`, …); a request
   with a `pending_added` line and no `pending_removed` line while Claude Code waited is
   a hang candidate. Logs carry ids and codes only, no payloads (D19), so they can be
   pasted below.

## Counters

| Day    | Date | `remotectl status` local counters |
| ------ | ---- | --------------------------------- |
| Day 1  |      |                                   |
| Day 14 |      |                                   |

## Daily log

| Date | Approvals away | Denials away | Network (mobile / other Wi-Fi) | Hangs | Notes |
| ---- | -------------- | ------------ | ------------------------------ | ----- | ----- |
|      |                |              |                                |       |       |

## Hangs

| #   | Date and time | What was seen | Agent log excerpt (ids/codes only) | Resulting WP |
| --- | ------------- | ------------- | ---------------------------------- | ------------ |
|     |               |               |                                    |              |

## Verdict

- [ ] 14 days covered
- [ ] ≥ 20 approvals from outside home (total: )
- [ ] 0 agent-caused hangs
