# ADR 0011 — Node 24 for the relay image and CI, Node 22 kept as the user floor

Status: accepted (M3 backlog item "Node 24 image + CI", 2026-10-14)
Deviates from: ROADMAP §2 pins ("`.nvmrc` 22; image/CI to Node 24 in H1 2027") — done
earlier than planned, at the owner's request.

## Context

Node 22 is in maintenance and reaches end of life on 2027-04-30 (06 R9, W21). The relay
runs only inside our image, so its Node version is ours to choose. `remotectl` runs on
the user's own Node, so its floor is a promise to users (`engines.node >=22`).

## Decision

- **Image.** The relay image moves to `node:24-bookworm-slim`, pinned by digest (Node
  24.21.0). The relay bundle targets `node24`.
- **Repository Node.** `.nvmrc` moves to 24, so the `ci`, `e2e`, `pg-real` and
  `release` workflows run on Node 24.
- **User floor unchanged.** `engines.node` stays `>=22`, the agent bundle keeps the
  `node22` target and `@types/node` stays on 22, so the code cannot use APIs that Node 22
  lacks. The `agent-os-matrix` job runs on Node 22 and 24 on every OS, so the floor stays
  tested until Node 22's end of life.
- **Release.** Node 24 ships npm 11 (≥ 11.5.1, as trusted publishing requires), so the
  `npm install -g npm@11` step is replaced by a version check.

## Consequences

- The `agent-os-matrix` job count doubles (6 instead of 3) and its check names gain the
  Node version (`agent-os (<os>, node <n>)`). Required status checks in branch protection,
  if any name the old checks, must be updated by the owner.
- Dropping Node 22 for users is a separate decision, due before 2027-04-30: raise
  `engines`, the agent target and `@types/node` together and remove `22` from the matrix.
