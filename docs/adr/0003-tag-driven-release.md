# ADR 0003 — `remotectl` releases are cut by a version tag, not by release-please

Status: proposed (M1-09, 2026-10-13); applies until the owner decides otherwise
Deviates from: M1-09 scope ("release-please manifest") and 06 §5.3 ("Versioning:
release-please manifest mode, Conventional Commits")

## Context

release-please decides what to release, and by how much to bump, by parsing commit
subjects as Conventional Commits (`feat:`, `fix:`, `feat!:`). Commits that do not parse
are ignored. This repository's commit convention is the work-package id
(`M1-09: release pipeline …`), set by the roadmap (§0, `ROADMAP.md`) and the owner's
work rules, so release-please would see no releasable commit and never open a release
PR. Making it work means either changing the commit convention for the whole project or
forcing every release with `release-as`, which is a manual version choice anyway.

The other parts of 06 §5.3 do not depend on release-please: npm trusted publishing
(OIDC, provenance, no token), a single self-contained tarball, no install scripts.

## Decision

- The version is chosen by a person: `pnpm release:version <x.y.z>` rewrites
  `apps/agent/package.json` and `apps/agent/src/version.ts` together (the existing
  `version.test.ts` keeps them equal), and the release PR is titled
  `release: remotectl <x.y.z>` and carries the executed `docs/release-checklist.md`.
- Pushing the tag `remotectl-v<x.y.z>` on the merged commit runs
  `.github/workflows/release.yml`: `pnpm check`, `pnpm pack`, the pre-publish checks in
  `tools/release.ts verify` (tag = version, no install scripts, no runtime
  dependencies, files whitelist, no `src/` exports, no `workspace:` ranges), then
  `npm publish --provenance` through trusted publishing, `npm audit signatures` on the published
  package, then a GitHub release with generated notes.
- Only the agent is published. The relay is deployed by Railway from `main` (06 §5.2);
  `apps/web` ships with the relay; `packages/*` stay private. None of them needs a version
  of its own yet.

## Consequences

- No changelog file. GitHub generates release notes from merged PRs since the previous
  tag; the WP ids in the subjects link each change to the roadmap.
- Bumping is manual, so a wrong bump is possible. The tool refuses a version that is not
  strictly higher, and the workflow refuses a tag that does not match `package.json`.
- If the project later adopts Conventional Commits, release-please can replace
  `tools/release.ts version` without changing `release.yml`'s publish steps.
