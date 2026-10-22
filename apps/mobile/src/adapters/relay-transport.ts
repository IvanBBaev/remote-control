import type { FetchLike } from '@remote-control/phone-core/auth/relay-api';
import type { SocketFactory, SocketLike } from '@remote-control/phone-core/realtime/relay-socket';

/** Where the app reaches its relay and the session it signs in with. */
export interface RelayConnection {
  /** The relay's origin, e.g. `http://localhost:3200`. */
  readonly origin: string;
  /** The `__Host-rc_session` cookie value. */
  readonly token: string;
}

/**
 * The headers a browser on the relay's origin would send by itself. The relay's origin
 * guard (D8) reads `Origin`; the session travels in the same cookie the PWA uses. Native
 * code has no ambient origin or cookie jar, so both are set explicitly here.
 */
function sessionHeaders({ origin, token }: RelayConnection): Record<string, string> {
  return { origin, cookie: `__Host-rc_session=${token}` };
}

/** `fetch` against the relay with the session attached; the shared cookie jar is unused. */
export function relayFetch(connection: RelayConnection): FetchLike {
  return (input, init) =>
    fetch(`${connection.origin}${input}`, {
      ...init,
      credentials: 'omit',
      headers: { ...(init.headers as Record<string, string>), ...sessionHeaders(connection) },
    });
}

/** The relay's `/ws` URL for `origin`. */
export function relaySocketUrl(origin: string): string {
  const url = new URL(origin);
  return `${url.protocol === 'https:' ? 'wss' : 'ws'}://${url.host}/ws`;
}

/** React Native's `WebSocket`, which takes upgrade headers as a third argument. */
type NativeWebSocket = new (
  url: string,
  protocols: string | string[] | null,
  options: { headers: Record<string, string> },
) => Pick<WebSocket, 'onopen' | 'onmessage' | 'onclose' | 'onerror' | 'send' | 'close'>;

/** Wraps React Native's `WebSocket` in the relay socket's port, session attached. */
export function nativeSocketFactory(connection: RelayConnection): SocketFactory {
  const NativeSocket = WebSocket as unknown as NativeWebSocket;
  return (url) => {
    const ws = new NativeSocket(url, null, { headers: sessionHeaders(connection) });
    const socket: SocketLike = {
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: (data) => {
        ws.send(data);
      },
      close: (code, reason) => {
        ws.close(code, reason);
      },
    };
    ws.onopen = (event) => socket.onopen?.(event);
    ws.onmessage = (event) => socket.onmessage?.(event);
    ws.onclose = (event) => socket.onclose?.(event);
    ws.onerror = (event) => socket.onerror?.(event);
    return socket;
  };
}
