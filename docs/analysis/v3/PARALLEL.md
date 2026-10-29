# v3 — parallel lanes and branch rules

Status: 2026-10-28. Companion to `ROADMAP-v3.md`. Goal: several sessions (or people) work
on v3 items at the same time, each in its own branch, without editing the same lines and
without blocking each other. Rules here bind every v3 branch; the execution rules of
`docs/analysis/ROADMAP.md` §0 and §5 still apply.

## 1. Branch protocol (one item = one branch)
1. **Claim on main first.** Set the item's status in `ROADMAP-v3.md` to `doing <lane>` in a
   commit on `main` touching only that file. An item already `doing` is taken — pick another.
2. **Worktree:** `git worktree add ~/Development/_branches/remote-control-<item-id> -b v3/<lane>/<item-id>`
   (e.g. `v3/sec-cards/V3-S03`). Never one long-lived branch per lane.
3. **Stay inside your lane's paths** (§2). Touching a path another lane owns, or a hotspot
   (§3) outside its rule, means: stop, finish or split the item, or ask.
4. **Before merge:** `git rebase main`, regenerate generated files (§3), `pnpm check` green
   on the rebased tip, AC verified.
5. **Merge:** `git checkout main && git merge --ff-only v3/<lane>/<item-id>`, then a separate
   `main` commit setting the status to `done <sha>`. Remove the worktree, `git branch -d`.
   No push unless the owner asks.
6. **Keep branches short** (one item, ideally < 1 day). Rebase on `main` at least after
   every merge that touched a hotspot your branch also touches.

## 2. Lanes and path ownership
A lane owns its paths exclusively while any of its items is `doing`. New directories are
the cheapest way to stay conflict-free: put new code in a new module, not in an existing file.

| Lane | Items (in order) | Owns (exclusive) | Must not touch |
|---|---|---|---|
| `sec-cards` | V3-S03 → V3-S03b → V3-S03c → V3-S03d → V3-S13 | new `packages/phone-core/src/card-safety/**`; card rendering: `apps/web/src/screens/{approval,question}.tsx`, `apps/mobile/src/ui/cards.tsx`; `SECURITY.md`; for the S03 follow-ups also `packages/protocol/src/hidden-characters.ts` (new), `apps/agent/src/core/push-summary.ts`, `apps/mobile/targets/notification-service/**`, `apps/mobile/src/core/{realtime-inbox,inbox,widget-snapshot}.ts` | relay; agent and protocol outside the files listed |
| `evidence` | V3-P02, V3-P03 → V3-P01, V3-P06 → V3-P08 | `apps/agent/src/cli/stats.ts` (new), `apps/agent/src/core/usage-stats.ts`, `apps/agent/src/adapters/file-stats-store.ts`; `docs/analysis/v3/gates.md` (new); `tools/vendor-watch*`; `README.md` (P06 only) | protocol, phone UI |
| `version-gate` | V3-C12 → V3-C13 | `packages/protocol/src/negotiate-version.ts`, new `packages/protocol/src/upgrade-required.ts`; `apps/relay/src/ws/**` handshake; `.github/workflows/ci.yml` | cards, agent core |
| `push-gateway` | V3-C01 → V3-C04, V3-C02 → V3-C16 → V3-C03 | `apps/push-gateway/**` (new app); `apps/relay/src/adapters/gateway-push-sender*.ts` (new); `docs/ops/push-gateway.md` (new) | `apps/relay/src/ports/push.ts` signature (implement it, do not change it) |
| `requester` | V3-A02 (ADR) → V3-A03 → V3-A04 → V3-A05, V3-S05 → gated V3-A08+V3-S06 | `packages/decision-verify/**` (new); while V3-A03 is open also `apps/agent/src/core/{decision-check,device-signature-check,assertion-check}.ts`; `apps/agent/src/requester/**` (new); `apps/agent/src/cli/{approve,clients,mcp}.ts` (new); `packages/protocol/src/requester.ts` (new) | cards, launcher |
| `rules` | V3-S01 (ADR) → V3-S02 → V3-S04, V3-P07 | `apps/agent/src/core/rules/**` (new); `apps/agent/src/core/session-rules.ts`; `apps/agent/src/cli/rules.ts` (new); `packages/protocol/src/standing-rule.ts` (new); rule screens `apps/web/src/screens/rules*.tsx`, `apps/mobile/src/app/rules*` (new) | decision-verify internals (consume its API) |
| `claude-surface` | V3-A06 → V3-A01 (spike) → V3-S09 → V3-A07, V3-A09 | `apps/agent/src/adapters/claude-code/**`; `apps/agent/src/core/hooks-installer.ts`; `apps/agent/src/core/launcher.ts`, `apps/agent/src/argv-policy.test.ts` (A09 only); `packages/protocol/src/elicitation.ts` (new); elicitation card `apps/*/…/elicitation*.tsx` (new) | existing card files (add a new card component instead) |
| `clients` | V3-C15, V3-A10, V3-C14 → gated V3-C11 | `apps/web/public/**` (manifest, icons); `apps/mobile/src/ui/composer.tsx`; `.github/workflows/mobile-release.yml` (new); `docs/verification/{desktop-pwa,watch-deny,dictation}.md` (new) | protocol, relay |
| `adapters` | V3-A11 (spike) → gated V3-A12 | `apps/agent/src/adapters/copilot/**` (new); `docs/verification/copilot-*.md` (new) | other adapters |
| `android` (gated Q-V3-7) | V3-C05 → … → V3-C10 | `apps/mobile/android/**`, `apps/mobile/modules/*-android/**`, Android branch of `apps/mobile/src/adapters/device-signer.ts` | iOS targets |
| `org` (branch A, gated Q-V3-8) | Phase E | decided when the gate opens | — |

Only one item per lane is `doing` at a time; several lanes run in parallel.

## 3. Shared hotspots — the only files several lanes may edit
| File / area | Rule |
|---|---|
| `packages/protocol/src/messages.ts`, `packages/protocol/src/index.ts` | **Append-only.** New schemas live in the lane's own file (§2); here only one import, one union member, one export line, added at the end of the list. A conflict is resolved by keeping both sides. |
| `apps/agent/src/cli/main.ts` | Only a dispatch branch of ≤ 3 lines per new command; the command body lives in `apps/agent/src/cli/<command>.ts`. |
| `apps/{agent,relay}/src/container.ts` | One wiring block per lane, appended; no reordering or refactors. |
| `apps/agent/src/core/parse-config.ts`, `default-config-text.ts` | Each lane adds only its reserved top-level key (§4) and its own parser module. |
| `apps/relay/drizzle/**` | Generated **last, after the final rebase**. If `main` gained a migration meanwhile, delete yours plus its `meta/` entry and regenerate. Never hand-merge `_journal.json`. |
| `pnpm-lock.yaml` | Never hand-merge: take `main`'s file, run `pnpm install`, commit the result. |
| `docs/adr/` | Use only the numbers reserved in §4. |
| `docs/analysis/v3/ROADMAP-v3.md` | Status cells only, only on `main`, never inside an item branch. |
| `SECURITY.md`, `README.md`, `.github/workflows/ci.yml` | Owned by `sec-cards`, `evidence`, `version-gate` respectively. Other lanes put the text they need in their commit body under `SECURITY note:` / `README note:`; the owning lane folds it in. New CI jobs go in new workflow files. |

## 4. Reserved names (decided here so lanes never collide)
| Kind | Reservation |
|---|---|
| ADR numbers | 0018 standing rules (V3-S01) · 0019 requester peer (V3-A02) · 0020 push-gateway contract (V3-C01) · 0021 cloud-session mode (V3-S09) · 0022 version gate and skew policy (V3-C12, only if needed) · 0023+ first come, after these |
| Protocol `t` values | `upgrade_required` (version-gate) · `requester_request`, `requester_result` (requester) · `rule_grant`, `rule_revoke`, `rule_used` (rules) · `elicitation`, `elicitation_answer` (claude-surface) |
| Agent config keys | `requesters:` · `rules:` · `notify:` (exceptions preset, rules lane) · `cloud:` · `stats:` |
| CLI commands | `remotectl stats` · `approve` · `clients` · `pair --role requester` · `mcp` · `rules` · `init-hook --cloud` |
| `remotectl approve` exit codes | 0 allow · 1 deny · 2 timeout · 3 error (V3-A04) |
| Relay env vars | `RC_PUSH_GATEWAY_URL`, `RC_PUSH_GATEWAY_KEY` (push-gateway); gateway's own vars use `GW_*` |
| New packages/apps | `packages/decision-verify` (`@remote-control/decision-verify`), `apps/push-gateway` (`@remote-control/push-gateway`) |

A lane that needs a name not in this table adds it here in its claim commit on `main`.

## 5. Sync points (the only cross-lane waits)
| # | Before … | … this must be `done` on `main` |
|---|---|---|
| P1 | any other lane changes how a card renders (V3-A06 phone part, V3-S02 rule UI, V3-P07) | V3-S03 |
| P2 | V3-S02, V3-S05 | V3-A03 (verifier extracted; consume `@remote-control/decision-verify`) |
| P3 | merging any item that adds a protocol `t` value | V3-C12 (old clients must get `upgrade_required`, not a parse error) |
| P4 | V3-C02, V3-C04, Android V3-C07 | V3-C01 |
| P5 | code that implements an ADR (V3-S02, V3-A03…A05, V3-S09) | that ADR `Accepted` by the owner |
| P6 | V3-A08/V3-S06, V3-P07 | V-G2 recorded in `gates.md` (V3-P03) / V3-P02 data |

Everything not listed can start as soon as its own lane deps are met.

## 6. Shared local resources
- Tests never bind fixed ports or real time (ROADMAP §5); parallel `pnpm check` runs must
  not interfere.
- Manual dev stacks per worktree: relay `RC_PORT=32<n>0` and Postgres container
  `rc-<lane>-pg`, where `<n>` is the lane's row number in §2 (sec-cards = 1 … adapters = 9).
- The iOS simulator, the paired real phone and the local `remotectl` service are single
  shared resources: one lane uses them at a time; note the use in `WORKLOG.md`.

## 7. Start set (wave 1 — no cross-lane waits)
V3-S03 (sec-cards) · V3-P02, V3-P03 (evidence) · V3-C12 (version-gate) · V3-A02 ADR
(requester) · V3-S01 ADR (rules) · V3-A06 agent side (claude-surface) · V3-C15, V3-A10
(clients) · V3-A11 spike (adapters). V3-C01 (push-gateway) starts once M4-05 is `done`.
