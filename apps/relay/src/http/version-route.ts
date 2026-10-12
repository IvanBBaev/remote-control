import { VERSION_TABLE } from '@remote-control/protocol';
import type { FastifyInstance } from 'fastify';

export interface VersionRouteDeps {
  readonly version: string;
  readonly commit: string | null;
}

/** `GET /api/version`: build identity plus the protocol range this relay speaks (D14). */
export function registerVersionRoute(app: FastifyInstance, deps: VersionRouteDeps): void {
  const body = {
    version: deps.version,
    commit: deps.commit,
    protocol: {
      id: VERSION_TABLE.id,
      v: VERSION_TABLE.v,
      minSupported: VERSION_TABLE.min_supported,
    },
  };
  app.get('/api/version', async (_request, reply) =>
    reply.header('cache-control', 'no-store').send(body),
  );
}
