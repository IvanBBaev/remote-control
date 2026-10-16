# M1 exit record

Exit record for **M1 — Second user** (ROADMAP §3): a second, named user installs from
the README in ≤ 10 min; the owner uses it daily.

**Status: pending the owner** — needs the M0 exit ([m0-exit.md](m0-exit.md)), the first
tagged publish (M1-09b), the second-user run (M1-14b), the two weeks of use and the
real-CLI checks (M1-04b, M1-05b, M1-07b).

## Exit criteria

| #   | Criterion (ROADMAP §3 M1)                                                                           | Evidence                                                                                                                  | Holds |
| --- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----- |
| 1   | J4 question, J8 sessions, J9 instruction, J10 new session, J11 allow-list refusal, J12 revoke green | `ci` and `agent-os` runs of the release commit below (`packages/test-harness/src/journeys/j4-…` to `j12-…`)               | [ ]   |
| 2   | `remotectl@0.1.0` published by trusted publishing; installers for macOS and Linux                   | `npm view remotectl@0.1.0` with provenance; `release` run link; `remotectl install` on macOS and Linux (Windows may slip) | [ ]   |
| 3   | Second-user run ≤ 10 min, no help                                                                   | [second-user.md](second-user.md) verdict                                                                                  | [ ]   |
| 4   | Two weeks of owner use: ≥ 20 approvals from outside home, zero agent-caused hangs                   | [m1-usage.md](m1-usage.md) verdict                                                                                        | [ ]   |
| 5   | Playwright P1–P9 + WebKit smoke green on `main`                                                     | `e2e` run on `main` (`e2e/specs/p1-…` to `p9-…`, `webkit.spec.ts`)                                                        | [ ]   |
| 6   | Release checklist executed once                                                                     | [release-checklist.md](../release-checklist.md) ticked for 0.1.0; link to the release PR                                  | [ ]   |

## Real-CLI checks carried from M1 WPs

| WP     | Check                                                      | Log (section added with the run)             | Holds |
| ------ | ---------------------------------------------------------- | -------------------------------------------- | ----- |
| M1-04b | Session registry, launcher and follow-up with the real CLI | [claude-code-hooks.md](claude-code-hooks.md) | [ ]   |
| M1-05b | Live feed and thin session view with the real CLI          | [claude-code-hooks.md](claude-code-hooks.md) | [ ]   |
| M1-07b | Machines screen and onboarding self-test with the real CLI | [claude-code-hooks.md](claude-code-hooks.md) | [ ]   |

## CI runs

| Workflow   | Commit / tag | Run link | Result |
| ---------- | ------------ | -------- | ------ |
| `ci`       |              |          |        |
| `agent-os` |              |          |        |
| `pg-real`  |              |          |        |
| `e2e`      |              |          |        |
| `release`  |              |          |        |

## Verdict

- [ ] All six criteria and the three real-CLI checks hold — M1 is done.
- Deviations (each with an ADR or a WP):
