// A signed-in session for the native app on a local relay (M4-03):
//
//   pnpm dev:session --relay http://localhost:3200 --invite <code>
//
// Registers a software passkey with the invite (mint one with `node dist/admin.js invite`
// against the same database) and prints the `__Host-rc_session` token, which the app's
// developer settings take until it has its own passkey sign-in (M4-04). The relay must run
// with `RC_ORIGIN` equal to `--relay` and `RC_RP_ID` its host. Exit 0 on success, 1 when
// the relay refuses, 2 on bad arguments.
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import { SoftwareAuthenticator } from '@remote-control/relay/testing';

type CreationOptions = Parameters<SoftwareAuthenticator['create']>[0];

const SESSION_COOKIE = /^__Host-rc_session=([^;]+);/;

export interface DevSessionOptions {
  /** The relay's origin, which is also the origin the session is bound to. */
  readonly relay: string;
  readonly inviteCode: string;
  readonly fetch?: typeof fetch;
}

export interface DevSession {
  readonly userId: string;
  /** The value of the `__Host-rc_session` cookie. */
  readonly token: string;
}

/** Registers a new account on `relay` with a software passkey and returns its session. */
export async function createDevSession(options: DevSessionOptions): Promise<DevSession> {
  const origin = new URL(options.relay).origin;
  const doFetch = options.fetch ?? fetch;
  let token = '';

  async function call<T>(path: string, body: unknown): Promise<T> {
    const response = await doFetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        origin,
        'sec-fetch-site': 'same-origin',
        'x-rc-client': 'pwa',
        'content-type': 'application/json',
        ...(token === '' ? {} : { cookie: `__Host-rc_session=${token}` }),
      },
      body: JSON.stringify(body),
    });
    const cookie = SESSION_COOKIE.exec(response.headers.get('set-cookie') ?? '');
    if (cookie !== null) token = cookie[1]!;
    const text = await response.text();
    if (!response.ok) throw new Error(`${path} → ${String(response.status)} ${text}`);
    return JSON.parse(text) as T;
  }

  const authenticator = new SoftwareAuthenticator(new URL(origin).hostname, origin);
  const creation = await call<CreationOptions>('/api/auth/register/options', {
    inviteCode: options.inviteCode,
    displayName: 'Simulator',
  });
  const { userId } = await call<{ userId: string }>(
    '/api/auth/register/verify',
    await authenticator.create(creation),
  );
  if (token === '') throw new Error('the relay set no session cookie');
  return { userId, token };
}

export interface DevSessionIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly create: (options: DevSessionOptions) => Promise<DevSession>;
}

export async function main(argv: readonly string[], io: DevSessionIo): Promise<number> {
  let relay: string | undefined;
  let invite: string | undefined;
  try {
    ({
      values: { relay, invite },
    } = parseArgs({
      args: [...argv],
      options: { relay: { type: 'string' }, invite: { type: 'string' } },
    }));
  } catch {
    relay = undefined;
  }
  if (relay === undefined || invite === undefined) {
    io.stderr('usage: pnpm dev:session --relay <origin> --invite <code>\n');
    return 2;
  }
  try {
    const session = await io.create({ relay, inviteCode: invite });
    io.stderr(`dev-session: signed in as ${session.userId}\n`);
    io.stdout(`${session.token}\n`);
    return 0;
  } catch (error) {
    io.stderr(`dev-session: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    create: createDevSession,
  });
}
