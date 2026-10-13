import { describe, expect, it, vi } from 'vitest';

import { browserSocketFactory } from './browser-socket.js';
import type { WebSocketConstructor } from './browser-socket.js';

describe('browserSocketFactory', () => {
  it('forwards events and calls to the browser socket', () => {
    const created: { url: string; ws: InstanceType<WebSocketConstructor> }[] = [];
    class FakeWebSocket {
      onopen: WebSocket['onopen'] = null;
      onmessage: WebSocket['onmessage'] = null;
      onclose: WebSocket['onclose'] = null;
      onerror: WebSocket['onerror'] = null;
      send = vi.fn();
      close = vi.fn();
      constructor(url: string) {
        created.push({ url, ws: this });
      }
    }
    const socket = browserSocketFactory(FakeWebSocket)('wss://rc.example.test/ws');
    const ws = created[0]?.ws as unknown as FakeWebSocket;
    expect(created[0]?.url).toBe('wss://rc.example.test/ws');

    // Before the client attaches handlers, events are dropped.
    ws.onopen?.call(ws as unknown as WebSocket, new Event('open'));

    const seen: string[] = [];
    socket.onopen = () => seen.push('open');
    socket.onmessage = (event) => seen.push(`message ${String(event.data)}`);
    socket.onclose = () => seen.push('close');
    socket.onerror = () => seen.push('error');
    const self = ws as unknown as WebSocket;
    ws.onopen?.call(self, new Event('open'));
    ws.onmessage?.call(self, new MessageEvent('message', { data: 'hi' }));
    ws.onerror?.call(self, new Event('error'));
    ws.onclose?.call(self, new Event('close') as CloseEvent);
    expect(seen).toEqual(['open', 'message hi', 'error', 'close']);

    socket.send('frame');
    socket.close(1000, 'bye');
    expect(ws.send).toHaveBeenCalledWith('frame');
    expect(ws.close).toHaveBeenCalledWith(1000, 'bye');
  });
});
