import WebSocket from 'ws';

/** A frame as the test peer received it (parsed JSON). */
export type ReceivedFrame = Record<string, unknown> & { readonly kind: string };

export interface CloseEvent {
  readonly code: number;
  readonly reason: string;
}

/**
 * A real `ws` client for relay tests: queues incoming frames so a test can await the
 * next one of a kind, and records how the socket closed.
 */
export class WsPeer {
  readonly frames: ReceivedFrame[] = [];
  readonly closed: Promise<CloseEvent>;
  pings = 0;
  readonly #waiters: {
    readonly match: (frame: ReceivedFrame) => boolean;
    readonly resolve: (frame: ReceivedFrame) => void;
  }[] = [];

  private constructor(readonly socket: WebSocket) {
    socket.on('message', (data: Buffer) => {
      const frame = JSON.parse(data.toString('utf8')) as ReceivedFrame;
      const index = this.#waiters.findIndex((waiter) => waiter.match(frame));
      if (index === -1) {
        this.frames.push(frame);
        return;
      }
      const [waiter] = this.#waiters.splice(index, 1);
      waiter?.resolve(frame);
    });
    socket.on('ping', () => (this.pings += 1));
    this.closed = new Promise((resolve) => {
      socket.on('close', (code, reason) => resolve({ code, reason: reason.toString('utf8') }));
    });
  }

  /** Opens a socket and waits until the relay accepted the upgrade. */
  static open(
    url: string,
    headers: Record<string, string>,
    options: { autoPong?: boolean } = {},
  ): Promise<WsPeer> {
    const socket = new WebSocket(url, { headers, autoPong: options.autoPong ?? true });
    const peer = new WsPeer(socket);
    return new Promise((resolve, reject) => {
      socket.once('open', () => resolve(peer));
      socket.once('error', reject);
    });
  }

  /** The HTTP status the relay answered an upgrade attempt with. */
  static rejection(url: string, headers: Record<string, string>): Promise<number> {
    const socket = new WebSocket(url, { headers });
    return new Promise((resolve, reject) => {
      socket.once('unexpected-response', (request, response) => {
        resolve(response.statusCode ?? 0);
        request.destroy();
      });
      socket.once('open', () => {
        socket.terminate();
        reject(new Error('upgrade was accepted'));
      });
      socket.on('error', () => undefined);
    });
  }

  send(frame: unknown): void {
    this.socket.send(typeof frame === 'string' ? frame : JSON.stringify(frame));
  }

  /** The next frame of `kind` (already received or still to come). */
  next(
    kind: string,
    match: (frame: ReceivedFrame) => boolean = () => true,
  ): Promise<ReceivedFrame> {
    const matches = (frame: ReceivedFrame) => frame.kind === kind && match(frame);
    const index = this.frames.findIndex(matches);
    if (index !== -1) return Promise.resolve(this.frames.splice(index, 1)[0] as ReceivedFrame);
    return new Promise((resolve) => this.#waiters.push({ match: matches, resolve }));
  }

  /** Sends `hello` and resolves with `hello_ok`. */
  async hello(kind: 'phone' | 'agent'): Promise<ReceivedFrame> {
    this.send({
      v: 1,
      kind: 'hello',
      protocol: { min: 1, max: 1 },
      client: { kind, version: '0.0.0' },
    });
    return this.next('hello_ok');
  }

  /** Waits for a ping/pong round trip, so every frame sent before it has been handled. */
  async sync(t = 1): Promise<void> {
    this.send({ v: 1, kind: 'ping', t });
    await this.next('pong', (frame) => frame.t === t);
  }

  close(): void {
    this.socket.close();
  }
}
