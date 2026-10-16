# M0 exit record

Exit record for **M0 — Walking skeleton** (ROADMAP §3, §4 "M0 exit record"): the owner,
away from home, allows or denies one real Claude Code permission request from the phone,
end-to-end encrypted, with a push notification.

**Status: pending the owner** — needs the deployed relay (M0-02b), the device spike
(M0-03b), the first push with green CI (PUSH), the real-CLI runs (M0-23b) and the npm
placeholder (M0-27b).

## Real approval from outside home

The phone is on a network other than the Mac's (mobile data, or Wi-Fi away from home);
the Mac runs the installed agent, not a dev build.

| Field                                       | Value |
| ------------------------------------------- | ----- |
| Date and time                               |       |
| Phone network (mobile data / other Wi-Fi)   |       |
| Phone, OS version, browser                  |       |
| Mac, macOS version, Node                    |       |
| `claude --version`                          |       |
| `remotectl --version`                       |       |
| Request (tool label shown on the card)      |       |
| Reached the phone by push (yes/no)          |       |
| Decision (allow/deny) and seconds to decide |       |
| Claude Code continued as decided (yes/no)   |       |

## Exit criteria

| #   | Criterion (ROADMAP §3 M0)                                                                          | Evidence                                                                                                                    | Holds |
| --- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----- |
| 1   | Device spike says GO                                                                               | [device-spike.md](device-spike.md) verdict                                                                                  | [ ]   |
| 2   | Relay live at the production domain on Railway Hobby, deployed by CI                               | `curl -fsS https://<domain>/health`; link to the deploy of the commit below                                                 | [ ]   |
| 3   | `remotectl` installed via `npx` on the owner's Mac, kept alive by launchd                          | `remotectl status` shows the service loaded; it is still running after a reboot                                             | [ ]   |
| 4   | J1, J2, J3, J5, J6, J7 green in CI on three OSes; privacy gate green; coverage thresholds enforced | `ci` and `agent-os` runs of the commit below (`packages/test-harness/src/journeys/`, `privacy-gate.test.ts`)                | [ ]   |
| 5   | A real request held ≥ 11 min and decided from the phone, Claude Code version noted                 | [claude-code-hooks.md](claude-code-hooks.md) results (`A2`, `A3`, `version`)                                                | [ ]   |
| 6   | SECURITY.md published; no message table in the schema                                              | [SECURITY.md](../../SECURITY.md); `apps/relay/src/db/schema.test.ts` and `migrator.pg-real.test.ts` green in the runs below | [ ]   |

## CI runs

| Workflow   | Commit | Run link | Result |
| ---------- | ------ | -------- | ------ |
| `ci`       |        |          |        |
| `agent-os` |        |          |        |
| `pg-real`  |        |          |        |
| `image`    |        |          |        |

## Verdict

- [ ] All six criteria hold and the real approval above succeeded — M0 is done.
- Deviations (each with an ADR or a WP):
