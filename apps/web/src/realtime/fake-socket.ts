import { encodeFrame, parseFrame, VERSION_TABLE } from '@remote-control/protocol';
import type { Frame, PresenceEntry } from '@remote-control/protocol';

import type { SocketLike } from './relay-socket.js';

/** A scripted socket for unit tests: the test plays the relay. */
export class FakeSocket implements SocketLike {
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  readonly sent: Frame[] = [];
  closed: { code?: number; reason?: string } | undefined;

  constructor(readonly url: string) {}

  send(data: string): void {
    const parsed = parseFrame(data);
    if (!parsed.ok) throw new Error(`fake socket: bad frame ${data}`);
    this.sent.push(parsed.frame);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }

  open(): void {
    this.onopen?.({});
  }

  receive(frame: Frame | string): void {
    this.onmessage?.({ data: typeof frame === 'string' ? frame : encodeFrame(frame) });
  }

  helloOk(deviceId: string, relayTs: number, presence: PresenceEntry[] = []): void {
    this.receive({
      v: VERSION_TABLE.v,
      kind: 'hello_ok',
      protocol: 1,
      min_supported: 1,
      deviceId,
      relayTs,
      presence,
    });
  }

  of<K extends Frame['kind']>(kind: K): Extract<Frame, { kind: K }>[] {
    return this.sent.filter((frame): frame is Extract<Frame, { kind: K }> => frame.kind === kind);
  }
}

/** A socket factory that remembers every socket it made. */
export function fakeSockets(): {
  create: (url: string) => FakeSocket;
  all: FakeSocket[];
  readonly last: FakeSocket;
} {
  const all: FakeSocket[] = [];
  return {
    all,
    create: (url) => {
      const socket = new FakeSocket(url);
      all.push(socket);
      return socket;
    },
    get last() {
      const socket = all.at(-1);
      if (socket === undefined) throw new Error('fake socket: none created');
      return socket;
    },
  };
}
