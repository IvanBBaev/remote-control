/** Callbacks of one WebSocket connection; text messages only (D14). */
export interface WebSocketHandlers {
  onOpen(): void;
  onMessage(text: string): void;
  /** Called exactly once, also when the connection never opened. */
  onClose(code: number, reason: string): void;
}

export interface WebSocketConnection {
  send(text: string): void;
  close(code?: number, reason?: string): void;
}

/** Opens an outbound WebSocket with the given request headers (the relay's bearer auth). */
export type WebSocketFactory = (
  url: string,
  headers: Readonly<Record<string, string>>,
  handlers: WebSocketHandlers,
) => WebSocketConnection;
