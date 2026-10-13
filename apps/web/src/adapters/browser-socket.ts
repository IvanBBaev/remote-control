import type { SocketFactory, SocketLike } from '../realtime/relay-socket.js';

/** The slice of the `WebSocket` constructor the adapter uses. */
export type WebSocketConstructor = new (
  url: string,
) => Pick<WebSocket, 'onopen' | 'onmessage' | 'onclose' | 'onerror' | 'send' | 'close'>;

/** Wraps the browser `WebSocket` in the relay socket's port. */
export function browserSocketFactory(WebSocketImpl: WebSocketConstructor): SocketFactory {
  return (url) => {
    const ws = new WebSocketImpl(url);
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
