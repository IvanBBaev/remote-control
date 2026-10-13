# Release checklist — `remotectl`

How a version of the home agent is cut and published (M1-09, ADR 0003). Copy the
checklist below into the release PR description and tick every item before merging.
Manual test plan from `docs/analysis/reports/07-qa.md` §5.14.

## One-time setup (owner)

- [ ] `remotectl` on npmjs.com is owned by the owner's account (placeholder `0.0.1`, M0-27).
- [ ] Package settings → **Trusted publisher**: GitHub Actions, repository
      `IvanBBaev/remote-control`, workflow `release.yml`, no environment.
- [ ] Package settings → Publishing access: **Require two-factor authentication and
      disallow tokens**. No npm token exists in GitHub secrets.
- [ ] Tag protection: only the owner can push `remotectl-v*` tags.

## Cut a release

1. On a branch from `main`: `pnpm release:version <x.y.z>` (refuses anything not
   strictly higher than the current version), then `pnpm check`.
2. Commit `release: remotectl <x.y.z>` and open the PR with the checklist below.
3. Run the manual checks, tick them in the PR, merge when `ci` is green.
4. On the merged commit of `main`:
   `git tag remotectl-v<x.y.z> && git push origin remotectl-v<x.y.z>`.
5. Watch the **Release** workflow: checks, pack, verify, publish, `npm audit signatures`,
   GitHub release. A failure before "Publish to npm" leaves nothing published; delete the
   tag, fix, and tag again.
6. `npm view remotectl@<x.y.z>` shows the version; the npm page shows the provenance
   badge linking to the workflow run.

A published version cannot be republished. To withdraw one: `npm deprecate
remotectl@<x.y.z> "<reason>"` and release a fixed patch version.

## Release PR checklist

```markdown
- [ ] Fixtures: `claude --version` recorded; recorder session run, anonymised
      (`pnpm fixtures:anonymise`), key sets diffed against committed fixtures; fixtures and
      `packages/fake-claude-code` updated if anything changed.
- [ ] Agent install: `npm install -g remotectl@<x.y.z>` on macOS, Windows and Linux;
      `remotectl hooks install`; `remotectl install`; the service survives a reboot;
      `remotectl uninstall` leaves no files.
- [ ] Real Claude Code: a Bash permission request reaches the phone as a push with the
      screen locked (iPhone and Android); the tap opens the request; Face ID / fingerprint
      on Allow; Claude continues.
- [ ] `AskUserQuestion` answered from the phone; one request denied; one request left to
      expire (Claude falls back to the terminal prompt).
- [ ] Connectivity: phone on mobile data, computer at home; the agent reconnects after a
      Wi-Fi drop; a WebSocket idle for more than 10 minutes through Railway stays up.
- [ ] Sessions: list, steps, diff and last turn match the terminal; a new instruction
      lands; a new session starts in an allow-listed repo and is refused outside it.
- [ ] Security: revoking a phone stops its frames; a second phone pairs; the lost-phone
      flow works.
- [ ] Privacy: the canary planted in a test prompt appears in neither the Railway logs
      nor a `pg_dump` of the relay database.
- [ ] Railway: deploy from `main`, migrations applied, `/health` green, cost page
      checked (docs/ops/runbook.md "Cost check").
```

Items for features that do not exist yet in this version are marked "n/a (WP id)"
instead of being ticked.
