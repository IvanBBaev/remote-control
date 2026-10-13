import { describe, expect, it } from 'vitest';

import { relayEndpoints } from './relay-url.js';

describe('relayEndpoints', () => {
  it('maps wss to https', () => {
    expect(relayEndpoints('wss://relay.example.com/')).toEqual({
      ws: 'wss://relay.example.com/ws',
      http: 'https://relay.example.com',
      host: 'relay.example.com',
    });
  });

  it('maps loopback ws to http and keeps the port', () => {
    expect(relayEndpoints('ws://127.0.0.1:8080')).toEqual({
      ws: 'ws://127.0.0.1:8080/ws',
      http: 'http://127.0.0.1:8080',
      host: '127.0.0.1:8080',
    });
  });
});
