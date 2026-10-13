import type { WebSocketFactory } from '../ports/web-socket.js';

/**
 * `WebSocketFactory` over Node 22's global `WebSocket` (undici; no runtime dependency,
 * D13). Binary messages are ignored: the relay protocol is text only (D14). Sending on a
 * socket that is not open is a no-op; `onClose` fires exactly once, with 1006 for an
 * error (including a refused upgrade).
 */
export const nodeWebSocket: WebSocketFactory = (url, headers, handlers) => {
  const socket = new WebSocket(url, { headers: { ...headers } });
  let closed = false;
  const finish = (code: number, reason: string): void => {
    if (closed) return;
    closed = true;
    handlers.onClose(code, reason);
  };
  socket.addEventListener('open', () => handlers.onOpen());
  socket.addEventListener('message', (event: MessageEvent) => {
    if (!closed && typeof event.data === 'string') handlers.onMessage(event.data);
  });
  // A failed opening handshake fires `error` without a `close` event (undici).
  socket.addEventListener('error', () => finish(1006, ''));
  socket.addEventListener('close', (event) => finish(event.code, event.reason));
  return {
    send(text) {
      if (socket.readyState === WebSocket.OPEN) socket.send(text);
    },
    close(code, reason) {
      try {
        socket.close(code, reason);
      } catch {
        // An invalid code or reason: close without them.
        socket.close();
      }
    },
  };
};
