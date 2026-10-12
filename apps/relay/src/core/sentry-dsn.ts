export interface SentryDsn {
  /** The DSN as configured (it goes into the envelope header). */
  readonly dsn: string;
  /** The project's public key (the DSN's user part); not a secret, but not logged either. */
  readonly publicKey: string;
  /** `https://<host>/api/<project>/envelope/`. */
  readonly envelopeUrl: string;
}

/** Parses `https://<key>@<host>[/<path>]/<project id>`; `null` when it is not a DSN. */
export function parseSentryDsn(dsn: string): SentryDsn | null {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return null;
  }
  const match = /^(.*)\/(\d+)\/?$/.exec(url.pathname);
  if (url.protocol !== 'https:' || url.username === '' || url.password !== '' || !match) {
    return null;
  }
  const [, prefix = '', projectId = ''] = match;
  return {
    dsn,
    publicKey: url.username,
    envelopeUrl: `${url.origin}${prefix}/api/${projectId}/envelope/`,
  };
}
