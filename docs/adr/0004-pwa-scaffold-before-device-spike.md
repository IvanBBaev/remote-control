# ADR 0004 — PWA scaffold before the device spike

Status: accepted (owner, 2026-10-13), M0-18
Deviates from: ROADMAP §4 dependency order (M0-18 depends on M0-03)

## Context

M0-18 (PWA scaffold, capability probe, onboarding gate, theming) lists M0-03 as a
dependency. M0-03 is the device feasibility spike: it needs a throwaway page on the
production domain, so passkeys bind to the final RP ID. The production domain comes from
M0-02, and M0-02 waits for the owner to buy it (§6 Q2). M0-02 and therefore M0-03 are
blocked, while M0-05 and M0-06 (the other M0-18 dependencies) are done.

Most of M0-18 does not depend on what the spike finds: the build setup, the route table,
the capability probe, the onboarding gate as a pure function, the theme and the screen
inventory are the same whatever the devices report. The owner approved starting M0-18
ahead of M0-03.

## Decision

- Build the M0-18 scaffold now as code plus unit tests: Vite 8 + React 19 +
  `vite-plugin-pwa` (injectManifest), the manifest and icons, the routes, the capability
  probe with the "update your browser" and "install first" screens, the onboarding gate,
  theming and `docs/product/screens.md`.
- The AC "Lighthouse PWA installability passes on the deployed build" stays open until
  M0-02 deploys. In its place, `apps/web` checks after every `vite build` that the
  manifest and the service worker are emitted with the installability fields
  (`apps/web/scripts/check-build.mjs`, part of `pnpm check`).
- Any change the M0-03 result implies (for example a different standalone check, a
  different install copy, or another capability in the probe) follows after M0-03 as a
  change to this scaffold.

## Consequences

- M0-18 can be reviewed and merged while M0-02 waits for the domain. Its status stays
  short of `done` until the Lighthouse check runs on the deployed build.
- A NO-GO in M0-03 on push or user verification still triggers the ROADMAP stop (native
  wrapper or scope change). That decision may discard part of this work, most likely the
  install and notification steps of the onboarding gate and the service worker.
- The probe encodes the platform assumptions from report 05 (iOS exposes `PushManager`
  only to Home Screen apps; an installed iOS app reports `display-mode: fullscreen`).
  M0-03 is where those assumptions are confirmed on real devices.
