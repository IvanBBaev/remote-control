import { deriveNotificationKey, openPushSummary } from '@remote-control/crypto';
import { decodePushSummary } from '@remote-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { createCanaries } from '../canaries.js';
import { eventually } from '../eventually.js';
import { scenario, type Scenario } from '../scenario.js';
import { decisionResult, JOURNEY, nextRequest, permissionRequest } from './fixtures.js';

describe('J7 — the phone is offline: push, reconnect, decide (M0-22)', () => {
  let running: Scenario | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it(
    'rings the phone with metadata only and re-sends the request on reconnect',
    JOURNEY,
    async () => {
      running = await scenario({ canaries: createCanaries('CANARY') });
      const { phone, agent, relay, canaries } = running;

      phone.disconnect();
      // The relay must have dropped the socket before the request, or it would deliver it.
      await eventually(
        () =>
          relay.logs().some((line) => line.includes('"ws_close"') && line.includes(phone.deviceId)),
        'relay: phone still online',
      );
      const hook = agent.fire(permissionRequest(canaries));

      await eventually(() => relay.push.received.length > 0, 'no push');
      const [push] = relay.push.received;
      expect(push!.rejected).toBeNull();
      expect(JSON.parse(push!.plaintext!)).toEqual({
        t: 'pending',
        rid: expect.any(String) as unknown,
        dev: 'harness-agent',
        exp: expect.any(Number) as unknown,
        sum: expect.any(String) as unknown,
      });
      expect(phone.of('request')).toEqual([]);

      await phone.connect();
      await phone.handshake(running.agentDeviceId, running.agentPublicKey);
      const { request } = await nextRequest(phone);
      expect(phone.of('request')).toHaveLength(1);
      expect(phone.of('snapshot').at(-1)).toMatchObject({ pending: [request.id] });

      await phone.decide('allow', request);
      expect(await decisionResult(phone, request.id)).toMatchObject({ result: 'accepted' });
      expect((await hook).output).toEqual({
        hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
      });

      await running.assertNoLeaks();
    },
  );

  it(
    'puts only ciphertext in the push: the summary opens on the phone alone (M1-06)',
    JOURNEY,
    async () => {
      running = await scenario({ canaries: createCanaries('CANARY') });
      const { phone, agent, relay, canaries } = running;

      phone.disconnect();
      await eventually(
        () =>
          relay.logs().some((line) => line.includes('"ws_close"') && line.includes(phone.deviceId)),
        'relay: phone still online',
      );
      void agent.fire(permissionRequest(canaries));
      await eventually(() => relay.push.received.length > 0, 'no push');
      const [push] = relay.push.received;
      const body = JSON.parse(push!.plaintext!) as { rid: string; sum: string };

      // The phone's service worker key opens the summary, and it carries the canaries…
      const opened = await deriveNotificationKey(phone.keyPair.privateKey, running.agentPublicKey, [
        'decrypt',
      ]).then((key) => openPushSummary(key, body.rid, Buffer.from(body.sum, 'base64')));
      const summary = decodePushSummary(new TextDecoder().decode(opened));
      const [, cwd, command] = canaries.all();
      expect(summary).toMatchObject({ v: 1, p: cwd, l: 'Run a command', s: `echo ${command!}` });

      // …so the privacy gate, which scans the push wire body and its plaintext, proves the
      // relay only ever handled ciphertext (I1).
      await running.assertNoLeaks();
    },
  );
});
