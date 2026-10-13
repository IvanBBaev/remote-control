import { startAgent, type HarnessAgent, type HarnessRepository } from './agent.js';
import { createCanaries, type Canaries } from './canaries.js';
import { createFakeClock, type FakeClock } from './fake-clock.js';
import { createPhone, type HeadlessPhone } from './phone.js';
import { assertNoLeaks, type LeakSource } from './privacy-gate.js';
import { startRelay, type HarnessRelay } from './relay.js';

export interface ScenarioOptions {
  /** The agent's machine name, sent only inside the E2E session (default `harness-mac`). */
  readonly agentName?: string;
  /** The name the phone enrols the agent under at the relay (default `harness-agent`). */
  readonly enrolName?: string;
  /** The phone's device name (default `harness-phone`). */
  readonly phoneName?: string;
  /** Canaries minted before the run (e.g. for `agentName`); default: a fresh set. */
  readonly canaries?: Canaries;
  /** Subscribe the phone to push (default: yes). */
  readonly push?: boolean;
  /** The agent's allow-listed repository folders (see `StartAgentOptions`). */
  readonly repositories?: readonly HarnessRepository[];
  /** Extra environment for the agent and its `claude` runs. */
  readonly env?: Readonly<Record<string, string>>;
}

export interface Scenario {
  readonly clock: FakeClock;
  readonly relay: HarnessRelay;
  readonly agent: HarnessAgent;
  readonly phone: HeadlessPhone;
  readonly canaries: Canaries;
  /** Wall-clock ms spent booting the relay (PGlite migrations) and the agent's temp HOME. */
  readonly bootMs: number;
  /** The agent's relay device id. */
  readonly agentDeviceId: string;
  /** The agent's static X25519 key, as the phone learnt it in the pairing handshake. */
  readonly agentPublicKey: Uint8Array;
  /**
   * What the privacy gate scans: relay log lines, a PGlite dump, every push (wire body
   * and what it decrypts to) and the agent's log lines.
   */
  leakSources(): Promise<LeakSource[]>;
  /**
   * The I1/I2 gate (07 §5.12): no canary in any of {@link leakSources}. Run it after the
   * scenario's traffic, before `close`.
   */
  assertNoLeaks(): Promise<void>;
  close(): Promise<void>;
}

/**
 * One relay, one agent and one phone, paired and connected (07 §5.6): the phone redeems
 * an invite, enrols the agent, the agent logs in and pairs, then `remotectl run` holds a
 * live E2E session with the phone (the snapshot has arrived).
 */
export async function scenario(options: ScenarioOptions = {}): Promise<Scenario> {
  const started = performance.now();
  const clock = createFakeClock();
  const canaries = options.canaries ?? createCanaries();
  const relay = await startRelay({ clock });
  const cleanup: (() => Promise<void>)[] = [() => relay.close()];
  const close = async () => {
    for (const step of cleanup.splice(0).reverse()) await step();
  };
  try {
    const agent = await startAgent({
      relayUrl: relay.wsOrigin,
      clock,
      name: options.agentName ?? 'harness-mac',
      ...(options.repositories !== undefined ? { repositories: options.repositories } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
    });
    cleanup.push(() => agent.close());
    const bootMs = performance.now() - started;
    const phone = await createPhone({ relay, clock, name: options.phoneName ?? 'harness-phone' });
    cleanup.push(() => Promise.resolve(phone.disconnect()));

    await phone.register(await relay.mintInvite());
    await phone.bind();
    if (options.push ?? true) await phone.subscribePush();
    await phone.connect();
    const enrolled = await phone.enrollAgent(options.enrolName ?? 'harness-agent');
    await agent.login(enrolled.enrollToken, phone.userId);

    const pairing = agent.pair();
    const paired = await phone.pair(await pairing.code);
    const exit = await pairing.done;
    if (exit !== 0) throw new Error(`remotectl pair exited ${String(exit)}: ${agent.stderr()}`);

    await agent.run();
    await phone.handshake(paired.agentDeviceId, paired.agentPublicKey);

    const leakSources = async (): Promise<LeakSource[]> => {
      await relay.idle();
      return [
        { name: 'relay-log', lines: relay.logs() },
        { name: 'pglite', lines: await relay.dump() },
        // The push message as the relay built it: the wire body and what it decrypts to.
        {
          name: 'push',
          lines: relay.push.received.flatMap((push) => [
            Buffer.from(push.body).toString('latin1'),
            push.plaintext ?? '',
          ]),
        },
        { name: 'agent-log', lines: agent.logs() },
      ];
    };
    return {
      clock,
      relay,
      agent,
      phone,
      canaries,
      bootMs,
      agentDeviceId: paired.agentDeviceId,
      agentPublicKey: paired.agentPublicKey,
      leakSources,
      async assertNoLeaks() {
        assertNoLeaks(await leakSources(), canaries.all());
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
