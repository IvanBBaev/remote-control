# ADR 0023 — Railway settings move from `railway.json` to `.railway/railway.ts`

Status: accepted (RV-OPS-01, review 06 F1 and F11, 2026-10-31)
Deviates from: nothing. This implements D16 ("settings in `.railway/railway.ts`"), which
the repository had not followed. It also amends ADR 0016, whose staging replica override
lived in `railway.json`.

## Context

The repository recorded its Railway service settings in `railway.json` (Config as Code).
Railway deprecated that format:

- services created after 2026-08-28 ignore the file;
- no service reads it after 2026-12-01.

The production service does not exist yet. It is created on owner day Q2, so the file
would have been ignored from the first deploy. These settings would have been lost
without warning:

- the `/health` gate;
- the pre-deploy migration (D17);
- the restart policy;
- overlap and draining, which keep WebSockets alive across a deploy (I2);
- the watch patterns;
- the staging replica count (ADR 0016).

D16 already named the replacement: Railway's infrastructure as code, a TypeScript file
evaluated by the Railway CLI with the `railway` npm package (`railway/iac`).

## Decision

1. `.railway/railway.ts` declares the project `remote-control` with the environments
   `production` and `staging`, a `postgres` database and the `relay` service. It holds
   the D16 values:
   - Dockerfile build;
   - pre-deploy `node dist/migrate.js`;
   - healthcheck `/health`, 100 s;
   - restart `ON_FAILURE` × 10;
   - Serverless off;
   - overlap 20 s, draining 30 s;
   - region `europe-west4-drams3a`.

   Production runs one replica from `main`. Staging runs two from `staging`, with
   `RC_HUB=pg` (ADR 0016).

2. The watch patterns add the root inputs that F11 found missing:
   - `package.json`, `pnpm-workspace.yaml` (overrides, `minimumReleaseAge`);
   - `.nvmrc`, `.dockerignore`;
   - the config itself.
3. The file holds no secret. `RC_DATABASE_URL` is a reference to the database. Every
   other secret or per-environment value is declared `preserve()`, so `apply` keeps the
   value already set in Railway.
4. `railway.json` is deleted now, not after the link. No service reads it, so keeping it
   would only leave two sources of truth.
5. `railway@3.16.0` is a root dev dependency. The CLI needs it to evaluate the file, and
   `tools/railway-config.test.ts` imports the file and asserts the values. The relay
   image does not ship it, because `pnpm deploy --prod` drops dev dependencies.
6. On day Q2, after `railway link`:
   - `railway config plan`, which is read-only;
   - review it. It must not delete a variable or a resource;
   - `railway config apply`.

   A later change to the file follows the same plan-then-apply steps.

## Consequences

- A change to deploy behaviour is a reviewed diff with a test, not a dashboard click.
  The dashboard is no longer the source of truth for these values.
- A Railway DSL change can break evaluation. The test catches that on the next
  dependency bump, because Dependabot groups `railway` like any other dev dependency.
- Railway's docs do not say how `apply` treats variables and resources the file does not
  declare, or whether it creates a missing environment. They say database provisioning
  is handled by Railway product workflows. So the first plan on day Q2 is the check. It
  must not delete an undeclared variable, such as `RC_LOG_LEVEL` or
  `RC_TRUST_PROXY_HOPS`.
- The owner creates the environments and databases, as the runbook says, and sets the
  preserved variables in the dashboard before the first deploy, as the runbook and
  `.env.example` list them.

## Rejected

- **Set the values in the dashboard and document them.** They drift, and nothing can
  check them.
- **Keep `railway.json`.** New services ignore it.
- **Generate the file with `railway config migrate`.** It needs a linked project, and the
  project does not exist yet. Writing the file by hand gives the same result.
