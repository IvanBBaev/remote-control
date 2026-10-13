/** Where the agent reaches the relay, derived from the configured `relay.url` origin. */
export interface RelayEndpoints {
  /** The WebSocket endpoint: `<origin>/ws`. */
  readonly ws: string;
  /** The HTTP API base: `https:` for `wss:`, `http:` for loopback `ws:`. */
  readonly http: string;
  /** `host[:port]`, as the `rc1:` pairing text carries it. */
  readonly host: string;
}

/** Derives the relay's WebSocket and HTTP endpoints from the configured origin. */
export function relayEndpoints(relayUrl: string): RelayEndpoints {
  const url = new URL(relayUrl);
  const secure = url.protocol === 'wss:';
  const ws = new URL('/ws', url);
  const http = new URL('/', url);
  http.protocol = secure ? 'https:' : 'http:';
  return { ws: ws.href, http: http.origin, host: url.host };
}
