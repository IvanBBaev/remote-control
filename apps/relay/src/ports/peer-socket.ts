/** The transport side of one WebSocket, as the relay core drives it (`ws` in production). */
export interface PeerSocket {
  /** Outbound bytes queued in the socket and not yet written. */
  readonly bufferedAmount: number;
  send(text: string): void;
  close(code: number, reason: string): void;
  /** Destroys the connection without a closing handshake. */
  terminate(): void;
  /** Sends a protocol-level ping; any pong counts as activity. */
  ping(): void;
}
