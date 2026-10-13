import { sha256, utf8 } from '@remote-control/crypto';
import { toBase64Url, type Clock, type Random } from '@remote-control/protocol';

import type { AccountStore, NewSession } from '../ports/account-store.js';
import type { SecretHasher } from '../ports/secret-hasher.js';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  WebAuthnPort,
} from '../ports/webauthn.js';
import { ChallengeStore } from './challenge-store.js';
import type { RateLimitResult } from './rate-limiter.js';
import { inviteCodeHash, newRecoveryCode, parseRecoveryCode } from './secret-codes.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** Session lifetimes (D8, 02 §5.5). */
export const SESSION_IDLE_MS = 7 * DAY;
export const SESSION_ABSOLUTE_MS = 30 * DAY;
/** How long a WebAuthn challenge stays valid (matches the 5-minute ceremony timeout). */
export const CHALLENGE_TTL_MS = 5 * MINUTE;
/** `last_seen_at` is written at most this often, not on every request. */
const TOUCH_INTERVAL_MS = MINUTE;

const SESSION_TOKEN_BYTES = 32;
const WEBAUTHN_USER_ID_BYTES = 32;
const CHALLENGE_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DEFAULT_USER_NAME = 'remote-control';

type Pending =
  | {
      readonly kind: 'register';
      readonly inviteId: string;
      readonly webauthnUserId: string;
      readonly displayName: string | null;
    }
  | { readonly kind: 'login' }
  | { readonly kind: 'recovery'; readonly userId: string; readonly recoveryCodeId: string };

export type Failure<R extends string> =
  | { readonly ok: false; readonly reason: R }
  | { readonly ok: false; readonly reason: 'rate_limited'; readonly retryAfterMs: number };

/** A freshly issued login session: the cookie value and its `Max-Age`. */
export interface IssuedSession {
  readonly token: string;
  readonly maxAgeSec: number;
}

export interface Registered {
  readonly ok: true;
  readonly userId: string;
  /** Shown once; only its scrypt hash is stored. */
  readonly recoveryCode: string;
  /** `false` → the PWA asks for a second passkey (02 §5.5). */
  readonly backedUp: boolean;
  readonly session: IssuedSession;
}

export interface LoggedIn {
  readonly ok: true;
  readonly userId: string;
  readonly session: IssuedSession;
}

export interface Authenticated {
  readonly ok: true;
  readonly sessionId: string;
  readonly userId: string;
  /** `Max-Age` for the refreshed cookie: the smaller of idle and absolute remaining. */
  readonly maxAgeSec: number;
}

export type ChallengeFailure = 'unknown_challenge' | 'verification_failed';
export type SessionFailure = 'no_session' | 'revoked' | 'expired';

/** Per-user rate check the caller applies once a response names its user. */
export type UserGuard = (userId: string) => RateLimitResult;

export interface AccountServiceDeps {
  readonly store: AccountStore;
  readonly webauthn: WebAuthnPort;
  readonly hasher: SecretHasher;
  readonly clock: Clock;
  readonly random: Random;
}

const allowAll: UserGuard = () => ({ allowed: true });

function fromBase64Url(text: string): Uint8Array {
  const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/**
 * Accounts with passkeys only (D8): invite-gated registration, discoverable login,
 * a single-use recovery code, and cookie sessions whose tokens are stored as hashes.
 * Every challenge is single-use: the response's own challenge is taken out of the
 * store before verification, so a replayed response finds nothing.
 */
export class AccountService {
  readonly #challenges: ChallengeStore<Pending>;

  constructor(private readonly deps: AccountServiceDeps) {
    this.#challenges = new ChallengeStore<Pending>(deps.clock, CHALLENGE_TTL_MS);
  }

  /** Outstanding challenges (tests, metrics). */
  get pendingChallenges(): number {
    return this.#challenges.size;
  }

  async startRegistration(
    inviteCode: string,
    displayName: string | null,
  ): Promise<
    | { readonly ok: true; readonly options: PublicKeyCredentialCreationOptionsJSON }
    | Failure<'invalid_invite'>
  > {
    const hash = await inviteCodeHash(inviteCode);
    const invite = hash && (await this.deps.store.findUsableInvite(hash, this.deps.clock.now()));
    if (!invite) return { ok: false, reason: 'invalid_invite' };
    const userId = this.deps.random.bytes(WEBAUTHN_USER_ID_BYTES);
    const challenge = this.#newChallenge({
      kind: 'register',
      inviteId: invite.id,
      webauthnUserId: toBase64Url(userId),
      displayName,
    });
    const options = await this.deps.webauthn.registrationOptions({
      userId,
      userName: displayName ?? DEFAULT_USER_NAME,
      challenge,
      excludeCredentialIds: [],
    });
    return { ok: true, options };
  }

  async finishRegistration(
    response: RegistrationResponseJSON,
  ): Promise<Registered | Failure<ChallengeFailure | 'invalid_invite'>> {
    const taken = this.#take(response, 'register');
    if (taken === undefined) return { ok: false, reason: 'unknown_challenge' };
    const passkey = await this.deps.webauthn.verifyRegistration(response, taken.challenge);
    if (passkey === null) return { ok: false, reason: 'verification_failed' };
    const now = this.deps.clock.now();
    const recovery = newRecoveryCode(this.deps.random);
    const { session, issued } = await this.#newSession(now);
    const created = await this.deps.store.createAccount({
      inviteId: taken.pending.inviteId,
      webauthnUserId: taken.pending.webauthnUserId,
      displayName: taken.pending.displayName,
      passkey,
      recoveryCode: {
        locator: recovery.locator,
        codeHash: await this.deps.hasher.hash(recovery.secret),
      },
      session,
      now,
    });
    // The invite was used or expired between options and verify.
    if (created === null) return { ok: false, reason: 'invalid_invite' };
    return {
      ok: true,
      userId: created.userId,
      recoveryCode: recovery.display,
      backedUp: passkey.backedUp,
      session: issued,
    };
  }

  /** Options for a discoverable-credential login (conditional UI, no user hint). */
  startLogin(): Promise<PublicKeyCredentialRequestOptionsJSON> {
    return this.deps.webauthn.authenticationOptions(this.#newChallenge({ kind: 'login' }));
  }

  async finishLogin(
    response: AuthenticationResponseJSON,
    guard: UserGuard = allowAll,
  ): Promise<LoggedIn | Failure<ChallengeFailure | 'unknown_credential'>> {
    const taken = this.#take(response, 'login');
    if (taken === undefined) return { ok: false, reason: 'unknown_challenge' };
    const passkey = await this.deps.store.findPasskey(response.id);
    if (passkey === undefined) return { ok: false, reason: 'unknown_credential' };
    const limit = guard(passkey.userId);
    if (!limit.allowed)
      return { ok: false, reason: 'rate_limited', retryAfterMs: limit.retryAfterMs };
    // A discoverable credential must name the account it was registered for.
    if (response.response.userHandle !== passkey.webauthnUserId) {
      return { ok: false, reason: 'verification_failed' };
    }
    const verified = await this.deps.webauthn.verifyAuthentication(
      response,
      taken.challenge,
      passkey,
    );
    if (verified === null) return { ok: false, reason: 'verification_failed' };
    const now = this.deps.clock.now();
    const { session, issued } = await this.#newSession(now);
    await this.deps.store.recordLogin({
      userId: passkey.userId,
      credentialId: passkey.id,
      newCounter: verified.newCounter,
      backedUp: verified.backedUp,
      session,
      now,
    });
    return { ok: true, userId: passkey.userId, session: issued };
  }

  /** Checks the recovery code and returns registration options for a new passkey. */
  async startRecovery(
    code: string,
    guard: UserGuard = allowAll,
  ): Promise<
    | { readonly ok: true; readonly options: PublicKeyCredentialCreationOptionsJSON }
    | Failure<'invalid_code'>
  > {
    const parsed = parseRecoveryCode(code);
    const stored = parsed && (await this.deps.store.findRecoveryCode(parsed.locator));
    if (!parsed || !stored || stored.usedAt !== null) return { ok: false, reason: 'invalid_code' };
    const limit = guard(stored.userId);
    if (!limit.allowed)
      return { ok: false, reason: 'rate_limited', retryAfterMs: limit.retryAfterMs };
    if (!(await this.deps.hasher.verify(parsed.secret, stored.codeHash))) {
      return { ok: false, reason: 'invalid_code' };
    }
    const user = await this.deps.store.findUser(stored.userId);
    if (user === undefined) return { ok: false, reason: 'invalid_code' };
    const challenge = this.#newChallenge({
      kind: 'recovery',
      userId: stored.userId,
      recoveryCodeId: stored.id,
    });
    const options = await this.deps.webauthn.registrationOptions({
      userId: fromBase64Url(user.webauthnUserId),
      userName: user.displayName ?? DEFAULT_USER_NAME,
      challenge,
      excludeCredentialIds: await this.deps.store.listPasskeyIds(stored.userId),
    });
    return { ok: true, options };
  }

  /** Adds the new passkey, rotates the recovery code and ends every other session. */
  async finishRecovery(
    response: RegistrationResponseJSON,
  ): Promise<Registered | Failure<ChallengeFailure | 'invalid_code'>> {
    const taken = this.#take(response, 'recovery');
    if (taken === undefined) return { ok: false, reason: 'unknown_challenge' };
    const passkey = await this.deps.webauthn.verifyRegistration(response, taken.challenge);
    if (passkey === null) return { ok: false, reason: 'verification_failed' };
    const now = this.deps.clock.now();
    const recovery = newRecoveryCode(this.deps.random);
    const { session, issued } = await this.#newSession(now);
    const recovered = await this.deps.store.recoverAccount({
      userId: taken.pending.userId,
      recoveryCodeId: taken.pending.recoveryCodeId,
      passkey,
      recoveryCode: {
        locator: recovery.locator,
        codeHash: await this.deps.hasher.hash(recovery.secret),
      },
      session,
      now,
    });
    if (!recovered) return { ok: false, reason: 'invalid_code' };
    return {
      ok: true,
      userId: taken.pending.userId,
      recoveryCode: recovery.display,
      backedUp: passkey.backedUp,
      session: issued,
    };
  }

  /** Resolves a cookie token to a live session and slides its idle window. */
  async authenticate(
    token: string | undefined,
  ): Promise<Authenticated | { readonly ok: false; readonly reason: SessionFailure }> {
    if (token === undefined || !TOKEN_PATTERN.test(token))
      return { ok: false, reason: 'no_session' };
    const session = await this.deps.store.findSession(await sha256(utf8(token)));
    if (session === undefined) return { ok: false, reason: 'no_session' };
    if (session.revokedAt !== null) return { ok: false, reason: 'revoked' };
    const now = this.deps.clock.now();
    if (now >= session.expiresAt || now >= session.lastSeenAt + SESSION_IDLE_MS) {
      return { ok: false, reason: 'expired' };
    }
    if (now - session.lastSeenAt >= TOUCH_INTERVAL_MS) {
      await this.deps.store.touchSession(session.id, now);
    }
    return {
      ok: true,
      sessionId: session.id,
      userId: session.userId,
      maxAgeSec: Math.floor(Math.min(SESSION_IDLE_MS, session.expiresAt - now) / 1000),
    };
  }

  /** Ends a session (logout); writes the `session_revoked` audit row. */
  revokeSession(session: Authenticated): Promise<void> {
    return this.deps.store.revokeSession(session.sessionId, session.userId, this.deps.clock.now());
  }

  #newChallenge(pending: Pending): Uint8Array {
    const challenge = this.deps.random.bytes(CHALLENGE_BYTES);
    this.#challenges.put(toBase64Url(challenge), pending);
    return challenge;
  }

  #take<K extends Pending['kind']>(
    response: RegistrationResponseJSON | AuthenticationResponseJSON,
    kind: K,
  ): { challenge: string; pending: Extract<Pending, { kind: K }> } | undefined {
    const challenge = this.deps.webauthn.challengeOf(response);
    if (challenge === null) return undefined;
    const pending = this.#challenges.take(challenge);
    if (pending?.kind !== kind) return undefined;
    return { challenge, pending: pending as Extract<Pending, { kind: K }> };
  }

  async #newSession(now: number): Promise<{ session: NewSession; issued: IssuedSession }> {
    const token = toBase64Url(this.deps.random.bytes(SESSION_TOKEN_BYTES));
    return {
      session: { tokenHash: await sha256(utf8(token)), expiresAt: now + SESSION_ABSOLUTE_MS },
      issued: { token, maxAgeSec: SESSION_IDLE_MS / 1000 },
    };
  }
}
